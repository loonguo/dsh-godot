/**
 * Godot child-process sessions: spawn/capture/timeout plus a small registry of
 * live sessions owned by the plugin.
 *
 * Node built-ins only. Commands are always argv arrays (`spawn(exe, argv)`),
 * never shell-concatenated.
 *
 * Sandbox note: some Windows sandbox policies deny creating the named pipes
 * that Node's `stdio: 'pipe'` needs (spawn fails synchronously with EPERM).
 * `startSession` therefore tries a normal piped capture first and transparently
 * falls back to inheriting a temporary capture file descriptor, keeping the
 * same Session API. `captureSync` does the same for one-shot probes.
 */

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Hard cap for a session's combined output tail (CONTRACT §2). */
export const MAX_OUTPUT_BYTES = 200 * 1024;

/** Hard cap for one `captureSync` result. */
const MAX_CAPTURE_BYTES = 1024 * 1024;

/**
 * Whether a spawn failure means the surrounding sandbox denied pipe creation
 * (as opposed to a genuinely missing or broken executable).
 * @param {unknown} error sync throw from `spawn`/`spawnSync`
 * @returns {boolean} true when the file-capture fallback should be used
 */
export function isPipeSpawnDenied(error) {
  if (error === null || typeof error !== 'object') return false;
  const code = /** @type {{ code?: string }} */ (error).code;
  return code === 'EPERM';
}

/** Create a unique temp path for capture files. */
function tempCapturePath(tag) {
  const random = crypto.randomBytes(6).toString('hex');
  return path.join(os.tmpdir(), `dsh-godot-${tag}-${process.pid}-${random}.log`);
}

/**
 * Read at most `maxBytes` from the end of a file.
 * @param {string} file absolute path
 * @param {number} maxBytes byte cap
 * @returns {{ text: string, size: number, truncated: boolean, found: boolean }}
 */
function readTailBytes(file, maxBytes) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { text: '', size: 0, truncated: false, found: false };
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return { text: '', size, truncated: false, found: true };
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try {
      let read = 0;
      while (read < length) {
        const chunk = fs.readSync(fd, buffer, read, length - read, start + read);
        if (chunk <= 0) break;
        read += chunk;
      }
      return { text: buffer.subarray(0, read).toString('utf8'), size, truncated: size > maxBytes, found: true };
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return { text: '', size: 0, truncated: false, found: false };
  }
}

