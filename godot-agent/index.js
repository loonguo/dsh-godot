/**
 * @local/dsh-godot — Godot 4 tools for DeepSeek Harness.
 *
 * Host-only ESM bundle plugin: no dependencies, no harness imports. Registers
 * the six `godot_*` tools from CONTRACT §2, the toolbar's game-control HTTP
 * routes, and kills every child process it started when the plugin unloads
 * (HMR / profile reload).
 *
 * The toolbar (client.js) presses run/pause/stop; those requests arrive on
 * `GET /dsh-godot/state` and `POST /dsh-godot/control` and are served by the
 * same controller that owns the game process and its loopback bridge, so the
 * agent's `godot_bridge` pause/resume reaches the same running game.
 *
 * Boot-order note: this row may be activated before the web carrier has finished
 * listening, so `webServer`, `agents` and `workingDirectory` are never cached at
 * apply time — the routes wait for the carrier (Cordis `ctx.inject`, plus a
 * bounded poll fallback) and every Session lookup reads the service when it is
 * used. Caching them here made the floating panel disappear after every DSH
 * restart until the plugin was reloaded by hand.
 *
 * Config (all optional, documented in cordis.patch.yml):
 *   enginePath       string  Godot executable or folder (prefers *_console.exe)
 *   projectRoot      string  default project directory reported by godot_status
 *                            and used by the toolbar when a session has none
 *   defaultTimeoutMs number  default run/import/check timeout (20000)
 */

import { createControlHandler, createController } from './src/control.js';
import { createRuntime, createToolDefinitions } from './src/tools.js';

export const inject = ['tools'];

/** How long the toolbar route registration waits for the web carrier. */
const SERVICE_WAIT_MS = 20000;
const SERVICE_POLL_MS = 250;

/**
 * Run `use` once an optional Cordis service exists, and return its disposer.
 *
 * The service may already be there (a profile reload), arrive later through
 * `ctx.inject` (Cordis resolves the dependency), or — for older loader
 * compositions — only become readable through `ctx.get` shortly after this row
 * activated, which the bounded poll covers. Everything stops on dispose.
 *
 * @param {object} ctx plugin context
 * @param {string} name service key
 * @param {(service: object) => (() => void) | void} use consumer, may return a disposer
 * @param {string} [label] warning label
 * @returns {() => void} disposer
 */
export function whenServiceAvailable(ctx, name, use, label = name) {
  let used = false;
  let timer = null;
  let consumerDispose = null;
  let injectDispose = null;
  let attempts = 0;
  const maxAttempts = Math.max(1, Math.round(SERVICE_WAIT_MS / SERVICE_POLL_MS));

  const read = () => {
    if (typeof ctx.get !== 'function') return undefined;
    try {
      return ctx.get(name);
    } catch {
      return undefined;
    }
  };

  const start = (service) => {
    if (used || service === undefined || service === null) return false;
    used = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      const cleanup = use(service);
      if (typeof cleanup === 'function') consumerDispose = cleanup;
    } catch (error) {
      console.warn(`[dsh-godot] ${label} consumer failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  };

  if (start(read())) {
    return () => {
      if (typeof consumerDispose === 'function') consumerDispose();
      consumerDispose = null;
    };
  }

  // Cordis resolves optional dependencies here once the provider activates.
  if (typeof ctx.inject === 'function') {
    try {
      const dispose = ctx.inject([name], () => {
        start(read());
      });
      if (typeof dispose === 'function') injectDispose = dispose;
    } catch {
      /* fall through to the poll */
    }
  }

  const tick = () => {
    timer = null;
    if (used) return;
    attempts += 1;
    if (start(read())) return;
    if (attempts >= maxAttempts) {
      console.warn(`[dsh-godot] ${label}: service "${name}" was not available after ${SERVICE_WAIT_MS} ms; the toolbar routes stay unregistered until the plugin reloads.`);
      return;
    }
    timer = setTimeout(tick, SERVICE_POLL_MS);
    if (typeof timer.unref === 'function') timer.unref();
  };
  timer = setTimeout(tick, SERVICE_POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  return () => {
    used = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (typeof consumerDispose === 'function') consumerDispose();
    consumerDispose = null;
    if (typeof injectDispose === 'function') injectDispose();
    injectDispose = null;
  };
}

/**
 * Register the six Godot tools, the toolbar routes, and their cleanup.
 * @param {{ tools: { register(definition: object): () => void }, get?(name: string): unknown, inject?(deps: string[], callback: () => void): unknown, effect(execute: () => (() => void) | void, label?: string): void }} ctx plugin context
 * @param {Record<string, unknown>} [config] row config (plain object; unknown keys tolerated)
 */
export function apply(ctx, config) {
  const runtime = createRuntime(config !== null && typeof config === 'object' ? config : {});
  const read = (name) => {
    if (typeof ctx.get !== 'function') return undefined;
    try {
      return ctx.get(name);
    } catch {
      return undefined;
    }
  };

  /**
   * Map a Session id from the page to the directory that session works in.
   * Services are read per call: at boot they may not exist yet when this row
   * activates, but they do by the time the page sends its first request.
   */
  const resolveSessionDirectory = (sessionId) => {
    try {
      const agents = read('agents');
      const workingDirectory = read('workingDirectory');
      const agent = agents?.get?.(sessionId);
      const session = agent?.session;
      if (session !== undefined && session !== null && typeof workingDirectory?.get === 'function') {
        return workingDirectory.get(session);
      }
    } catch {
      /* a service shape change must not break the toolbar */
    }
    return undefined;
  };

  const controller = createController(runtime, { resolveSessionDirectory });

  // Kill every live Godot process, close bridges and stop the toolbar controller
  // when the plugin unloads (HMR, profile reload, shutdown). Registered before
  // the tools and routes so it runs even if a later registration throws.
  ctx.effect(
    () => () => {
      try {
        controller.dispose();
      } catch {
        /* best effort during teardown */
      }
      try {
        runtime.dispose();
      } catch {
        /* best effort during teardown */
      }
    },
    'dsh-godot: stop child processes',
  );

  const definitions = createToolDefinitions(runtime);
  for (const definition of definitions) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-godot: tool ${definition.name}`);
  }

  // Toolbar transport: two exact routes on the Host HTTP carrier. The carrier is
  // an optional service that may activate after this row, hence the wait.
  const handler = createControlHandler(controller);
  ctx.effect(
    () =>
      whenServiceAvailable(
        ctx,
        'webServer',
        (webServer) => {
          if (webServer === null || webServer === undefined || typeof webServer.register !== 'function') return undefined;
          const disposers = [];
          for (const path of ['/dsh-godot/state', '/dsh-godot/control']) {
            disposers.push(webServer.register({ kind: 'exact', path, handler }));
          }
          return () => {
            for (const dispose of disposers.reverse()) {
              try {
                dispose();
              } catch {
                /* already gone */
              }
            }
          };
        },
        'toolbar routes',
      ),
    'dsh-godot: toolbar routes',
  );
}
