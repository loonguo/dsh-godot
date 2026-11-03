/**
 * Regression tests for defect D1: `godot_run { keepAlive: true, bridge: true }`
 * must wait for the bridge attach instead of returning ~1.5 s after the first
 * output line (which loses windowed runs whose Vulkan/GL startup connects
 * seconds after the engine banner).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BridgeServer } from '../src/bridge.js';
import { projectHasBridgeAutoload } from '../src/project.js';
import { createSessionRegistry } from '../src/runner.js';
import { createRuntime, createToolDefinitions, waitForKeepAliveBridge, waitForKeepAliveRun } from '../src/tools.js';

const node = process.execPath;

const AUTOLOAD_ROW = '[autoload]\n\nBridge="*res://addons/dsh_bridge/dsh_bridge.gd"\n';

function projectText({ withAutoload }) {
  return `config_version=5\n\n[application]\n\nconfig/name="Fake"\nrun/main_scene="res://main.tscn"\n${withAutoload ? `\n${AUTOLOAD_ROW}` : ''}`;
}

/** Write a minimal project.godot and return its directory. */
function makeProject(root, name, { withAutoload }) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'project.godot'), projectText({ withAutoload }), 'utf8');
  return directory;
}

/** A fake windowed game: prints a banner immediately, connects/attaches after ~3 s. */
const DELAYED_ATTACH_GAME = `
import net from 'node:net';

console.log('FAKE_GAME_BANNER');

setTimeout(() => {
  const socket = net.connect(Number(process.argv[2]), '127.0.0.1');
  socket.setEncoding('utf8');
  socket.on('connect', () => {
    socket.write(JSON.stringify({ event: 'ready', engine: '4.7.2', project: 'Fake', scene: 'res://main.tscn', pid: process.pid }) + '\\n');
  });
  socket.on('data', () => {});
  socket.on('error', () => {});
}, 3000);

setInterval(() => {}, 1000);
`;

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-godot-keepalive-'));
}