/** Best-effort remove of a capture file. */
function removeFile(file) {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

/** Turn an async spawn error into an actionable Error. */
function spawnFailure(command, error) {
  const executable = command[0] ?? '<unknown>';
  const code = error && typeof error === 'object' ? /** @type {{ code?: string }} */ (error).code : undefined;
  if (code === 'ENOENT') {
    return new Error(`cannot start Godot engine "${executable}": the executable was not found. Set \`enginePath\` in the dsh-godot row or $GODOT_BIN.`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`cannot start "${executable}": ${message}`);
}

/** One running (or finished) Godot child process. */
export class Session {
  /**
   * @param {object} options
   * @param {string} options.id session id
   * @param {string[]} options.command full argv (executable first)
   * @param {string} [options.cwd]
   * @param {Record<string, string>} [options.env]
   * @param {string} [options.label]
   * @param {string} [options.project] project directory this process belongs to
   * @param {string} [options.captureDir]
   * @param {number} [options.maxOutputBytes]
   */
  constructor({ id, command, cwd, env, label, project, captureDir, maxOutputBytes = MAX_OUTPUT_BYTES }) {
    if (!Array.isArray(command) || command.length === 0 || typeof command[0] !== 'string') {
      throw new TypeError('godot session needs a non-empty command argument array, e.g. [enginePath, "--headless", "--path", dir]');
    }
    this.id = id;
    this.command = command.map(String);
    this.cwd = cwd ? path.resolve(cwd) : process.cwd();
    this.env = env ?? process.env;
    this.label = label;
    this.project = project ?? this.cwd;
    this.captureDir = captureDir;
    this.startedAt = new Date().toISOString();
    this.maxOutputBytes = Number.isFinite(maxOutputBytes) && maxOutputBytes > 0 ? maxOutputBytes : MAX_OUTPUT_BYTES;

    /** @type {import('node:net').Server|null} bridge server attached by tools.js */
    this.bridge = null;
    /** @type {import('node:child_process').ChildProcess|null} */
    this.child = null;
    this.pid = undefined;
    /** 'pipe' (live stdout/stderr) or 'file' (inherited temp file descriptor). */
    this.captureMode = 'none';
    this.exitCode = null;
    this.signal = null;
    this.alive = false;
    this.started = false;
    /** @type {Error|null} */
    this.spawnError = null;

    this._chunks = [];
    this._bytes = 0;
    this._truncated = false;
    this._capturePath = null;
    this._settled = false;
    this._pollTimer = null;
    this._exitResolve = null;
    this.exitPromise = new Promise((resolve) => {
      this._exitResolve = resolve;
    });

    this._spawn();
  }

  /** Spawn with piped stdio, falling back to file capture if pipes are denied. */
  _spawn() {
    const spawnOptions = { cwd: this.cwd, env: this.env, windowsHide: true };
    try {
      const child = spawn(this.command[0], this.command.slice(1), { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      this.pid = child.pid;
      this.alive = true;
      this.started = true;
      this.captureMode = 'pipe';
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => this._append(String(chunk)));
      child.stderr?.on('data', (chunk) => this._append(String(chunk)));
      this._wireExit();
      return;
    } catch (error) {
      if (!isPipeSpawnDenied(error)) {
        this.started = false;
        this._settled = true;
        this.spawnError = error instanceof Error ? error : new Error(String(error));
        this._exitResolve?.({ exitCode: null, signal: null, timedOut: false, spawnError: this.spawnError });
        throw spawnFailure(this.command, error);
      }
    }
    this._spawnWithFileCapture(spawnOptions);
  }

  /** Spawn with an inherited capture-file descriptor (no OS pipes). */
  _spawnWithFileCapture(spawnOptions) {
    const capturePath = tempCapturePath(this.id);
    let fd;
    try {
      fd = fs.openSync(capturePath, 'w');
    } catch (error) {
      const code = error && typeof error === 'object' ? /** @type {{ code?: string }} */ (error).code : undefined;
      throw new Error(`cannot create a capture file in "${path.dirname(capturePath)}" (${code ?? 'unknown error'}); set TMP or run with a writable temp directory.`);
    }
    try {
      const child = spawn(this.command[0], this.command.slice(1), { ...spawnOptions, stdio: ['ignore', fd, fd] });
      this.child = child;
      this.pid = child.pid;
      this.alive = true;
      this.started = true;
      this.captureMode = 'file';
      this._capturePath = capturePath;
      child.on('error', (error) => {
        this.spawnError = error instanceof Error ? error : new Error(String(error));
      });
      this._wireExit();
    } catch (error) {
      removeFile(capturePath);
      this.started = false;
      this._settled = true;
      throw spawnFailure(this.command, error);
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* the child owns an inherited duplicate */
      }
    }
  }

  /** Attach once-only exit handling. */
  _wireExit() {
    const child = this.child;
    if (!child) return;
    child.on('close', (code, signal) => {
      this._settleExit(code ?? null, signal ?? null);
    });
    child.on('error', (error) => {
      this.spawnError = error instanceof Error ? error : new Error(String(error));
      this._settleExit(null, null);
    });
  }

  /** Mark the session finished exactly once and resolve the exit promise. */
  _settleExit(code, signal) {
    if (this._settled) return;
    this._settled = true;
    this.alive = false;
    this.exitCode = code;
    this.signal = signal;
    this._stopPolling();
    this._exitResolve?.({ exitCode: code, signal, timedOut: false, spawnError: this.spawnError });
  }

  /** Append a piped chunk while keeping only the last `maxOutputBytes`. */
  _append(text) {
    if (text.length === 0) return;
    const bytes = Buffer.byteLength(text, 'utf8');
    this._chunks.push({ text, bytes });
    this._bytes += bytes;
    while (this._bytes > this.maxOutputBytes && this._chunks.length > 1) {
      const removed = this._chunks.shift();
      this._bytes -= removed?.bytes ?? 0;
      this._truncated = true;
    }
  }

  /** Current combined stdout+stderr tail, capped at 200 KB by default. */
  readOutput() {
    if (this.captureMode === 'file') {
      const tail = readTailBytes(this._capturePath, this.maxOutputBytes);
      const prefix = tail.truncated ? `[dsh-godot: output truncated to the last ${this.maxOutputBytes} bytes]\n` : '';
      return prefix + tail.text;
    }
    let body = this._chunks.map((chunk) => chunk.text).join('');
    let truncated = this._truncated;
    if (body.length > this.maxOutputBytes) {
      body = body.slice(-this.maxOutputBytes);
      truncated = true;
    }
    const prefix = truncated ? `[dsh-godot: output truncated to the last ${this.maxOutputBytes} bytes]\n` : '';
    return prefix + body;
  }

  /** Whether any output was discarded by the cap. */
  get truncated() {
    if (this.captureMode === 'file') {
      try {
        return fs.statSync(this._capturePath).size > this.maxOutputBytes;
      } catch {
        return false;
      }
    }
    return this._truncated;
  }

  /**
   * Wait for process exit or the timeout.
   * @param {number} [timeoutMs]
   * @returns {Promise<{ exitCode: number|null, signal: string|null, timedOut: boolean, spawnError: Error|null }>}
   */
  waitForExit(timeoutMs = 30000) {
    return new Promise((resolve) => {
      let timer = null;
      const finish = (info) => {
        if (timer !== null) clearTimeout(timer);
        resolve(info);
      };
      this.exitPromise.then((info) => finish({ ...info, timedOut: false }));
      if (this.alive && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => finish({ exitCode: this.exitCode, signal: this.signal, timedOut: true, spawnError: this.spawnError }), timeoutMs);
      }
    });
  }

  /**
   * Wait until the captured output matches `regex`.
   * @param {RegExp} regex pattern to search for
   * @param {number} [timeoutMs]
   * @returns {Promise<boolean>} true when matched before exit/timeout
   */
  waitForOutput(regex, timeoutMs = 5000) {
    if (!(regex instanceof RegExp)) return Promise.reject(new TypeError('waitForOutput expects a RegExp'));
    return new Promise((resolve) => {
      let done = false;
      const stop = (value) => {
        if (done) return;
        done = true;
        this._stopPolling();
        clearTimeout(timer);
        resolve(value);
      };
      const check = () => {
        try {
          if (regex.test(this.readOutput())) {
            stop(true);
            return true;
          }
        } catch {
          /* ignore and retry */
        }
        return false;
      };
      const timer = setTimeout(() => stop(check()), Number.isFinite(timeoutMs) ? timeoutMs : 5000);
      this._pollTimer = setInterval(() => {
        if (check()) stop(true);
      }, 50);
      if (this._pollTimer.unref) this._pollTimer.unref();
      this.exitPromise.then(() => {
        if (!done && check()) stop(true);
        else stop(false);
      });
      check();
    });
  }

  /** Clear the polling timer used by waitForOutput. */
  _stopPolling() {
    if (this._pollTimer !== null) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Terminate the process (and any children on Windows), waiting briefly.
   * Does not delete the capture file: read output before dispose().
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.started || this._settled) return;
    try {
      this.child?.kill();
    } catch {
      /* already gone */
    }
    const graceful = await this.waitForExit(1000);
    if (!graceful.timedOut || !this.alive) return;
    if (process.platform === 'win32' && Number.isInteger(this.pid)) {
      try {
        spawnSync('taskkill', ['/pid', String(this.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch {
        /* ignore */
      }
      await this.waitForExit(1500);
    }
    if (this.alive) {
      try {
        this.child?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }

  /** Delete the capture file and drop references (after output is consumed). */
  dispose() {
    this._stopPolling();
    removeFile(this._capturePath);
    this._capturePath = null;
    this._chunks = [];
    this._bytes = 0;
    this.child = null;
  }
}

/**
 * Create an isolated session registry. The plugin owns exactly one; tests create
 * their own so ids and cleanup never interfere.
 * @param {{ maxSessions?: number, captureDir?: string }} [options]
 */
export function createSessionRegistry({ maxSessions = 16, captureDir } = {}) {
  /** @type {Map<string, Session>} */
  const sessions = new Map();
  let counter = 0;

  /**
   * @param {{ command: string[], cwd?: string, env?: Record<string,string>, label?: string, project?: string }} options
   * @returns {Session}
   */
  function start(options) {
    const id = `g${++counter}`;
    const session = new Session({ id, captureDir, ...options });
    sessions.set(id, session);
    if (sessions.size > maxSessions) {
      for (const [key, candidate] of sessions) {
        if (key === id || candidate.alive) continue;
        candidate.dispose();
        sessions.delete(key);
        break;
      }
    }
    return session;
  }

  /** @param {string} id */
  function get(id) {
    return sessions.get(id);
  }

  /** All sessions, newest last. */
  function list() {
    return [...sessions.values()];
  }

  /** @param {string} id */
  async function stop(id) {
    const session = sessions.get(id);
    if (!session) return false;
    await session.stop();
    return true;
  }

  /** Stop + dispose one session and drop it from the registry. @param {string} id */
  async function remove(id) {
    const session = sessions.get(id);
    if (!session) return false;
    await session.stop();
    session.dispose();
    sessions.delete(id);
    return true;
  }

  /** Stop and dispose every session. @returns {Promise<string[]>} stopped ids */
  async function stopAll() {
    const ids = [...sessions.keys()];
    await Promise.all([...sessions.values()].map((session) => session.stop()));
    for (const session of sessions.values()) session.dispose();
    sessions.clear();
    return ids;
  }

  /** Synchronous teardown for plugin unload: kill and dispose without awaiting. */
  function destroy() {
    for (const session of sessions.values()) {
      try {
        session.child?.kill();
      } catch {
        /* ignore */
      }
      session.dispose();
    }
    sessions.clear();
  }

  return { start, get, list, stop, remove, stopAll, destroy };
}

/**
 * Run one process to completion with a bounded timeout, returning its output.
 * Used for `godot_project_init`, `godot_check` import/check passes.
 *
 * @param {{ command: string[], cwd?: string, env?: Record<string,string>, timeoutMs?: number, label?: string, project?: string, captureDir?: string }} options
 * @returns {Promise<{ exitCode: number|null, timedOut: boolean, output: string, truncated: boolean }>}
 */
export async function runOnce({ command, cwd, env, timeoutMs = 30000, label, project, captureDir }) {
  const registry = createSessionRegistry({ captureDir });
  const session = registry.start({ command, cwd, env, label, project });
  let info;
  try {
    info = await session.waitForExit(timeoutMs);
    if (info.timedOut) await session.stop();
    const output = session.readOutput();
    const truncated = session.truncated;
    if (info.spawnError !== null && info.spawnError !== undefined) throw spawnFailure(command, info.spawnError);
    return { exitCode: info.exitCode, timedOut: info.timedOut, output, truncated };
  } finally {
    const current = registry.get(session.id);
    if (current) {
      await registry.stop(session.id);
      current.dispose();
    }
  }
}

/**
 * Synchronous one-shot capture for engine probing.
 *
 * Piped stdio is attempted first; if the sandbox denies pipes, the child
 * inherits a temporary file descriptor and its combined output is read back.
 *
 * @param {string} command executable path
 * @param {string[]} argv arguments
 * @param {{ cwd?: string, env?: Record<string,string>, timeoutMs?: number, maxBytes?: number }} [options]
 * @returns {{ exitCode: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean, error?: Error }}
 */
export function captureSync(command, argv, { cwd, env, timeoutMs = 30000, maxBytes = MAX_CAPTURE_BYTES } = {}) {
  try {
    const result = spawnSync(command, argv, {
      cwd,
      env,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: Math.max(maxBytes, 1024 * 1024),
    });
    if (result.error && isPipeSpawnDenied(result.error)) {
      return captureSyncViaFile(command, argv, { cwd, env, timeoutMs });
    }
    return {
      exitCode: result.status ?? null,
      signal: result.signal ?? null,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
      ...(result.error ? { error: result.error } : {}),
    };
  } catch (error) {
    if (!isPipeSpawnDenied(error)) throw error;
  }
  return captureSyncViaFile(command, argv, { cwd, env, timeoutMs });
}

/** File-descriptor variant of `captureSync` (no named pipes). */
function captureSyncViaFile(command, argv, { cwd, env, timeoutMs }) {
  const capturePath = tempCapturePath('probe');
  let fd;
  try {
    fd = fs.openSync(capturePath, 'w');
  } catch (error) {
    const code = error && typeof error === 'object' ? /** @type {{ code?: string }} */ (error).code : undefined;
    throw new Error(`cannot create a capture file in "${path.dirname(capturePath)}" (${code ?? 'unknown error'}).`);
  }
  let result;
  try {
    result = spawnSync(command, argv, {
      cwd,
      env,
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
  const tail = readTailBytes(capturePath, MAX_CAPTURE_BYTES);
  removeFile(capturePath);
  return {
    exitCode: result.status ?? null,
    signal: result.signal ?? null,
    stdout: tail.text,
    stderr: '',
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    ...(result.error ? { error: result.error } : {}),
  };
}
