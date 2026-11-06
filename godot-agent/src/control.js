/**
 * One-click game control shared by the Web toolbar and the agent's tools.
 *
 * The toolbar button and `godot_bridge`'s `pause`/`resume` reach the same running
 * game state: this module owns the process, the loopback bridge and the paused
 * flag, and exposes them as plain JSON for the UI's HTTP route.
 *
 * A start makes the project bridge-ready first (`ensureBridgeInProject`) so an
 * existing project does not have to be re-scaffolded: the current
 * `addons/dsh_bridge/dsh_bridge.gd` is copied in and the `[autoload]` row is
 * added when missing.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BridgeServer } from './bridge.js';
import { discoverEngine } from './engine.js';
import { ensureBridgeInProject, resolveProject } from './project.js';
import { waitForKeepAliveBridge } from './tools.js';

const ATTACH_TIMEOUT_MS = 20000;
const MAX_BODY_BYTES = 64 * 1024;
const PROJECT_SEARCH_DEPTH = 2;

/* ------------------------------------------------------------- discovery */

/** Newest modification time of a file or directory, 0 when unreadable. */
function mtimeMs(target) {
  try {
    return fs.statSync(target).mtimeMs;
  } catch {
    return 0;
  }
}

/** Whether a directory directly contains a Godot project. */
function isProjectDirectory(directory) {
  try {
    return fs.statSync(path.join(directory, 'project.godot')).isFile();
  } catch {
    return false;
  }
}

/**
 * Godot projects that are the directory itself or one of its descendants within
 * `PROJECT_SEARCH_DEPTH`, most recently modified first.
 * @param {string} root directory to inspect
 * @returns {string[]} project directories
 */
export function findProjects(root) {
  const found = [];
  if (isProjectDirectory(root)) found.push(root);
  const walk = (directory, depth) => {
    if (depth > PROJECT_SEARCH_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.godot') continue;
      const child = path.join(directory, entry.name);
      if (isProjectDirectory(child)) found.push(child);
      else walk(child, depth + 1);
    }
  };
  walk(root, 1);
  const unique = [...new Set(found)];
  unique.sort((left, right) => {
    const leftTime = Math.max(mtimeMs(path.join(left, 'project.godot')), mtimeMs(left));
    const rightTime = Math.max(mtimeMs(path.join(right, 'project.godot')), mtimeMs(right));
    return rightTime - leftTime;
  });
  return unique;
}

/* ---------------------------------------------------------------- control */

/**
 * Create the shared game controller.
 *
 * @param {ReturnType<import('./tools.js').createRuntime>} runtime session registry + config
 * @param {{ resolveSessionDirectory?: (sessionId: string) => string | undefined }} [hooks]
 * @returns {object} controller with `state`, `act`, `start`, `pause`, `resume`, `stop`, `dispose`
 */
