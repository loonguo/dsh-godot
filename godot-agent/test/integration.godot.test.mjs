/**
 * Real-Godot integration test.
 *
 * Skips gracefully when Godot 4.x is not installed at the CONTRACT §0 path.
 * Uses the real engine (console build, --headless) through the actual tool
 * definitions, not mocks. Temp projects live under os.tmpdir() and are removed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { templatesAvailable } from '../src/project.js';
import { createRuntime, createToolDefinitions } from '../src/tools.js';

const ENGINE = 'D:\\Software\\Godot_v4.7.2-stable_win64.exe\\Godot_v4.7.2-stable_win64_console.exe';
const engineAvailable = fs.existsSync(ENGINE);
const SCAFFOLD_AVAILABLE = engineAvailable && templatesAvailable();
const skipEngine = engineAvailable ? false : 'real Godot 4.x engine not installed at the CONTRACT §0 path';
const skipScaffold = SCAFFOLD_AVAILABLE ? false : 'real engine and shipped templates are required';

const FIXTURE_PROJECT = `config_version=5

[application]

config/name="Fixture"
run/main_scene="res://main.tscn"
config/features=PackedStringArray("4.7")
`;

const FIXTURE_SCENE = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://main.gd" id="1"]

[node name="Main" type="Node"]
script = ExtResource("1")
`;

const CLEAN_MAIN = `extends Node

func _ready() -> void:
	print("FIXTURE_READY")
	get_tree().quit()
`;

const RUNTIME_ERROR_MAIN = `extends Node

func _ready() -> void:
	print("BEFORE_RUNTIME_ERROR")
	var nothing = null
	nothing.missing_method()
`;

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-godot-it-'));
}

function writeFixtureProject(directory, mainScript) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'project.godot'), FIXTURE_PROJECT, 'utf8');
  fs.writeFileSync(path.join(directory, 'main.tscn'), FIXTURE_SCENE, 'utf8');
  fs.writeFileSync(path.join(directory, 'main.gd'), mainScript, 'utf8');
}

function findTool(definitions, name) {
  const tool = definitions.find((candidate) => candidate.name === name);
  assert.ok(tool, `tool ${name} must be registered`);
  return tool;
}

/** Whether an OS process id still exists. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('godot_project_init scaffolds a real project, imports it and check passes', { skip: skipScaffold }, async (t) => {
  const root = makeRoot();
  const runtime = createRuntime({ enginePath: ENGINE });
  t.after(() => {
    runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const definitions = createToolDefinitions(runtime);
  const init = findTool(definitions, 'godot_project_init');
  const check = findTool(definitions, 'godot_check');

  const directory = path.join(root, 'starter');
  const value = await init.execute({ directory, name: 'Integration Starter' });
  assert.equal(value.name, 'Integration Starter');
  assert.equal(value.project.valid, true);
  assert.equal(value.project.path, directory);
  assert.equal(value.mainScene, 'res://main.tscn');
  assert.equal(value.import.ok, true, `import diagnostics: ${JSON.stringify(value.import.diagnostics)}`);
  assert.ok(value.files.includes('project.godot'));
  assert.ok(value.files.includes('main.tscn'));
  assert.ok(value.files.includes('main.gd'));
  assert.ok(value.files.includes('addons/dsh_bridge/dsh_bridge.gd'), `files: ${value.files.join(', ')}`);
  assert.equal(value.files.some((file) => file.toLowerCase().endsWith('.md')), false, 'template documentation must not be scaffolded');

  const projectFile = fs.readFileSync(path.join(directory, 'project.godot'), 'utf8');
  assert.match(projectFile, /config\/name="Integration Starter"/);
  assert.match(projectFile, /Bridge="\*res:\/\/addons\/dsh_bridge\/dsh_bridge\.gd"/);

  const checked = await check.execute({ project: directory });
  assert.equal(checked.ok, true, `check diagnostics: ${JSON.stringify(checked.diagnostics)}`);
  assert.ok(checked.checked.length >= 2, `expected main.gd + bridge script, got ${checked.checked.join(', ')}`);
  assert.ok(checked.checked.some((script) => script.endsWith('main.gd')));
  assert.ok(checked.checked.some((script) => script.includes('addons/dsh_bridge/dsh_bridge.gd')));
});

test('godot_check reports a deliberate parse error with the right res:// file and line', { skip: skipEngine }, async (t) => {
  const root = makeRoot();
  const runtime = createRuntime({ enginePath: ENGINE });
  t.after(() => {
    runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const directory = path.join(root, 'broken');
  writeFixtureProject(directory, CLEAN_MAIN);
  fs.writeFileSync(
    path.join(directory, 'broken.gd'),
    ['extends Node', '', 'func _ready() -> void:', '\tvar x: int = "not an int"', '\tprint(x)', ''].join('\n'),
    'utf8',
  );

  const check = findTool(createToolDefinitions(runtime), 'godot_check');
  const value = await check.execute({ project: directory });
  assert.equal(value.ok, false);
  assert.ok(value.checked.includes('res://broken.gd'), `checked: ${value.checked.join(', ')}`);
  const parseDiagnostic = value.diagnostics.find((diagnostic) => diagnostic.source === 'parse' && diagnostic.file === 'res://broken.gd');
  assert.ok(parseDiagnostic, `expected a parse diagnostic with res://broken.gd, got ${JSON.stringify(value.diagnostics)}`);
  assert.equal(parseDiagnostic.severity, 'error');
  assert.equal(parseDiagnostic.line, 4);
  assert.match(parseDiagnostic.message, /Parse Error/);
});

test('godot_run captures print output from a headless run that exits', { skip: skipEngine }, async (t) => {
  const root = makeRoot();
  const runtime = createRuntime({ enginePath: ENGINE });
  t.after(() => {
    runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const directory = path.join(root, 'clean');
  writeFixtureProject(directory, CLEAN_MAIN);

  const run = findTool(createToolDefinitions(runtime), 'godot_run');
  const value = await run.execute({ project: directory, timeoutMs: 20000 });
  assert.equal(value.timedOut, false);
  assert.equal(value.exitCode, 0, `output: ${value.output}`);
  assert.match(value.output, /FIXTURE_READY/);
  assert.equal(value.diagnostics.some((diagnostic) => diagnostic.severity === 'error'), false);
  assert.equal(value.session, undefined);
  assert.equal(value.bridge, null);
  await delay(300);
  assert.equal(pidAlive(value.pid), false, `a completed run must not leave pid ${value.pid} alive`);
});

test('godot_run captures runtime-error diagnostics with res:// file and line', { skip: skipEngine }, async (t) => {
  const root = makeRoot();
  const runtime = createRuntime({ enginePath: ENGINE });
  t.after(() => {
    runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const directory = path.join(root, 'runtime-error');
  writeFixtureProject(directory, RUNTIME_ERROR_MAIN);

  const run = findTool(createToolDefinitions(runtime), 'godot_run');
  const value = await run.execute({ project: directory, timeoutMs: 3000 });
  assert.equal(value.timedOut, true, 'the fixture keeps running after the runtime error');
  assert.match(value.output, /BEFORE_RUNTIME_ERROR/);
  const runtimeDiagnostic = value.diagnostics.find((diagnostic) => diagnostic.source === 'runtime');
  assert.ok(runtimeDiagnostic, `expected a runtime diagnostic, got ${JSON.stringify(value.diagnostics)}`);
  assert.equal(runtimeDiagnostic.severity, 'error');
  assert.equal(runtimeDiagnostic.file, 'res://main.gd');
  assert.equal(runtimeDiagnostic.line, 6);
  assert.match(runtimeDiagnostic.message, /Nonexistent function/);
  await delay(400);
  assert.equal(pidAlive(value.pid), false, `the timed-out run must be killed (pid ${value.pid})`);
});

test('godot_run keepAlive + bridge attaches to the real game and godot_bridge round-trips', { skip: skipScaffold }, async (t) => {
  const root = makeRoot();
  const runtime = createRuntime({ enginePath: ENGINE });
  let sessionId;
  t.after(async () => {
    try {
      if (sessionId !== undefined) {
        await findTool(createToolDefinitions(runtime), 'godot_stop').execute({ session: sessionId });
      }
    } finally {
      runtime.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const definitions = createToolDefinitions(runtime);
  const init = findTool(definitions, 'godot_project_init');
  const run = findTool(definitions, 'godot_run');
  const bridge = findTool(definitions, 'godot_bridge');
  const status = findTool(definitions, 'godot_status');
  const stop = findTool(definitions, 'godot_stop');

  const directory = path.join(root, 'bridge-game');
  const project = await init.execute({ directory, name: 'Bridge Game' });
  assert.equal(project.import.ok, true, `import diagnostics: ${JSON.stringify(project.import.diagnostics)}`);

  const started = await run.execute({ project: directory, keepAlive: true, bridge: true, timeoutMs: 30000 });
  sessionId = started.session;
  assert.ok(typeof started.session === 'string' && started.session.length > 0, 'keepAlive must return a session id');
  assert.ok(started.pid > 0);
  assert.equal(started.timedOut, false);
  assert.equal(started.bridge.attached, true, `bridge did not attach; output: ${started.output}`);
  assert.ok(started.bridge.port > 0);

  const ping = await bridge.execute({ session: sessionId, command: 'ping' });
  assert.equal(ping.ok, true, JSON.stringify(ping));
  assert.equal(ping.result.pong, true);
  assert.equal(ping.result.scene, 'res://main.tscn');

  const tree = await bridge.execute({ session: sessionId, command: 'tree', args: { depth: 2 } });
  assert.equal(tree.ok, true, JSON.stringify(tree));
  assert.ok(tree.result.root, 'tree must return a root node');
  assert.equal(typeof tree.result.root.name, 'string');
  const mainChild = (tree.result.root.children ?? []).find((child) => child.name === 'Main');
  assert.ok(mainChild, `tree root children must contain Main: ${JSON.stringify(tree.result.root)}`);
  assert.equal(mainChild.path, '/root/Main');

  const node = await bridge.execute({ session: sessionId, command: 'node', args: { path: '/root/Main' } });
  assert.equal(node.ok, true, JSON.stringify(node));
  assert.equal(node.result.path, '/root/Main');

  const nodeCall = await bridge.execute({ session: sessionId, command: 'node_call', args: { path: '/root/Main', method: 'dsh_probe' } });
  assert.equal(nodeCall.ok, true, JSON.stringify(nodeCall));
  assert.equal(typeof nodeCall.result.return, 'object');

  const frames = await bridge.execute({ session: sessionId, command: 'frames', args: { count: 3 } });
  assert.equal(frames.ok, true, JSON.stringify(frames));
  assert.equal(frames.result.frames, 3);

  const screenshot = await bridge.execute({ session: sessionId, command: 'screenshot', args: {} });
  assert.equal(screenshot.ok, false, 'headless screenshot must fail cleanly');
  assert.match(screenshot.error, /headless/i);

  const sessionStatus = await status.execute({});
  const listed = sessionStatus.sessions.find((entry) => entry.id === sessionId);
  assert.ok(listed, `session ${sessionId} missing from status: ${JSON.stringify(sessionStatus.sessions)}`);
  assert.equal(listed.alive, true);
  assert.equal(listed.bridge.attached, true);

  const stopped = await stop.execute({ session: sessionId });
  assert.deepEqual(stopped.stopped, [sessionId]);
  const stoppedPid = started.pid;
  sessionId = undefined;
  await new Promise((resolve) => setTimeout(resolve, 400));
  let alive = true;
  try {
    process.kill(stoppedPid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, `godot_stop must kill pid ${stoppedPid}`);
  const after = await status.execute({});
  assert.equal(after.sessions.some((entry) => entry.id === stopped.stopped[0]), false);
});

test('godot_run keepAlive without bridge returns a live session after output settles', { skip: skipScaffold }, async (t) => {
  const root = makeRoot();
  const runtime = createRuntime({ enginePath: ENGINE });
  let sessionId;
  t.after(async () => {
    try {
      if (sessionId !== undefined) await findTool(createToolDefinitions(runtime), 'godot_stop').execute({ session: sessionId });
    } finally {
      runtime.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const definitions = createToolDefinitions(runtime);
  const init = findTool(definitions, 'godot_project_init');
  const run = findTool(definitions, 'godot_run');
  const status = findTool(definitions, 'godot_status');
  const stop = findTool(definitions, 'godot_stop');

  const directory = path.join(root, 'keepalive');
  const project = await init.execute({ directory, name: 'Keep Alive' });
  assert.equal(project.import.ok, true, `import diagnostics: ${JSON.stringify(project.import.diagnostics)}`);

  const startedAt = Date.now();
  const value = await run.execute({ project: directory, keepAlive: true, timeoutMs: 20000 });
  const elapsed = Date.now() - startedAt;
  sessionId = value.session;

  assert.equal(typeof value.session, 'string');
  assert.equal(value.bridge, null);
  assert.equal(value.timedOut, false);
  assert.ok(value.pid > 0);
  assert.ok(elapsed >= 1000, `keepAlive without a bridge settles for output before returning (took ${elapsed} ms)`);
  assert.ok(elapsed < 15000, `keepAlive without a bridge must not wait for a bridge (took ${elapsed} ms)`);
  assert.match(value.output, /STARTER_READY/);

  const sessionStatus = await status.execute({});
  assert.equal(sessionStatus.sessions.find((entry) => entry.id === sessionId)?.alive, true);

  await stop.execute({ session: sessionId });
  sessionId = undefined;
});

test('godot_run keepAlive+bridge on a project without the bridge autoload returns fast with a hint', { skip: skipEngine }, async (t) => {
  const root = makeRoot();
  const runtime = createRuntime({ enginePath: ENGINE });
  let sessionId;
  t.after(async () => {
    try {
      if (sessionId !== undefined) await findTool(createToolDefinitions(runtime), 'godot_stop').execute({ session: sessionId });
    } finally {
      runtime.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const directory = path.join(root, 'no-autoload');
  // Fixture projects have no [autoload] section; this script errors and keeps
  // running, so the game is alive but can never attach.
  writeFixtureProject(directory, RUNTIME_ERROR_MAIN);

  const definitions = createToolDefinitions(runtime);
  const run = findTool(definitions, 'godot_run');
  const status = findTool(definitions, 'godot_status');
  const stop = findTool(definitions, 'godot_stop');

  const startedAt = Date.now();
  const value = await run.execute({ project: directory, keepAlive: true, bridge: true, timeoutMs: 20000 });
  const elapsed = Date.now() - startedAt;
  sessionId = value.session;

  assert.ok(elapsed < 5000, `a project without the bridge autoload must not block for the 15 s attach budget (took ${elapsed} ms)`);
  assert.equal(typeof value.session, 'string');
  assert.equal(value.bridge.attached, false);
  assert.equal(value.timedOut, false);
  assert.match(value.output, /no dsh_bridge autoload/);

  const sessionStatus = await status.execute({});
  const listed = sessionStatus.sessions.find((entry) => entry.id === sessionId);
  assert.ok(listed, `session ${sessionId} must stay registered so it can be read/stopped`);
  assert.equal(listed.bridge.attached, false);

  const stopped = await stop.execute({ session: sessionId });
  assert.deepEqual(stopped.stopped, [sessionId]);
  const pid = listed.pid;
  sessionId = undefined;
  await delay(400);
  assert.equal(pidAlive(pid), false, `godot_stop must kill pid ${pid}`);
});

test('godot_run without keepAlive captures the starter print line and times out on a running game', { skip: skipScaffold }, async (t) => {
  const root = makeRoot();
  const runtime = createRuntime({ enginePath: ENGINE });
  t.after(() => {
    runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const definitions = createToolDefinitions(runtime);
  const init = findTool(definitions, 'godot_project_init');
  const run = findTool(definitions, 'godot_run');

  const directory = path.join(root, 'starter-run');
  const project = await init.execute({ directory, name: 'Starter Run' });
  assert.equal(project.import.ok, true, `import diagnostics: ${JSON.stringify(project.import.diagnostics)}`);

  const value = await run.execute({ project: directory, timeoutMs: 4000 });
  assert.equal(value.timedOut, true, 'the starter keeps running until the timeout');
  assert.match(value.output, /STARTER_READY/);
  assert.match(value.output, /res:\/\/main\.tscn/);
  assert.equal(value.diagnostics.some((diagnostic) => diagnostic.severity === 'error'), false, JSON.stringify(value.diagnostics));
  await delay(400);
  assert.equal(pidAlive(value.pid), false, `a timed-out run must be killed (pid ${value.pid})`);
});
