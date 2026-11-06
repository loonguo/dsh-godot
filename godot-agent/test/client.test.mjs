/**
 * Client-half contract test.
 *
 * The browser loads client.js through `window.__ModuleLoader__`. This test
 * provides that loader plus a minimal React and Cordis context, so the module's
 * shape is verified without a browser: the module id, the two slot entries, the
 * movable floating panel's DOM contract and the locale dictionaries.
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
function loadClientModule(options = {}) {
  const captured = { id: null, factory: null };
  const fakeWindow = {
    __ModuleLoader__: {
      load(definition) {
        captured.id = definition.id;
        captured.factory = definition.factory;
      },
    },
    // Enough of a browser for effects that run in the immediate-refresh test.
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  const React = options.react ?? {
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

/** A context that records every slot injection and registration. */
function recordingContext() {
  const record = { injectedKeys: [], registrations: [], locales: [] };
  const ctx = {
    get: (name) =>
      name === 'locale'
        ? {
            register: (ns, locale, dict) => record.locales.push({ ns, locale, dict }),
            bind: (ns) => (key) => `${ns}:${key}`,
          }
        : undefined,
    slots: {
      inject: (key, callback) => {
        record.injectedKeys.push(key);
        callback();
      },
      register: (options, component) => {
        record.registrations.push({ options, component });
      },
    },
  };
  return { ctx, record };
}

test('client module id matches the package name the Host serves', () => {
  const { id } = loadClientModule();
  assert.equal(id, packageJson.name);
  assert.equal(packageJson.dsh.client.platform, 'web');
  assert.deepEqual(packageJson.exports['./client'], './client.js');
  assert.ok(packageJson.files.includes('client.js'), 'client.js must be published');
});

test('the floating panel registers in shell.overlay plus a session-id bridge', () => {
  const { plugin } = loadClientModule();
  assert.deepEqual([...plugin.inject], ['slots']);

  const { ctx, record } = recordingContext();
  plugin.apply(ctx);

  assert.deepEqual([...record.injectedKeys].sort(), ['conversation.session.header.utilities', 'shell.overlay']);
  const overlay = record.registrations.find((entry) => entry.options.name === 'shell.overlay');
  const bridge = record.registrations.find((entry) => entry.options.name === 'conversation.session.header.utilities');
  assert.ok(overlay, 'expected a shell.overlay registration (the movable panel)');
  assert.ok(bridge, 'expected a session header bridge entry');
  assert.equal(overlay.options.id, 'godot-float');
  assert.equal(bridge.options.id, 'godot-session-bridge');
  assert.equal(typeof overlay.component, 'function');

  const locales = record.locales.map((entry) => entry.locale);
  assert.deepEqual([...locales].sort(), ['en', 'zh']);
  for (const entry of record.locales) {
    assert.equal(entry.ns, 'dsh-godot');
    for (const key of ['run', 'pause', 'resume', 'stop', 'running', 'paused', 'idle', 'failed', 'moveHint']) {
      assert.equal(typeof entry.dict[key], 'string', `${entry.locale}.${key} must be a string`);
    }
  }
});

