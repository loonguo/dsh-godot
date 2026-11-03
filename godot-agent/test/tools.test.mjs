import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apply } from '../index.js';
import { templatesAvailable } from '../src/project.js';
import { compileParameters, createRuntime, createToolDefinitions, TOOL_NAMES, validateToolArguments } from '../src/tools.js';

const ENGINE = 'D:\\Software\\Godot_v4.7.2-stable_win64.exe\\Godot_v4.7.2-stable_win64_console.exe';
const engineAvailable = fs.existsSync(ENGINE);

/** Minimal Cordis-like context: captures registrations and effects. */
function fakeCtx() {
  const tools = [];
  const disposers = [];
  return {
    tools: {
      register(definition) {
        tools.push(definition);
        const dispose = () => {
          const index = tools.indexOf(definition);
          if (index >= 0) tools.splice(index, 1);
        };
        disposers.push(dispose);
        return dispose;
      },
    },
    effect(execute) {
      const dispose = execute();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    toolsRegistered: tools,
    disposeAll() {
      for (const dispose of disposers.reverse()) dispose();
    },
  };
}

test('apply registers exactly the six CONTRACT §2 tools with a renderable output', () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  assert.deepEqual(
    ctx.toolsRegistered.map((tool) => tool.name),
    TOOL_NAMES,
  );
  for (const tool of ctx.toolsRegistered) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 30, `${tool.name} needs a model-facing description`);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.parameters.properties, 'object');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(tool.output.schema.type, 'object');
    assert.equal(typeof tool.execute, 'function');
  }
  ctx.disposeAll();
  assert.deepEqual(ctx.toolsRegistered, []);
});

test('compiled parameters expose a required array, not inline required flags', () => {
  const parameters = compileParameters({
    project: { type: 'string', required: true, description: 'Project directory.' },
    mode: { type: 'string', enum: ['project', 'scene'], description: 'Mode.' },
    args: { type: 'array', items: { type: 'string' }, description: 'User args.' },
  });
  assert.deepEqual(parameters.required, ['project']);
  assert.equal(parameters.properties.project.description, 'Project directory.');
  assert.equal(parameters.properties.project.required, undefined);
  assert.deepEqual(parameters.properties.mode.enum, ['project', 'scene']);
  assert.deepEqual(parameters.properties.args.items, { type: 'string' });
  assert.equal(JSON.stringify(parameters).includes('"required":true'), false);
});

test('validateToolArguments enforces required and typed arguments with actionable messages', () => {
  const parameters = compileParameters({
    project: { type: 'string', required: true, description: 'Project directory or project.godot path.' },
    headless: { type: 'boolean', description: 'Headless.' },
    timeoutMs: { type: 'number', description: 'Timeout.' },
    args: { type: 'array', items: { type: 'string' }, description: 'User args.' },
    mode: { type: 'string', enum: ['project', 'scene'], description: 'Mode.' },
  });

  assert.throws(() => validateToolArguments('godot_run', parameters, {}), /missing required argument "project".*Project directory/);
  assert.throws(() => validateToolArguments('godot_run', parameters, { project: 3 }), /argument "project" must be a string/);
  assert.throws(() => validateToolArguments('godot_run', parameters, { project: 'p', headless: 'yes' }), /argument "headless" must be a boolean/);
  assert.throws(() => validateToolArguments('godot_run', parameters, { project: 'p', timeoutMs: 'soon' }), /argument "timeoutMs" must be a finite number/);
  assert.throws(() => validateToolArguments('godot_run', parameters, { project: 'p', args: [1] }), /argument "args\[0\]" must be a string/);
  assert.throws(() => validateToolArguments('godot_run', parameters, { project: 'p', mode: 'nope' }), /argument "mode" must be one of/);
  assert.throws(() => validateToolArguments('godot_run', parameters, 'nope'), /arguments must be an object/);

  const ok = validateToolArguments('godot_run', parameters, { project: 'p', extra: 1 });
  assert.deepEqual(ok, { project: 'p', extra: 1 });
});

test('every tool output.render returns [{ type: "text", text }] for a representative value', () => {
  const runtime = createRuntime({ enginePath: ENGINE });
  const definitions = createToolDefinitions(runtime);
  const values = {
    godot_status: { engine: null, projectRoot: 'D:\\tmp', defaultTimeoutMs: 20000, sessions: [] },
    godot_project_init: {
      project: { path: 'D:\\tmp\\p', name: 'P', mainScene: 'res://main.tscn', valid: true },
      name: 'P',
      mainScene: 'res://main.tscn',
      files: ['project.godot'],
      import: { ok: true, exitCode: 0, diagnostics: [] },
    },
    godot_check: { ok: true, diagnostics: [], checked: ['res://main.gd'], import: { ok: true, exitCode: 0, diagnostics: [] } },
    godot_run: { pid: 1234, command: ['godot'], timedOut: false, bridge: null, output: 'hello', diagnostics: [] },
    godot_bridge: { ok: true, result: { pong: true } },
    godot_stop: { stopped: ['g1'] },
  };
  for (const definition of definitions) {
    const content = definition.output.render({}, values[definition.name]);
    assert.ok(Array.isArray(content), `${definition.name} render must return an array`);
    assert.equal(content.length, 1);
    assert.equal(content[0].type, 'text');
    assert.equal(typeof content[0].text, 'string');
    runtime.dispose();
  }
});

