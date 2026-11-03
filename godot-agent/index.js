/**
 * @local/dsh-godot — Godot 4 tools for DeepSeek Harness.
 *
 * Host-only ESM bundle plugin: no dependencies, no harness imports. Registers
 * the six `godot_*` tools from CONTRACT §2 and kills every child process it
 * started when the plugin unloads (HMR / profile reload).
 *
 * Config (all optional, documented in cordis.patch.yml):
 *   enginePath       string  Godot executable or folder (prefers *_console.exe)
 *   projectRoot      string  default project directory reported by godot_status
 *   defaultTimeoutMs number  default run/import/check timeout (20000)
 */

import { createRuntime, createToolDefinitions } from './src/tools.js';

export const inject = ['tools'];

/**
 * Register the six Godot tools and their cleanup.
 * @param {{ tools: { register(definition: object): () => void }, effect(execute: () => (() => void) | void, label?: string): void }} ctx plugin context
 * @param {Record<string, unknown>} [config] row config (plain object; unknown keys tolerated)
 */
export function apply(ctx, config) {
  const runtime = createRuntime(config !== null && typeof config === 'object' ? config : {});

  // Kill every live Godot process and close bridges when the plugin unloads
  // (HMR, profile reload, shutdown). Registered before the tools so it runs
  // even if a later registration throws.
  ctx.effect(
    () => () => {
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
}