export function createController(runtime, { resolveSessionDirectory } = {}) {
  /** @type {{ session: object, bridge: BridgeServer, projectDir: string, projectName: string, startedAt: number, paused: boolean } | null} */
  let current = null;
  /** Last project started in this Host run — what the refresh button re-runs. */
  let lastRun = null;
  /** Serializes start/stop/pause so double clicks cannot spawn twice. */
  let chain = Promise.resolve();

  const serialize = (operation) => {
    const run = chain.then(operation, operation);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  function engineInfo() {
    if (runtime.engineCache !== null) return runtime.engineCache;
    runtime.engineCache = discoverEngine(runtime.config);
    return runtime.engineCache;
  }

  /**
   * What the page needs to decide whether the floating panel is relevant: the
   * session's workspace directory and whether it (or a descendant) holds a
   * Godot project. `available` gates the panel; the first candidate is what the
   * run button would launch.
   *
   * @param {string} [sessionId] Session id reported by the page
   * @returns {{ directory: string|null, available: boolean, project: string|null, projectName: string|null, candidates: string[] }}
   */
  function sessionWorkspace(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof resolveSessionDirectory !== 'function') {
      return { directory: null, available: false, project: null, projectName: null, candidates: [] };
    }
    /** @type {string|undefined} */
    let directory;
    try {
      directory = resolveSessionDirectory(sessionId);
    } catch {
      directory = undefined;
    }
    if (typeof directory !== 'string' || directory.length === 0) {
      return { directory: null, available: false, project: null, projectName: null, candidates: [] };
    }
    const absolute = path.resolve(directory);
    const candidates = findProjects(absolute);
    let projectName = null;
    if (candidates.length > 0) {
      try {
        projectName = resolveProject(candidates[0]).name;
      } catch {
        projectName = path.basename(candidates[0]);
      }
    }
    return {
      directory: absolute,
      available: candidates.length > 0,
      project: candidates[0] ?? null,
      projectName,
      candidates: candidates.map((entry) => path.basename(entry)),
    };
  }

  /**
   * The raw state object sent to the UI and returned by `godot_play`.
   * @param {string} [sessionId] Session id from the page; drives `workspace`
   */
  function state(sessionId) {
    const workspace = sessionWorkspace(sessionId);
    const lastRunInfo = lastRun === null ? null : { project: lastRun.project, projectName: lastRun.projectName };
    if (current === null) {
      return {
        running: false,
        paused: false,
        project: null,
        projectName: null,
        sessionId: null,
        pid: null,
        startedAt: null,
        bridge: null,
        workspace,
        lastRun: lastRunInfo,
      };
    }
    const alive = current.session.alive !== false;
    return {
      running: alive,
      paused: alive ? current.paused : false,
      project: current.projectDir,
      projectName: current.projectName,
      sessionId: current.session.id,
      pid: current.session.pid ?? null,
      startedAt: current.startedAt,
      bridge: current.bridge.attached ? 'attached' : 'detached',
      workspace,
      lastRun: lastRunInfo,
    };
  }

  /**
   * Pick the project to run: explicit argument, the session's own project, the
   * configured `projectRoot`, then the newest project found under the session
   * directory (a dev toolbar should launch the project you touched last).
   *
   * @param {{ project?: string, sessionId?: string }} options
   * @returns {{ directory: string, name: string }}
   */
  function resolveProjectDirectory({ project, sessionId } = {}) {
    const explicit = typeof project === 'string' ? project.trim() : '';
    if (explicit.length > 0) {
      const info = resolveProject(explicit);
      return { directory: info.dir, name: info.name };
    }

    /** @type {string|undefined} */
    let sessionDirectory;
    if (typeof sessionId === 'string' && sessionId.length > 0 && typeof resolveSessionDirectory === 'function') {
      try {
        sessionDirectory = resolveSessionDirectory(sessionId);
      } catch {
        sessionDirectory = undefined;
      }
    }

    if (sessionDirectory !== undefined && sessionDirectory !== null) {
      const directory = path.resolve(sessionDirectory);
      const candidates = findProjects(directory);
      if (candidates.length > 0) {
        const chosen = candidates[0];
        try {
          const info = resolveProject(chosen);
          return { directory: info.dir, name: info.name };
        } catch {
          /* fall through to the other hints */
        }
      }
    }

    const configured = typeof runtime.config.projectRoot === 'string' ? runtime.config.projectRoot.trim() : '';
    if (configured.length > 0) {
      try {
        const info = resolveProject(configured);
        return { directory: info.dir, name: info.name };
      } catch {
        /* a stale projectRoot should not block the toolbar */
      }
    }

    const searched = sessionDirectory !== undefined && sessionDirectory !== null ? path.resolve(sessionDirectory) : process.cwd();
    const found = findProjects(searched);
    if (found.length === 1) {
      const info = resolveProject(found[0]);
      return { directory: info.dir, name: info.name };
    }
    if (found.length > 1) {
      throw new Error(
        `several Godot projects are under "${searched}": ${found.map((entry) => path.basename(entry)).join(', ')}. Open one of them as the session directory, pass a project path, or set the plugin's projectRoot.`,
      );
    }
    throw new Error(
      `no Godot project found under "${searched}". Open the Godot project folder (the one with project.godot) as this session's directory, or set projectRoot in the dsh-godot row.`,
    );
  }

  /** Kill a process and close its bridge without touching `current`. */
  async function discard(session, bridge) {
    try {
      bridge?.close();
    } catch {
      /* already closed */
    }
    try {
      await runtime.sessions.remove(session.id);
    } catch {
      /* already gone */
    }
  }

  /** Tail of a session's captured output, for error messages. */
  function outputTail(session, limit = 2000) {
    const output = session.readOutput();
    return output.length > limit ? `…${output.slice(-limit)}` : output;
  }

  /**
   * Start the game. Callers go through `serialize`; this body must not serialize
   * again (a nested serialize on the same chain deadlocks the toggle path).
   */
  async function startInternal(options = {}) {
    if (current !== null && current.session.alive !== false) return state();

      const { directory, name } = resolveProjectDirectory(options);
      const bridgeInfo = ensureBridgeInProject(directory);

      const engine = engineInfo();
      const bridge = new BridgeServer();
      await bridge.start();
      const headless = options.headless === true;
      const command = [
        engine.path,
        ...(headless ? ['--headless'] : []),
        '--path',
        directory,
        '--',
        `--dsh-bridge=127.0.0.1:${bridge.port}`,
      ];

      const session = runtime.sessions.start({
        command,
        cwd: directory,
        env: process.env,
        label: 'godot game (toolbar)',
        project: directory,
      });
      session.bridge = bridge;

      const outcome = await waitForKeepAliveBridge(session, bridge, { timeoutMs: ATTACH_TIMEOUT_MS });
      if (!outcome.attached) {
        const tail = outputTail(session);
        await discard(session, bridge);
        if (outcome.dead) {
          throw new Error(
            `Godot exited before its bridge attached (exit ${outcome.exitCode ?? 'unknown'}). Is the main scene valid and is the engine path right? Output tail: ${tail || '(no output)'}`,
          );
        }
        throw new Error(
          `Godot started but the bridge did not attach within ${ATTACH_TIMEOUT_MS} ms${bridgeInfo.bridgeWritten ? ' (the bridge script was just installed and needs an import pass)' : ''}. Output tail: ${tail || '(no output)'}`,
        );
      }

      lastRun = { project: directory, projectName: name };
      current = {
        session,
        bridge,
        projectDir: directory,
        projectName: name,
        startedAt: Date.now(),
        paused: false,
      };
      session.exitPromise.then(() => {
        if (current !== null && current.session === session) {
          try {
            bridge.close();
          } catch {
            /* already closed */
          }
          current = null;
        }
      });
      return state();
  }

  const start = (options = {}) => serialize(() => startInternal(options));

  async function setPausedInternal(paused) {
    if (current === null || current.session.alive === false) {
      throw new Error('no game is running; press the run button first.');
    }
    if (!current.bridge.attached) {
      throw new Error('the running game is not attached to the control bridge; stop it and start again.');
    }
    const reply = await current.bridge.request('pause', { paused });
    if (reply.ok !== true) throw new Error(reply.error ?? 'the game refused the pause command');
    current.paused = Boolean(reply.result && typeof reply.result === 'object' ? reply.result.paused : paused);
    return state();
  }

  const setPaused = (paused) => serialize(() => setPausedInternal(paused));

  async function stopInternal() {
    if (current === null) return state();
    const { session, bridge } = current;
    current = null;
    await discard(session, bridge);
    return state();
  }

  const stop = () => serialize(() => stopInternal());

  /**
   * The floating toolbar's refresh button: reload the running game's current
   * scene in place, or — when no game is running — run the last project again.
   * @param {{ project?: string, sessionId?: string }} [options]
   */
  async function reloadInternal(options = {}) {
    if (current !== null && current.session.alive !== false) {
      if (!current.bridge.attached) {
        throw new Error('the running game is not attached to the control bridge; stop it and start again.');
      }
      // The scene reload resumes a paused tree; mirror that in the tracked state.
      current.paused = false;
      const reply = await current.bridge.request('reload', {});
      if (reply.ok !== true) throw new Error(reply.error ?? 'the game refused the reload command');
      current.paused = false;
      return state();
    }
    if (lastRun === null) throw new Error('nothing to reload yet: run the game once first.');
    return startInternal({ ...options, project: lastRun.project });
  }

  const reload = (options = {}) => serialize(() => reloadInternal(options));

  /**
   * One HTTP/agent-facing entry point.
   * @param {'start'|'pause'|'resume'|'toggle'|'reload'|'stop'|'status'} action
   * @param {{ project?: string, sessionId?: string }} [options]
   */
  function act(action, options = {}) {
    switch (action) {
      case 'start':
        return start(options);
      case 'pause':
        return setPaused(true);
      case 'resume':
        return setPaused(false);
      case 'toggle':
        return serialize(async () => {
          if (current === null || current.session.alive === false) return startInternal(options);
          return setPausedInternal(!current.paused);
        });
      case 'reload':
        return reload(options);
      case 'stop':
        return stop();
      case 'status':
        return Promise.resolve(state());
      default:
        return Promise.reject(new Error(`unknown action "${action}": expected start, pause, resume, toggle, stop or status`));
    }
  }

  /** Best-effort teardown on plugin unload (the runtime also kills sessions). */
  function dispose() {
    if (current !== null) {
      try {
        current.bridge.close();
      } catch {
        /* already closed */
      }
      current = null;
    }
  }

  return { state, act, start, pause: () => setPaused(true), resume: () => setPaused(false), reload, stop, dispose };
}

