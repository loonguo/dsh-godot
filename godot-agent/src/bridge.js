/**
 * Host side of the Godot runtime bridge (CONTRACT §4).
 *
 * The game connects OUT to a loopback listener owned by the host, so no
 * inbound firewall rule and no port guessing. Wire format is NDJSON: one JSON
 * object per line. The game's first line after connecting is an unsolicited
 * `{"event":"ready",...}`; host requests look like
 * `{"id":7,"cmd":"node","args":{"path":"/root/Main"}}` and replies like
 * `{"id":7,"ok":true,"result":{}}` / `{"id":7,"ok":false,"error":"..."}`.
 *
 * Node built-ins only (`node:net`).
 */

import net from 'node:net';

/** Default per-request timeout required by CONTRACT §4. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

/**
 * Listener + request multiplexer for one running game instance.
 */
export class BridgeServer {
  /**
   * @param {{ host?: string, requestTimeoutMs?: number, readyTimeoutMs?: number }} [options]
   */
  constructor({ host = '127.0.0.1', requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, readyTimeoutMs = 15000 } = {}) {
    this.host = host;
    this.requestTimeoutMs = requestTimeoutMs;
    this.readyTimeoutMs = readyTimeoutMs;

    /** @type {net.Server|null} */
    this.server = null;
    /** @type {import('node:net').Socket|null} */
    this.socket = null;
    this.port = null;
    this.attached = false;
    /** @type {{engine?: string, project?: string, scene?: string, pid?: number}|null} */
    this.readyInfo = null;
    this._buffer = '';
    this._nextId = 0;
    /** @type {Map<number, { resolve: (value: {ok: boolean, result?: unknown, error?: string}) => void, timer: NodeJS.Timeout }>} */
    this._pending = new Map();
    /** @type {Array<{ resolve: (info: object) => void, reject: (error: Error) => void }>} */
    this._readyWaiters = [];
  }

