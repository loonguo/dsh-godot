/**
 * Load the REAL, installed DSH JSON-Schema assertion used by
 * `@deepseek-ai/dsh-tools` at tool registration (lib/index.js:2978 calls
 * `assertSupportedJsonSchema(definition.output.schema)`).
 *
 * The harness ships packed inside Electron's `app.asar`. This module parses the
 * asar header (documented layout: 16-byte preamble, JSON header, then concatenated
 * file bodies) and extracts ONLY the pure validator module
 * `dsh/node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js` into a
 * scratch node_modules tree under verify/tmp/harness/, together with two minimal
 * stub packages for the validator's only imports:
 *
 *   @deepseek-ai/dsh-llm         -> HarnessError base class
 *   @deepseek-ai/dsh-util-values -> assertNever, isJsonValue
 *
 * The validator source itself is unmodified installed harness code; sha256 is
 * reported so evidence is auditable. If no asar can be read (different install
 * layout, CI), a local replication of the same rules is used and the mode is
 * reported as 'replicated' so the result is not overstated.
 *
 * Zero runtime dependencies (node: built-ins only). Not part of the plugin.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VERIFY_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
const HARNESS_DIR = path.join(VERIFY_DIR, 'tmp', 'harness');
const EXTRACTED_REL = 'dsh/node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js';

/** Candidate asar locations; DSH_ASAR overrides (absolute path). */
export const ASAR_CANDIDATES = [
  process.env.DSH_ASAR,
  path.join('D:', 'Software', 'DeepSeek Harness', 'resources', 'app.asar'),
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
].filter((entry) => typeof entry === 'string' && entry.length > 0);

/** Read one file out of an asar archive by its POSIX archive path. */
function readAsarEntry(buffer, archivePath) {
  const jsonSize = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.subarray(16, 16 + jsonSize).toString('utf8'));
  const dataStart = 16 + jsonSize;
  let node = header;
  for (const part of archivePath.split('/')) {
    if (node === null || typeof node !== 'object' || node.files === undefined || node.files[part] === undefined) return undefined;
    node = node.files[part];
  }
  if (typeof node.offset !== 'string' || typeof node.size !== 'number') return undefined;
  const start = dataStart + Number(node.offset);
  return buffer.subarray(start, start + Number(node.size));
}

const STUB_PACKAGE_JSON = (name) => `${JSON.stringify({ name, version: '0.0.0-verify-stub', type: 'module', main: './index.js', exports: { '.': './index.js' } }, null, 2)}\n`;

const LLM_STUB = `// verify-only stub for the validator import; the real class adds HarnessError metadata
export class HarnessError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
  }
}
`;

const UTIL_STUB = `// verify-only stub for the validator imports (lossless-JSON predicate + never helper)
export function assertNever(value, hint) {
  throw new Error(\`unexpected \${hint ?? 'value'}: \${String(value)}\`);
}
export function isJsonValue(value, seen = new Set()) {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'boolean' || type === 'string') return true;
  if (type === 'number') return Number.isFinite(value);
  if (type !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, seen));
    if (Object.prototype.toString.call(value) !== '[object Object]') return false;
    return Object.keys(value).every((key) => isJsonValue(value[key], seen));
  } finally {
    seen.delete(value);
  }
}
`;

/** Write the two stub packages the extracted validator imports. */
function writeStubs(root) {
  const modules = path.join(root, 'node_modules', '@deepseek-ai');
  for (const [name, body] of [
    ['dsh-llm', LLM_STUB],
    ['dsh-util-values', UTIL_STUB],
  ]) {
    const dir = path.join(modules, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), STUB_PACKAGE_JSON(`@deepseek-ai/${name}`));
    fs.writeFileSync(path.join(dir, 'index.js'), body);
  }
}

/** Extract the installed validator (once) and import it; returns load report. */
async function loadInstalledValidator() {
  let lastError = '';
  for (const asar of ASAR_CANDIDATES) {
    let buffer;
    try {
      buffer = fs.readFileSync(asar);
    } catch (error) {
      lastError = `${asar}: ${error instanceof Error ? error.message : String(error)}`;
      continue;
    }
    let source;
    try {
      source = readAsarEntry(buffer, EXTRACTED_REL);
    } catch (error) {
      lastError = `${asar}: cannot parse asar header (${error instanceof Error ? error.message : String(error)})`;
      continue;
    }
    if (source === undefined) {
      lastError = `${asar}: entry ${EXTRACTED_REL} not found`;
      continue;
    }
    const targetDir = path.join(HARNESS_DIR, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'types');
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, 'json-schema.js');
    fs.writeFileSync(target, source);
    writeStubs(HARNESS_DIR);
    try {
      const module = await import(pathToFileURL(target).href);
      if (typeof module.assertSupportedJsonSchema !== 'function') throw new Error('assertSupportedJsonSchema is not exported');
      return {
        mode: 'installed-harness',
        asar,
        entry: EXTRACTED_REL,
        extractedTo: target,
        sha256: crypto.createHash('sha256').update(source).digest('hex'),
        assertSupportedJsonSchema: module.assertSupportedJsonSchema,
        assertObjectJsonSchema: module.assertObjectJsonSchema,
      };
    } catch (error) {
      lastError = `${asar}: extracted validator failed to import (${error instanceof Error ? error.message : String(error)})`;
    }
  }
  return { mode: 'unavailable', error: lastError || 'no asar candidate found' };
}

/* -------------------------------------------------------------------------- */
/* Local replication of the installed rules (fallback only)                    */
/* -------------------------------------------------------------------------- */

