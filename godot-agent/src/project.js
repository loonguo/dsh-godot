/**
 * Godot project scaffolding, discovery and import passes (CONTRACT §1, §2).
 *
 * Templates live next to this module in `../templates/` and are copied into the
 * new project:
 *   project.godot.tmpl   -> project.godot   ({{NAME}}, {{MAIN_SCENE}}, {{BRIDGE_PATH}})
 *   main.tscn.tmpl       -> main.tscn
 *   main.gd.tmpl         -> main.gd
 *   bridge/dsh_bridge.gd -> addons/dsh_bridge/dsh_bridge.gd (verbatim, autoload)
 * Documentation (`*.md`) under templates/ is never copied into the project.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverEngine } from './engine.js';
import { parseGodotLog } from './gdparse.js';
import { runOnce } from './runner.js';

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TEMPLATES_DIR = path.join(PACKAGE_ROOT, 'templates');
const BRIDGE_SOURCE_REL = 'bridge/dsh_bridge.gd';
const BRIDGE_DEST_REL = 'addons/dsh_bridge/dsh_bridge.gd';
const BRIDGE_RES_PATH = 'res://addons/dsh_bridge/dsh_bridge.gd';
const DEFAULT_MAIN_SCENE = 'res://main.tscn';
const MAX_DISCOVERED_SCRIPTS = 40;

/** Absolute path of the bundled templates directory (for tests and diagnostics). */
export function templatesDirectory() {
  return TEMPLATES_DIR;
}

/** Whether the package ships a complete template set (bridge + project file). */
export function templatesAvailable() {
  return fs.existsSync(path.join(TEMPLATES_DIR, 'project.godot.tmpl')) && fs.existsSync(path.join(TEMPLATES_DIR, BRIDGE_SOURCE_REL));
}

/**
 * Parse the subset of project.godot the tools need.
 * @param {string} projectFile absolute path of project.godot
 * @returns {{ name: string, mainScene: string, hasBridgeAutoload: boolean, raw: string }}
 */
export function readProjectFile(projectFile) {
  let raw = '';
  try {
    raw = fs.readFileSync(projectFile, 'utf8');
  } catch {
    raw = '';
  }
  const info = { name: '', mainScene: DEFAULT_MAIN_SCENE, hasBridgeAutoload: raw.includes(BRIDGE_RES_PATH), raw };
  let section = '';
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header) {
      section = header[1] ?? '';
      continue;
    }
    const assignment = /^([^=]+?)\s*=\s*(.*)$/.exec(trimmed);
    if (!assignment) continue;
    const key = (assignment[1] ?? '').trim();
    let value = (assignment[2] ?? '').trim();
    if (/^"(.*)"$/.test(value)) value = value.slice(1, -1);
    else if (/^'(.*)'$/.test(value)) value = value.slice(1, -1);
    if (section === 'application' && key === 'config/name') info.name = value;
    else if (section === 'application' && key === 'run/main_scene') info.mainScene = value;
  }
  if (info.name.length === 0) info.name = path.basename(path.dirname(projectFile));
  return info;
}

/**
 * Whether a project's `[autoload]` section registers the dsh bridge addon
 * (any value mentioning `dsh_bridge`, e.g.
 * `Bridge="*res://addons/dsh_bridge/dsh_bridge.gd"`).
 *
 * Used by `godot_run { keepAlive: true, bridge: true }` to skip the attach wait
 * for projects that can never attach.
 *
 * @param {string} projectDir project directory (or the project.godot path)
 * @returns {boolean} true when the bridge autoload is registered
 */
export function projectHasBridgeAutoload(projectDir) {
  if (typeof projectDir !== 'string' || projectDir.trim().length === 0) return false;
  const resolved = path.resolve(projectDir.trim().replace(/^"(.*)"$/, '$1'));
  const projectFile = /project\.godot$/i.test(resolved) ? resolved : path.join(resolved, 'project.godot');
  let raw;
  try {
    raw = fs.readFileSync(projectFile, 'utf8');
  } catch {
    return false;
  }
  let inAutoloadSection = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inAutoloadSection = /^\[autoload\]$/i.test(trimmed);
      continue;
    }
    if (!inAutoloadSection || trimmed.length === 0 || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    if (trimmed.includes('dsh_bridge')) return true;
  }
  return false;
}

/**
 * Resolve a `project` argument (directory or `project.godot` path) to a usable
 * project description. Throws an actionable Error when it is not a project.
 *
 * @param {string} project project directory or project.godot path
 * @returns {{ dir: string, projectFile: string, name: string, mainScene: string, valid: boolean, hasBridgeAutoload: boolean }}
 */
