import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  clearEngineProbeCache,
  defaultScanRoots,
  deriveConsolePath,
  discoverEngine,
  ENGINE_NOT_FOUND_MESSAGE,
  isConsoleExecutable,
  probeEngine,
  resolveEngineExecutable,
} from '../src/engine.js';

const ENGINE = 'D:\\Software\\Godot_v4.7.2-stable_win64.exe\\Godot_v4.7.2-stable_win64_console.exe';
const GUI_ENGINE = 'D:\\Software\\Godot_v4.7.2-stable_win64.exe\\Godot_v4.7.2-stable_win64.exe';
const engineAvailable = fs.existsSync(ENGINE);

test('discoverEngine: config enginePath file is probed and cached', { skip: !engineAvailable && 'real Godot 4.x engine not installed' }, () => {
  clearEngineProbeCache();
  const solved = discoverEngine({ enginePath: ENGINE }, { env: {}, platform: 'win32', pathNames: [], scanRoots: [] });
  assert.equal(path.resolve(solved.path), path.resolve(ENGINE));
  assert.match(solved.version, /^4\./);
  assert.equal(solved.console, true);
  assert.equal(isConsoleExecutable(solved.path), true);
  // Cached probe returns an equal identity.
  assert.deepEqual(probeEngine(ENGINE), solved);
});

test('discoverEngine: a directory enginePath prefers the *_console.exe', { skip: !engineAvailable && 'real Godot 4.x engine not installed' }, () => {
  const solved = discoverEngine({ enginePath: path.dirname(ENGINE) }, { env: {}, platform: 'win32', pathNames: [], scanRoots: [] });
  assert.equal(path.basename(solved.path), 'Godot_v4.7.2-stable_win64_console.exe');
  assert.equal(solved.console, true);
});

test('discoverEngine: GODOT_BIN is used when enginePath is empty', { skip: !engineAvailable && 'real Godot 4.x engine not installed' }, () => {
  const solved = discoverEngine({}, { env: { GODOT_BIN: ENGINE }, platform: 'win32', pathNames: [], scanRoots: [] });
  assert.equal(path.resolve(solved.path), path.resolve(ENGINE));
});

test('discoverEngine: enginePath wins over GODOT_BIN', { skip: !engineAvailable && 'real Godot 4.x engine not installed' }, () => {
  const solved = discoverEngine(
    { enginePath: ENGINE },
    { env: { GODOT_BIN: 'C:\\definitely\\not\\godot.exe' }, platform: 'win32', pathNames: [], scanRoots: [] },
  );
  assert.equal(path.resolve(solved.path), path.resolve(ENGINE));
});

test('discoverEngine: missing engine produces the actionable CONTRACT §5 message', () => {
  let error;
  try {
    discoverEngine({ enginePath: 'C:\\definitely\\missing\\godot.exe' }, { env: {}, platform: 'win32', pathNames: [], scanRoots: [] });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error);
  assert.match(error.message, /Godot engine not found/);
  assert.match(error.message, /enginePath/);
  assert.match(error.message, /GODOT_BIN/);
  assert.ok(error.message.startsWith(ENGINE_NOT_FOUND_MESSAGE));
});

test('discoverEngine: PATH lookup can resolve the engine executable', { skip: !engineAvailable && 'real Godot 4.x engine not installed' }, () => {
  const directory = path.dirname(ENGINE);
  const solved = discoverEngine({}, { env: { PATH: directory, PATHEXT: '.EXE' }, platform: 'win32', pathNames: ['Godot_v4.7.2-stable_win64_console'], scanRoots: [] });
  assert.equal(path.resolve(solved.path), path.resolve(ENGINE));
});

test('deriveConsolePath prefers a sibling *_console.exe', { skip: !engineAvailable && 'real Godot 4.x engine not installed' }, () => {
  assert.equal(deriveConsolePath(GUI_ENGINE), ENGINE);
  assert.equal(deriveConsolePath(ENGINE), ENGINE);
});

test('resolveEngineExecutable: missing path returns undefined', () => {
  assert.equal(resolveEngineExecutable('C:\\nope\\nope.exe'), undefined);
  assert.equal(resolveEngineExecutable(''), undefined);
});

test('defaultScanRoots mentions the documented install roots on Windows', () => {
  const roots = defaultScanRoots({ USERPROFILE: 'C:\\Users\\test', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' }, 'win32');
  const rendered = roots.map((root) => root.directory.toLowerCase());
  assert.ok(rendered.some((entry) => entry.includes('d:\\software')));
  assert.ok(rendered.some((entry) => entry.includes('program files')));
  assert.ok(rendered.some((entry) => entry.includes('programs')));
});