const CONSTRAINT_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']);
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples']);
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const ONE_OF_SIBLING_KEYWORDS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'];

function isJsonValueReplica(value) {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'boolean' || type === 'string') return true;
  if (type === 'number') return Number.isFinite(value);
  if (type !== 'object') return false;
  if (Array.isArray(value)) return value.every(isJsonValueReplica);
  if (Object.prototype.toString.call(value) !== '[object Object]') return false;
  return Object.values(value).every(isJsonValueReplica);
}

export function replicatedSchemaViolations(root) {
  const violations = [];
  const stack = [{ node: root, path: 'schema', parent: undefined }];
  while (stack.length > 0) {
    const { node, path: schemaPath, parent } = stack.pop();
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      violations.push(`${schemaPath} must be a schema object`);
      continue;
    }
    for (const key of Object.keys(node)) {
      if (CONSTRAINT_KEYWORDS.has(key)) continue;
      if (ANNOTATION_KEYWORDS.has(key)) {
        if (!isJsonValueReplica(node[key])) violations.push(`${schemaPath}.${key} annotation must be lossless JSON data`);
        continue;
      }
      violations.push(`${schemaPath}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`);
    }
    if (Object.hasOwn(node, 'description') && typeof node.description !== 'string') violations.push(`${schemaPath}.description must be a string`);
    if (Object.hasOwn(node, 'title') && typeof node.title !== 'string') violations.push(`${schemaPath}.title must be a string`);
    const hasType = Object.hasOwn(node, 'type');
    const hasOneOf = Object.hasOwn(node, 'oneOf');
    if (hasType && hasOneOf) {
      violations.push(`${schemaPath} cannot declare both type and oneOf`);
      continue;
    }
    if (!hasType && !hasOneOf) {
      for (const key of ONE_OF_SIBLING_KEYWORDS) if (Object.hasOwn(node, key)) violations.push(`${schemaPath}.${key} requires type or oneOf`);
      continue;
    }
    if (hasOneOf) {
      const oneOf = node.oneOf;
      if (!Array.isArray(oneOf) || oneOf.length < 2) violations.push(`${schemaPath}.oneOf must be an array of at least two schemas`);
      else for (let index = oneOf.length - 1; index >= 0; index -= 1) stack.push({ node: oneOf[index], path: `${schemaPath}.oneOf[${index}]`, parent });
      for (const key of ONE_OF_SIBLING_KEYWORDS) if (Object.hasOwn(node, key)) violations.push(`${schemaPath}.${key} is not supported beside oneOf`);
      continue;
    }
    const type = node.type;
    if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
      violations.push(`${schemaPath}.type must be one of ${SCHEMA_TYPES.join('/')}`);
      continue;
    }
    const constraints = { properties: ['object'], required: ['object'], additionalProperties: ['object'], items: ['array'], enum: ['string', 'number', 'integer', 'boolean', 'null'], const: ['string', 'number', 'integer', 'boolean', 'null'] };
    for (const [key, types] of Object.entries(constraints)) if (Object.hasOwn(node, key) && !types.includes(type)) violations.push(`${schemaPath}.${key} is not supported on type "${type}"`);
    if (type === 'object') {
      if (Object.hasOwn(node, 'properties')) {
        if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) violations.push(`${schemaPath}.properties must be an object of schemas`);
        else for (const [key, child] of Object.entries(node.properties)) stack.push({ node: child, path: `${schemaPath}.properties.${key}`, parent: node });
      }
      if (Object.hasOwn(node, 'required')) {
        if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== 'string')) violations.push(`${schemaPath}.required must be an array of strings`);
        else for (const key of node.required) if (!Object.hasOwn(node.properties ?? {}, key)) violations.push(`${schemaPath}.required names "${key}" which is not in properties`);
      }
      if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') violations.push(`${schemaPath}.additionalProperties must be a boolean`);
    } else if (type === 'array') {
      if (Object.hasOwn(node, 'items')) stack.push({ node: node.items, path: `${schemaPath}.items`, parent: node });
    } else if (Object.hasOwn(node, 'enum')) {
      if (!Array.isArray(node.enum) || node.enum.length === 0) violations.push(`${schemaPath}.enum must be a non-empty array of ${type} values`);
    }
  }
  return violations;
}

/** Replicated fallback with the same throwing contract as the harness. */
export function replicatedAssertSupportedJsonSchema(schema) {
  const violations = replicatedSchemaViolations(schema);
  if (violations.length > 0) throw new Error(`unsupported JSON schema: ${violations.join('; ')}`);
}

let cached = null;

/**
 * Load the validator; cached for the process.
 * @returns {Promise<{mode: 'installed-harness'|'replicated', assertSupportedJsonSchema: (schema: unknown) => void, evidence: object}>}
 */
export async function loadHarnessSchema() {
  if (cached !== null) return cached;
  const installed = await loadInstalledValidator();
  if (installed.mode === 'installed-harness') {
    cached = {
      mode: 'installed-harness',
      assertSupportedJsonSchema: installed.assertSupportedJsonSchema,
      evidence: { asar: installed.asar, entry: installed.entry, extractedTo: installed.extractedTo, sha256: installed.sha256, stubs: ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-util-values'] },
    };
    return cached;
  }
  cached = {
    mode: 'replicated',
    assertSupportedJsonSchema: replicatedAssertSupportedJsonSchema,
    evidence: { reason: installed.error, note: 'installed validator not loadable here; local replication of lib/types/json-schema.js rules used' },
  };
  return cached;
}