  /**
   * Bind an ephemeral loopback port. Resolves once the listener is ready.
   * @returns {Promise<number>} bound port
   */
  start() {
    if (this.server !== null) throw new Error('bridge server already started');
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this._onConnection(socket));
      this.server = server;
      server.on('error', (error) => {
        this.server = null;
        reject(new Error(`cannot start the dsh-godot bridge listener on ${this.host}: ${error instanceof Error ? error.message : String(error)}`));
      });
      server.listen(0, this.host, () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          server.close();
          this.server = null;
          reject(new Error('dsh-godot bridge listener bound to an unexpected address'));
          return;
        }
        this.port = address.port;
        resolve(address.port);
      });
    });
  }

  /** Accept exactly one game connection; later connections replace the socket. */
  _onConnection(socket) {
    if (this.socket !== null && !this.socket.destroyed) {
      try {
        this.socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.socket = socket;
    this.attached = true;
    this._buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this._onData(String(chunk)));
    socket.on('error', () => {
      /* surfaced through close */
    });
    socket.on('close', () => this._onClose());
  }

  /** Buffer bytes, split on newlines, dispatch each JSON object. */
  _onData(chunk) {
    this._buffer += chunk;
    for (;;) {
      const index = this._buffer.indexOf('\n');
      if (index < 0) break;
      const line = this._buffer.slice(0, index).trim();
      this._buffer = this._buffer.slice(index + 1);
      if (line.length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // malformed line: ignore rather than kill the session
      }
      if (message === null || typeof message !== 'object') continue;
      this._dispatch(message);
    }
  }

  /** Route one decoded bridge message. */
  _dispatch(message) {
    if (typeof message.event === 'string') {
      if (message.event === 'ready') {
        this.readyInfo = {
          ...(typeof message.engine === 'string' ? { engine: message.engine } : {}),
          ...(typeof message.project === 'string' ? { project: message.project } : {}),
          ...(typeof message.scene === 'string' ? { scene: message.scene } : {}),
          ...(typeof message.pid === 'number' ? { pid: message.pid } : {}),
        };
        const waiters = this._readyWaiters;
        this._readyWaiters = [];
        for (const waiter of waiters) waiter.resolve(this.readyInfo);
      }
      return;
    }
    const id = message.id;
    if (typeof id !== 'number') return;
    const pending = this._pending.get(id);
    if (pending === undefined) return;
    this._pending.delete(id);
    clearTimeout(pending.timer);
    if (message.ok === true) pending.resolve({ ok: true, result: message.result });
    else pending.resolve({ ok: false, error: typeof message.error === 'string' ? message.error : 'bridge request failed' });
  }

  /** Fail every in-flight request and ready waiter when the game goes away. */
  _onClose() {
    this.attached = false;
    this.socket = null;
    for (const [id, pending] of this._pending) {
      clearTimeout(pending.timer);
      this._pending.delete(id);
      pending.resolve({ ok: false, error: 'the game closed the bridge connection' });
    }
    const waiters = this._readyWaiters;
    this._readyWaiters = [];
    for (const waiter of waiters) waiter.reject(new Error('the game closed the bridge connection before it sent the `ready` event'));
  }

  /**
   * Wait for the game's `ready` event.
   * @param {number} [timeoutMs]
   * @returns {Promise<{engine?: string, project?: string, scene?: string, pid?: number}>}
   */
  waitForReady(timeoutMs = this.readyTimeoutMs) {
    if (this.readyInfo !== null) return Promise.resolve(this.readyInfo);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._readyWaiters = this._readyWaiters.filter((waiter) => waiter !== entry);
        reject(
          new Error(
            `the game did not attach to the dsh-godot bridge within ${timeoutMs} ms. ` +
              'Run with `bridge: true` and make sure the bridge addon autoload `addons/dsh_bridge/dsh_bridge.gd` exists in the project and the project was imported.',
          ),
        );
      }, timeoutMs);
      const entry = {
        resolve: (info) => {
          clearTimeout(timer);
          resolve(info);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this._readyWaiters.push(entry);
    });
  }

  /**
   * Send one request and await its reply.
   * @param {string} cmd bridge command (`ping`, `tree`, `node`, ...)
   * @param {Record<string, unknown>} [args]
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{ok: boolean, result?: unknown, error?: string}>}
   */
  request(cmd, args = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (typeof cmd !== 'string' || cmd.length === 0) return Promise.reject(new Error('bridge request needs a non-empty `command`'));
    if (this.socket === null || this.socket.destroyed || !this.attached) {
      return Promise.reject(new Error('the dsh-godot bridge is not attached: the game is not running or was not started with `bridge: true`.'));
    }
    const id = ++this._nextId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        resolve({ ok: false, error: `bridge request "${cmd}" timed out after ${timeoutMs} ms` });
      }, timeoutMs);
      this._pending.set(id, { resolve, timer });
      const line = `${JSON.stringify({ id, cmd, args })}\n`;
      try {
        this.socket?.write(line);
      } catch (error) {
        clearTimeout(timer);
        this._pending.delete(id);
        resolve({ ok: false, error: `cannot write to the bridge connection: ${error instanceof Error ? error.message : String(error)}` });
      }
    });
  }

  /** Reject all pending requests and close listener + socket. */
  close() {
    for (const [id, pending] of this._pending) {
      clearTimeout(pending.timer);
      this._pending.delete(id);
      pending.resolve({ ok: false, error: 'the dsh-godot bridge was closed' });
    }
    if (this.socket !== null) {
      try {
        this.socket.destroy();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    this.attached = false;
    const server = this.server;
    this.server = null;
    if (server !== null) {
      try {
        server.close();
      } catch {
        /* ignore */
      }
    }
    const readyWaiters = this._readyWaiters;
    this._readyWaiters = [];
    for (const waiter of readyWaiters) waiter.reject(new Error('the dsh-godot bridge was closed before the game attached'));
  }
}
