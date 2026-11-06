/**
 * Six model-facing `godot_*` tools (CONTRACT §2).
 *
 * Raw `ctx.tools.register` stores `parameters` verbatim, so — unlike packages
 * that import `defineTool` from the harness — this module compiles its own
 * author-friendly parameter specs into the plain JSON Schema the model must
 * see (`type: 'object'`, `properties`, a top-level `required` array) and does
 * its own required/type validation of model arguments.
 *
 * Output schemas use the enforced JSON-Schema subset
 * (type/properties/required/additionalProperties/items/enum/oneOf).
 */

import path from 'node:path';

import { BridgeServer } from './bridge.js';
import { discoverEngine } from './engine.js';
import { parseGodotLog } from './gdparse.js';
import { discoverScripts, normaliseScriptPath, projectHasBridgeAutoload, resolveProject, scaffoldProject } from './project.js';
import { createSessionRegistry, runOnce } from './runner.js';

/** Exact model-facing tool names in CONTRACT §2 order. */
export const TOOL_NAMES = ['godot_status', 'godot_project_init', 'godot_check', 'godot_run', 'godot_bridge', 'godot_stop'];

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_DISCOVERED_SCRIPTS = 40;

/* -------------------------------------------------------------------------- */
/* Parameter-spec compiler (author spec -> raw JSON Schema)                    */
/* -------------------------------------------------------------------------- */

/** Copy the shared annotation keys from an author spec node. */
function copyAnnotations(source, target) {
  for (const key of ['description', 'title', 'default']) {
    if (source[key] !== undefined) target[key] = source[key];
  }
}

/**
 * Recursively compile one author value schema into raw JSON Schema. The author
 * form accepts `required: true` inline on object properties and `type: 'json'`
 * for unconstrained JSON; both are lowered to plain JSON Schema.
 * @param {object} spec author value schema
 * @returns {object} plain JSON Schema node
 */
export function compileValueSchema(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError('tool parameter schema nodes must be plain objects');
  }
  if (spec.type === 'json') {
    const node = {};
    copyAnnotations(spec, node);
    return node;
  }
  const node = {};
  if (spec.type !== undefined) node.type = spec.type;
  copyAnnotations(spec, node);
  if (spec.enum !== undefined) node.enum = [...spec.enum];
  if (spec.const !== undefined) node.const = spec.const;
  if (Array.isArray(spec.oneOf)) node.oneOf = spec.oneOf.map((branch) => compileValueSchema(branch));
  if (spec.type === 'object') {
    const properties = {};
    const required = [];
    for (const [key, value] of Object.entries(spec.properties ?? {})) {
      if (value !== null && typeof value === 'object' && value.required === true) required.push(key);
      properties[key] = compileValueSchema(value);
    }
    node.properties = properties;
    if (required.length > 0) node.required = required;
    if (typeof spec.additionalProperties === 'boolean') node.additionalProperties = spec.additionalProperties;
  } else if (spec.type === 'array' && spec.items !== undefined) {
    node.items = compileValueSchema(spec.items);
  }
  return node;
}

/**
 * Compile the author-facing property map into one object-rooted raw JSON Schema.
 * @param {Record<string, object>} spec per-property author schemas (inline `required: true`)
 * @returns {object} plain JSON Schema
 */
export function compileParameters(spec) {
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(spec)) {
    if (value !== null && typeof value === 'object' && value.required === true) required.push(key);
    properties[key] = compileValueSchema(value);
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

/* -------------------------------------------------------------------------- */
/* Argument validation (raw registrations are not auto-validated)              */
/* -------------------------------------------------------------------------- */

function describeArgument(schema) {
  return typeof schema.description === 'string' && schema.description.length > 0 ? ` — ${schema.description}` : '';
}

/** Check one value against one compiled property schema. */
function checkArgumentType(toolName, namePath, schema, value) {
  const type = schema.type;
  const fail = (expected) => {
    throw new Error(`${toolName}: argument "${namePath}" must be ${expected}${describeArgument(schema)}.`);
  };
  if (type === undefined || Array.isArray(schema.oneOf)) {
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      throw new Error(`${toolName}: argument "${namePath}" must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')} (got ${JSON.stringify(value)}).`);
    }
    return;
  }
  switch (type) {
    case 'string':
      if (typeof value !== 'string') fail('a string');
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('a finite number');
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) fail('an integer');
      break;
    case 'boolean':
      if (typeof value !== 'boolean') fail('a boolean');
      break;
    case 'array':
      if (!Array.isArray(value)) fail('an array');
      if (Array.isArray(value) && schema.items !== undefined) {
        value.forEach((entry, index) => checkArgumentType(toolName, `${namePath}[${index}]`, schema.items, entry));
      }
      break;
    case 'object':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('an object');
      break;
    default:
      break;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    throw new Error(`${toolName}: argument "${namePath}" must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')} (got ${JSON.stringify(value)}).`);
  }
}

