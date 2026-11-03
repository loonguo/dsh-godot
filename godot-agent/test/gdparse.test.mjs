import assert from 'node:assert/strict';
import test from 'node:test';

import { mapEnginePath, parseGodotLog, stripEngineHeader } from '../src/gdparse.js';

const BANNER = 'Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org';

test('parseGodotLog: check-only parse error maps res:// file and line', () => {
  const log = [
    "ERROR: Could not create directory: 'user://logs'.",
    '   at: make_dir_recursive (core/io/dir_access.cpp:179)',
    BANNER,
    '',
    'SCRIPT ERROR: Parse Error: Cannot assign a value of type "String" as "int".',
    '   at: GDScript::reload (res://broken.gd:4)',
    '',
  ].join('\n');

  const diagnostics = parseGodotLog(log);
  assert.equal(diagnostics.length, 1);
  const [diagnostic] = diagnostics;
  assert.equal(diagnostic.severity, 'error');
  assert.equal(diagnostic.source, 'parse');
  assert.equal(diagnostic.file, 'res://broken.gd');
  assert.equal(diagnostic.line, 4);
  assert.equal(diagnostic.function, 'GDScript::reload');
  assert.match(diagnostic.message, /Parse Error/);
  assert.ok(!diagnostic.raw.includes('Godot Engine'), 'banner line must be stripped from raw');
});

test('parseGodotLog: runtime SCRIPT ERROR gets file, line, function and source runtime', () => {
  const log = [
    BANNER,
    '',
    'SCRIPT ERROR: Invalid call. Nonexistent function \'missing_method\' in base \'Nil\'.',
    '   at: _ready (res://main.gd:6)',
    '   GDScript backtrace (most recent call first):',
    '       [0] _ready (res://main.gd:6)',
    '',
  ].join('\n');

  const diagnostics = parseGodotLog(log);
  assert.equal(diagnostics.length, 1);
  const [diagnostic] = diagnostics;
  assert.equal(diagnostic.source, 'runtime');
  assert.equal(diagnostic.severity, 'error');
  assert.equal(diagnostic.file, 'res://main.gd');
  assert.equal(diagnostic.line, 6);
  assert.equal(diagnostic.function, '_ready');
});

test('parseGodotLog: warnings become severity warning', () => {
  const log = ['WARNING: Resource not found', '   at: load (res://thing.gd:2)'].join('\n');
  const [diagnostic] = parseGodotLog(log);
  assert.equal(diagnostic.severity, 'warning');
  assert.equal(diagnostic.source, 'engine');
  assert.equal(diagnostic.file, 'res://thing.gd');
  assert.equal(diagnostic.line, 2);
});

test('parseGodotLog: ignores the engine noise listed in CONTRACT §3', () => {
  const log = [
    "ERROR: Could not create directory: 'user://logs'.",
    '   at: make_dir_recursive (core/io/dir_access.cpp:179)',
    'ERROR: Failed to open log file for writing: user://logs/godot.log',
    '   at: rotate_file (core/io/logger.cpp:169)',
    'ERROR: Failed to read the root certificate store.',
    '   at: get_system_ca_certificates (platform/windows/os_windows.cpp:2582)',
  ].join('\n');
  assert.deepEqual(parseGodotLog(log), []);
});

test('parseGodotLog: maps absolute project paths back to res://', () => {
  const projectRoot = 'C:\\games\\demo';
  const log = ['SCRIPT ERROR: Parse Error: Unexpected token.', `   at: GDScript::reload (${projectRoot}\\scripts\\player.gd:12)`].join('\n');
  const [diagnostic] = parseGodotLog(log, { projectRoot });
  assert.equal(diagnostic.file, 'res://scripts/player.gd');
  assert.equal(diagnostic.line, 12);
  assert.equal(diagnostic.source, 'parse');
});

test('parseGodotLog: keeps absolute paths outside the project', () => {
  const outside = 'D:\\other\\lib.gd';
  const [diagnostic] = parseGodotLog(`SCRIPT ERROR: Parse Error: bad.\n   at: GDScript::reload (${outside}:3)`, { projectRoot: 'C:\\games\\demo' });
  assert.equal(diagnostic.file, outside);
});

test('parseGodotLog: handles several blocks and collapses exact duplicates', () => {
  const log = [
    'SCRIPT ERROR: Parse Error: bad one.',
    '   at: GDScript::reload (res://a.gd:1)',
    'SCRIPT ERROR: Parse Error: bad one.',
    '   at: GDScript::reload (res://a.gd:1)',
    'SCRIPT ERROR: Invalid call.',
    '   at: _ready (res://b.gd:9)',
  ].join('\n');
  const diagnostics = parseGodotLog(log);
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0].file, 'res://a.gd');
  assert.equal(diagnostics[1].file, 'res://b.gd');
});

test('parseGodotLog: empty and undefined input are safe', () => {
  assert.deepEqual(parseGodotLog(''), []);
  assert.deepEqual(parseGodotLog(undefined), []);
  assert.deepEqual(parseGodotLog(null), []);
});

test('stripEngineHeader removes only banner lines', () => {
  const text = [BANNER, 'SCRIPT ERROR: boom.', '   at: _ready (res://x.gd:2)', 'OpenGL API 4.6'].join('\n');
  const stripped = stripEngineHeader(text);
  assert.ok(!stripped.includes('Godot Engine'));
  assert.ok(!stripped.includes('OpenGL API'));
  assert.ok(stripped.includes('SCRIPT ERROR: boom.'));
});

test('mapEnginePath leaves res:// and user:// alone and maps absolute paths', () => {
  assert.equal(mapEnginePath('res://a.gd', 'C:\\p'), 'res://a.gd');
  assert.equal(mapEnginePath('user://logs/x.log', 'C:\\p'), 'user://logs/x.log');
  assert.equal(mapEnginePath('C:\\p\\sub\\a.gd', 'C:\\p'), 'res://sub/a.gd');
  assert.equal(mapEnginePath('D:\\elsewhere\\a.gd', 'C:\\p'), 'D:\\elsewhere\\a.gd');
  assert.equal(mapEnginePath('', 'C:\\p'), '');
});