test('godot_status reports engine, projectRoot and sessions', { skip: !engineAvailable && 'real Godot 4.x engine not installed' }, async () => {
  const runtime = createRuntime({ enginePath: ENGINE });
  try {
    const status = createToolDefinitions(runtime).find((tool) => tool.name === 'godot_status');
    const value = await status.execute({});
    assert.equal(value.engine.console, true);
    assert.match(value.engine.version, /^4\./);
    assert.equal(value.defaultTimeoutMs, 20000);
    assert.deepEqual(value.sessions, []);
  } finally {
    runtime.dispose();
  }
});

test('godot_status reports the configured project when projectRoot is a Godot project', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-godot-tools-'));
  fs.writeFileSync(
    path.join(directory, 'project.godot'),
    'config_version=5\n\n[application]\n\nconfig/name="Status Project"\nrun/main_scene="res://main.tscn"\n',
    'utf8',
  );
  const runtime = createRuntime({ projectRoot: directory, enginePath: path.join(os.tmpdir(), 'no-engine-here.exe') });
  try {
    const status = createToolDefinitions(runtime).find((tool) => tool.name === 'godot_status');
    const value = await status.execute({});
    assert.equal(value.project.path, directory);
    assert.equal(value.project.name, 'Status Project');
    assert.equal(value.project.mainScene, 'res://main.tscn');
    assert.equal(value.projectRoot, directory);
  } finally {
    runtime.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('godot_project_init refuses a non-empty directory with an actionable error', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-godot-tools-'));
  fs.writeFileSync(path.join(directory, 'keep.txt'), 'x');
  const runtime = createRuntime({});
  try {
    const init = createToolDefinitions(runtime).find((tool) => tool.name === 'godot_project_init');
    await assert.rejects(() => init.execute({ directory }), /not empty/);
  } finally {
    runtime.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('godot_check and godot_run fail actionably for a missing project', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-godot-tools-'));
  const runtime = createRuntime({ enginePath: ENGINE });
  try {
    const definitions = createToolDefinitions(runtime);
    const check = definitions.find((tool) => tool.name === 'godot_check');
    const run = definitions.find((tool) => tool.name === 'godot_run');
    await assert.rejects(() => check.execute({ project: directory }), /Godot project not found/);
    await assert.rejects(() => run.execute({ project: directory }), /Godot project not found/);
    await assert.rejects(() => check.execute({}), /missing required argument "project"/);
  } finally {
    runtime.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('godot_bridge and godot_stop fail actionably for an unknown session', async () => {
  const runtime = createRuntime({ enginePath: ENGINE });
  try {
    const definitions = createToolDefinitions(runtime);
    const bridge = definitions.find((tool) => tool.name === 'godot_bridge');
    const stop = definitions.find((tool) => tool.name === 'godot_stop');
    await assert.rejects(() => bridge.execute({ session: 'g99', command: 'ping' }), /unknown session "g99"/);
    await assert.rejects(() => stop.execute({ session: 'g99' }), /unknown session "g99"/);
    const stopped = await stop.execute({});
    assert.deepEqual(stopped, { stopped: [] });
  } finally {
    runtime.dispose();
  }
});

test('godot_project_init can scaffold without running an import pass', { skip: templatesAvailable() ? false : 'templates not shipped' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-godot-tools-'));
  const directory = path.join(root, 'no-import');
  // No enginePath: scaffolding without import must not need an engine.
  const runtime = createRuntime({ enginePath: path.join(os.tmpdir(), 'missing-engine.exe') });
  try {
    const init = createToolDefinitions(runtime).find((tool) => tool.name === 'godot_project_init');
    const value = await init.execute({ directory, name: 'No Import', import: false, template: '2d' });
    assert.equal(value.import.ok, true);
    assert.equal(value.import.exitCode, null);
    assert.deepEqual(value.import.diagnostics, []);
    assert.ok(fs.existsSync(path.join(directory, 'project.godot')));
    assert.ok(fs.existsSync(path.join(directory, 'addons', 'dsh_bridge', 'dsh_bridge.gd')));
    assert.equal(fs.existsSync(path.join(directory, '.godot')), false, 'import: false must not create the import cache');
  } finally {
    runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createRuntime merges config defaults and tolerates unknown keys', () => {
  const runtime = createRuntime({ enginePath: 'x', projectRoot: 'y', defaultTimeoutMs: 5000, unknownKey: true });
  try {
    assert.deepEqual(runtime.config, { enginePath: 'x', projectRoot: 'y', defaultTimeoutMs: 5000 });
    assert.doesNotThrow(() => runtime.dispose());
    assert.doesNotThrow(() => runtime.dispose());
  } finally {
    runtime.dispose();
  }
});

/* -------------------------------------------------------------------------- */
/* Output schemas must stay inside the harness's enforced JSON-Schema subset.  */
/* (Raw ctx.tools.register asserts output.schema, so a stray keyword would     */
/* fail the whole plugin activation at install time.)                          */
/* -------------------------------------------------------------------------- */

const CONSTRAINT_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']);
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples']);
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const ONE_OF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'];
const TYPE_KEYWORDS = {
  object: new Set(['properties', 'required', 'additionalProperties']),
  array: new Set(['items']),
  string: new Set(['enum', 'const']),
  number: new Set(['enum', 'const']),
  integer: new Set(['enum', 'const']),
  boolean: new Set(['enum', 'const']),
  null: new Set(['enum', 'const']),
};

function assertSupportedSchema(schema, schemaPath, violations) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    violations.push(`${schemaPath} must be a schema object`);
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!CONSTRAINT_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) violations.push(`${schemaPath}.${key} is not in the enforced subset`);
  }
  const hasType = Object.hasOwn(schema, 'type');
  const hasOneOf = Object.hasOwn(schema, 'oneOf');
  if (hasType && hasOneOf) violations.push(`${schemaPath} declares both type and oneOf`);
  if (!hasType && !hasOneOf) {
    for (const key of ONE_OF_SIBLINGS) if (Object.hasOwn(schema, key)) violations.push(`${schemaPath}.${key} needs type or oneOf`);
    return;
  }
  if (hasOneOf) {
    for (const key of ONE_OF_SIBLINGS) if (Object.hasOwn(schema, key)) violations.push(`${schemaPath}.${key} is not allowed beside oneOf`);
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length < 2) violations.push(`${schemaPath}.oneOf must have at least two branches`);
    else schema.oneOf.forEach((branch, index) => assertSupportedSchema(branch, `${schemaPath}.oneOf[${index}]`, violations));
    return;
  }
  if (typeof schema.type !== 'string' || !SCHEMA_TYPES.has(schema.type)) {
    violations.push(`${schemaPath}.type must be one JSON Schema type string`);
    return;
  }
  for (const key of CONSTRAINT_KEYWORDS) {
    if (key === 'type') continue;
    if (Object.hasOwn(schema, key) && !TYPE_KEYWORDS[schema.type].has(key)) violations.push(`${schemaPath}.${key} is not supported on type ${schema.type}`);
  }
  if (schema.type === 'object') {
    const properties = schema.properties ?? {};
    if (typeof properties !== 'object' || Array.isArray(properties)) violations.push(`${schemaPath}.properties must be an object`);
    for (const [key, child] of Object.entries(properties)) assertSupportedSchema(child, `${schemaPath}.properties.${key}`, violations);
    if (Object.hasOwn(schema, 'required')) {
      if (!Array.isArray(schema.required) || schema.required.some((entry) => typeof entry !== 'string')) violations.push(`${schemaPath}.required must be strings`);
      else for (const key of schema.required) if (!Object.hasOwn(properties, key)) violations.push(`${schemaPath}.required names undeclared "${key}"`);
    }
  }
  if (schema.type === 'array' && Object.hasOwn(schema, 'items')) assertSupportedSchema(schema.items, `${schemaPath}.items`, violations);
  if (Object.hasOwn(schema, 'enum')) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) violations.push(`${schemaPath}.enum must be non-empty`);
  }
}

test('every registered output.schema satisfies the enforced JSON-Schema subset', () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  const violations = [];
  for (const tool of ctx.toolsRegistered) assertSupportedSchema(tool.output.schema, `${tool.name}.output.schema`, violations);
  assert.deepEqual(violations, []);
  ctx.disposeAll();
});

test('every registered parameter schema is object-rooted plain JSON Schema', () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  for (const tool of ctx.toolsRegistered) {
    const { parameters } = tool;
    assert.equal(parameters.type, 'object', `${tool.name} parameters must be object-rooted`);
    assert.equal(typeof parameters.properties, 'object');
    assert.equal(JSON.stringify(parameters).includes('"required":true'), false, `${tool.name} parameters must not use inline required flags`);
    if (parameters.required !== undefined) {
      assert.ok(Array.isArray(parameters.required));
      for (const key of parameters.required) assert.ok(Object.hasOwn(parameters.properties, key), `${tool.name}.required names undeclared ${key}`);
    }
  }
  ctx.disposeAll();
});
