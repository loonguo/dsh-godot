import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { captureSync, createSessionRegistry, runOnce } from '../src/runner.js';

const node = process.execPath;

/** Whether an OS process id still exists. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Small delay helper for process-death settling. */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('runOnce captures combined stdout+stderr and the exit code', async () => {
  const run = await runOnce({
    command: [node, '-e', 'process.stdout.write("HELLO_STDOUT\\n"); process.stderr.write("ERR_LINE\\n"); process.exit(0)'],
    timeoutMs: 15000,
  });
  assert.equal(run.exitCode, 0);
  assert.equal(run.timedOut, false);
  assert.match(run.output, /HELLO_STDOUT/);
  assert.match(run.output, /ERR_LINE/);
});

test('runOnce reports a non-zero exit code', async () => {
  const run = await runOnce({ command: [node, '-e', 'process.exit(7)'], timeoutMs: 15000 });
  assert.equal(run.exitCode, 7);
  assert.equal(run.timedOut, false);
});

test('runOnce turns a missing executable into an actionable error', async () => {
  await assert.rejects(
    () => runOnce({ command: [path.join(os.tmpdir(), 'definitely-missing-godot-binary.exe'), '--version'], timeoutMs: 5000 }),
    /cannot start|not found|ENOENT/i,
  );
});

test('Session.waitForOutput resolves once the line appears', async () => {
  const registry = createSessionRegistry();
  const session = registry.start({
    command: [node, '-e', 'setTimeout(() => console.log("LATE_LINE"), 250)'],
  });
  try {
    assert.equal(await session.waitForOutput(/LATE_LINE/, 5000), true);
    const info = await session.waitForExit(5000);
    assert.equal(info.timedOut, false);
    assert.equal(session.alive, false);
    assert.match(session.readOutput(), /LATE_LINE/);
  } finally {
    await registry.stopAll();
  }
});

test('Session.waitForOutput times out when the line never appears', async () => {
  const registry = createSessionRegistry();
  const session = registry.start({ command: [node, '-e', 'setInterval(() => {}, 1000)'] });
  try {
    assert.equal(await session.waitForOutput(/NEVER_APPEARS/, 300), false);
    assert.equal(session.alive, true);
  } finally {
    await registry.stopAll();
  }
});

test('timeout then stop kills the process and the session is no longer alive', async () => {
  const registry = createSessionRegistry();
  const session = registry.start({ command: [node, '-e', 'process.stdout.write("STARTED\\n"); setInterval(() => {}, 1000)'] });
  const pid = session.pid;
  const info = await session.waitForExit(400);
  assert.equal(info.timedOut, true);
  assert.equal(session.alive, true);
  assert.equal(await session.waitForOutput(/STARTED/, 3000), true);
  await registry.stop(session.id);
  assert.equal(session.alive, false);
  assert.equal(registry.get(session.id).alive, false);
  await delay(300);
  assert.equal(pidAlive(pid), false, `pid ${pid} must be gone after stop()`);
  await registry.stopAll();
  assert.deepEqual(registry.list(), []);
});

test('stopAll stops every live session and returns their ids', async () => {
  const registry = createSessionRegistry();
  const first = registry.start({ command: [node, '-e', 'setInterval(() => {}, 1000)'] });
  const second = registry.start({ command: [node, '-e', 'setInterval(() => {}, 1000)'] });
  const stopped = await registry.stopAll();
  assert.deepEqual(stopped.sort(), [first.id, second.id].sort());
  assert.equal(first.alive, false);
  assert.equal(second.alive, false);
  assert.equal(registry.list().length, 0);
});

test('registry ids are stable and short', () => {
  const registry = createSessionRegistry();
  const session = registry.start({ command: [node, '-e', 'process.exit(0)'], label: 'id test' });
  assert.equal(session.id, 'g1');
  assert.ok(session.startedAt.length > 0);
  assert.deepEqual(session.command.slice(0, 1), [node]);
  return registry.stopAll();
});

test('captureSync captures --version output from a real executable', () => {
  const result = captureSync(node, ['--version'], { timeoutMs: 15000 });
  assert.equal(result.exitCode, 0);
  assert.match(`${result.stdout}${result.stderr}`, /v\d+\.\d+\.\d+/);
});

test('captureSync reports a missing executable without throwing', () => {
  const result = captureSync(path.join(os.tmpdir(), 'missing-capture-probe.exe'), ['--version'], { timeoutMs: 5000 });
  assert.equal(result.exitCode, null);
});
