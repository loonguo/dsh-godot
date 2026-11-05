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
 * Config (all optional, documented in cordis.patch.yml):
 *   enginePath       string  Godot executable or folder (prefers *_console.exe)
 *   projectRoot      string  default project directory reported by godot_status
 *                            and used by the toolbar when a session has none
 *   defaultTimeoutMs number  default run/import/check timeout (20000)
 */

import { createControlHandler, createController } from './src/control.js';
import { createRuntime, createToolDefinitions } from './src/tools.js';

export const inject = ['tools'];

/**
 * Register the six Godot tools, the toolbar routes, and their cleanup.
 * @param {{ tools: { register(definition: object): () => void }, get(name: string): unknown, effect(execute: () => (() => void) | void, label?: string): void }} ctx plugin context
 * @param {Record<string, unknown>} [config] row config (plain object; unknown keys tolerated)
 */
export function apply(ctx, config) {
  const runtime = createRuntime(config !== null && typeof config === 'object' ? config : {});

  // Optional Host services: present in a Web/Desktop profile, absent in a
  // deployment without a browser page, where the toolbar is simply not served.
  // `ctx.get` is optional so a minimal test context still mounts the plugin.
  const get = typeof ctx.get === 'function' ? (name) => ctx.get(name) : () => undefined;
  const agents = get('agents');
  const workingDirectory = get('workingDirectory');
  const webServer = get('webServer');

  /** Map a Session id from the page to the directory that session works in. */
  const resolveSessionDirectory = (sessionId) => {
    try {
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

  // Toolbar transport: two exact routes on the Host HTTP carrier.
  if (webServer !== undefined && webServer !== null && typeof webServer.register === 'function') {
    const handler = createControlHandler(controller);
    for (const path of ['/dsh-godot/state', '/dsh-godot/control']) {
      ctx.effect(() => webServer.register({ kind: 'exact', path, handler }), `dsh-godot: route ${path}`);
    }
  }
}
