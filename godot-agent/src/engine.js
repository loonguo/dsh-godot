/**
 * Godot engine discovery and probing (CONTRACT §5).
 *
 * Order:
 *   1. config `enginePath` (file or directory; a directory prefers `*_console.exe`)
 *   2. env `GODOT_BIN`
 *   3. `godot` / `godot4` / `Godot` on PATH
 *   4. bounded scan of common install roots (depth <= 3), stopping at the first
 *      console executable
 *
 * Whenever a resolved path is a GUI executable and a sibling `*_console.exe`
 * exists, the console build is used instead: the non-console Windows build does
 * not reliably deliver stdout/stderr to a pipe.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { captureSync } from './runner.js';

/** Actionable error required by CONTRACT §5. */
export const ENGINE_NOT_FOUND_MESSAGE =
  'Godot engine not found. Install Godot 4.x and set `enginePath` in the `dsh-godot` row of `cordis.patch.yml`, or set the GODOT_BIN environment variable.';

const CONSOLE_SUFFIX_RE = /_console\.exe$/i;

/** @param {string} file */
function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** @param {string} dir */
function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Whether a path is the console variant of the Godot executable. */
export function isConsoleExecutable(exePath) {
  return typeof exePath === 'string' && CONSOLE_SUFFIX_RE.test(exePath);
}

/**
 * Derive the sibling `*_console.exe` path for a GUI executable and return it
 * when it exists; otherwise return the original path.
 * @param {string} exePath executable path
 * @returns {string} preferred executable path
 */
export function deriveConsolePath(exePath) {
  if (typeof exePath !== 'string' || exePath.length === 0) return exePath;
  if (isConsoleExecutable(exePath)) return exePath;
  if (!/\.exe$/i.test(exePath)) {
    const withExtension = `${exePath}.exe`;
    if (isFile(`${exePath}_console.exe`)) return `${exePath}_console.exe`;
    if (isFile(withExtension)) return deriveConsolePath(withExtension);
    return exePath;
  }
  const candidate = exePath.replace(/\.exe$/i, '_console.exe');
  return isFile(candidate) ? candidate : exePath;
}

/**
 * Find the best engine executable inside one directory (prefers console builds).
 * @param {string} dir directory to inspect
 * @returns {string|undefined} executable path
 */
export function findConsoleExeInDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const executableNames = entries.filter((name) => /\.exe$/i.test(name));
  const consoleName = executableNames.find((name) => CONSOLE_SUFFIX_RE.test(name));
  if (consoleName !== undefined) return path.join(dir, consoleName);
  const guiName = executableNames.find((name) => /godot/i.test(name));
  if (guiName === undefined) return undefined;
  const derived = deriveConsolePath(path.join(dir, guiName));
  return isFile(derived) ? derived : undefined;
}

/**
 * Turn a config/env candidate (file or directory) into a runnable executable.
 * @param {string} candidate path from config/env/PATH/scan
 * @returns {string|undefined} executable path, or undefined when nothing usable exists
 */
export function resolveEngineExecutable(candidate) {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) return undefined;
  const trimmed = candidate.trim().replace(/^"(.*)"$/, '$1');
  const resolved = path.resolve(trimmed);
  if (isDirectory(resolved)) return findConsoleExeInDir(resolved);
  if (isFile(resolved)) {
    const preferred = deriveConsolePath(resolved);
    return isFile(preferred) ? preferred : resolved;
  }
  return undefined;
}

/** @type {Map<string, {path: string, version: string, console: boolean}>} */
const probeCache = new Map();

/** Clear the successful-probe cache (tests and HMR). */
export function clearEngineProbeCache() {
  probeCache.clear();
}

/**
 * Run `--version` and return the engine identity. Results are cached per path.
 * @param {string} exePath engine executable (or path to one)
 * @param {{ timeoutMs?: number }} [options]
 * @returns {{ path: string, version: string, console: boolean }}
 */
export function probeEngine(exePath, { timeoutMs = 15000 } = {}) {
  const resolved = path.resolve(String(exePath));
  const cacheKey = resolved.toLowerCase();
  const cached = probeCache.get(cacheKey);
  if (cached !== undefined) return { ...cached };
  if (!isFile(resolved)) {
    throw new Error(`Godot engine executable not found at "${resolved}". Set \`enginePath\` in the dsh-godot row or $GODOT_BIN.`);
  }
  const result = captureSync(resolved, ['--version'], { timeoutMs });
  if (result.error) {
    const code = /** @type {{ code?: string }} */ (result.error).code;
    if (code === 'ENOENT') throw new Error(ENGINE_NOT_FOUND_MESSAGE);
    throw new Error(`cannot run "${resolved} --version": ${result.error.message}. Point \`enginePath\` at the Godot executable.`);
  }
  const text = `${result.stdout}\n${result.stderr}`.trim();
  const match = /Godot Engine v?([0-9][0-9A-Za-z.+-]*)/i.exec(text) ?? /([0-9]+\.[0-9]+(?:\.[0-9]+)?[-0-9A-Za-z.]*)/.exec(text);
  if (match === null) {
    const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    throw new Error(`"${resolved}" is not a working Godot engine: \`--version\` printed no version (${JSON.stringify(preview)}).`);
  }
  const info = { path: resolved, version: match[1], console: isConsoleExecutable(resolved) };
  probeCache.set(cacheKey, info);
  return { ...info };
}