/**
 * Validate one tool's arguments against its compiled parameter schema.
 * Required keys are enforced; extra keys are ignored (the schema is open).
 * @param {string} toolName tool name for messages
 * @param {object} parameters compiled JSON Schema
 * @param {unknown} rawArgs model-supplied arguments
 * @returns {Record<string, unknown>} the arguments object
 */
export function validateToolArguments(toolName, parameters, rawArgs) {
  const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`${toolName}: arguments must be an object.`);
  }
  for (const key of parameters.required ?? []) {
    const schema = parameters.properties[key] ?? {};
    if (args[key] === undefined || args[key] === null) {
      throw new Error(`${toolName}: missing required argument "${key}"${describeArgument(schema)}.`);
    }
  }
  for (const [key, schema] of Object.entries(parameters.properties)) {
    if (args[key] === undefined) continue;
    checkArgumentType(toolName, key, schema, args[key]);
  }
  return args;
}

/* -------------------------------------------------------------------------- */
/* Output schemas (enforced JSON-Schema subset, no description annotations)    */
/* -------------------------------------------------------------------------- */

const DIAGNOSTIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    severity: { type: 'string', enum: ['error', 'warning'] },
    message: { type: 'string' },
    file: { type: 'string' },
    line: { type: 'integer' },
    function: { type: 'string' },
    source: { type: 'string', enum: ['parse', 'runtime', 'engine'] },
    raw: { type: 'string' },
  },
  required: ['severity', 'message', 'source', 'raw'],
};

const EXIT_CODE_SCHEMA = { oneOf: [{ type: 'integer' }, { type: 'null' }] };

const IMPORT_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    exitCode: EXIT_CODE_SCHEMA,
    diagnostics: { type: 'array', items: DIAGNOSTIC_SCHEMA },
  },
  required: ['ok', 'diagnostics'],
};

const BRIDGE_STATE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        attached: { type: 'boolean' },
        port: { type: 'integer' },
      },
      required: ['attached'],
    },
    { type: 'null' },
  ],
};

const PROJECT_INFO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    name: { type: 'string' },
    mainScene: { type: 'string' },
    valid: { type: 'boolean' },
  },
  required: ['path', 'name', 'mainScene', 'valid'],
};

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    engine: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string' },
            version: { type: 'string' },
            console: { type: 'boolean' },
          },
          required: ['path', 'version', 'console'],
        },
        { type: 'null' },
      ],
    },
    projectRoot: { type: 'string' },
    defaultTimeoutMs: { type: 'integer' },
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          pid: { type: 'integer' },
          project: { type: 'string' },
          startedAt: { type: 'string' },
          bridge: BRIDGE_STATE_SCHEMA,
          alive: { type: 'boolean' },
        },
        required: ['id', 'pid', 'project', 'startedAt', 'bridge', 'alive'],
      },
    },
    project: PROJECT_INFO_SCHEMA,
  },
  required: ['engine', 'projectRoot', 'defaultTimeoutMs', 'sessions'],
};

const PROJECT_INIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    project: PROJECT_INFO_SCHEMA,
    name: { type: 'string' },
    mainScene: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    import: IMPORT_RESULT_SCHEMA,
  },
  required: ['project', 'name', 'mainScene', 'files', 'import'],
};

const CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    diagnostics: { type: 'array', items: DIAGNOSTIC_SCHEMA },
    checked: { type: 'array', items: { type: 'string' } },
    import: IMPORT_RESULT_SCHEMA,
    truncated: { type: 'boolean' },
  },
  required: ['ok', 'diagnostics', 'checked'],
};

const RUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    session: { type: 'string' },
    pid: { type: 'integer' },
    command: { type: 'array', items: { type: 'string' } },
    exitCode: EXIT_CODE_SCHEMA,
    timedOut: { type: 'boolean' },
    bridge: BRIDGE_STATE_SCHEMA,
    output: { type: 'string' },
    diagnostics: { type: 'array', items: DIAGNOSTIC_SCHEMA },
  },
  required: ['pid', 'command', 'timedOut', 'output', 'diagnostics'],
};

const BRIDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    result: {},
    error: { type: 'string' },
  },
  required: ['ok'],
};

const STOP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    stopped: { type: 'array', items: { type: 'string' } },
  },
  required: ['stopped'],
};

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Render diagnostics as one line each. */
function diagnosticLines(diagnostics) {
  return diagnostics.map((diagnostic) => {
    const location = diagnostic.file ? `${diagnostic.file}${diagnostic.line !== undefined ? `:${diagnostic.line}` : ''}` : '';
    const where = location.length > 0 ? `${location}: ` : '';
    return `${diagnostic.severity}: ${where}${diagnostic.message}`;
  });
}

/** Remove exact duplicate diagnostics (import + per-script passes overlap). */
function dedupeDiagnostics(diagnostics) {
  const seen = new Set();
  const result = [];
  for (const diagnostic of diagnostics) {
    const key = [diagnostic.severity, diagnostic.message, diagnostic.file ?? '', diagnostic.line ?? '', diagnostic.source].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(diagnostic);
  }
  return result;
}

