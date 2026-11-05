/**
 * Real-engine test for the toolbar's game controller (src/control.js).
 *
 * A headless run keeps the test non-intrusive, but the controller and bridge code
 * path is the same one the Web toolbar uses: start -> pause (game frozen, bridge
 * still answering) -> resume -> stop.
 *
 * Skips gracefully when Godot 4.x is missing at the CONTRACT §0 path.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createController } from '../src/control.js';
import { scaffoldProject } from '../src/project.js';
import { createRuntime } from '../src/tools.js';

const ENGINE = 'D:\\Software\\Godot_v4.7.2-stable_win64.exe\\Godot_v4.7.2-stable_win64_console.exe';
const skip = fs.existsSync(ENGINE) ? false : 'real Godot 4.x engine not installed at the CONTRACT §0 path';

const GAME = `extends Node
## Fixture that proves pause really freezes gameplay.

var ticks := 0


func _process(_delta: float) -> void:
	ticks += 1


func debug_state() -> Dictionary:
	return {"ticks": ticks}
`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Guard a controller call so a serialization deadlock fails instead of hanging. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms)),
  ]);
}

async function debugTicks(session, bridge) {
  const reply = await bridge.request('node_call', { path: '/root/Main', method: 'debug_state' });
  assert.equal(reply.ok, true, `node_call failed: ${reply.error ?? ''}`);
  return reply.result.return.ticks;
}

test('controller starts, pauses, resumes and stops a real game', { skip, timeout: 180000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-godot-control-'));
  const runtime = createRuntime({ enginePath: ENGINE, defaultTimeoutMs: 20000 });
  const controller = createController(runtime, {});
  try {
    await scaffoldProject({ directory, name: 'ControlFixture', template: '2d', import: true, config: { enginePath: ENGINE } });
    fs.writeFileSync(path.join(directory, 'main.gd'), GAME, 'utf8');

    const idle = controller.state();
    assert.equal(idle.running, false);

    const started = await controller.start({ project: directory, headless: true });
    assert.equal(started.running, true, `start failed: ${JSON.stringify(started)}`);
    assert.equal(started.bridge, 'attached');
    assert.equal(started.paused, false);
    assert.ok(started.sessionId, 'a running game has a session id');

    const session = runtime.sessions.get(started.sessionId);
    assert.ok(session && session.alive, 'session should be alive');
    const bridge = session.bridge;
    assert.ok(bridge && bridge.attached, 'bridge should be attached');

    const before = await debugTicks(session, bridge);
    await wait(400);
    const ticking = await debugTicks(session, bridge);
    assert.ok(ticking > before, `a running game should tick (${before} -> ${ticking})`);

    const paused = await controller.pause();
    assert.equal(paused.paused, true);
    const ping = await bridge.request('ping');
    assert.equal(ping.result.paused, true, 'ping reports the paused flag');

    const frozenBefore = await debugTicks(session, bridge);
    await wait(600);
    const frozenAfter = await debugTicks(session, bridge);
    assert.equal(frozenAfter, frozenBefore, `a paused game must not tick (${frozenBefore} -> ${frozenAfter})`);

    const resumed = await controller.resume();
    assert.equal(resumed.paused, false);
    await wait(400);
    const afterResume = await debugTicks(session, bridge);
    assert.ok(afterResume > frozenAfter, `a resumed game should tick again (${frozenAfter} -> ${afterResume})`);

    // The toolbar button uses `toggle`; nested serialization used to deadlock here.
    const toggledToPause = await withTimeout(controller.act('toggle'), 8000, 'toggle -> pause');
    assert.equal(toggledToPause.paused, true);
    const toggledToResume = await withTimeout(controller.act('toggle'), 8000, 'toggle -> resume');
    assert.equal(toggledToResume.paused, false);

    const stopped = await controller.stop();
    assert.equal(stopped.running, false);
    await wait(300);
    assert.equal(session.alive, false, 'stop must end the Godot process');
    assert.equal(runtime.sessions.list().length, 0, 'the session registry must be empty');
  } finally {
    controller.dispose();
    runtime.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('controller rejects actions without a running game', { skip, timeout: 30000 }, async () => {
  const runtime = createRuntime({ enginePath: ENGINE });
  const controller = createController(runtime, {});
  try {
    await assert.rejects(() => controller.pause(), /no game is running/);
    await assert.rejects(() => controller.act('explode'), /unknown action/);
    assert.equal(controller.state().running, false);
  } finally {
    controller.dispose();
    runtime.dispose();
  }
});