/** PATH entries that may hold an engine, honouring PATHEXT on Windows. */
function findOnPath(name, env, platform) {
  const pathValue = env.PATH ?? env.Path ?? '';
  if (pathValue.length === 0) return [];
  const directories = pathValue.split(path.delimiter).filter((entry) => entry.length > 0);
  const extensions = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter((ext) => ext.length > 0) : [''];
  const names = [name];
  if (!/\.[a-z0-9]+$/i.test(name)) {
    for (const ext of extensions) names.push(`${name}${ext.toLowerCase()}`, `${name}${ext}`);
  }
  const found = [];
  for (const directory of directories) {
    for (const candidateName of names) {
      const candidate = path.join(directory, candidateName);
      if (isFile(candidate)) {
        found.push(candidate);
        break;
      }
      if (found.length > 0) break;
    }
    if (found.length > 0) break;
  }
  return found;
}

/** Default scan roots (bounded depth), expanded from the environment. */
export function defaultScanRoots(env = process.env, platform = process.platform) {
  if (platform !== 'win32') {
    return [
      { directory: '/usr/local/bin', prefix: /^godot/i },
      { directory: '/usr/bin', prefix: /^godot/i },
    ];
  }
  const localAppData = env.LOCALAPPDATA ?? path.join(env.USERPROFILE ?? os.homedir(), 'AppData', 'Local');
  return [
    { directory: 'D:\\Software', prefix: /^Godot/i },
    { directory: 'C:\\Program Files', prefix: /^Godot/i },
    { directory: path.join(localAppData, 'Programs'), prefix: /^Godot/i },
    { directory: 'D:\\', prefix: /^Godot/i },
    { directory: 'C:\\', prefix: /^Godot/i },
  ];
}

/**
 * Bounded depth-first scan for a console executable below directories matching
 * `prefix` inside `root.directory`.
 * @param {{ directory: string, prefix: RegExp }} root
 * @param {number} maxDepth
 * @returns {string|undefined}
 */
export function scanForConsoleExe(root, maxDepth = 3) {
  let entries;
  try {
    entries = fs.readdirSync(root.directory, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const starts = entries.filter((entry) => root.prefix.test(entry.name)).map((entry) => path.join(root.directory, entry.name));
  let fallback;
  for (const start of starts) {
    if (isFile(start)) {
      const preferred = deriveConsolePath(start);
      if (isConsoleExecutable(preferred)) return preferred;
      fallback ??= preferred;
      continue;
    }
    if (!isDirectory(start)) continue;
    /** @type {Array<{ directory: string, depth: number }>} */
    const stack = [{ directory: start, depth: 0 }];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      let children;
      try {
        children = fs.readdirSync(current.directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        const childPath = path.join(current.directory, child.name);
        if (child.isFile()) {
          if (CONSOLE_SUFFIX_RE.test(child.name)) return childPath;
          if (fallback === undefined && /\.exe$/i.test(child.name) && /godot/i.test(child.name)) {
            fallback = deriveConsolePath(childPath);
          }
        } else if (child.isDirectory() && current.depth < maxDepth && !/^\./.test(child.name)) {
          stack.push({ directory: childPath, depth: current.depth + 1 });
        }
      }
    }
  }
  return fallback !== undefined && isFile(fallback) ? fallback : undefined;
}

/**
 * Discover and probe a working Godot engine.
 * @param {{ enginePath?: string }} [config]
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, pathNames?: string[], scanRoots?: Array<{directory: string, prefix: RegExp}>, probeTimeoutMs?: number }} [options]
 * @returns {{ path: string, version: string, console: boolean }}
 */
export function discoverEngine(config = {}, options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const tried = [];
  const consider = (origin, candidate) => {
    const executable = resolveEngineExecutable(candidate);
    if (executable === undefined) {
      tried.push(`${origin} "${candidate}" (not found)`);
      return undefined;
    }
    try {
      return probeEngine(executable, { timeoutMs: options.probeTimeoutMs ?? 15000 });
    } catch (error) {
      tried.push(`${origin} ${executable}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  const configured = typeof config.enginePath === 'string' ? config.enginePath.trim() : '';
  if (configured.length > 0) {
    const found = consider('enginePath', configured);
    if (found !== undefined) return found;
  }

  const envPath = typeof env.GODOT_BIN === 'string' ? env.GODOT_BIN.trim() : '';
  if (envPath.length > 0) {
    const found = consider('GODOT_BIN', envPath);
    if (found !== undefined) return found;
  }

  const pathNames = options.pathNames ?? ['godot', 'godot4', 'Godot'];
  for (const name of pathNames) {
    for (const candidate of findOnPath(name, env, platform)) {
      const found = consider('PATH', candidate);
      if (found !== undefined) return found;
    }
  }

  const scanRoots = options.scanRoots ?? defaultScanRoots(env, platform);
  for (const root of scanRoots) {
    const candidate = scanForConsoleExe(root, 3);
    if (candidate === undefined) continue;
    const found = consider(`scan ${root.directory}`, candidate);
    if (found !== undefined) return found;
  }

  const detail = tried.length > 0 ? ` Tried: ${tried.slice(0, 6).join('; ')}` : '';
  throw new Error(`${ENGINE_NOT_FOUND_MESSAGE}${detail}`);
}