test('waitForKeepAliveBridge waits for a late attach instead of settling on output', async (t) => {
  const root = makeRoot();
  const gameFile = path.join(root, 'delayed-attach-game.mjs');
  fs.writeFileSync(gameFile, DELAYED_ATTACH_GAME, 'utf8');
  const registry = createSessionRegistry();
  const bridge = new BridgeServer({ readyTimeoutMs: 15000 });
  await bridge.start();
  const session = registry.start({ command: [node, gameFile, String(bridge.port)] });
  session.bridge = bridge;
  t.after(async () => {
    bridge.close();
    await registry.stopAll();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // The game has already printed a line, so the old implementation's
  // settleForOutput fallback would win the race ~1.5 s after this point.
  assert.equal(await session.waitForOutput(/FAKE_GAME_BANNER/, 5000), true);

  const started = Date.now();
  const outcome = await waitForKeepAliveBridge(session, bridge, { timeoutMs: 15000 });
  const elapsed = Date.now() - started;

  assert.equal(outcome.attached, true, 'the wait policy must return attached once the game connects');
  assert.equal(outcome.dead, false);
  assert.equal(outcome.timedOut, false);
  assert.ok(elapsed >= 2500, `attach policy must keep waiting for the 3 s deferred connect (waited ${elapsed} ms)`);
  assert.ok(bridge.readyInfo !== null);
  assert.equal(bridge.readyInfo.engine, '4.7.2');
  assert.equal(bridge.readyInfo.project, 'Fake');
});

test('waitForKeepAliveBridge reports an exited game with its exit code instead of an unattached session', async (t) => {
  const registry = createSessionRegistry();
  const bridge = new BridgeServer({ readyTimeoutMs: 15000 });
  await bridge.start();
  const session = registry.start({
    command: [node, '-e', 'process.stdout.write("GAME_DIED_BEFORE_ATTACH\\n"); process.exit(9)'],
  });
  t.after(async () => {
    bridge.close();
    await registry.stopAll();
  });

  const outcome = await waitForKeepAliveBridge(session, bridge, { timeoutMs: 5000 });
  assert.equal(outcome.attached, false);
  assert.equal(outcome.dead, true);
  assert.equal(outcome.exitCode, 9);
  assert.match(session.readOutput(), /GAME_DIED_BEFORE_ATTACH/);
});

test('waitForKeepAliveBridge times out with a live but unattached game', async (t) => {
  const registry = createSessionRegistry();
  const bridge = new BridgeServer({ readyTimeoutMs: 15000 });
  await bridge.start();
  const session = registry.start({ command: [node, '-e', 'setInterval(() => {}, 1000)'] });
  t.after(async () => {
    bridge.close();
    await registry.stopAll();
  });

  const outcome = await waitForKeepAliveBridge(session, bridge, { timeoutMs: 400 });
  assert.equal(outcome.attached, false);
  assert.equal(outcome.dead, false);
  assert.equal(outcome.timedOut, true);
  assert.equal(session.alive, true);
});

test('godot_run keepAlive+bridge returns exitCode and output when the game dies before attaching', async (t) => {
  const root = makeRoot();
  // The autoload is present, so the attach-authoritative wait is used and the
  // immediate process death is reported as a dead result rather than a session.
  const projectDir = makeProject(root, 'fake-project', { withAutoload: true });

  // A "fake engine" whose executable is this node binary: it rejects the
  // Godot-style argv immediately, which exercises the dead-before-attach path
  // without needing a real game window.
  const runtime = createRuntime({});
  runtime.engineCache = { path: node, version: '4.7.2', console: true };
  t.after(() => {
    runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const run = createToolDefinitions(runtime).find((tool) => tool.name === 'godot_run');
  const value = await run.execute({ project: projectDir, keepAlive: true, bridge: true, timeoutMs: 5000 });

  assert.equal(value.session, undefined, 'a game that died before attaching must not look like a live session');
  assert.equal(value.bridge.attached, false);
  assert.equal(typeof value.exitCode, 'number');
  assert.notEqual(value.exitCode, 0);
  assert.match(value.output, /bad option/i);
  assert.equal(value.timedOut, false);
  assert.equal(value.pid > 0, true);
  assert.equal(runtime.sessions.list().length, 0, 'the dead session must be removed from the registry');
});

/* -------------------------------------------------------------------------- */
/* F5: projects that can never attach must not block for the 15 s budget      */
/* -------------------------------------------------------------------------- */

test('projectHasBridgeAutoload detects the [autoload] section only', () => {
  const root = makeRoot();
  try {
    const withRow = makeProject(root, 'with-autoload', { withAutoload: true });
    assert.equal(projectHasBridgeAutoload(withRow), true);
    assert.equal(projectHasBridgeAutoload(path.join(withRow, 'project.godot')), true);

    const withoutRow = makeProject(root, 'without-autoload', { withAutoload: false });
    assert.equal(projectHasBridgeAutoload(withoutRow), false);

    // A dsh_bridge reference outside [autoload] does not count as an autoload.
    fs.writeFileSync(
      path.join(withoutRow, 'project.godot'),
      `${projectText({ withAutoload: false })}\n[display]\n\nwindow/size/test="res://addons/dsh_bridge/dsh_bridge.gd"\n`,
      'utf8',
    );
    assert.equal(projectHasBridgeAutoload(withoutRow), false);

    assert.equal(projectHasBridgeAutoload(path.join(root, 'missing-project')), false);
    assert.equal(projectHasBridgeAutoload(''), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('waitForKeepAliveRun skips the attach wait when the project has no bridge autoload', async (t) => {
  const root = makeRoot();
  const projectDir = makeProject(root, 'no-autoload', { withAutoload: false });
  const registry = createSessionRegistry();
  const bridge = new BridgeServer({ readyTimeoutMs: 15000 });
  await bridge.start();
  const session = registry.start({ command: [node, '-e', 'process.stdout.write("SILENT_GAME\\n"); setInterval(() => {}, 1000)'] });
  t.after(async () => {
    bridge.close();
    await registry.stopAll();
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal(await session.waitForOutput(/SILENT_GAME/, 5000), true);

  const started = Date.now();
  const outcome = await waitForKeepAliveRun(session, bridge, { projectDir, timeoutMs: 15000 });
  const elapsed = Date.now() - started;

  assert.equal(outcome.mode, 'no-autoload');
  assert.equal(outcome.attached, false);
  assert.equal(outcome.timedOut, false);
  assert.match(outcome.hint, /no dsh_bridge autoload/);
  assert.ok(elapsed < 5000, `an unattachable project must not block for the 15 s budget (took ${elapsed} ms)`);
  assert.ok(elapsed >= 1000, `the no-autoload path still settles for output (took ${elapsed} ms)`);
});

test('waitForKeepAliveRun times out with a hint when the autoload exists but the game never connects', async (t) => {
  const root = makeRoot();
  const projectDir = makeProject(root, 'with-autoload', { withAutoload: true });
  const registry = createSessionRegistry();
  const bridge = new BridgeServer({ readyTimeoutMs: 15000 });
  await bridge.start();
  const session = registry.start({ command: [node, '-e', 'setInterval(() => {}, 1000)'] });
  t.after(async () => {
    bridge.close();
    await registry.stopAll();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const outcome = await waitForKeepAliveRun(session, bridge, { projectDir, timeoutMs: 500 });
  assert.equal(outcome.mode, 'attach-timeout');
  assert.equal(outcome.attached, false);
  assert.equal(outcome.timedOut, true);
  assert.match(outcome.hint, /did not attach within 500 ms/);
  assert.match(outcome.hint, new RegExp(session.id));
  assert.equal(session.alive, true);
});

test('godot_run keepAlive+bridge on a project without the autoload returns in ~1.5 s with a hint', async (t) => {
  const root = makeRoot();
  const projectDir = makeProject(root, 'no-autoload-run', { withAutoload: false });
  // Fake engine (node) that dies at once: still proves the call does not wait
  // for a bridge that cannot attach.
  const runtime = createRuntime({});
  runtime.engineCache = { path: node, version: '4.7.2', console: true };
  t.after(() => {
    runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const definitions = createToolDefinitions(runtime);
  const run = definitions.find((tool) => tool.name === 'godot_run');
  const stop = definitions.find((tool) => tool.name === 'godot_stop');
  const started = Date.now();
  const value = await run.execute({ project: projectDir, keepAlive: true, bridge: true, timeoutMs: 20000 });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 5000, `an unattachable project must not block for the 15 s attach budget (took ${elapsed} ms)`);
  assert.equal(typeof value.session, 'string');
  assert.equal(value.bridge.attached, false);
  assert.equal(value.timedOut, false);
  assert.match(value.output, /no dsh_bridge autoload/);
  assert.equal(runtime.sessions.list().length, 1, 'the session is kept alive so the caller can read output and stop it');

  const stopped = await stop.execute({ session: value.session });
  assert.deepEqual(stopped.stopped, [value.session]);
  assert.equal(runtime.sessions.list().length, 0);
});
