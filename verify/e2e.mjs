/**
 * Independent end-to-end verification of the @local/dsh-godot plugin.
 *
 * Contract: D:\DeepSeekHarness\plugins\CONTRACT.md (read it before changing this).
 *
 * This suite drives the REAL plugin modules (godot-agent/index.js + src/*.js)
 * through a fake Cordis context and the REAL Godot 4.7.2 console engine. It does
 * not import any harness package and has zero npm dependencies. It only writes
 * under verify/ (all scratch state in verify/tmp/e2e).
 *
 * Run:  node verify/e2e.mjs
 * Exit: 0 = every check passed; 1 = at least one check failed or an unexpected fault.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply, inject } from '../godot-agent/index.js';
import * as pluginModule from '../godot-agent/index.js';
import {
  ENGINE_NOT_FOUND_MESSAGE,
  clearEngineProbeCache,
  deriveConsolePath,
  discoverEngine,
} from '../godot-agent/src/engine.js';
import { parseGodotLog, stripEngineHeader } from '../godot-agent/src/gdparse.js';
import { discoverScripts, normaliseScriptPath } from '../godot-agent/src/project.js';
import { MAX_OUTPUT_BYTES, captureSync, createSessionRegistry } from '../godot-agent/src/runner.js';
import { loadHarnessSchema } from './harness-schema.mjs';

/* -------------------------------------------------------------------------- */
/* Environment (CONTRACT §0)                                                   */
/* -------------------------------------------------------------------------- */

const VERIFY_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(VERIFY_DIR, '..');
const PLUGIN_DIR = path.join(WORKSPACE, 'godot-agent');
const TMP_DIR = path.join(VERIFY_DIR, 'tmp');
const RUN_DIR = path.join(TMP_DIR, 'e2e');
const FRESH_DIR = path.join(RUN_DIR, 'project');
const DEMO_SRC = path.join(WORKSPACE, 'demo');
const DEMO_COPY = path.join(RUN_DIR, 'demo');
const ENGINE = 'D:\\Software\\Godot_v4.7.2-stable_win64.exe\\Godot_v4.7.2-stable_win64_console.exe';
const ENGINE_GUI = ENGINE.replace(/_console\.exe$/i, '.exe');
const ENGINE_DIR = path.dirname(ENGINE);
const EXPECTED_TOOLS = ['godot_status', 'godot_project_init', 'godot_check', 'godot_run', 'godot_bridge', 'godot_stop'];
const DEFAULT_TIMEOUT_MS = 20000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------- */
/* Result collection                                                           */
/* -------------------------------------------------------------------------- */

/** @type {Array<{id: string, group: string, title: string, pass: boolean, detail: string}>} */
const results = [];
let currentGroup = '';

function beginGroup(name) {
  currentGroup = name;
  console.log(`\n=== ${name} ===`);
}

async function check(id, title, fn) {
  try {
    const detail = await fn();
    results.push({ id, group: currentGroup, title, pass: true, detail: detail ?? '' });
    console.log(`PASS ${id} ${title}${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ id, group: currentGroup, title, pass: false, detail: message });
    console.log(`FAIL ${id} ${title} — ${message}`);
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Fake Cordis context (CONTRACT §1/§6: ctx.tools.register + ctx.effect)       */
/* -------------------------------------------------------------------------- */

function createFakeCordis() {
  /** @type {Array<object>} */
  const tools = [];
  /** @type {Array<() => void>} */
  const disposers = [];
  /** @type {string[]} */
  const effectLabels = [];
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {
          const index = tools.indexOf(definition);
          if (index >= 0) tools.splice(index, 1);
        };
      },
    },
    effect(execute, label) {
      effectLabels.push(typeof label === 'string' ? label : '');
      const disposer = execute();
      if (disposer !== undefined && disposer !== null && typeof disposer !== 'function') {
        throw new TypeError(`ctx.effect callback returned ${typeof disposer}, expected a disposer function or undefined`);
      }
      disposers.push(typeof disposer === 'function' ? disposer : () => {});
    },
  };
  let disposed = false;
  function disposeAll() {
    if (disposed) return;
    disposed = true;
    const pending = disposers.splice(0).reverse();
    let firstError;
    for (const dispose of pending) {
      try {
        dispose();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }
  return { ctx, tools, disposers, effectLabels, disposeAll, isDisposed: () => disposed };
}

/* -------------------------------------------------------------------------- */
/* Small OS/process helpers (never rely on piped stdio: sandbox may deny it)   */
/* -------------------------------------------------------------------------- */

/** Capture a child's combined output via an inherited temp-file descriptor. */
function captureExternal(exe, argv, timeoutMs = 30000) {
  const capturePath = path.join(os.tmpdir(), `verify-e2e-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  const fd = fs.openSync(capturePath, 'w');
  try {
    const result = spawnSync(exe, argv, { timeout: timeoutMs, windowsHide: true, stdio: ['ignore', fd, fd] });
    const text = fs.readFileSync(capturePath, 'utf8');
    return { status: result.status, text, error: result.error };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(capturePath);
    } catch {
      /* ignore */
    }
  }
}

/** All Godot PIDs currently running on the machine (tasklist via file capture). */
function listGodotPids() {
  const result = captureExternal('tasklist', ['/FO', 'CSV', '/NH']);
  if (result.error !== undefined) return { pids: [], error: result.error.message };
  const pids = [];
  for (const line of result.text.split(/\r?\n/)) {
    const match = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (match && /godot/i.test(match[1])) pids.push({ pid: Number(match[2]), image: match[1] });
  }
  return { pids, error: null };
}

/** True when the pid no longer exists. */
function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'EPERM') return true; // exists, access denied
    return false;
  }
}

async function waitForPidGone(pid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidExists(pid)) return true;
    await delay(100);
  }
  return !pidExists(pid);
}

/** Best-effort hard kill for cleanup of anything the suite leaked. */
function hardKill(pid) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* ignore */
  }
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    /* ignore */
  }
}

/* -------------------------------------------------------------------------- */
/* Assertions shared by groups                                                 */
/* -------------------------------------------------------------------------- */

/** Render contract: render(args, value) -> [{type:'text', text:string}] (CONTRACT §2). */
function assertRender(tool, args, value) {
  assert.equal(typeof tool.output.render, 'function', `${tool.name}: output.render must be a function`);
  const blocks = tool.output.render(args, value);
  assert.ok(Array.isArray(blocks), `${tool.name}: output.render must return an array`);
  assert.ok(blocks.length > 0, `${tool.name}: output.render returned no blocks`);
  for (const block of blocks) {
    assert.equal(block.type, 'text', `${tool.name}: render block type must be "text" (got ${JSON.stringify(block.type)})`);
    assert.equal(typeof block.text, 'string', `${tool.name}: render block text must be a string`);
  }
  return `${blocks.length} render block(s)`;
}

/** Value must survive a JSON round-trip unchanged (CONTRACT §2 lossless JSON). */
function assertLosslessJson(label, value) {
  const roundTripped = JSON.parse(JSON.stringify(value));
  assert.deepEqual(roundTripped, value, `${label} is not lossless JSON`);
}

/** Validate plain JSON Schema for `parameters`; never the inline `required:true` author form. */
function findInlineRequired(node, at, found) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required' && value === true) found.push(at);
    findInlineRequired(value, `${at}.${key}`, found);
  }
}

