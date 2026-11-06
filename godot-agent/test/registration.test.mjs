/**
 * Host activation-order test.
 *
 * Bug reproduced: every DSH restart lost the floating panel until the plugin was
 * reloaded by hand, because the row can activate before the web carrier is
 * listening. Caching `webServer`/`agents`/`workingDirectory` at apply time made
 * the toolbar routes never register and every Session lookup fail.
 *
 * These tests drive the plugin with a context whose services appear *after*
 * apply, which is what the boot path does.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apply, whenServiceAvailable } from '../index.js';

/** Fake plugin context: services live in a mutable map and can arrive late. */
function makeContext(services = {}, { injectable = true } = {}) {
  const tools = [];
  const effects = [];
  const injections = [];
  const map = { ...services };
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
    effect(effect) {
      const dispose = effect();
      if (typeof dispose === 'function') effects.push(dispose);
      return dispose;
    },
    get(name) {
      return map[name];
    },
    ...(injectable
      ? {
          inject(deps, callback) {
            injections.push({ deps, callback });
            return () => {};
          },
        }
      : {}),
  };
  return { ctx, tools, effects, injections, services: map };
}

function fakeWebServer() {
  const routes = [];
  return {
    routes,
    register(route) {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('toolbar routes register immediately when the web carrier already exists', () => {
  const webServer = fakeWebServer();
  const { ctx, tools, effects } = makeContext({ webServer });
  apply(ctx, {});
  assert.equal(tools.length, 6, 'the six godot tools still register');
  assert.deepEqual(
    webServer.routes.map((route) => route.path),
    ['/dsh-godot/state', '/dsh-godot/control'],
  );
  assert.equal(webServer.routes[0].kind, 'exact');
  for (const dispose of effects.reverse()) dispose();
  assert.equal(webServer.routes.length, 0, 'dispose removes the routes');
});

test('toolbar routes wait for a web carrier that activates after this row', async () => {
  const { ctx, effects, injections, services } = makeContext({});
  apply(ctx, {});
  assert.equal(injections.length, 1, 'the plugin asks Cordis for the webServer dependency');
  assert.deepEqual(injections[0].deps, ['webServer']);

  const webServer = fakeWebServer();
  services.webServer = webServer;
  injections[0].callback();

  assert.deepEqual(
    webServer.routes.map((route) => route.path),
    ['/dsh-godot/state', '/dsh-godot/control'],
    'routes register when the dependency resolves',
  );
  for (const dispose of effects.reverse()) dispose();
});

test('toolbar routes still recover through the bounded poll when injection never fires', async () => {
  const { ctx, effects, services } = makeContext({}, { injectable: false });
  apply(ctx, {});
  const webServer = fakeWebServer();
  services.webServer = webServer;
  await wait(400); // one poll interval is 250 ms
  assert.equal(webServer.routes.length, 2, 'the poll fallback registers the routes');
  for (const dispose of effects.reverse()) dispose();
  assert.equal(webServer.routes.length, 0);
});

test('a Session lookup reads agents/workingDirectory when the page asks, not at apply time', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-godot-boot-'));
  const projectDir = path.join(workspace, 'game');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'project.godot'),
    'config_version=5\n\n[application]\n\nconfig/name="Boot Game"\nrun/main_scene="res://main.tscn"\n',
    'utf8',
  );

  const webServer = fakeWebServer();
  const { ctx, effects } = makeContext({ webServer });
  apply(ctx, {});

  // The services the plugin needs for Session resolution appear later.
  const session = { id: 'session-boot' };
  ctx.get = (name) => {
    if (name === 'agents') return { get: (id) => (id === 'session-boot' ? { session } : undefined) };
    if (name === 'workingDirectory') return { get: () => workspace };
    if (name === 'webServer') return webServer;
    return undefined;
  };

  const route = webServer.routes.find((entry) => entry.path === '/dsh-godot/state');
  assert.ok(route);
  let body = '';
  const response = {
    statusCode: 0,
    setHeader() {},
    end(chunk) {
      body += chunk;
    },
  };
  await route.handler(
    { method: 'GET', url: '/dsh-godot/state?sessionId=session-boot', headers: {} },
    response,
  );

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(body);
  assert.equal(payload.ok, true);
  assert.equal(payload.state.workspace.available, true, 'the panel must become visible after a restart');
  assert.equal(path.resolve(payload.state.workspace.directory), path.resolve(workspace));
  assert.equal(payload.state.workspace.projectName, 'Boot Game');

  for (const dispose of effects.reverse()) dispose();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('whenServiceAvailable runs once and stops waiting on dispose', async () => {
  const { ctx, services } = makeContext({});
  let calls = 0;
  const dispose = whenServiceAvailable(ctx, 'webServer', () => {
    calls += 1;
  });
  services.webServer = { register: () => () => {} };
  await wait(400);
  assert.equal(calls, 1);
  dispose();
  // Already-consumed services never run again.
  await wait(300);
  assert.equal(calls, 1);
});
