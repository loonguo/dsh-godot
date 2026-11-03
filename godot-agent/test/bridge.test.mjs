import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BridgeServer } from '../src/bridge.js';

/** A fake "game": connects out, sends `ready`, answers the CONTRACT §4 commands. */
const FAKE_GAME = `
import net from 'node:net';

const port = Number(process.argv[2]);
const socket = net.connect(port, '127.0.0.1');
socket.setEncoding('utf8');
let buffer = '';
const send = (message) => socket.write(JSON.stringify(message) + '\\n');

socket.on('connect', () => {
  send({ event: 'ready', engine: '4.7.2', project: 'Fake', scene: 'res://main.tscn', pid: process.pid });
});

socket.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\\n');
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length === 0) continue;
    const message = JSON.parse(line);
    const id = message.id;
    switch (message.cmd) {
      case 'ping':
        send({ id, ok: true, result: { pong: true, scene: 'res://main.tscn' } });
        break;
      case 'tree':
        send({ id, ok: true, result: { root: { name: 'Main', path: '/root/Main', type: 'Node2D', scene: 'res://main.tscn', children: [] } } });
        break;
      case 'node':
        send({ id, ok: true, result: { name: 'Main', path: message.args?.path ?? '/root/Main', type: 'Node2D', script: 'res://main.gd', properties: { visible: true } } });
        break;
      case 'node_set':
        send({ id, ok: true, result: { value: message.args?.value ?? null } });
        break;
      case 'node_call':
        send({ id, ok: true, result: { return: 42 } });
        break;
      case 'quit':
        send({ id, ok: true, result: {} });
        setTimeout(() => process.exit(0), 50);
        break;
      case 'slow':
        break;
      default:
        send({ id, ok: false, error: 'unknown command: ' + message.cmd });
    }
  }
});

socket.on('error', () => process.exit(0));
`;

function writeFakeGame(directory) {
  const file = path.join(directory, 'fake-game.mjs');
  fs.writeFileSync(file, FAKE_GAME, 'utf8');
  return file;
}

test('BridgeServer rejects requests before a game attaches', async () => {
  const server = new BridgeServer({ readyTimeoutMs: 500 });
  await server.start();
  try {
    assert.ok(server.port > 0);
    assert.equal(server.attached, false);
    await assert.rejects(() => server.request('ping'), /bridge is not attached/);
    await assert.rejects(() => server.waitForReady(300), /did not attach/i);
  } finally {
    server.close();
  }
});

test('BridgeServer.close rejects a pending waitForReady', async () => {
  const server = new BridgeServer({ readyTimeoutMs: 5000 });
  await server.start();
  const waiting = server.waitForReady(5000);
  server.close();
  await assert.rejects(waiting, /closed before the game attached/);
});

test('BridgeServer round-trips NDJSON commands with a fake game', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-godot-bridge-'));
  const fakeGame = writeFakeGame(directory);
  const server = new BridgeServer({ requestTimeoutMs: 1500, readyTimeoutMs: 10000 });
  await server.start();

  const child = spawn(process.execPath, [fakeGame, String(server.port)], { stdio: 'ignore', windowsHide: true });

  t.after(async () => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const ready = await server.waitForReady(10000);
  assert.equal(ready.engine, '4.7.2');
  assert.equal(ready.project, 'Fake');
  assert.equal(ready.scene, 'res://main.tscn');
  assert.equal(server.attached, true);

  const ping = await server.request('ping');
  assert.deepEqual(ping, { ok: true, result: { pong: true, scene: 'res://main.tscn' } });

  const tree = await server.request('tree', { depth: 2 });
  assert.equal(tree.ok, true);
  assert.equal(tree.result.root.name, 'Main');

  const node = await server.request('node', { path: '/root/Main' });
  assert.equal(node.ok, true);
  assert.equal(node.result.path, '/root/Main');

  const nodeSet = await server.request('node_set', { path: '/root/Main', property: 'visible', value: false });
  assert.deepEqual(nodeSet, { ok: true, result: { value: false } });

  const nodeCall = await server.request('node_call', { path: '/root/Main', method: 'dsh_probe' });
  assert.deepEqual(nodeCall, { ok: true, result: { return: 42 } });

  const unknown = await server.request('bogus');
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown command/);

  const slow = await server.request('slow');
  assert.equal(slow.ok, false);
  assert.match(slow.error, /timed out/);

  const quit = await server.request('quit');
  assert.deepEqual(quit, { ok: true, result: {} });
});

test('BridgeServer fails in-flight requests when the game disconnects', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-godot-bridge-'));
  const fakeGame = writeFakeGame(directory);
  const server = new BridgeServer({ requestTimeoutMs: 10000, readyTimeoutMs: 10000 });
  await server.start();
  const child = spawn(process.execPath, [fakeGame, String(server.port)], { stdio: 'ignore', windowsHide: true });
  t.after(() => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await server.waitForReady(10000);
  const pending = server.request('slow');
  child.kill();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /closed the bridge connection|timed out/);
});

test('BridgeServer.close resolves pending requests and detaches', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-godot-bridge-'));
  const fakeGame = writeFakeGame(directory);
  const server = new BridgeServer({ requestTimeoutMs: 10000, readyTimeoutMs: 10000 });
  await server.start();
  const child = spawn(process.execPath, [fakeGame, String(server.port)], { stdio: 'ignore', windowsHide: true });
  t.after(() => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await server.waitForReady(10000);
  const pending = server.request('slow');
  server.close();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /closed/);
  assert.equal(server.attached, false);
  await assert.rejects(() => server.request('ping'), /not attached/);
});