export function resolveProject(project) {
  if (typeof project !== 'string' || project.trim().length === 0) {
    throw new Error('a `project` path is required: pass the project directory or its project.godot path.');
  }
  const resolved = path.resolve(project.trim().replace(/^"(.*)"$/, '$1'));
  let dir;
  if (resolved.toLowerCase().endsWith('project.godot')) dir = path.dirname(resolved);
  else dir = resolved;
  const projectFile = path.join(dir, 'project.godot');
  if (!fs.existsSync(projectFile)) {
    throw new Error(`Godot project not found at "${dir}": no project.godot there. Create one with godot_project_init, or pass the project directory that contains project.godot.`);
  }
  const info = readProjectFile(projectFile);
  return { dir, projectFile, name: info.name, mainScene: info.mainScene, valid: true, hasBridgeAutoload: info.hasBridgeAutoload };
}

/**
 * Discover up to `limit` GDScript files under a project directory, skipping
 * `.godot/` (import cache) and hidden directories.
 * @param {string} dir project directory
 * @param {{ limit?: number }} [options]
 * @returns {{ scripts: string[], truncated: boolean }} scripts as `res://` paths
 */
export function discoverScripts(dir, { limit = MAX_DISCOVERED_SCRIPTS } = {}) {
  const found = [];
  let truncated = false;
  /** @type {string[]} */
  const stack = [path.resolve(dir)];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.godot' || entry.name === 'node_modules') continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !/\.gd$/i.test(entry.name)) continue;
      const relative = path.relative(dir, full).replace(/\\/g, '/');
      found.push(`res://${relative}`);
    }
  }
  found.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (found.length > limit) {
    truncated = true;
    found.length = limit;
  }
  return { scripts: found, truncated };
}

/**
 * Convert a user-supplied script reference to a `res://` path.
 * @param {string} script relative path, absolute path or `res://` path
 * @param {string} dir project directory
 * @returns {string} `res://` path
 */
export function normaliseScriptPath(script, dir) {
  const trimmed = String(script).trim().replace(/^"(.*)"$/, '$1');
  if (/^res:\/\//i.test(trimmed)) return trimmed;
  if (path.isAbsolute(trimmed)) {
    const relative = path.relative(dir, trimmed).replace(/\\/g, '/');
    return `res://${relative}`;
  }
  return `res://${trimmed.replace(/^\.\//, '').replace(/\\/g, '/')}`;
}

/** Strip characters that would break a Godot project name / template text. */
function sanitiseProjectName(name) {
  const cleaned = String(name).replace(/[\r\n\t]/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : 'Godot Game';
}

/** Recursively list files under a directory (relative, forward slashes). */
function listFilesRecursive(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(path.relative(root, full));
    }
  }
  files.sort();
  return files;
}

/** Apply the documented template placeholders. */
function applyPlaceholders(text, name) {
  return text
    .replaceAll('{{NAME}}', name)
    .replaceAll('{{PROJECT_NAME}}', name)
    .replaceAll('{{MAIN_SCENE}}', DEFAULT_MAIN_SCENE)
    .replaceAll('{{BRIDGE_PATH}}', BRIDGE_RES_PATH);
}

/** Insert the bridge autoload row when the template did not ship one. */
function ensureBridgeAutoload(projectFile) {
  let text;
  try {
    text = fs.readFileSync(projectFile, 'utf8');
  } catch {
    return;
  }
  if (text.includes(BRIDGE_RES_PATH)) return;
  const row = `Bridge="*${BRIDGE_RES_PATH}"`;
  if (/^\[autoload\]\s*$/m.test(text)) {
    text = text.replace(/^\[autoload\]\s*$/m, `[autoload]\n\n${row}`);
  } else {
    text = `${text.replace(/\s*$/, '')}\n\n[autoload]\n\n${row}\n`;
  }
  fs.writeFileSync(projectFile, text, 'utf8');
}

/** Pick the template root: `templates/<template>/` when present, else `templates/`. */
function pickTemplateRoot(template) {
  if (template !== undefined && template !== null) {
    const value = String(template);
    if (value !== 'empty' && value !== '2d') {
      throw new Error(`unknown template "${value}": expected "empty" or "2d".`);
    }
    const specific = path.join(TEMPLATES_DIR, value);
    if (fs.existsSync(path.join(specific, 'project.godot.tmpl'))) return specific;
  }
  return TEMPLATES_DIR;
}