test('the floating panel is fixed-positioned, draggable and keeps the run/stop controls', () => {
  const { plugin, React } = loadClientModule();
  const { ctx, record } = recordingContext();
  plugin.apply(ctx);
  const overlay = record.registrations.find((entry) => entry.options.name === 'shell.overlay');
  assert.ok(overlay);
  assert.ok(React, 'react runtime is required by the module');

  // Hidden until a workspace with a Godot project is known.
  assert.equal(overlay.component({}), null, 'the panel must stay hidden without workspace information');
  assert.equal(
    overlay.component({ initialState: { running: false, workspace: { available: false, projectName: null } } }),
    null,
    'the panel must stay hidden when the workspace has no Godot project',
  );

  const rendered = overlay.component({
    initialState: { running: false, workspace: { available: true, projectName: 'Star Catcher' } },
  });
  assert.equal(rendered.type, 'div');
  assert.equal(rendered.props.role, 'group');
  assert.equal(rendered.props.style.position, 'fixed', 'the panel must float above the app');
  assert.equal(rendered.props.style.pointerEvents, 'auto', 'the overlay layer is click-through; the panel opts back in');
  assert.equal(rendered.props.style.cursor, 'grab');
  assert.equal(typeof rendered.props.onPointerDown, 'function', 'dragging starts on pointer down');
  assert.equal(typeof rendered.props.onDoubleClick, 'function', 'double-click resets the position');
  assert.match(rendered.props.title, /moveHint|move/i);

  const buttons = rendered.children.filter((child) => child && child.type === 'button');
  assert.equal(buttons.length, 2, 'expected a run/pause toggle and a stop button');
  assert.equal(typeof buttons[0].props.onClick, 'function');
  assert.equal(buttons[0].props.disabled, false);
  assert.equal(buttons[1].props.disabled, true, 'stop is disabled while no game runs');

  // An idle panel names the workspace project so the run button is self-explanatory.
  const label = rendered.children.find((child) => child && child.type === 'span' && child.props.style && child.props.style.overflow === 'hidden');
  assert.ok(label, 'expected a status label');
  assert.match(String(label.children[0]), /Star Catcher/);

  // A running game keeps the panel visible even if the workspace check fails.
  const running = overlay.component({ initialState: { running: true, workspace: { available: false } } });
  assert.equal(running.type, 'div');
});

test('the session bridge records the conversation id for the overlay', () => {
  const { plugin } = loadClientModule();
  const { ctx, record } = recordingContext();
  plugin.apply(ctx);
  const bridge = record.registrations.find((entry) => entry.options.name === 'conversation.session.header.utilities');
  assert.ok(bridge);
  // The bridge renders nothing; its effect stores the id when React mounts it.
  assert.equal(bridge.component({ sessionId: 'session-42' }), null);
});

test('switching sessions refreshes the panel immediately instead of waiting for the poll', async () => {
  // A React whose effects run on mount, so the session bridge and the panel's
  // subscription can be exercised the way the browser mounts them.
  const cleanups = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: (effect) => {
      const cleanup = effect();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
  };
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let polls = 0;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const sessionId = new URL(String(url), 'http://127.0.0.1').searchParams.get('sessionId');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        state: { running: false, paused: false, workspace: { available: sessionId === 'session-a', projectName: 'Game A' } },
      }),
    };
  };
  globalThis.setInterval = () => {
    polls += 1;
    return polls;
  };
  globalThis.clearInterval = () => {};

  try {
    const { plugin } = loadClientModule({ react });
    const { ctx, record } = recordingContext();
    plugin.apply(ctx);
    const bridge = record.registrations.find((entry) => entry.options.name === 'conversation.session.header.utilities');
    const overlay = record.registrations.find((entry) => entry.options.name === 'shell.overlay');
    assert.ok(bridge && overlay);

    // Mount order in the page: the panel first, then the header bridge.
    overlay.component({});
    assert.equal(calls.length, 1, 'the panel loads state once on mount');
    assert.equal(calls[0].includes('sessionId='), false, 'no session is known yet');

    bridge.component({ sessionId: 'session-a' });
    assert.equal(calls.length, 2, 'a Session switch must trigger an immediate refresh');
    assert.match(calls[1], /sessionId=session-a/);

    bridge.component({ sessionId: 'session-b' });
    assert.equal(calls.length, 3, 'each switch refreshes immediately, not on the next poll');
    assert.match(calls[2], /sessionId=session-b/);

    // Re-rendering the same session must not add traffic.
    bridge.component({ sessionId: 'session-b' });
    assert.equal(calls.length, 3, 'an unchanged session does not refresh again');

    // Unmounting the header (Plugins/Settings/New Session: no conversation open)
    // must clear the Session, otherwise the panel keeps a stale workspace answer.
    const beforeUnmount = calls.length;
    cleanups[cleanups.length - 1]();
    assert.equal(calls.length, beforeUnmount + 1, 'unmounting the session header triggers a refresh');
    assert.equal(calls.at(-1).includes('sessionId='), false, 'no conversation means no workspace decision');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch {
        /* ignore */
      }
    }
  }
});