/* ------------------------------------------------------------------ http */

/** Read a JSON request body with a size cap. */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object');
        resolve(parsed);
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    request.on('error', reject);
  });
}

/** Refuse requests whose Origin does not match the Host header (CSRF guard). */
function sameOriginRequest(request) {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(payload));
}

/**
 * Handler for the two toolbar routes:
 *   GET  /dsh-godot/state?sessionId=…    -> { ok, state }
 *   POST /dsh-godot/control {action,…}   -> { ok, state } | { ok:false, error }
 *
 * @param {ReturnType<typeof createController>} controller
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}
 */
export function createControlHandler(controller) {
  return async function handle(request, response) {
    if (!sameOriginRequest(request)) {
      sendJson(response, 403, { ok: false, error: 'cross-origin requests are refused' });
      return;
    }
    let url;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendJson(response, 400, { ok: false, error: 'invalid request URL' });
      return;
    }
    try {
      if (request.method === 'GET' && url.pathname === '/dsh-godot/state') {
        const sessionId = url.searchParams.get('sessionId') ?? undefined;
        sendJson(response, 200, { ok: true, state: controller.state(sessionId), sessionId: sessionId ?? null, platform: os.platform() });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/dsh-godot/control') {
        const body = await readJsonBody(request);
        const action = typeof body.action === 'string' ? body.action : '';
        const state = await controller.act(action, {
          ...(typeof body.project === 'string' ? { project: body.project } : {}),
          ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
        });
        sendJson(response, 200, { ok: true, state });
        return;
      }
      sendJson(response, 404, { ok: false, error: 'unknown dsh-godot route; use GET /dsh-godot/state or POST /dsh-godot/control' });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
}
