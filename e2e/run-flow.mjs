/**
 * Lead-owned end-to-end demonstration of the dsh-godot tools, run exactly the
 * way the agent will run them once the bundle is installed: the six tools are
 * registered through `apply(fakeCtx, config)` and then invoked by name.
 *
 * Flow: scaffold a project with godot_project_init -> overwrite the starter with
 * a small game the "agent" wrote -> godot_check -> inject a real GDScript bug ->
 * godot_check must pinpoint it -> fix -> run headless -> drive the live game over
 * godot_bridge (tree/node/state/call/input/frames) -> windowed screenshot ->
 * godot_stop. Exit code 0 only when every assertion holds.
 *
 * Run: node e2e/run-flow.mjs
 */

import { existsSync, mkdirSync, readFileSync, rmSync, copyFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply } from '../godot-agent/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const GAME = path.join(HERE, 'game');
const EVIDENCE = path.join(HERE, 'evidence');
const ENGINE = 'D:\\Software\\Godot_v4.7.2-stable_win64.exe\\Godot_v4.7.2-stable_win64_console.exe';

const results = [];
function check(label, condition, detail = '') {
  results.push({ label, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  return Boolean(condition);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------------------- registry */

const registered = new Map();
const disposers = [];
const fakeCtx = {
  tools: {
    register(definition) {
      if (registered.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
      registered.set(definition.name, definition);
      const dispose = () => registered.delete(definition.name);
      disposers.push(dispose);
      return dispose;
    },
  },
  effect(run) {
    const dispose = run();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  },
};

apply(fakeCtx, { enginePath: ENGINE, projectRoot: GAME, defaultTimeoutMs: 15000 });

const EXPECTED = ['godot_status', 'godot_project_init', 'godot_check', 'godot_run', 'godot_bridge', 'godot_stop'];
check('apply() registers the six godot_* tools', EXPECTED.every((name) => registered.has(name)), [...registered.keys()].join(','));

const tools = Object.fromEntries([...registered.entries()]);
async function call(name, args = {}) {
  const tool = tools[name];
  if (!tool) throw new Error(`tool ${name} is not registered`);
  return tool.execute(args);
}

/* ------------------------------------------------------------------- flow */

rmSync(GAME, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

const status0 = await call('godot_status');
check('godot_status finds the engine with no config beyond enginePath', status0.engine !== null && /^4\./.test(status0.engine.version ?? ''), status0.engine ? `Godot ${status0.engine.version} console=${status0.engine.console}` : 'engine NOT FOUND');

const init = await call('godot_project_init', { directory: GAME, name: 'Star Catcher', import: true });
check('godot_project_init scaffolds a runnable project', init.import.ok && existsSync(path.join(GAME, 'project.godot')), `${init.files.length} files, import exit ${init.import.exitCode}`);
check('scaffold installs the bridge autoload', init.files.some((file) => file.includes('addons/dsh_bridge')), init.files.join(', '));

// The agent now writes its own game over the starter.
copyFileSync(path.join(HERE, 'fixtures', 'main.gd'), path.join(GAME, 'main.gd'));
copyFileSync(path.join(HERE, 'fixtures', 'main.tscn'), path.join(GAME, 'main.tscn'));

const cleanCheck = await call('godot_check', { project: GAME, import: true });
check('godot_check accepts the hand-written game', cleanCheck.ok === true, `${cleanCheck.checked.length} scripts checked, ${cleanCheck.diagnostics.length} diagnostics`);

// Agent introduces a real typo, the kind an LLM actually makes.
const good = readFileSync(path.join(GAME, 'main.gd'), 'utf8');
const buggy = good.replace('clampf(player_x, 40.0, 760.0)', 'clampff(player_x, 40.0, 760.0)');
const bugLine = buggy.split(/\r?\n/).findIndex((line) => line.includes('clampff')) + 1;
writeFileSync(path.join(GAME, 'main.gd'), buggy);

const brokenCheck = await call('godot_check', { project: GAME });
const parseErrors = brokenCheck.diagnostics.filter((entry) => entry.severity === 'error');
check('godot_check catches the injected bug', brokenCheck.ok === false && parseErrors.length > 0, `${parseErrors.length} errors`);
check('diagnostic names the right file and line', parseErrors.some((entry) => entry.file === 'res://main.gd' && entry.line === bugLine), JSON.stringify(parseErrors[0] ?? null));
console.log(`      diagnostic: ${parseErrors[0]?.message ?? 'none'}`);

writeFileSync(path.join(GAME, 'main.gd'), good);
const fixedCheck = await call('godot_check', { project: GAME });
check('godot_check passes again after the fix', fixedCheck.ok === true, `${fixedCheck.diagnostics.length} diagnostics`);

/* --------------------------------------------------- headless + bridge */

const headless = await call('godot_run', { project: GAME, headless: true, keepAlive: true, bridge: true, timeoutMs: 20000 });
check('godot_run keeps a headless session alive with a bridge', Boolean(headless.session) && headless.bridge?.attached === true, `session ${headless.session} port ${headless.bridge?.port}`);
check('godot_run captured the game print output', /GAME_READY/.test(headless.output ?? ''), (headless.output ?? '').split(/\r?\n/).filter(Boolean).slice(-2).join(' | '));
const session = headless.session;
if (!session) {
  console.log('cannot continue without a session');
  process.exit(1);
}

try {
  const ping = await call('godot_bridge', { session, command: 'ping' });
  check('bridge ping round-trips', ping.ok === true && ping.result.pong === true, JSON.stringify(ping.result));

  const tree = await call('godot_bridge', { session, command: 'tree', args: { depth: 3 } });
  const flatten = (node, out = []) => {
    out.push(node?.name);
    for (const child of node?.children ?? []) flatten(child, out);
    return out;
  };
  const sceneNames = flatten(tree.result?.root);
  check('bridge tree lists the live scene', tree.ok === true && ['Main', 'Player', 'Hud'].every((name) => sceneNames.includes(name)), sceneNames.join(','));

  const player = await call('godot_bridge', { session, command: 'node', args: { path: '/root/Main/Player', properties: ['position'] } });
  check('bridge reads a node', player.ok === true && player.result.type === 'ColorRect', `${player.result?.type} position=${JSON.stringify(player.result?.properties?.position)}`);

  const before = await call('godot_bridge', { session, command: 'node_call', args: { path: '/root/Main', method: 'debug_state' } });
  check('bridge calls a game method', before.ok === true && typeof before.result.return.score === 'number', JSON.stringify(before.result?.return));

  // Teleport the paddle under the star, then let the game loop run: score must go up.
  const star = before.result.return.star;
  const movedStar = await call('godot_bridge', { session, command: 'node_set', args: { path: '/root/Main', property: 'star_pos', value: [star[0], 521] } });
  const movedPaddle = await call('godot_bridge', { session, command: 'node_set', args: { path: '/root/Main', property: 'player_x', value: star[0] } });
  check('bridge writes script-var node properties', movedStar.ok === true && movedPaddle.ok === true, `${JSON.stringify(movedStar.result)} ${JSON.stringify(movedPaddle.result)}`);
  await call('godot_bridge', { session, command: 'frames', args: { count: 10 } });
  const after = await call('godot_bridge', { session, command: 'node_call', args: { path: '/root/Main', method: 'debug_state' } });
  check('the game reacted to the injected state (score increased)', after.result.return.score > before.result.return.score, `score ${before.result.return.score} -> ${after.result.return.score}`);

  const pressed = await call('godot_bridge', { session, command: 'action', args: { action: 'ui_right', pressed: true } });
  await call('godot_bridge', { session, command: 'frames', args: { count: 20 } });
  await call('godot_bridge', { session, command: 'action', args: { action: 'ui_right', pressed: false } });
  const moved2 = await call('godot_bridge', { session, command: 'node_call', args: { path: '/root/Main', method: 'debug_state' } });
  check('bridge drives input actions', pressed.ok === true && moved2.result.return.player_x > after.result.return.player_x, `player_x ${after.result.return.player_x.toFixed(1)} -> ${moved2.result.return.player_x.toFixed(1)}`);

  const shot = await call('godot_bridge', { session, command: 'screenshot' });
  check('headless screenshot fails actionably', shot.ok === false && /headless/.test(shot.error ?? ''), shot.error ?? '');
} finally {
  const stopped = await call('godot_stop', {});
  check('godot_stop ends the session', stopped.stopped.includes(session), JSON.stringify(stopped));
}

/* ------------------------------------------------- windowed screenshot */

const windowed = await call('godot_run', { project: GAME, headless: false, keepAlive: true, bridge: true, timeoutMs: 20000 });
check('windowed godot_run attaches the bridge', windowed.bridge?.attached === true, `session ${windowed.session}`);
if (windowed.session) {
  try {
    await call('godot_bridge', { session: windowed.session, command: 'frames', args: { count: 10 } });
    const shot = await call('godot_bridge', { session: windowed.session, command: 'screenshot' });
    const shotPath = shot.result?.path ?? '';
    const ok = shot.ok === true && existsSync(shotPath) && statSync(shotPath).size > 1000;
    check('windowed screenshot produces a real PNG', ok, `${shotPath} ${ok ? statSync(shotPath).size : 0} bytes`);
    if (ok) copyFileSync(shotPath, path.join(EVIDENCE, 'star-catcher.png'));
  } finally {
    await call('godot_stop', {});
  }
}

/* ------------------------------------------------------------- teardown */

for (const dispose of disposers.reverse()) {
  try {
    dispose();
  } catch {
    /* ignore */
  }
}
const statusEnd = await call('godot_status').catch(() => null);
check('no sessions are left running', statusEnd === null || statusEnd.sessions.length === 0, JSON.stringify(statusEnd?.sessions ?? []));

const failed = results.filter((entry) => !entry.ok);
console.log(`\nE2E SUMMARY passed=${results.length - failed.length} failed=${failed.length}`);
if (failed.length > 0) {
  for (const entry of failed) console.log(`  FAILED: ${entry.label} — ${entry.detail}`);
  process.exit(1);
}
// Wait a beat so a leaked child would surface, then exit clean.
await sleep(300);
process.exit(0);