function assertParametersAreJsonSchema(name, parameters) {
  assert.equal(typeof parameters, 'object', `${name}: parameters must be an object`);
  assert.ok(parameters !== null && !Array.isArray(parameters), `${name}: parameters must be a plain object`);
  assert.equal(parameters.type, 'object', `${name}: parameters.type must be "object" (got ${JSON.stringify(parameters.type)})`);
  assert.equal(typeof parameters.properties, 'object', `${name}: parameters.properties must be an object`);
  assert.ok(parameters.properties !== null && !Array.isArray(parameters.properties), `${name}: parameters.properties must be a plain object`);
  const inline = [];
  findInlineRequired(parameters, name, inline);
  assert.equal(inline.length, 0, `${name}: inline author spec leaked into model schema at ${inline.join(', ')}`);
  if (parameters.required !== undefined) {
    assert.ok(Array.isArray(parameters.required), `${name}: parameters.required must be an array`);
    for (const key of parameters.required) {
      assert.equal(typeof key, 'string', `${name}: parameters.required entries must be strings`);
      assert.ok(Object.hasOwn(parameters.properties, key), `${name}: parameters.required names unknown property "${key}"`);
    }
  }
  if (parameters.additionalProperties !== undefined) {
    assert.equal(typeof parameters.additionalProperties, 'boolean', `${name}: additionalProperties must be boolean`);
  }
  for (const [key, schema] of Object.entries(parameters.properties)) {
    assert.equal(typeof schema, 'object', `${name}.${key}: property schema must be an object`);
    assert.ok(schema !== null && !Array.isArray(schema), `${name}.${key}: property schema must be a plain object`);
    assert.notEqual(schema.required, true, `${name}.${key}: property still uses inline required:true`);
  }
  assertLosslessJson(`${name}.parameters`, parameters);
  return `${Object.keys(parameters.properties).length} properties, required=${JSON.stringify(parameters.required ?? [])}`;
}

/** Capture a thrown Error and assert it is actionable, not a stack-trace dump. */
async function assertActionableError(fn, predicate, label) {
  let caught;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== undefined, `${label}: expected an Error to be thrown, nothing was`);
  assert.ok(caught instanceof Error, `${label}: thrown value is not an Error (got ${typeof caught})`);
  assert.equal(caught.name, 'Error', `${label}: expected plain Error, got ${caught.name}`);
  assert.equal(typeof caught.message, 'string', `${label}: Error has no message`);
  assert.ok(caught.message.length > 20, `${label}: message is not actionable: ${JSON.stringify(caught.message)}`);
  assert.ok(!/\n\s+at\s+\S+ \(/.test(caught.message), `${label}: message contains a stack trace`);
  if (predicate !== undefined) predicate(caught.message);
  return caught.message;
}

/* -------------------------------------------------------------------------- */
/* Scratch filesystem helpers                                                  */
/* -------------------------------------------------------------------------- */

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function writeFile(projectDir, relative, content) {
  const absolute = path.join(projectDir, ...relative.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
  return absolute;
}

function snapshotDir(root, { skip = [] } = {}) {
  const entries = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (skip.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        entries.push(`dir:${relative}`);
        walk(full);
      } else if (entry.isFile()) {
        const stat = fs.statSync(full);
        entries.push(`file:${relative}:${stat.size}:${stat.mtimeMs}`);
      }
    }
  };
  walk(root);
  return entries;
}

/** All runtime .js files of the plugin (index.js + src/**), relative to the package root. */
function listPluginJsFiles() {
  const files = ['index.js'];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path.relative(PLUGIN_DIR, full).replace(/\\/g, '/'));
    }
  };
  walk(path.join(PLUGIN_DIR, 'src'));
  return files.sort();
}

/* -------------------------------------------------------------------------- */
/* Bridge fixture content (written into a COPY of demo/, never demo/ itself)   */
/* -------------------------------------------------------------------------- */

const SELF_QUIT_GD = `extends Node


func _ready() -> void:
	print("EXIT_SCENE_READY")
	get_tree().quit(3)
`;

const SELF_QUIT_TSCN = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://verify_scene.gd" id="1"]

[node name="VerifyQuit" type="Node"]
script = ExtResource("1")
`;

/* Injected bug fixtures (line numbers asserted below) ---------------------- */

// Parse error is reported at line 4 (the incomplete variable initialiser).
const PARSE_BUG_GD = `extends Node

func _ready() -> void:
	var x: int = 
	print(x)
`;

// Runtime error is reported at line 6 (out-of-bounds array read); the print on
// line 4 proves output before the error is captured.
const RUNTIME_BUG_GD = `extends Node

func _ready() -> void:
	print("RUNTIME_BUG_READY")
	var items: Array = []
	print(items[5])
	print("AFTER_CALL")
`;

const RUNTIME_BUG_TSCN = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://bugs/runtime_bug.gd" id="1"]

[node name="RuntimeBug" type="Node"]
script = ExtResource("1")
`;

const FIXED_BUG_GD = `extends Node

func _ready() -> void:
	pass
`;

/* -------------------------------------------------------------------------- */
/* Suite                                                                       */
/* -------------------------------------------------------------------------- */

/** @type {Array<{pid: number, label: string}>} */
const spawnedPids = [];
let fake = null;
let byName = {};
let harness = null;
let baselineGodot = [];
let demoSnapshotBefore = [];
const state = {};