/** A synthetic engine diagnostic for a failing process that printed no parseable error. */
function syntheticFailure(message, raw, extra = {}) {
  return { severity: 'error', message, source: 'engine', raw: String(raw).slice(-4000), ...extra };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Attach the probed engine to a runtime, caching success only. */
function engineFor(runtime) {
  if (runtime.engineCache !== null) return runtime.engineCache;
  const engine = discoverEngine(runtime.config);
  runtime.engineCache = engine;
  return engine;
}

/** Close a session's bridge listener if it owns one. */
function closeSessionBridge(session) {
  if (session.bridge !== null && session.bridge !== undefined) {
    session.bridge.close();
    session.bridge = null;
  }
}

/**
 * Create the plugin's runtime state: merged config plus one session registry.
 * `dispose()` is idempotent and kills every live process (plugin unload/HMR).
 * @param {Record<string, unknown>} [config]
 */
export function createRuntime(config = {}) {
  const merged = {
    enginePath: typeof config.enginePath === 'string' ? config.enginePath : '',
    projectRoot: typeof config.projectRoot === 'string' ? config.projectRoot : '',
    defaultTimeoutMs:
      typeof config.defaultTimeoutMs === 'number' && Number.isFinite(config.defaultTimeoutMs) && config.defaultTimeoutMs > 0
        ? Math.floor(config.defaultTimeoutMs)
        : DEFAULT_TIMEOUT_MS,
  };
  return {
    config: merged,
    sessions: createSessionRegistry(),
    engineCache: null,
    dispose() {
      for (const session of this.sessions.list()) closeSessionBridge(session);
      this.sessions.destroy();
    },
  };
}

/**
 * Register one tool definition with argument validation folded into execute.
 * @param {{ name: string, description: string, parameters: Record<string, object>, schema: object, render: Function, execute: Function }} options
 */
function defineGodotTool({ name, description, parameters, schema, render, execute }) {
  /** @type {object} */
  const definition = {
    name,
    description,
    parameters: compileParameters(parameters),
    output: {
      schema,
      render: (args, value) => render(args, value),
    },
    async execute(rawArgs) {
      const args = validateToolArguments(name, definition.parameters, rawArgs);
      return execute(args);
    },
  };
  return definition;
}

/**
 * Wait ~1.5 s for the first output, then — when output appeared — another
 * ~1.5 s so a keepAlive run returns with a useful tail (CONTRACT §2).
 * @param {import('./runner.js').Session} session
 */
async function settleForOutput(session) {
  const appeared = session.readOutput().length > 0 || (await session.waitForOutput(/[\s\S]/, 1500));
  if (appeared) await delay(1500);
  return appeared;
}

/**
 * Wait policy for a `keepAlive: true, bridge: true` run.
 *
 * The bridge attach is authoritative: this waits up to `timeoutMs` for the
 * game's `ready` line and returns the moment it arrives — it never settles
 * early because the engine printed its banner (a windowed Vulkan start can print
 * long before it connects). If the process exits first (or fails to spawn), the
 * result is marked `dead` with the exit code so the caller can return a
 * diagnosable result instead of a normal-looking unattached session.
 *
 * @param {import('./runner.js').Session} session running game session
 * @param {import('./bridge.js').BridgeServer} bridge listener for this session
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ attached: boolean, dead: boolean, timedOut: boolean, exitCode: number|null, spawnError: Error|null, error: Error|null }>}
 */
export async function waitForKeepAliveBridge(session, bridge, { timeoutMs = 15000 } = {}) {
  if (bridge === null || bridge === undefined) throw new TypeError('waitForKeepAliveBridge requires a bridge server');
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000;

  const attachOutcome = bridge.waitForReady(deadline).then(
    () => ({ kind: 'attached' }),
    (error) => ({ kind: 'attach-error', error: error instanceof Error ? error : new Error(String(error)) }),
  );
  const exitOutcome = session.exitPromise.then((info) => ({ kind: 'exited', info }));

  const winner = await Promise.race([attachOutcome, exitOutcome]);
  if (winner.kind === 'attached') {
    return { attached: true, dead: false, timedOut: false, exitCode: null, spawnError: null, error: null };
  }
  if (winner.kind === 'exited') {
    return {
      attached: false,
      dead: true,
      timedOut: false,
      exitCode: winner.info.exitCode ?? null,
      spawnError: winner.info.spawnError ?? null,
      error: null,
    };
  }
  // A rejected ready wait can mean the timeout OR a closed connection. Give the
  // process one event-loop turn to report its exit so a dying game is reported
  // as dead-with-exit-code rather than a plain attach timeout.
  const lateExit = await Promise.race([session.exitPromise, delay(50).then(() => null)]);
  if (lateExit !== null && lateExit !== undefined) {
    return {
      attached: false,
      dead: true,
      timedOut: false,
      exitCode: lateExit.exitCode ?? null,
      spawnError: lateExit.spawnError ?? null,
      error: winner.error,
    };
  }
  return { attached: false, dead: false, timedOut: true, exitCode: null, spawnError: null, error: winner.error };
}

/** Hint appended to `output` when a project cannot attach because it has no bridge autoload. */
export const BRIDGE_MISSING_AUTOLOAD_HINT =
  '[dsh-godot] bridge not attached: this project has no dsh_bridge autoload; run godot_project_init or copy godot-agent/templates/bridge/dsh_bridge.gd into the project and register it under [autoload].';

/** Hint appended to `output` when the autoload exists but the game never connects. */
export function bridgeAttachTimeoutHint(timeoutMs, sessionId) {
  return `[dsh-godot] bridge did not attach within ${timeoutMs} ms even though the dsh_bridge autoload is registered; check that the project imported and that its main scene actually runs. The game is still running as session ${sessionId}.`;
}

/**
 * Decide how to finish a `keepAlive: true, bridge: true` run.
 *
 * - No `dsh_bridge` autoload in the project → attaching is impossible, so do
 *   not block the full attach budget: settle on output (~1.5 s after first
 *   output) and return `attached:false` plus an actionable hint.
 * - Autoload present → attach-authoritative wait (CONTRACT/D1): attach returns
 *   immediately, process exit yields a dead result with the exit code, and an
 *   attach timeout yields `timedOut:true` plus a hint.
 *
 * @param {import('./runner.js').Session} session
 * @param {import('./bridge.js').BridgeServer} bridge
 * @param {{ projectDir?: string, timeoutMs?: number, hasBridgeAutoload?: boolean }} [options]
 * @returns {Promise<{ mode: 'attached'|'dead'|'no-autoload'|'attach-timeout', attached: boolean, dead: boolean, timedOut: boolean, exitCode: number|null, spawnError: Error|null, error: Error|null, hint: string|null }>}
 */
export async function waitForKeepAliveRun(session, bridge, { projectDir, timeoutMs = 15000, hasBridgeAutoload } = {}) {
  if (bridge === null || bridge === undefined) throw new TypeError('waitForKeepAliveRun requires a bridge server');
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000;
  const autoloadPresent = typeof hasBridgeAutoload === 'boolean' ? hasBridgeAutoload : projectHasBridgeAutoload(projectDir);
  if (!autoloadPresent) {
    await settleForOutput(session);
    return {
      mode: 'no-autoload',
      attached: false,
      dead: false,
      timedOut: false,
      exitCode: null,
      spawnError: null,
      error: null,
      hint: BRIDGE_MISSING_AUTOLOAD_HINT,
    };
  }
  const outcome = await waitForKeepAliveBridge(session, bridge, { timeoutMs: deadline });
  if (outcome.attached) return { ...outcome, mode: 'attached', hint: null };
  if (outcome.dead) return { ...outcome, mode: 'dead', hint: null };
  return { ...outcome, mode: 'attach-timeout', hint: bridgeAttachTimeoutHint(deadline, session.id) };
}

/* -------------------------------------------------------------------------- */
/* Tool definitions                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Build the six tool definitions bound to one runtime.
 * @param {ReturnType<typeof createRuntime>} runtime
 * @returns {Array<object>} registerable tool definitions
 */
export function createToolDefinitions(runtime) {
  const timeoutFor = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : runtime.config.defaultTimeoutMs;

  return [
    /* ------------------------------ godot_status ---------------------------- */
    defineGodotTool({
      name: 'godot_status',
      description:
        'Report the Godot engine these tools will use (path, version, console build), the configured project root, the default timeout, and every live session started by godot_run. Call it first to confirm the engine was found.',
      parameters: {},
      schema: STATUS_SCHEMA,
      render: (_args, value) => {
        const engineText =
          value.engine === null
            ? 'engine: NOT FOUND (install Godot 4.x and set enginePath or GODOT_BIN)'
            : `engine: Godot ${value.engine.version} (${value.engine.console ? 'console' : 'gui'} build) at ${value.engine.path}`;
        const projectText =
          value.project !== undefined ? `project: ${value.project.name} (${value.project.path}), main scene ${value.project.mainScene}` : `project: none at ${value.projectRoot}`;
        const sessionText =
          value.sessions.length === 0
            ? 'sessions: none'
            : `sessions: ${value.sessions
                .map(
                  (session) =>
                    `${session.id} (pid ${session.pid}, ${session.alive ? 'alive' : 'exited'}, ${session.project}${session.bridge !== null ? `, bridge ${session.bridge.attached ? 'attached' : 'detached'}` : ''})`,
                )
                .join('; ')}`;
        return [
          {
            type: 'text',
            text: `${engineText}\nprojectRoot: ${value.projectRoot}\ndefaultTimeoutMs: ${value.defaultTimeoutMs}\n${projectText}\n${sessionText}`,
          },
        ];
      },
      async execute() {
        let engine = null;
        try {
          const probed = engineFor(runtime);
          engine = { path: probed.path, version: probed.version, console: probed.console };
        } catch {
          engine = null;
        }
        const configuredRoot = runtime.config.projectRoot.trim().length > 0 ? runtime.config.projectRoot.trim() : process.cwd();
        const projectRoot = path.resolve(configuredRoot);
        const sessions = runtime.sessions.list().map((session) => ({
          id: session.id,
          pid: Number.isInteger(session.pid) ? session.pid : 0,
          project: session.project,
          startedAt: session.startedAt,
          bridge:
            session.bridge !== null && session.bridge !== undefined
              ? { attached: Boolean(session.bridge.attached), ...(Number.isInteger(session.bridge.port) ? { port: session.bridge.port } : {}) }
              : null,
          alive: Boolean(session.alive),
        }));
        const value = { engine, projectRoot, defaultTimeoutMs: runtime.config.defaultTimeoutMs, sessions };
        try {
          const info = resolveProject(projectRoot);
          value.project = { path: info.dir, name: info.name, mainScene: info.mainScene, valid: info.valid };
        } catch {
          /* no project at projectRoot: omit the optional field */
        }
        return value;
      },
    }),

    /* --------------------------- godot_project_init ------------------------- */
    defineGodotTool({
      name: 'godot_project_init',
      description:
        'Create a new, runnable Godot 4 project (project.godot, main scene, main script and the dsh bridge autoload) in an empty or absent directory, then run an engine import pass. Returns the project description, every file written, and the import outcome.',
      parameters: {
        directory: { type: 'string', required: true, description: 'Directory to create the project in. Must be empty or not exist yet.' },
        name: { type: 'string', description: 'Project display name (project.godot config/name). Defaults to the directory name.' },
        template: { type: 'string', enum: ['empty', '2d'], description: 'Starter template. "empty" and "2d" currently ship the same minimal 2D starter.' },
        import: { type: 'boolean', description: 'Run the Godot import pass after writing files (default true).' },
      },
      schema: PROJECT_INIT_SCHEMA,
      render: (_args, value) => [
        {
          type: 'text',
          text: `Created Godot project "${value.name}" at ${value.project.path} (${value.files.length} files, main scene ${value.mainScene}).\nImport: ${value.import.ok ? 'ok' : 'FAILED'} (exit ${value.import.exitCode ?? 'n/a'})${
            value.import.diagnostics.length > 0 ? `\n${diagnosticLines(value.import.diagnostics).join('\n')}` : ''
          }`,
        },
      ],
      async execute(args) {
        const runImport = args.import !== false;
        const result = await scaffoldProject({
          directory: /** @type {string} */ (args.directory),
          ...(typeof args.name === 'string' ? { name: args.name } : {}),
          ...(typeof args.template === 'string' ? { template: /** @type {'empty'|'2d'} */ (args.template) } : {}),
          import: runImport,
          ...(runImport ? { engine: engineFor(runtime) } : {}),
          config: runtime.config,
          timeoutMs: runtime.config.defaultTimeoutMs,
        });
        return {
          project: result.project,
          name: result.name,
          mainScene: result.mainScene,
          files: result.files,
          import: { ok: result.import.ok, exitCode: result.import.exitCode, diagnostics: result.import.diagnostics },
        };
      },
    }),

    /* ------------------------------ godot_check ----------------------------- */
    defineGodotTool({
      name: 'godot_check',
      description:
        'Parse-check a Godot project with the real engine: optionally run one import pass, then `--check-only --script` for each script (every project *.gd file up to 40 when none are named). Returns structured diagnostics with res:// file and line for every parse or engine error.',
      parameters: {
        project: { type: 'string', required: true, description: 'Project directory or the path of its project.godot.' },
        scripts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Scripts to check (res:// paths, project-relative paths or absolute paths). Omit to check every *.gd file in the project (up to 40).',
        },
        import: { type: 'boolean', description: 'Run one engine import pass before checking (default true). Pass false only when .godot/ is already warm.' },
      },
      schema: CHECK_SCHEMA,
      render: (_args, value) => {
        const errors = value.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
        const lines = [
          `${value.ok ? 'OK' : 'FAILED'}: checked ${value.checked.length} script(s), ${errors.length} error(s), ${value.diagnostics.length - errors.length} warning(s).`,
        ];
        if (value.import !== undefined) {
          lines.push(`import: ${value.import.ok ? 'ok' : 'FAILED'}${value.import.exitCode !== null && value.import.exitCode !== undefined ? ` (exit ${value.import.exitCode})` : ''}`);
        }
        if (value.truncated === true) lines.push(`note: only the first ${MAX_DISCOVERED_SCRIPTS} scripts (sorted) were checked; pass \`scripts\` to check others.`);
        if (value.diagnostics.length > 0) lines.push(diagnosticLines(value.diagnostics).join('\n'));
        return [{ type: 'text', text: lines.join('\n') }];
      },
      async execute(args) {
        const project = resolveProject(/** @type {string} */ (args.project));
        const engine = engineFor(runtime);
        const timeoutMs = runtime.config.defaultTimeoutMs;
        /** @type {Array<object>} */
        const diagnostics = [];
        let importResult;

        if (args.import !== false) {
          const run = await runOnce({
            command: [engine.path, '--headless', '--path', project.dir, '--quit'],
            cwd: project.dir,
            timeoutMs,
            label: 'godot import pass',
            project: project.dir,
          });
          const parsed = parseGodotLog(run.output, { projectRoot: project.dir });
          if (run.exitCode !== 0 && !parsed.some((diagnostic) => diagnostic.severity === 'error')) {
            parsed.push(syntheticFailure(run.timedOut ? 'the Godot import pass timed out' : `the Godot import pass exited with code ${run.exitCode}`, run.output));
          }
          importResult = { ok: run.exitCode === 0 && !parsed.some((diagnostic) => diagnostic.severity === 'error'), exitCode: run.exitCode, diagnostics: parsed };
          diagnostics.push(...parsed);
        }

        let scripts;
        let truncated = false;
        if (Array.isArray(args.scripts) && args.scripts.length > 0) {
          scripts = args.scripts.map((script) => normaliseScriptPath(script, project.dir));
        } else {
          const discovered = discoverScripts(project.dir);
          scripts = discovered.scripts;
          truncated = discovered.truncated;
        }

        for (const script of scripts) {
          const run = await runOnce({
            command: [engine.path, '--headless', '--path', project.dir, '--check-only', '--script', script],
            cwd: project.dir,
            timeoutMs,
            label: `godot check ${script}`,
            project: project.dir,
          });
          const parsed = parseGodotLog(run.output, { projectRoot: project.dir });
          if (run.exitCode !== 0 && !parsed.some((diagnostic) => diagnostic.severity === 'error')) {
            parsed.push(syntheticFailure(run.timedOut ? `checking ${script} timed out` : `checking ${script} exited with code ${run.exitCode}`, run.output, { file: script }));
          }
          diagnostics.push(...parsed);
        }

        const deduped = dedupeDiagnostics(diagnostics);
        const value = { ok: !deduped.some((diagnostic) => diagnostic.severity === 'error'), diagnostics: deduped, checked: scripts };
        if (importResult !== undefined) value.import = importResult;
        if (truncated) value.truncated = true;
        return value;
      },
    }),

    /* ------------------------------- godot_run ------------------------------ */
    defineGodotTool({
      name: 'godot_run',
      description:
        'Run a Godot project headlessly (default) or windowed: whole project, one scene or one script. Captures combined stdout+stderr, parses structured diagnostics, and can open a real-time bridge (`bridge: true`) that the running game dials out to. With `keepAlive: true` the process keeps running under a new session id so godot_bridge can drive it until godot_stop. With `keepAlive: true, bridge: true` the call waits for the game to attach (up to min(timeoutMs, 15000) ms) and returns the moment it does — windowed Vulkan/GL starts can take several seconds after the first output line. If the project has no dsh_bridge autoload it cannot attach, so the call skips that wait (returns ~1.5 s after output with `attached:false` plus a hint) instead of blocking. If the game exits before attaching, no session id is returned; the result instead carries `exitCode` plus the captured output tail.',
      parameters: {
        project: { type: 'string', required: true, description: 'Project directory or the path of its project.godot.' },
        mode: { type: 'string', enum: ['project', 'scene', 'script'], description: 'What to run: the main scene (default), one scene, or one script.' },
        scene: { type: 'string', description: 'Scene to run when mode is "scene" (res:// path or project-relative path).' },
        script: { type: 'string', description: 'Script to run when mode is "script" (res:// path or project-relative path).' },
        args: { type: 'array', items: { type: 'string' }, description: 'Extra user arguments passed to the game after a bare `--` (OS.get_cmdline_user_args()).' },
        headless: { type: 'boolean', description: 'Run with --headless (default true). Set false for a real window.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds (defaults to the plugin defaultTimeoutMs, 20000). Kills a non-keepAlive run that does not exit in time; for keepAlive + bridge it caps the attach wait at 15000 ms.' },
        keepAlive: { type: 'boolean', description: 'Keep the process running after the initial wait and return a session id (default false). With bridge: true and a dsh_bridge autoload this waits for the game to attach (up to 15 s) before returning; if the game dies first the result has no session id but has exitCode and output. Without the autoload it returns after output settles with attached:false and a hint.' },
        bridge: { type: 'boolean', description: 'Open a loopback bridge listener and append --dsh-bridge=127.0.0.1:<port> after `--` so the game can attach (default false). The game connects back out; windowed starts may connect a few seconds after their first output.' },
      },
      schema: RUN_SCHEMA,
      render: (_args, value) => {
        const bridgeText =
          value.bridge === null ? 'bridge: off' : `bridge: ${value.bridge.attached ? 'attached' : 'detached'}${value.bridge.port !== undefined ? ` on 127.0.0.1:${value.bridge.port}` : ''}`;
        const exitText = value.timedOut ? 'timed out (process killed)' : value.exitCode !== undefined && value.exitCode !== null ? `exit ${value.exitCode}` : 'running';
        const sessionText = value.session !== undefined ? `session ${value.session} ` : '';
        const errors = value.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
        const parts = [`godot_run: ${sessionText}pid=${value.pid} ${exitText}; ${bridgeText}; ${errors.length} error(s)`];
        if (value.diagnostics.length > 0) parts.push(diagnosticLines(value.diagnostics).join('\n'));
        if (value.output.length > 0) {
          const tail = value.output.length > 6000 ? `…${value.output.slice(-6000)}` : value.output;
          parts.push(`output:\n${tail}`);
        }
        return [{ type: 'text', text: parts.join('\n') }];
      },
      async execute(args) {
        const project = resolveProject(/** @type {string} */ (args.project));
        const engine = engineFor(runtime);
        const mode = typeof args.mode === 'string' ? args.mode : 'project';
        const timeoutMs = timeoutFor(args.timeoutMs);
        const headless = args.headless !== false;

        const command = [engine.path];
        if (headless) command.push('--headless');
        command.push('--path', project.dir);
        if (mode === 'scene') {
          if (typeof args.scene !== 'string' || args.scene.trim().length === 0) {
            throw new Error('godot_run with mode "scene" needs a `scene` argument (res:// path or project-relative path).');
          }
          command.push(normaliseScriptPath(args.scene, project.dir));
        } else if (mode === 'script') {
          if (typeof args.script !== 'string' || args.script.trim().length === 0) {
            throw new Error('godot_run with mode "script" needs a `script` argument (res:// path or project-relative path).');
          }
          command.push('--script', normaliseScriptPath(args.script, project.dir));
        }

        const userArgs = Array.isArray(args.args) ? args.args.map((entry) => String(entry)) : [];
        /** @type {BridgeServer|null} */
        let bridge = null;
        if (args.bridge === true) {
          bridge = new BridgeServer();
          await bridge.start();
          userArgs.push(`--dsh-bridge=127.0.0.1:${bridge.port}`);
        }
        if (userArgs.length > 0) command.push('--', ...userArgs);

        let session;
        try {
          session = runtime.sessions.start({
            command,
            cwd: project.dir,
            env: process.env,
            label: `godot_run ${path.basename(project.dir)}`,
            project: project.dir,
          });
        } catch (error) {
          bridge?.close();
          throw error;
        }
        if (bridge !== null) session.bridge = bridge;
        const sessionPid = Number.isInteger(session.pid) ? session.pid : 0;

        if (args.keepAlive === true) {
          if (bridge !== null) {
            const outcome = await waitForKeepAliveRun(session, bridge, {
              projectDir: project.dir,
              hasBridgeAutoload: projectHasBridgeAutoload(project.dir),
              timeoutMs: Math.min(timeoutMs, 15000),
            });
            const engineOutput = session.readOutput();
            const hintedOutput =
              outcome.hint === null
                ? engineOutput
                : `${engineOutput}${engineOutput.length > 0 && !engineOutput.endsWith('\n') ? '\n' : ''}${outcome.hint}\n`;
            const diagnostics = parseGodotLog(engineOutput, { projectRoot: project.dir });
            const bridgeState = { attached: Boolean(bridge.attached), ...(Number.isInteger(bridge.port) ? { port: bridge.port } : {}) };
            if (outcome.spawnError) {
              const tail = engineOutput.trim();
              await runtime.sessions.remove(session.id);
              throw new Error(
                `cannot start Godot engine "${engine.path}": ${outcome.spawnError.message}${tail.length > 0 ? `\noutput:\n${tail.slice(-4000)}` : ''}`,
              );
            }
            if (outcome.dead) {
              // The game exited before attaching: not a live session. Surface the
              // exit code and output tail instead of a normal-looking detached session.
              await runtime.sessions.remove(session.id);
              bridge.close();
              session.bridge = null;
              const deadValue = { pid: sessionPid, command, timedOut: false, bridge: { attached: false, ...(Number.isInteger(bridge.port) ? { port: bridge.port } : {}) }, output: hintedOutput, diagnostics };
              if (outcome.exitCode !== null) deadValue.exitCode = outcome.exitCode;
              return deadValue;
            }
            // `no-autoload` and `attach-timeout` keep the session alive so the
            // caller can still read output and stop it; both carry a hint line.
            return {
              session: session.id,
              pid: sessionPid,
              command,
              timedOut: Boolean(outcome.timedOut),
              bridge: bridgeState,
              output: hintedOutput,
              diagnostics,
            };
          }
          await settleForOutput(session);
          if (session.spawnError) {
            await runtime.sessions.remove(session.id);
            throw new Error(`cannot start Godot engine "${engine.path}": ${session.spawnError.message}`);
          }
          const output = session.readOutput();
          return {
            session: session.id,
            pid: sessionPid,
            command,
            timedOut: false,
            bridge: null,
            output,
            diagnostics: parseGodotLog(output, { projectRoot: project.dir }),
          };
        }

        const info = await session.waitForExit(timeoutMs);
        if (info.timedOut) await session.stop();
        const output = session.readOutput();
        const spawnError = session.spawnError;
        const bridgeState = bridge !== null ? { attached: Boolean(bridge.attached), ...(Number.isInteger(bridge.port) ? { port: bridge.port } : {}) } : null;
        await runtime.sessions.remove(session.id);
        if (bridge !== null) {
          bridge.close();
          session.bridge = null;
        }
        if (spawnError) throw new Error(`cannot start Godot engine "${engine.path}": ${spawnError.message}`);
        const value = {
          pid: sessionPid,
          command,
          timedOut: info.timedOut,
          bridge: bridgeState,
          output,
          diagnostics: parseGodotLog(output, { projectRoot: project.dir }),
        };
        if (info.exitCode !== null && info.exitCode !== undefined) value.exitCode = info.exitCode;
        return value;
      },
    }),

    /* ------------------------------ godot_bridge ---------------------------- */
    defineGodotTool({
      name: 'godot_bridge',
      description:
        'Send one command to the running game of a live session over the dsh bridge and return its reply. Commands: ping, tree, node, node_set, node_call, action, pause, reload, frames, screenshot, quit. `pause` takes {"paused": true|false} and freezes or resumes the whole scene tree; ping reports the current paused flag. `reload` reloads the currently active scene in place (the toolbar refresh button) and resumes a paused tree. The session must have been started with godot_run { keepAlive: true, bridge: true } or by the toolbar run button. For `tree`, `args.depth` is the number of descendant levels below the `/root` viewport node: depth 1 returns /root plus its direct children (autoload Bridge, main scene node …), depth 2 also returns their children (e.g. Player under Main), depth 3 also grandchildren, and so on (default 4).',
      parameters: {
        session: { type: 'string', required: true, description: 'Session id returned by godot_run with keepAlive: true.' },
        command: { type: 'string', required: true, description: 'Bridge command: ping | tree | node | node_set | node_call | action | frames | screenshot | quit.' },
        args: { type: 'json', description: 'Command arguments object, e.g. {"path": "/root/Main"} for node, {"depth": 2} for tree, {"count": 3} for frames; {} for ping.' },
      },
      schema: BRIDGE_SCHEMA,
      render: (_args, value) => {
        if (value.ok !== true) return [{ type: 'text', text: `bridge error: ${value.error ?? 'unknown error'}` }];
        if (value.result === undefined || value.result === null) return [{ type: 'text', text: 'ok' }];
        const text = JSON.stringify(value.result, null, 2);
        return [{ type: 'text', text: text.length > 8000 ? `${text.slice(0, 8000)}\n… (display truncated; the full value is in the tool result)` : text }];
      },
      async execute(args) {
        const id = String(args.session).trim();
        const session = runtime.sessions.get(id);
        if (session === undefined) {
          const active = runtime.sessions.list().map((entry) => entry.id);
          throw new Error(
            `godot_bridge: unknown session "${id}".${active.length > 0 ? ` Active sessions: ${active.join(', ')}.` : ''} Start one with godot_run { keepAlive: true, bridge: true }.`,
          );
        }
        const server = session.bridge;
        if (server === null || server === undefined) {
          throw new Error(`godot_bridge: session "${id}" has no bridge. Start it with godot_run { bridge: true, keepAlive: true }.`);
        }
        if (!server.attached) {
          throw new Error(`godot_bridge: session "${id}" bridge is not attached (the game has not connected yet or has exited). Check godot_status for the session state.`);
        }
        const bridgeArgs = args.args !== null && typeof args.args === 'object' && !Array.isArray(args.args) ? args.args : {};
        const reply = await server.request(String(args.command).trim(), bridgeArgs);
        if (reply.ok === true) return { ok: true, result: reply.result === undefined ? null : reply.result };
        return { ok: false, error: reply.error ?? 'bridge request failed' };
      },
    }),

    /* ------------------------------- godot_stop ----------------------------- */
    defineGodotTool({
      name: 'godot_stop',
      description:
        'Stop live godot_run sessions and close their bridges. Omit `session` to stop every session this plugin owns (the plugin also does this automatically when it unloads).',
      parameters: {
        session: { type: 'string', description: 'Session id to stop. Omit to stop all live sessions.' },
      },
      schema: STOP_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.stopped.length === 0 ? 'no live sessions to stop' : `stopped: ${value.stopped.join(', ')}` }],
      async execute(args) {
        if (typeof args.session === 'string' && args.session.trim().length > 0) {
          const id = args.session.trim();
          const session = runtime.sessions.get(id);
          if (session === undefined) {
            const active = runtime.sessions.list().map((entry) => entry.id);
            throw new Error(
              `godot_stop: unknown session "${id}".${active.length > 0 ? ` Active sessions: ${active.join(', ')}.` : ' There are no live sessions.'} Call godot_status to list sessions.`,
            );
          }
          closeSessionBridge(session);
          await runtime.sessions.remove(id);
          return { stopped: [id] };
        }
        const sessions = runtime.sessions.list();
        for (const session of sessions) closeSessionBridge(session);
        const stopped = await runtime.sessions.stopAll();
        return { stopped };
      },
    }),
  ];
}