/**
 * Create a new Godot project in an empty or absent directory.
 *
 * @param {object} options
 * @param {string} options.directory target directory (must be empty or absent)
 * @param {string} [options.name] project display name (defaults to directory name)
 * @param {'empty'|'2d'} [options.template]
 * @param {boolean} [options.import] run the engine import pass (default true)
 * @param {{ path: string }} [options.engine] probed engine; required when importing
 * @param {{ enginePath?: string }} [options.config] engine config for discovery
 * @param {number} [options.timeoutMs]
 * @param {string} [options.captureDir]
 * @returns {Promise<{ project: {path: string, name: string, mainScene: string, valid: boolean}, name: string, mainScene: string, files: string[], import: {ok: boolean, exitCode: number|null, diagnostics: Array<object>} }>}
 */
export async function scaffoldProject({
  directory,
  name,
  template = 'empty',
  import: runImport = true,
  engine,
  config = {},
  timeoutMs = 30000,
  captureDir,
}) {
  if (typeof directory !== 'string' || directory.trim().length === 0) {
    throw new Error('godot_project_init requires a `directory` string (the project folder to create).');
  }
  if (!templatesAvailable()) {
    throw new Error(
      `the dsh-godot package is missing its project templates (expected ${path.join(TEMPLATES_DIR, 'project.godot.tmpl')} and ${path.join(TEMPLATES_DIR, BRIDGE_SOURCE_REL)}). Reinstall the bundle.`,
    );
  }

  const dir = path.resolve(directory.trim().replace(/^"(.*)"$/, '$1'));
  if (fs.existsSync(dir)) {
    if (!fs.statSync(dir).isDirectory()) throw new Error(`"${dir}" exists and is not a directory; choose an empty or new project directory.`);
    const entries = fs.readdirSync(dir);
    if (entries.length > 0) {
      throw new Error(`refusing to initialise "${dir}": the directory is not empty (${entries.slice(0, 5).join(', ')}${entries.length > 5 ? ', …' : ''}). Choose an empty or new directory.`);
    }
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }

  const projectName = sanitiseProjectName(name ?? path.basename(dir));
  const templateRoot = pickTemplateRoot(template);
  const files = [];

  for (const relative of listFilesRecursive(templateRoot)) {
    const fileName = path.basename(relative);
    if (/\.md$/i.test(fileName)) continue; // documentation, never copied
    const isTemplate = /\.tmpl$/i.test(relative);
    let destinationRelative = relative.replace(/\.tmpl$/i, '').replace(/\\/g, '/');
    if (destinationRelative === BRIDGE_SOURCE_REL) destinationRelative = BRIDGE_DEST_REL;
    const source = path.join(templateRoot, relative);
    const destination = path.join(dir, destinationRelative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    let content = fs.readFileSync(source, 'utf8');
    if (isTemplate) content = applyPlaceholders(content, projectName);
    fs.writeFileSync(destination, content, 'utf8');
    files.push(destinationRelative);
  }

  const projectFile = path.join(dir, 'project.godot');
  if (!fs.existsSync(projectFile)) {
    throw new Error(`the dsh-godot templates are incomplete: no project.godot was produced in "${dir}".`);
  }
  if (!fs.existsSync(path.join(dir, BRIDGE_DEST_REL))) {
    throw new Error(`the dsh-godot templates are incomplete: "${BRIDGE_SOURCE_REL}" was not copied to "${BRIDGE_DEST_REL}".`);
  }
  ensureBridgeAutoload(projectFile);

  const project = readProjectFile(projectFile);
  const projectInfo = { path: dir, name: project.name, mainScene: project.mainScene, valid: true };

  let importResult = { ok: true, exitCode: null, diagnostics: [] };
  if (runImport) {
    let engineInfo = engine;
    if (engineInfo === undefined || engineInfo === null) {
      engineInfo = discoverEngine(config);
    }
    const run = await runOnce({
      command: [engineInfo.path, '--headless', '--path', dir, '--quit'],
      cwd: dir,
      timeoutMs,
      label: 'godot import pass',
      project: dir,
      ...(captureDir !== undefined ? { captureDir } : {}),
    });
    const diagnostics = parseGodotLog(run.output, { projectRoot: dir });
    if (run.exitCode !== 0 && !diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      diagnostics.push({
        severity: 'error',
        message: run.timedOut ? 'the Godot import pass timed out' : `the Godot import pass exited with code ${run.exitCode}`,
        source: 'engine',
        raw: run.output.slice(-2000),
      });
    }
    importResult = {
      ok: run.exitCode === 0 && !diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
      exitCode: run.exitCode,
      diagnostics,
    };
  }

  return { project: projectInfo, name: projectName, mainScene: project.mainScene, files, import: importResult };
}