async function groupA() {
  beginGroup('A. Registration surface (CONTRACT §1, §2)');

  fake = createFakeCordis();
  await check('A1', 'apply() registers exactly the six contract tools in order', () => {
    assert.deepEqual(inject, ['tools'], 'index.js must export inject = ["tools"]');
    apply(fake.ctx, { enginePath: ENGINE, projectRoot: FRESH_DIR, defaultTimeoutMs: DEFAULT_TIMEOUT_MS });
    assert.equal(fake.tools.length, 6, `expected 6 registered tools, got ${fake.tools.length}`);
    assert.deepEqual(fake.tools.map((tool) => tool.name), EXPECTED_TOOLS, 'tool names/order differ from CONTRACT §2');
    byName = Object.fromEntries(fake.tools.map((tool) => [tool.name, tool]));
    return fake.tools.map((tool) => tool.name).join(', ');
  });

  await check('A2', 'every registration has name/description/parameters/output.schema/output.render/execute', () => {
    for (const tool of fake.tools) {
      assert.equal(typeof tool.name, 'string');
      assert.ok(tool.description.length > 40, `${tool.name}: description too short to guide a model`);
      assert.equal(typeof tool.parameters, 'object');
      assert.equal(typeof tool.output, 'object');
      assert.equal(typeof tool.output.schema, 'object');
      assert.equal(typeof tool.output.render, 'function');
      assert.equal(typeof tool.execute, 'function');
    }
    return '6 definitions complete';
  });

  await check('A3', 'parameters are plain JSON Schema (no inline required:true author spec)', () => {
    const summaries = [];
    for (const tool of fake.tools) summaries.push(`${tool.name}: ${assertParametersAreJsonSchema(tool.name, tool.parameters)}`);
    const requiredByContract = {
      godot_project_init: ['directory'],
      godot_check: ['project'],
      godot_run: ['project'],
      godot_bridge: ['session', 'command'],
    };
    for (const [name, required] of Object.entries(requiredByContract)) {
      for (const key of required) assert.ok((byName[name].parameters.required ?? []).includes(key), `${name}: contract-required arg "${key}" missing from top-level required`);
    }
    return summaries.join(' | ').slice(0, 400);
  });

  harness = await loadHarnessSchema();
  const schemaEvidence = harness.mode === 'installed-harness'
    ? `installed harness (${path.basename(harness.evidence.asar)}, sha256 ${harness.evidence.sha256.slice(0, 12)}…)`
    : `replicated rules (${harness.evidence.reason})`;
  state.schemaEvidence = schemaEvidence;

  for (const tool of fake.tools) {
    await check(`A4-${tool.name}`, `output.schema of ${tool.name} is accepted by DSH assertSupportedJsonSchema`, () => {
      harness.assertSupportedJsonSchema(tool.output.schema);
      assertLosslessJson(`${tool.name}.output.schema`, tool.output.schema);
      return schemaEvidence;
    });
  }

  await check('A5', 'fake ctx effect/disposer wiring covers 6 tools + unload cleanup', () => {
    assert.equal(fake.tools.length, 6);
    assert.equal(fake.effectLabels.length, 7, `expected 7 ctx.effect calls (1 runtime cleanup + 6 tools), got ${fake.effectLabels.length}`);
    assert.equal(fake.disposers.length, 7, 'every ctx.effect must contribute a disposer');
    assert.ok(fake.effectLabels[0].includes('stop child processes'), 'runtime cleanup effect should be registered first');
    return `${fake.effectLabels.length} effects`;
  });

  await check('A6', 'index.js exports apply + inject only (no export const Config, CONTRACT §1)', () => {
    assert.equal(typeof pluginModule.apply, 'function');
    assert.deepEqual(pluginModule.inject, ['tools']);
    assert.equal(Object.hasOwn(pluginModule, 'Config'), false, 'v1 must not export a Config schema');
    assert.equal(Object.hasOwn(pluginModule, 'default'), false, 'no default export expected');
    return `exports: ${Object.keys(pluginModule).sort().join(', ')}`;
  });

  await check('A7', 'package.json declares the installable bundle metadata and no dependencies (CONTRACT §1, §7)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'));
    assert.equal(pkg.name, '@local/dsh-godot');
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.main, './index.js');
    assert.equal(pkg.exports['.'], './index.js');
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
    assert.equal(pkg.dependencies, undefined, 'bundle must not declare npm dependencies');
    assert.equal(pkg.devDependencies, undefined, 'bundle must not declare devDependencies');
    for (const required of ['index.js', 'cordis.patch.yml', 'src', 'templates', 'locale/*.json', 'icon.svg']) {
      assert.ok(pkg.files.includes(required), `files[] must ship ${required}`);
    }
    return `${pkg.name}@${pkg.version}, 0 dependencies`;
  });

  await check('A8', 'cordis.patch.yml inserts the dsh-godot row and documents the config keys', () => {
    const text = fs.readFileSync(path.join(PLUGIN_DIR, 'cordis.patch.yml'), 'utf8');
    assert.match(text, /insert:/);
    assert.match(text, /id:\s*dsh-godot/);
    assert.match(text, /name:\s*'@local\/dsh-godot'/);
    for (const key of ['enginePath', 'projectRoot', 'defaultTimeoutMs']) {
      assert.ok(text.includes(key), `patch comment must document config key ${key}`);
    }
    return 'insert row documented';
  });

  await check('A9', 'locale/en.json and locale/zh.json carry meta.title + meta.description (CONTRACT §7)', () => {
    for (const locale of ['en', 'zh']) {
      const data = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'locale', `${locale}.json`), 'utf8'));
      assert.equal(typeof data.meta?.title, 'string', `${locale}.json meta.title missing`);
      assert.equal(typeof data.meta?.description, 'string', `${locale}.json meta.description missing`);
      assert.ok(data.meta.title.length > 0 && data.meta.description.length > 20, `${locale}.json meta text too short`);
    }
    return 'en + zh metadata present';
  });

  await check('A10', 'runtime sources import no harness packages and never shell-concatenate commands (CONTRACT §7)', () => {
    const files = listPluginJsFiles();
    const offenders = [];
    const allowedChildProcessImports = new Set(['spawn', 'spawnSync']);
    const childProcessImports = [];
    for (const relative of files) {
      const text = fs.readFileSync(path.join(PLUGIN_DIR, ...relative.split('/')), 'utf8');
      for (const match of text.matchAll(/(?:from\s+|import\s+)['"]([^'"]+)['"]/g)) {
        const specifier = match[1];
        if (!specifier.startsWith('.') && !specifier.startsWith('node:')) offenders.push(`${relative}: imports "${specifier}"`);
      }
      for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]node:child_process['"]/g)) {
        const names = match[1].split(',').map((entry) => entry.trim().split(/\s+as\s+/)[0].trim()).filter((entry) => entry.length > 0);
        childProcessImports.push(...names);
        for (const name of names) if (!allowedChildProcessImports.has(name)) offenders.push(`${relative}: imports child_process.${name}`);
      }
      if (/import\s+\*\s+as\s+\w+\s+from\s*['"]node:child_process['"]/.test(text)) offenders.push(`${relative}: namespace-imports node:child_process`);
      if (/import\s+\w+\s+from\s*['"]node:child_process['"]/.test(text)) offenders.push(`${relative}: default-imports node:child_process`);
      // Real shell-execution APIs only: RegExp.prototype.exec() is not child_process.
      if (/child_process\s*\.\s*(?:exec|execFile|fork)\s*\(/.test(text)) offenders.push(`${relative}: calls child_process.exec/execFile/fork`);
      if (/(?:^|[^.\w])execSync\s*\(|(?:^|[^.\w])execFileSync\s*\(/m.test(text)) offenders.push(`${relative}: calls execSync/execFileSync`);
      if (/(?:^|[^.\w])(?:require)\s*\(\s*['"]node:child_process['"]/.test(text)) offenders.push(`${relative}: require()s child_process`);
      if (/\bshell\s*:\s*true/.test(text)) offenders.push(`${relative}: spawns with shell:true`);
    }
    assert.equal((/(?:^|[^.\w])require\s*\(/m.test(files.map((relative) => fs.readFileSync(path.join(PLUGIN_DIR, ...relative.split('/')), 'utf8')).join('\n'))), false, 'plugin runtime must be ESM (no require())');
    assert.deepEqual(offenders, [], offenders.join('; '));
    assert.deepEqual([...new Set(childProcessImports)].sort(), ['spawn', 'spawnSync'], `child_process imports should be exactly spawn/spawnSync, got ${childProcessImports.join(',')}`);
    return `${files.length} js files; child_process {spawn,spawnSync} with argv arrays only`;
  });
}

async function groupB() {
  beginGroup('B. Engine discovery (CONTRACT §5)');

  await check('B1', 'enginePath file resolves and probes Godot 4.7.2 console build', () => {
    clearEngineProbeCache();
    const engine = discoverEngine({ enginePath: ENGINE });
    assert.equal(engine.path, ENGINE);
    assert.match(engine.version, /^4\.7\.2/, `unexpected version ${engine.version}`);
    assert.equal(engine.console, true, 'console build must be detected');
    state.engine = engine;
    return `${engine.version} console=${engine.console}`;
  });

  await check('B2', 'enginePath directory prefers the *_console.exe inside it', () => {
    const engine = discoverEngine({ enginePath: ENGINE_DIR });
    assert.equal(engine.path, ENGINE);
    return path.basename(engine.path);
  });

  await check('B3', 'GUI executable path is switched to the sibling console build', () => {
    assert.ok(fs.existsSync(ENGINE_GUI), `expected GUI build at ${ENGINE_GUI}`);
    assert.equal(deriveConsolePath(ENGINE_GUI), ENGINE);
    const engine = discoverEngine({ enginePath: ENGINE_GUI });
    assert.equal(engine.path, ENGINE);
    return `${path.basename(ENGINE_GUI)} -> ${path.basename(engine.path)}`;
  });

  await check('B4', 'no engine found -> actionable CONTRACT §5 message', async () => {
    await assertActionableError(
      () => discoverEngine({ enginePath: 'D:\\does-not-exist\\godot.exe' }, { env: {}, platform: 'win32', pathNames: [], scanRoots: [] }),
      (message) => {
        assert.ok(message.startsWith(ENGINE_NOT_FOUND_MESSAGE), `message must start with the contract text, got: ${message.slice(0, 120)}`);
        assert.match(message, /enginePath|GODOT_BIN/);
        assert.ok(!/ERR_|ENOENT/.test(message), 'message leaks a raw errno');
      },
      'engine not found',
    );
    return 'CONTRACT §5 text present';
  });

  await check('B5', 'GODOT_BIN environment variable is honoured (CONTRACT §5 step 2)', () => {
    clearEngineProbeCache();
    const engine = discoverEngine({}, {
      env: { GODOT_BIN: ENGINE, PATH: '' },
      platform: 'win32',
      pathNames: [],
      scanRoots: [],
    });
    assert.equal(engine.path, ENGINE);
    return 'GODOT_BIN resolved';
  });

  await check('B6', 'runner capture/session API works under the sandbox (file-capture fallback) and caps output at 200 KB', async () => {
    assert.equal(MAX_OUTPUT_BYTES, 200 * 1024, 'CONTRACT §2 output cap is 200 KB');
    const probe = captureSync(ENGINE, ['--version'], { timeoutMs: 15000 });
    assert.equal(probe.exitCode, 0, `--version exited ${probe.exitCode}`);
    // `godot --version` prints only the version string (e.g. 4.7.2.stable.official.ed1daf0bf).
    assert.match(`${probe.stdout}${probe.stderr}`.trim(), /^4\.7\.2\./, 'captureSync did not capture the --version line');
    const registry = createSessionRegistry();
    const session = registry.start({ command: [ENGINE, '--version'] });
    assert.equal(typeof session.waitForExit, 'function');
    assert.equal(typeof session.waitForOutput, 'function');
    assert.equal(typeof session.stop, 'function');
    assert.equal(typeof session.readOutput, 'function');
    const info = await session.waitForExit(15000);
    assert.equal(info.timedOut, false, 'session --version timed out');
    assert.equal(info.exitCode, 0);
    assert.match(session.readOutput().trim(), /^4\.7\.2\./, 'session readOutput did not capture the --version line');
    await registry.stopAll();
    return 'captureSync + Session API verified (4.7.2.x)';
  });
}

async function groupC() {
  beginGroup('C. Fresh project flow: init -> status -> check -> run -> stop (CONTRACT §2)');

  rmrf(RUN_DIR);
  fs.mkdirSync(RUN_DIR, { recursive: true });

  const init = byName.godot_project_init;
  await check('C1', 'godot_project_init scaffolds a complete runnable project and imports it', async () => {
    const args = { directory: FRESH_DIR, name: 'VerifyFresh', template: '2d' };
    const value = await init.execute(args);
    assert.equal(value.project.path, FRESH_DIR);
    assert.equal(value.name, 'VerifyFresh');
    assert.equal(value.mainScene, 'res://main.tscn');
    assert.equal(value.project.valid, true);
    for (const expected of ['project.godot', 'main.tscn', 'main.gd', 'addons/dsh_bridge/dsh_bridge.gd']) {
      assert.ok(value.files.includes(expected), `missing scaffolded file ${expected} in ${JSON.stringify(value.files)}`);
      assert.ok(fs.existsSync(path.join(FRESH_DIR, ...expected.split('/'))), `scaffolded file missing on disk: ${expected}`);
    }
    assert.ok(!value.files.some((file) => file.endsWith('.md')), 'template README.md must not be copied into the project');
    assert.ok(!fs.existsSync(path.join(FRESH_DIR, 'README.md')), 'README.md must not exist in the project');
    assert.equal(value.import.ok, true, `import pass failed: ${JSON.stringify(value.import.diagnostics)}`);
    assert.equal(value.import.exitCode, 0);
    assert.deepEqual(value.import.diagnostics.filter((d) => d.severity === 'error'), []);
    const projectGodot = fs.readFileSync(path.join(FRESH_DIR, 'project.godot'), 'utf8');
    assert.match(projectGodot, /config\/name="VerifyFresh"/);
    assert.match(projectGodot, /\[autoload\]/);
    assert.match(projectGodot, /Bridge="\*res:\/\/addons\/dsh_bridge\/dsh_bridge\.gd"/);
    assert.match(fs.readFileSync(path.join(FRESH_DIR, 'main.gd'), 'utf8'), /STARTER_READY/);
    assertRender(init, args, value);
    return `${value.files.length} files, import exit ${value.import.exitCode}`;
  });

  await check('C2', 'godot_status reports engine, projectRoot, configured project and no sessions', async () => {
    const value = await byName.godot_status.execute({});
    assert.equal(value.engine.path, ENGINE);
    assert.match(value.engine.version, /^4\.7\.2/);
    assert.equal(value.engine.console, true);
    assert.equal(value.projectRoot, FRESH_DIR);
    assert.equal(value.defaultTimeoutMs, DEFAULT_TIMEOUT_MS);
    assert.deepEqual(value.sessions, []);
    assert.equal(value.project.path, FRESH_DIR);
    assert.equal(value.project.name, 'VerifyFresh');
    assert.equal(value.project.mainScene, 'res://main.tscn');
    assert.equal(value.project.valid, true);
    assertRender(byName.godot_status, {}, value);
    return `engine ${value.engine.version}, project ${value.project.name}, sessions ${value.sessions.length}`;
  });

  await check('C3', 'godot_check passes on the freshly scaffolded project (import + every script)', async () => {
    const args = { project: FRESH_DIR, import: true };
    const value = await byName.godot_check.execute(args);
    assert.equal(value.ok, true, `diagnostics: ${JSON.stringify(value.diagnostics)}`);
    assert.ok(value.checked.length >= 2, `expected at least main.gd + bridge script, got ${JSON.stringify(value.checked)}`);
    assert.ok(value.checked.includes('res://main.gd'));
    assert.ok(value.checked.includes('res://addons/dsh_bridge/dsh_bridge.gd'));
    assert.equal(value.import.ok, true);
    assert.equal(value.import.exitCode, 0);
    assert.deepEqual(value.diagnostics.filter((d) => d.severity === 'error'), []);
    assertRender(byName.godot_check, args, value);
    return `checked ${value.checked.length} script(s), 0 errors`;
  });

  await check('C4', 'godot_run mode:"scene" captures a known print line and reports the real exit code', async () => {
    writeFile(FRESH_DIR, 'verify_scene.gd', SELF_QUIT_GD);
    writeFile(FRESH_DIR, 'verify_scene.tscn', SELF_QUIT_TSCN);
    const args = { project: FRESH_DIR, mode: 'scene', scene: 'res://verify_scene.tscn', timeoutMs: 15000 };
    const value = await byName.godot_run.execute(args);
    assert.equal(value.timedOut, false, 'self-quitting scene must not time out');
    assert.equal(value.exitCode, 3, `expected exit code 3 from get_tree().quit(3), got ${JSON.stringify(value.exitCode)}`);
    assert.ok(value.output.includes('EXIT_SCENE_READY'), 'known print line missing from captured output');
    assert.deepEqual(value.diagnostics.filter((d) => d.severity === 'error'), []);
    spawnedPids.push({ pid: value.pid, label: 'C4 self-quit scene' });
    assertRender(byName.godot_run, args, value);
    return `exitCode=${value.exitCode}, output has EXIT_SCENE_READY`;
  });

  await check('C5', 'godot_run headless project captures STARTER_READY then times out and kills the process', async () => {
    const args = { project: FRESH_DIR, timeoutMs: 4000 };
    const value = await byName.godot_run.execute(args);
    assert.equal(value.timedOut, true, 'starter project has no quit, so the run must time out');
    assert.ok(value.output.includes('STARTER_READY name=VerifyFresh scene=res://main.tscn'), `STARTER_READY line missing: ${value.output.slice(-400)}`);
    assert.deepEqual(value.diagnostics.filter((d) => d.severity === 'error'), [], 'noise must not become diagnostics');
    spawnedPids.push({ pid: value.pid, label: 'C5 starter run' });
    const gone = await waitForPidGone(value.pid, 8000);
    assert.equal(gone, true, `timed-out run left process ${value.pid} alive`);
    assertRender(byName.godot_run, args, value);
    return `timedOut=${value.timedOut}, exitCode=${JSON.stringify(value.exitCode)}, pid gone`;
  });

  await check('C6', 'godot_stop (no session) stops everything; status reports no sessions', async () => {
    const value = await byName.godot_stop.execute({});
    assert.deepEqual(value.stopped, [], 'completed non-keepAlive runs must already be removed from the registry');
    const status = await byName.godot_status.execute({});
    assert.deepEqual(status.sessions, []);
    assertRender(byName.godot_stop, {}, value);
    return 'stopped=[] sessions=[]';
  });

  await check('C7', 'godot_project_init refuses a non-empty directory with an actionable error', async () => {
    await assertActionableError(
      () => byName.godot_project_init.execute({ directory: FRESH_DIR }),
      (message) => assert.match(message, /not empty|refusing/i),
      'init non-empty',
    );
    return 'refuses non-empty dir';
  });

  await check('C8', 'godot_project_init rejects an unknown template with an actionable error', async () => {
    await assertActionableError(
      () => byName.godot_project_init.execute({ directory: path.join(RUN_DIR, 'never-created'), template: 'nope' }),
      (message) => assert.match(message, /template|empty|2d/i),
      'init bad template',
    );
    return 'enum validated';
  });

  await check('C9', 'godot_check accepts a project.godot path as `project` (CONTRACT §2)', async () => {
    const value = await byName.godot_check.execute({ project: path.join(FRESH_DIR, 'project.godot'), scripts: ['res://main.gd'], import: false });
    assert.equal(value.ok, true, JSON.stringify(value.diagnostics));
    assert.deepEqual(value.checked, ['res://main.gd']);
    return 'project.godot path accepted';
  });

  await check('C10', 'godot_run mode:"script" runs a SceneTree script and reports its exit code', async () => {
    writeFile(FRESH_DIR, 'script_mode.gd', 'extends SceneTree\n\n\nfunc _initialize() -> void:\n\tprint("SCRIPT_MODE_READY")\n\tquit(7)\n');
    const args = { project: FRESH_DIR, mode: 'script', script: 'res://script_mode.gd', timeoutMs: 15000 };
    const value = await byName.godot_run.execute(args);
    assert.equal(value.timedOut, false);
    assert.equal(value.exitCode, 7, `expected exit code 7, got ${JSON.stringify(value.exitCode)}`);
    assert.ok(value.output.includes('SCRIPT_MODE_READY'), 'print from --script mode not captured');
    assertRender(byName.godot_run, args, value);
    return `mode=script exitCode=${value.exitCode}`;
  });

  await check('C11', 'godot_run caps output at 200 KB and marks truncation (CONTRACT §2)', async () => {
    writeFile(FRESH_DIR, 'big_output.gd', 'extends Node\n\n\nfunc _ready() -> void:\n\tvar line := "A".repeat(1000)\n\tfor index in range(300):\n\t\tprint(line)\n\tprint("BIG_OUTPUT_END")\n\tget_tree().quit(0)\n');
    writeFile(FRESH_DIR, 'big_output.tscn', '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://big_output.gd" id="1"]\n\n[node name="BigOutput" type="Node"]\nscript = ExtResource("1")\n');
    const args = { project: FRESH_DIR, mode: 'scene', scene: 'res://big_output.tscn', timeoutMs: 20000 };
    const value = await byName.godot_run.execute(args);
    assert.equal(value.exitCode, 0);
    assert.equal(value.timedOut, false);
    const bytes = Buffer.byteLength(value.output, 'utf8');
    assert.ok(bytes <= 210 * 1024, `output not capped: ${bytes} bytes`);
    assert.ok(value.output.includes('truncated to the last 204800 bytes'), 'truncation marker missing');
    assert.ok(value.output.includes('BIG_OUTPUT_END'), 'tail of the output was not kept');
    return `${bytes} bytes returned, marker present`;
  });
}

async function groupD() {
  beginGroup('D. Bug injection: parse error + runtime error -> structured diagnostics (CONTRACT §3)');

  writeFile(FRESH_DIR, 'bugs/parse_bug.gd', PARSE_BUG_GD);
  writeFile(FRESH_DIR, 'bugs/runtime_bug.gd', RUNTIME_BUG_GD);
  writeFile(FRESH_DIR, 'bugs/runtime_bug.tscn', RUNTIME_BUG_TSCN);

  await check('D1', 'godot_check reports the parse error with severity=error, res:// file and the exact line', async () => {
    const args = { project: FRESH_DIR, scripts: ['res://bugs/parse_bug.gd'], import: false };
    const value = await byName.godot_check.execute(args);
    state.parseCheck = value;
    assert.equal(value.ok, false, 'check must fail with a parse error');
    const error = value.diagnostics.find((d) => d.severity === 'error' && d.file === 'res://bugs/parse_bug.gd');
    assert.ok(error !== undefined, `no error diagnostic for res://bugs/parse_bug.gd in ${JSON.stringify(value.diagnostics)}`);
    assert.equal(error.source, 'parse', `parse error source must be "parse", got ${error.source}`);
    assert.equal(error.line, 4, `expected parse error on line 4, got ${error.line}`);
    assert.match(error.message, /Parse Error/i);
    assert.equal(error.function, 'GDScript::reload');
    assert.ok(typeof error.raw === 'string' && error.raw.includes('SCRIPT ERROR'), 'raw log excerpt missing');
    assertRender(byName.godot_check, args, value);
    return `${error.file}:${error.line} severity=${error.severity} source=${error.source}`;
  });

  await check('D2', 'parse diagnostics contain only contract fields and ignore engine noise (CONTRACT §3)', () => {
    const value = state.parseCheck;
    for (const diagnostic of value.diagnostics) {
      assert.ok(['error', 'warning'].includes(diagnostic.severity));
      assert.ok(['parse', 'runtime', 'engine'].includes(diagnostic.source));
      assert.equal(typeof diagnostic.message, 'string');
      assert.equal(typeof diagnostic.raw, 'string');
      assert.ok(!/Could not create directory: 'user:\/\/logs'|Failed to open log file for writing|Failed to read the root certificate store/.test(diagnostic.message), `engine noise leaked: ${diagnostic.message}`);
    }
    return `${value.diagnostics.length} diagnostic(s), no noise`;
  });

  await check('D3', 'godot_run reports the runtime error with severity=error, res:// file, line and function', async () => {
    const args = { project: FRESH_DIR, mode: 'scene', scene: 'res://bugs/runtime_bug.tscn', timeoutMs: 5000 };
    const value = await byName.godot_run.execute(args);
    state.runtimeRun = value;
    spawnedPids.push({ pid: value.pid, label: 'D3 runtime bug run' });
    assert.equal(value.timedOut, true, 'script with a runtime error does not quit, so the run must time out');
    assert.ok(value.output.includes('RUNTIME_BUG_READY'), 'output printed before the error was not captured');
    const error = value.diagnostics.find((d) => d.severity === 'error' && d.file === 'res://bugs/runtime_bug.gd');
    assert.ok(error !== undefined, `no runtime diagnostic for res://bugs/runtime_bug.gd in ${JSON.stringify(value.diagnostics)}`);
    assert.equal(error.source, 'runtime', `runtime error source must be "runtime", got ${error.source}`);
    assert.equal(error.line, 6, `expected runtime error on line 6, got ${error.line}`);
    assert.equal(error.function, '_ready');
    assert.match(error.message, /Out of bounds|Invalid/i);
    assert.equal(error.severity, 'error');
    assertRender(byName.godot_run, args, value);
    return `${error.file}:${error.line} fn=${error.function} message=${error.message.slice(0, 60)}`;
  });

  await check('D4', 'a script that prints then errors does not leak a process or a session', async () => {
    const value = state.runtimeRun;
    assert.ok(await waitForPidGone(value.pid, 8000), `pid ${value.pid} still alive after timeout kill`);
    const status = await byName.godot_status.execute({});
    assert.deepEqual(status.sessions, [], 'timed-out run left a session in the registry');
    return `pid ${value.pid} gone, sessions=[]`;
  });

  await check('D5', 'after fixing both scripts godot_check is ok again (default discovery)', async () => {
    writeFile(FRESH_DIR, 'bugs/parse_bug.gd', FIXED_BUG_GD);
    writeFile(FRESH_DIR, 'bugs/runtime_bug.gd', FIXED_BUG_GD);
    const args = { project: FRESH_DIR, import: true };
    const value = await byName.godot_check.execute(args);
    assert.equal(value.ok, true, `fixed project still failing: ${JSON.stringify(value.diagnostics)}`);
    assert.ok(value.checked.includes('res://bugs/parse_bug.gd'));
    assert.ok(value.checked.includes('res://bugs/runtime_bug.gd'));
    assert.ok(value.checked.includes('res://main.gd'));
    assert.deepEqual(value.diagnostics.filter((d) => d.severity === 'error'), []);
    assertRender(byName.godot_check, args, value);
    return `ok=true checked=${value.checked.length} diagnostics=${value.diagnostics.length}`;
  });

  await check('D6', 'gdparse maps res://, absolute paths, functions and warnings; strips banner + noise', () => {
    const sample = [
      'Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org',
      '',
      "ERROR: Could not create directory: 'user://logs'.",
      '   at: make_dir_recursive (core/io/dir_access.cpp:179)',
      'ERROR: Failed to read the root certificate store.',
      '   at: get_system_ca_certificates (platform/windows/os_windows.cpp:2582)',
      'SCRIPT ERROR: Parse Error: Expected expression for variable initial value after "=".',
      '   at: GDScript::reload (res://broken.gd:4)',
      'SCRIPT WARNING: Integer division, decimal part will be discarded.',
      '   at: divide (res://main.gd:12)',
      '   GDScript backtrace (most recent call first):',
      '       [0] divide (res://main.gd:12)',
    ].join('\n');
    const absoluteSample = "SCRIPT ERROR: Invalid call. Nonexistent function 'foo' in base 'Node'.\n   at: _ready (D:\\games\\demo\\main.gd:6)";
    const diagnostics = parseGodotLog(sample, { projectRoot: 'D:\\games\\demo' });
    assert.equal(diagnostics.length, 2, `expected parse + warning diagnostics only (noise/banner dropped), got ${JSON.stringify(diagnostics)}`);
    const parse = diagnostics[0];
    assert.equal(parse.severity, 'error');
    assert.equal(parse.source, 'parse');
    assert.equal(parse.file, 'res://broken.gd');
    assert.equal(parse.line, 4);
    assert.equal(parse.function, 'GDScript::reload');
    const warning = diagnostics[1];
    assert.equal(warning.severity, 'warning');
    assert.equal(warning.line, 12);
    assert.equal(warning.source, 'runtime');
    const absolute = parseGodotLog(absoluteSample, { projectRoot: 'D:\\games\\demo' });
    assert.equal(absolute.length, 1);
    assert.equal(absolute[0].file, 'res://main.gd', 'absolute project path must be mapped to res://');
    assert.equal(absolute[0].line, 6);
    assert.equal(absolute[0].source, 'runtime');
    assert.ok(!stripEngineHeader(sample).includes('Godot Engine v'), 'banner line was not stripped');
    assert.ok(!diagnostics.some((d) => /user:\/\/logs|certificate store|Failed to open log file/.test(d.message)));
    return '2 diagnostics + 1 absolute-path mapping, noise/banner dropped';
  });

  await check('D7', 'script discovery caps at 40, skips .godot/ and normalises res:// paths (CONTRACT §2)', () => {
    const fixture = path.join(RUN_DIR, 'scripts-fixture');
    rmrf(fixture);
    fs.mkdirSync(path.join(fixture, '.godot'), { recursive: true });
    fs.writeFileSync(path.join(fixture, '.godot', 'ignored.gd'), 'extends Node\n');
    for (let index = 0; index < 45; index += 1) {
      fs.writeFileSync(path.join(fixture, `script_${String(index).padStart(2, '0')}.gd`), 'extends Node\n');
    }
    const discovered = discoverScripts(fixture);
    assert.equal(discovered.scripts.length, 40, `expected 40 scripts, got ${discovered.scripts.length}`);
    assert.equal(discovered.truncated, true, 'truncated flag must be set when >40 scripts exist');
    for (const script of discovered.scripts) {
      assert.match(script, /^res:\/\/script_\d+\.gd$/, `unexpected discovered path ${script}`);
      assert.ok(!script.includes('.godot'), '.godot/ scripts must be skipped');
    }
    const absolute = path.join(fixture, 'script_00.gd');
    assert.equal(normaliseScriptPath(absolute, fixture), 'res://script_00.gd');
    assert.equal(normaliseScriptPath('script_01.gd', fixture), 'res://script_01.gd');
    assert.equal(normaliseScriptPath('res://already.gd', fixture), 'res://already.gd');
    return '40/45 scripts, truncated=true, .godot skipped, path mapping ok';
  });
}

async function copyDemoProject() {
  const skip = new Set(['.godot', 'evidence']);
  fs.cpSync(DEMO_SRC, DEMO_COPY, {
    recursive: true,
    filter: (source) => !skip.has(path.basename(source)),
  });
  if (!fs.existsSync(path.join(DEMO_COPY, 'project.godot'))) {
    throw new Error(`failed to copy demo project to ${DEMO_COPY}`);
  }
}

async function groupE() {
  beginGroup('E. Runtime bridge over real engine: keepAlive + bridge -> commands -> quit/stop (CONTRACT §4)');

  await copyDemoProject();

  await check('E1', 'godot_run keepAlive+bridge attaches and returns a live session', async () => {
    const args = { project: DEMO_COPY, keepAlive: true, bridge: true, args: ['--deterministic'] };
    const value = await byName.godot_run.execute(args);
    state.bridgeSession = value;
    spawnedPids.push({ pid: value.pid, label: 'E1 bridge session' });
    assert.equal(value.timedOut, false);
    assert.match(value.session, /^g\d+$/, `session id must be short ("g1", "g2", ...), got ${JSON.stringify(value.session)}`);
    assert.ok(Number.isInteger(value.pid) && value.pid > 0, `pid must be an integer, got ${JSON.stringify(value.pid)}`);
    assert.equal(value.bridge.attached, true, 'bridge must be attached to a real game');
    assert.ok(Number.isInteger(value.bridge.port) && value.bridge.port > 0, 'bridge port must be reported');
    assert.equal(value.command[0], ENGINE, 'engine console exe must be the first argv element');
    const bridgeArgIndex = value.command.findIndex((arg) => String(arg).startsWith('--dsh-bridge=127.0.0.1:'));
    assert.ok(bridgeArgIndex > 0, `missing --dsh-bridge user arg in command: ${JSON.stringify(value.command)}`);
    const bareDashDash = value.command.indexOf('--');
    assert.ok(bareDashDash > 0, `command must separate Godot flags from user args with a bare "--": ${JSON.stringify(value.command)}`);
    assert.ok(bridgeArgIndex > bareDashDash, `--dsh-bridge must follow the bare "--" (user args), got ${JSON.stringify(value.command)}`);
    assert.ok(value.command.slice(bareDashDash + 1).includes('--deterministic'), 'caller-supplied game args must also follow "--"');
    assert.ok(value.command.includes('--headless'), 'headless defaults to true');
    assert.equal(value.command[bridgeArgIndex], `--dsh-bridge=127.0.0.1:${value.bridge.port}`);
    assert.ok(value.output.includes('DEMO_READY coins=5 enemies=3 deterministic=true'), `DEMO_READY missing: ${value.output.slice(-300)}`);
    assert.deepEqual(value.diagnostics.filter((d) => d.severity === 'error'), []);
    assertRender(byName.godot_run, args, value);
    return `session=${value.session} pid=${value.pid} port=${value.bridge.port}`;
  });

  const sessionId = () => {
    assert.ok(state.bridgeSession !== undefined, 'E1 did not produce a session; later bridge checks cannot run');
    return state.bridgeSession.session;
  };
  const bridgeCall = async (args) => byName.godot_bridge.execute({ session: sessionId(), ...args });

  await check('E2', 'bridge ping returns {pong:true, scene:res://main.tscn}', async () => {
    const value = await bridgeCall({ command: 'ping' });
    assert.equal(value.ok, true);
    assert.equal(value.result.pong, true);
    assert.equal(value.result.scene, 'res://main.tscn');
    assertRender(byName.godot_bridge, { command: 'ping' }, value);
    return JSON.stringify(value.result);
  });

  await check('E3', 'bridge tree exposes /root/Main and its scene children', async () => {
    const args = { command: 'tree', args: { depth: 3 } };
    const value = await bridgeCall(args);
    assert.equal(value.ok, true);
    assert.equal(value.result.root.path, '/root');
    const find = (node, wanted) => {
      if (node.path === wanted) return node;
      for (const child of node.children ?? []) {
        const hit = find(child, wanted);
        if (hit) return hit;
      }
      return undefined;
    };
    const main = find(value.result.root, '/root/Main');
    assert.ok(main !== undefined, '/root/Main not present in tree');
    assert.equal(main.type, 'Node2D');
    assert.equal(main.scene, 'res://main.tscn');
    const player = find(main, '/root/Main/Player');
    assert.ok(player !== undefined, '/root/Main/Player missing from tree');
    assert.equal(player.type, 'CharacterBody2D');
    assertRender(byName.godot_bridge, args, value);
    return `Main(${main.type}) children=${main.children.length}`;
  });

  await check('E4', 'bridge node returns JSON-safe properties and script/type metadata', async () => {
    const args = { command: 'node', args: { path: '/root/Main', properties: ['score', 'lives', 'game_over', 'position'] } };
    const value = await bridgeCall(args);
    assert.equal(value.ok, true);
    assert.equal(value.result.path, '/root/Main');
    assert.equal(value.result.type, 'Node2D');
    assert.equal(value.result.script, 'res://main.gd');
    assert.equal(value.result.properties.score, 0);
    assert.equal(value.result.properties.lives, 3);
    assert.equal(value.result.properties.game_over, false);
    assert.match(value.result.properties.position, /^<[A-Za-z0-9_]+>$/, 'non-JSON value must be rendered as "<ClassName>" (CONTRACT §4)');
    assertRender(byName.godot_bridge, args, value);
    return `properties=${JSON.stringify(value.result.properties)}`;
  });

  await check('E5', 'bridge node_set writes a property and a following node read observes the change', async () => {
    const setValue = await bridgeCall({ command: 'node_set', args: { path: '/root/Main', property: 'game_over', value: true } });
    assert.equal(setValue.ok, true, JSON.stringify(setValue));
    assert.equal(setValue.result.value, true);
    const readValue = await bridgeCall({ command: 'node', args: { path: '/root/Main', properties: ['game_over'] } });
    assert.equal(readValue.ok, true);
    assert.equal(readValue.result.properties.game_over, true, 'node_set change was not observable via a following node read');
    assertRender(byName.godot_bridge, { command: 'node_set' }, setValue);
    return 'game_over false -> true read back';
  });

  await check('E6', 'bridge node_call invokes a game method and returns JSON-safe data', async () => {
    const args = { command: 'node_call', args: { path: '/root/Main', method: 'debug_state' } };
    const value = await bridgeCall(args);
    assert.equal(value.ok, true);
    assert.equal(value.result.return.score, 0);
    assert.equal(value.result.return.lives, 3);
    assert.equal(value.result.return.coins, 5);
    assert.equal(value.result.return.enemies, 3);
    assert.equal(value.result.return.deterministic, true);
    assert.equal(value.result.return.game_over, true);
    assertRender(byName.godot_bridge, args, value);
    return `return=${JSON.stringify(value.result.return).slice(0, 160)}`;
  });

  await check('E7', 'bridge frames waits for the requested number of frames', async () => {
    const args = { command: 'frames', args: { count: 7 } };
    const value = await bridgeCall(args);
    assert.equal(value.ok, true);
    assert.equal(value.result.frames, 7);
    assertRender(byName.godot_bridge, args, value);
    return 'frames=7';
  });

  await check('E8', 'bridge action presses a real input action and rejects unknown actions', async () => {
    const pressed = await bridgeCall({ command: 'action', args: { action: 'ui_left', pressed: true } });
    assert.equal(pressed.ok, true, JSON.stringify(pressed));
    assert.equal(pressed.result.pressed, true);
    const unknown = await bridgeCall({ command: 'action', args: { action: 'definitely_not_an_action' } });
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /unknown input action/i);
    assertRender(byName.godot_bridge, { command: 'action' }, unknown);
    return 'ui_left pressed, unknown action rejected';
  });

  await check('E9', 'bridge screenshot explains the headless restriction (CONTRACT §4)', async () => {
    const value = await bridgeCall({ command: 'screenshot' });
    assert.equal(value.ok, false, 'screenshot must fail under the headless display driver');
    assert.match(value.error, /headless|dummy|display/i);
    assertRender(byName.godot_bridge, { command: 'screenshot' }, value);
    return value.error.slice(0, 120);
  });

  await check('E10', 'bridge unknown command returns {ok:false, error} instead of breaking the session', async () => {
    const args = { command: 'not_a_command' };
    const value = await bridgeCall(args);
    assert.equal(value.ok, false);
    assert.match(value.error, /unknown command/i);
    const stillAlive = await bridgeCall({ command: 'ping' });
    assert.equal(stillAlive.ok, true, 'session must survive an unknown command');
    assertRender(byName.godot_bridge, args, value);
    return 'ok:false + session still responsive';
  });

  await check('E11', 'malformed session id produces an actionable Error (message, not a stack)', async () => {
    const message = await assertActionableError(
      () => byName.godot_bridge.execute({ session: 'nope', command: 'ping' }),
      (text) => {
        assert.match(text, /unknown session "nope"/);
        assert.match(text, /godot_run/);
      },
      'bad bridge session',
    );
    const unknownStop = await assertActionableError(
      () => byName.godot_stop.execute({ session: 'nope' }),
      (text) => assert.match(text, /unknown session "nope"/),
      'bad stop session',
    );
    return `${message.slice(0, 90)} | ${unknownStop.slice(0, 60)}`;
  });

  await check('E12', 'bridge quit shuts the game down cleanly', async () => {
    const value = await bridgeCall({ command: 'quit', args: { code: 0 } });
    assert.equal(value.ok, true);
    const pid = state.bridgeSession.pid;
    assert.ok(await waitForPidGone(pid, 8000), `pid ${pid} still alive after bridge quit`);
    const status = await byName.godot_status.execute({});
    const session = status.sessions.find((entry) => entry.id === sessionId());
    assert.ok(session !== undefined, 'quit session should remain listed until stopped');
    assert.equal(session.alive, false, 'status must report the session as not alive after quit');
    return `pid ${pid} gone, status alive=false`;
  });

  await check('E13', 'godot_stop removes the session and leaves no bridge session behind', async () => {
    const value = await byName.godot_stop.execute({ session: sessionId() });
    assert.deepEqual(value.stopped, [sessionId()]);
    const status = await byName.godot_status.execute({});
    assert.deepEqual(status.sessions, []);
    assert.ok(await waitForPidGone(state.bridgeSession.pid, 3000));
    assertRender(byName.godot_stop, {}, value);
    return `stopped=${sessionId()}`;
  });
}

async function groupF() {
  beginGroup('F. Robustness: actionable errors, keepAlive without bridge, HMR unload cleanup');

  await check('F1', 'godot_run on a nonexistent project gives an actionable error', async () => {
    const message = await assertActionableError(
      () => byName.godot_run.execute({ project: path.join(RUN_DIR, 'does-not-exist') }),
      (text) => {
        assert.match(text, /Godot project not found/);
        assert.match(text, /godot_project_init/);
      },
      'run missing project',
    );
    return message.slice(0, 110);
  });

  await check('F2', 'missing required argument yields an actionable error', async () => {
    const message = await assertActionableError(
      () => byName.godot_run.execute({}),
      (text) => assert.match(text, /missing required argument "project"/),
      'run without project',
    );
    return message.slice(0, 110);
  });

  await check('F3', 'keepAlive without bridge runs and is stoppable; godot_bridge explains it has no bridge', async () => {
    const value = await byName.godot_run.execute({ project: FRESH_DIR, keepAlive: true, timeoutMs: 10000 });
    spawnedPids.push({ pid: value.pid, label: 'F3 keepAlive no bridge' });
    assert.equal(value.timedOut, false);
    assert.equal(value.bridge, null);
    assert.ok(value.output.includes('STARTER_READY'), 'keepAlive run must capture startup output');
    assert.match(value.session, /^g\d+$/);
    const message = await assertActionableError(
      () => byName.godot_bridge.execute({ session: value.session, command: 'ping' }),
      (text) => assert.match(text, /no bridge|bridge/),
      'bridge on non-bridge session',
    );
    const stopped = await byName.godot_stop.execute({ session: value.session });
    assert.deepEqual(stopped.stopped, [value.session]);
    assert.ok(await waitForPidGone(value.pid, 8000), `pid ${value.pid} still alive after godot_stop`);
    return `${message.slice(0, 70)} | pid gone`;
  });

  await check('F5', 'keepAlive+bridge on a project without the bridge autoload returns ~1.5 s after output, not blocked 15 s', async () => {
    const noAutoload = path.join(RUN_DIR, 'no-autoload');
    rmrf(noAutoload);
    fs.cpSync(FRESH_DIR, noAutoload, { recursive: true, filter: (source) => path.basename(source) !== '.godot' });
    const projectFile = path.join(noAutoload, 'project.godot');
    const stripped = fs.readFileSync(projectFile, 'utf8')
      .split(/\r?\n/)
      .filter((line) => !/^\[autoload\]$/.test(line.trim()) && !/^Bridge="\*res:\/\/addons\/dsh_bridge\/dsh_bridge\.gd"$/.test(line.trim()))
      .join('\n');
    fs.writeFileSync(projectFile, stripped, 'utf8');
    assert.ok(!fs.readFileSync(projectFile, 'utf8').includes('dsh_bridge.gd'), 'fixture must not reference the bridge autoload');
    const startedAt = Date.now();
    const value = await byName.godot_run.execute({ project: noAutoload, keepAlive: true, bridge: true, timeoutMs: 20000 });
    const elapsed = Date.now() - startedAt;
    spawnedPids.push({ pid: value.pid, label: 'F5 no-autoload bridge run' });
    assert.equal(value.timedOut, false);
    assert.ok(elapsed < 10000, `keepAlive blocked for ${elapsed} ms waiting for a bridge that cannot attach (CONTRACT §2: ~1.5 s after first output)`);
    assert.ok(value.bridge !== null, 'bridge state must be reported when bridge:true');
    assert.equal(value.bridge.attached, false, 'no game should have attached');
    assert.ok(value.output.includes('STARTER_READY'), 'run output missing');
    assert.ok(pidExists(value.pid), 'session process should still be alive after keepAlive returns');
    const stopped = await byName.godot_stop.execute({ session: value.session });
    assert.deepEqual(stopped.stopped, [value.session]);
    assert.ok(await waitForPidGone(value.pid, 8000), `pid ${value.pid} still alive after stop`);
    return `returned in ${elapsed} ms, attached=false, pid gone after stop`;
  });

  await check('F6', 'keepAlive+bridge with the autoload present but never connecting reports attached=false, timedOut=true and a hint', async () => {
    const inert = path.join(RUN_DIR, 'bridge-inert');
    rmrf(inert);
    fs.cpSync(FRESH_DIR, inert, { recursive: true, filter: (source) => path.basename(source) !== '.godot' });
    fs.writeFileSync(path.join(inert, 'addons', 'dsh_bridge', 'dsh_bridge.gd'), 'extends Node\n', 'utf8');
    const projectText = fs.readFileSync(path.join(inert, 'project.godot'), 'utf8');
    assert.ok(projectText.includes('res://addons/dsh_bridge/dsh_bridge.gd'), 'fixture must keep the autoload row so the plugin attempts a bridge attach');
    const startedAt = Date.now();
    const value = await byName.godot_run.execute({ project: inert, keepAlive: true, bridge: true, timeoutMs: 5000 });
    const elapsed = Date.now() - startedAt;
    spawnedPids.push({ pid: value.pid, label: 'F6 inert-bridge attach wait' });
    assert.ok(value.bridge !== null && value.bridge !== undefined, 'bridge state must be reported');
    assert.equal(value.bridge.attached, false, 'no game should have attached');
    assert.equal(value.timedOut, true, `attach-wait exhaustion must be reported as timedOut:true (got ${JSON.stringify(value.timedOut)})`);
    assert.match(value.output, /bridge/i, 'result must carry an actionable bridge hint line in output');
    assert.match(value.output, /attach|connect|autoload|timed out/i, 'hint must explain that the bridge did not attach');
    assert.ok(elapsed >= 4500 && elapsed < 12000, `attach-authoritative wait should last ~5000 ms, took ${elapsed} ms`);
    if (typeof value.session === 'string') {
      const stopped = await byName.godot_stop.execute({ session: value.session });
      assert.deepEqual(stopped.stopped, [value.session]);
      assert.ok(await waitForPidGone(value.pid, 8000), `pid ${value.pid} still alive after stop`);
    } else {
      assert.ok(await waitForPidGone(value.pid, 4000), 'an unattached keepAlive run must not leave an unmanaged process');
    }
    return `attached=false timedOut=true elapsed=${elapsed} ms, hint in output`;
  });

  await check('F4', 'plugin unload (ctx.effect disposers) kills a live keepAlive session', async () => {
    const value = await byName.godot_run.execute({ project: FRESH_DIR, keepAlive: true, timeoutMs: 10000 });
    spawnedPids.push({ pid: value.pid, label: 'F4 HMR cleanup' });
    assert.equal(fake.tools.length, 6);
    fake.disposeAll();
    assert.equal(fake.tools.length, 0, 'tool disposers must unregister every tool');
    assert.ok(await waitForPidGone(value.pid, 8000), `HMR cleanup left pid ${value.pid} alive`);
    return `disposers ran, pid ${value.pid} gone, tools unregistered`;
  });
}

async function groupG() {
  beginGroup('G. Cleanup: no leaked processes / capture files / writes outside verify');

  await check('G1', 'every Godot pid started by this suite is gone', async () => {
    const alive = [];
    for (const { pid, label } of spawnedPids) {
      if (pidExists(pid)) alive.push(`${label}(pid ${pid})`);
    }
    assert.deepEqual(alive, [], `leaked Godot processes: ${alive.join(', ')}`);
    return `${new Set(spawnedPids.map((entry) => entry.pid)).size} tracked pid(s) gone`;
  });

  await check('G2', 'no dsh-godot capture files for this process remain in the temp dir', () => {
    const temp = os.tmpdir();
    const leftovers = fs.readdirSync(temp).filter((name) => name.startsWith('dsh-godot-') && name.includes(`-${process.pid}-`));
    assert.deepEqual(leftovers, [], `leftover capture files: ${leftovers.join(', ')}`);
    return 'none';
  });

  await check('G3', 'no new Godot process is left running globally (beyond concurrent teammate work)', () => {
    const now = listGodotPids();
    const baseline = new Set(baselineGodot.map((entry) => entry.pid));
    const ours = new Set(spawnedPids.map((entry) => entry.pid));
    const foreign = now.pids.filter((entry) => !baseline.has(entry.pid) && !ours.has(entry.pid));
    const leakedOurs = now.pids.filter((entry) => ours.has(entry.pid));
    assert.deepEqual(leakedOurs, [], `suite-spawned Godot processes still running: ${JSON.stringify(leakedOurs)}`);
    return foreign.length === 0
      ? `no Godot processes running (${now.pids.length} total)`
      : `none of ours; ${foreign.length} unrelated Godot pid(s) running (concurrent work): ${foreign.map((entry) => entry.pid).join(',')}`;
  });

  await check('G4', 'demo/ is byte-for-byte untouched by verification (bridge ran on a copy)', () => {
    const after = snapshotDir(DEMO_SRC, { skip: ['.godot', 'evidence'] });
    assert.deepEqual(after, demoSnapshotBefore, 'verification wrote into demo/ (it must only use the copy under verify/tmp)');
    return `${after.length} demo entries unchanged`;
  });
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  console.log('dsh-godot independent end-to-end verification');
  console.log(`workspace: ${WORKSPACE}`);
  console.log(`engine:    ${ENGINE}`);
  console.log(`node:      ${process.version}`);

  assert.ok(fs.existsSync(ENGINE), `Godot console engine missing at ${ENGINE} (CONTRACT §0)`);
  fs.mkdirSync(TMP_DIR, { recursive: true });
  baselineGodot = listGodotPids().pids;
  demoSnapshotBefore = snapshotDir(DEMO_SRC, { skip: ['.godot', 'evidence'] });
  console.log(`baseline:  ${baselineGodot.length} Godot process(es) already running`);

  try {
    await groupA();
    await groupB();
    await groupC();
    await groupD();
    await groupE();
    await groupF();
    await groupG();
  } finally {
    // Defensive cleanup: stop every session the plugin still owns, then unload.
    try {
      if (byName.godot_stop) await byName.godot_stop.execute({});
    } catch {
      /* best effort */
    }
    try {
      if (fake && !fake.isDisposed()) fake.disposeAll();
    } catch {
      /* best effort */
    }
    for (const { pid } of spawnedPids) {
      if (pidExists(pid)) hardKill(pid);
    }
  }

  const passed = results.filter((entry) => entry.pass).length;
  const failed = results.filter((entry) => !entry.pass);
  console.log('\n================ PASS/FAIL MATRIX ================');
  let previousGroup = '';
  for (const entry of results) {
    if (entry.group !== previousGroup) {
      console.log(`\n${entry.group}`);
      previousGroup = entry.group;
    }
    console.log(`${entry.pass ? 'PASS' : 'FAIL'}  ${entry.id.padEnd(26)} ${entry.title}`);
  }
  console.log(`\nSUMMARY passed=${passed} failed=${failed.length} total=${results.length}`);
  if (failed.length > 0) {
    console.log('FAILURES:');
    for (const entry of failed) console.log(`- ${entry.id}: ${entry.detail}`);
  } else {
    console.log('RESULT: ALL CHECKS PASSED');
  }
  return failed.length === 0 ? 0 : 1;
}

const watchdog = setTimeout(() => {
  console.error('FATAL: e2e suite exceeded its 300 s watchdog');
  process.exit(3);
}, 300000);
watchdog.unref?.();

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error('FATAL: unexpected suite failure:', error);
    process.exitCode = 1;
  });
