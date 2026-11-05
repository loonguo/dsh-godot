/**
 * Client-half contract test.
 *
 * The browser loads client.js through `window.__ModuleLoader__`. This test
 * provides that loader plus a minimal React and Cordis context, so the module's
 * shape (id === package name, declared injects, slot registration, locale
 * dictionaries) is verified without a browser.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.dirname(HERE);
const packageJson = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));

/** Load client.js as the page would and return what it registered. */
function loadClientModule() {
  const captured = { id: null, factory: null };
  const fakeWindow = {
    __ModuleLoader__: {
      load(definition) {
        captured.id = definition.id;
        captured.factory = definition.factory;
      },
    },
  };
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  };
  const require = (name) => {
    if (name === 'react') return React;
    throw new Error(`unexpected module import: ${name}`);
  };

  const source = fs.readFileSync(path.join(PACKAGE_DIR, 'client.js'), 'utf8');
  // Execute the module with a `window` binding: the file is a browser script.
  const run = new Function('window', `${source}\n`);
  run(fakeWindow);
  assert.ok(captured.factory, 'client.js must call window.__ModuleLoader__.load');
  return { id: captured.id, plugin: captured.factory(require), React };
}

test('client module id matches the package name the Host serves', () => {
  const { id } = loadClientModule();
  assert.equal(id, packageJson.name);
  assert.equal(packageJson.dsh.client.platform, 'web');
  assert.deepEqual(packageJson.exports['./client'], './client.js');
  assert.ok(packageJson.files.includes('client.js'), 'client.js must be published');
});

test('the toolbar registers the run/pause control in the session header utilities', () => {
  const { plugin } = loadClientModule();
  assert.deepEqual([...plugin.inject], ['slots']);

  const registered = { locales: [], injectKey: null, options: null, component: null };
  const ctx = {
    get: (name) =>
      name === 'locale'
        ? {
            register: (ns, locale, dict) => registered.locales.push({ ns, locale, dict }),
            bind: (ns) => (key) => `${ns}:${key}`,
          }
        : undefined,
    slots: {
      inject: (key, callback) => {
        registered.injectKey = key;
        callback();
      },
      register: (options, component) => {
        registered.options = options;
        registered.component = component;
      },
    },
  };
  plugin.apply(ctx);

  assert.equal(registered.injectKey, 'conversation.session.header.utilities');
  assert.equal(registered.options.name, 'conversation.session.header.utilities');
  assert.equal(registered.options.id, 'godot-runner');
  assert.equal(registered.options.order, 20);
  assert.equal(typeof registered.component, 'function');

  const locales = registered.locales.map((entry) => entry.locale);
  assert.deepEqual([...locales].sort(), ['en', 'zh']);
  for (const entry of registered.locales) {
    assert.equal(entry.ns, 'dsh-godot');
    for (const key of ['run', 'pause', 'resume', 'stop', 'running', 'paused', 'idle', 'failed']) {
      assert.equal(typeof entry.dict[key], 'string', `${entry.locale}.${key} must be a string`);
    }
  }
});

test('the toolbar component renders a toggle and a stop control from a session id', () => {
  const { plugin, React } = loadClientModule();
  let component = null;
  plugin.apply({
    get: () => undefined,
    slots: { inject: (key, callback) => callback(), register: (options, candidate) => (component = candidate) },
  });
  assert.ok(component);

  // The registered factory renders the inner GodotRunner component.
  const element = component({ sessionId: 'session-1' });
  assert.equal(typeof element.type, 'function');
  assert.equal(element.props.sessionId, 'session-1');

  const rendered = element.type({ translate: (key) => key, sessionId: 'session-1' });
  assert.equal(rendered.type, 'div');
  assert.equal(rendered.props.role, 'group');
  const buttons = rendered.children.filter((child) => child && child.type === 'button');
  assert.equal(buttons.length, 2, 'expected a run/pause toggle and a stop button');
  assert.ok(React, 'react runtime is required by the module');

  const toggle = buttons[0];
  assert.equal(typeof toggle.props.onClick, 'function');
  assert.equal(toggle.props.disabled, false);
  const stop = buttons[1];
  assert.equal(stop.props.disabled, true, 'stop is disabled while no game runs');
});
