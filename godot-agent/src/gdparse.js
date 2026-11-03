/**
 * Godot console log -> structured diagnostics.
 *
 * `parseGodotLog` turns the stderr/stdout text of a `godot --headless ...`
 * invocation (check-only, import pass, or a real run) into the shared
 * Diagnostic shape from CONTRACT §3:
 *
 *   { severity, message, file?, line?, function?, source, raw }
 *
 * Only Node built-ins are used and no harness package is imported.
 */

/** ANSI colour escapes some Godot builds emit on a terminal-ish stream. */
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

/**
 * Engine banner / startup lines that are not diagnostics. Matching is done per
 * trimmed line so leading indentation does not matter.
 */
const HEADER_PATTERNS = [
  /^Godot Engine v\d/i,
  /^Godot Engine - /i,
  /^https?:\/\/godotengine\.org/i,
  /^-{10,}$/,
  /^Vulkan \d/i,
  /^OpenGL API \d/i,
  /^This is a console build/i,
];

/**
 * Non-fatal engine chatter explicitly ignored by CONTRACT §3. These can appear
 * as the message body of an `ERROR:`/`WARNING:` block (sandboxed import passes
 * emit the user://logs one), so the message is tested, not only the raw line.
 */
const NOISE_PATTERNS = [
  /Could not create directory: ['"]user:\/\/logs['"]/i,
  /Failed to open log file for writing/i,
  /Failed to read the root certificate store/i,
];

/** `SCRIPT ERROR: ...`, `ERROR: ...`, `WARNING: ...`, `SCRIPT WARNING: ...`. */
const SEVERITY_RE = /^(SCRIPT ERROR|SCRIPT WARNING|ERROR|WARNING):\s*(.*)$/;

/** A location line: `   at: <fn> (res://file.gd:12)` or `   at: res://file.gd:12`. */
const AT_RE = /^\s+at:\s*(.+?)\s*$/;

/**
 * Strip the Godot banner/startup lines from a captured log chunk.
 * @param {string} text raw captured output
 * @returns {string} text without the recognised banner lines
 */
export function stripEngineHeader(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  const lines = text.split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (HEADER_PATTERNS.some((re) => re.test(trimmed))) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Whether one diagnostic message is known non-fatal engine noise.
 * @param {string} message the message body
 * @returns {boolean} true when the message must be ignored
 */
export function isEngineNoise(message) {
  return NOISE_PATTERNS.some((re) => re.test(message));
}

/**
 * Split an `at:` payload into function and file/line.
 *
 * Accepted shapes:
 *   `GDScript::reload (res://broken.gd:4)`
 *   `_ready (res://main.gd:6)`
 *   `res://main.gd:6`
 *   `D:\game\main.gd:6`
 *
 * @param {string} payload text after `at:`
 * @returns {{ fn?: string, file?: string, line?: number }}
 */
function parseAtPayload(payload) {
  const text = payload.trim();
  if (text.length === 0) return {};

  let fn;
  let location = text;
  const paren = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(text);
  if (paren && paren[1] !== '') {
    fn = paren[1].trim();
    location = paren[2].trim();
  }

  let file;
  let line;
  const colon = /^(.*):(\d+)\s*$/.exec(location);
  if (colon) {
    file = colon[1].trim();
    const parsed = Number(colon[2]);
    if (Number.isInteger(parsed) && parsed > 0) line = parsed;
  } else {
    file = location;
  }

  return {
    ...(fn !== undefined && fn.length > 0 ? { fn } : {}),
    ...(file !== undefined && file.length > 0 ? { file } : {}),
    ...(line !== undefined ? { line } : {}),
  };
}

/**
 * Map an absolute engine path back onto the project's `res://` form when it is
 * inside the project. Paths already using `res://` (and paths outside the
 * project) are returned untouched.
 *
 * @param {string} file path captured from the log
 * @param {string} [projectRoot] absolute project directory
 * @returns {string} mapped path
 */
export function mapEnginePath(file, projectRoot) {
  if (typeof file !== 'string' || file.length === 0) return file;
  if (!projectRoot) return file;
  if (/^res:\/\//i.test(file)) return file;
  if (/^user:\/\//i.test(file)) return file;

  const normalisedFile = file.replace(/\\/g, '/');
  const normalisedRoot = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalisedRoot.length === 0) return file;

  const root = normalisedRoot.toLowerCase();
  const candidate = normalisedFile.toLowerCase();
  if (candidate === root) return 'res://';
  if (candidate.startsWith(root + '/')) return `res://${normalisedFile.slice(normalisedRoot.length + 1)}`;
  return file;
}

/** Derive the diagnostic source from the block header, message and location. */
function sourceFor(header, message, fn) {
  if (header === 'SCRIPT ERROR' || header === 'SCRIPT WARNING') {
    if (/parse error/i.test(message)) return 'parse';
    if (fn !== undefined && /GDScript::reload/i.test(fn)) return 'parse';
    return 'runtime';
  }
  return 'engine';
}

/**
 * Parse Godot console output into diagnostics.
 *
 * Each recognised `ERROR:` / `WARNING:` / `SCRIPT ERROR:` block becomes one
 * diagnostic; the first following `at:` line supplies file, line and function.
 * Banner lines are stripped and known non-fatal engine noise is dropped.
 * Exact duplicates (same severity/message/file/line/source) are collapsed.
 *
 * @param {string} text combined stdout+stderr of a Godot invocation
 * @param {{ projectRoot?: string }} [options]
 * @returns {Array<{severity: 'error'|'warning', message: string, file?: string, line?: number, function?: string, source: 'parse'|'runtime'|'engine', raw: string}>}
 */
export function parseGodotLog(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const projectRoot = typeof options.projectRoot === 'string' ? options.projectRoot : undefined;

  const clean = stripEngineHeader(text).replace(ANSI_RE, '');
  const lines = clean.split(/\r?\n/);
  const diagnostics = [];
  const seen = new Set();

  let current = null; // { header, message, rawLines, at }

  const flush = () => {
    if (current === null) return;
    const { header, message } = current;
    if (isEngineNoise(message)) {
      current = null;
      return;
    }
    const location = current.at ?? {};
    const file = location.file !== undefined ? mapEnginePath(location.file, projectRoot) : undefined;
    const diagnostic = {
      severity: header === 'WARNING' || header === 'SCRIPT WARNING' ? 'warning' : 'error',
      message,
      ...(file !== undefined ? { file } : {}),
      ...(location.line !== undefined ? { line: location.line } : {}),
      ...(location.fn !== undefined ? { function: location.fn } : {}),
      source: sourceFor(header, message, location.fn),
      raw: current.rawLines.join('\n'),
    };
    const key = [diagnostic.severity, diagnostic.message, diagnostic.file ?? '', diagnostic.line ?? '', diagnostic.source].join('\u0000');
    if (!seen.has(key)) {
      seen.add(key);
      diagnostics.push(diagnostic);
    }
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const severityMatch = SEVERITY_RE.exec(trimmed);
    if (severityMatch) {
      flush();
      current = {
        header: severityMatch[1],
        message: (severityMatch[2] ?? '').trim(),
        rawLines: [line.trimEnd()],
        at: undefined,
      };
      continue;
    }

    if (current !== null) {
      const at = AT_RE.exec(line);
      if (at) {
        if (current.at === undefined) {
          current.at = parseAtPayload(at[1]);
          current.rawLines.push(line.trimEnd());
        }
        continue;
      }
      // A second indented continuation line belongs to the same block only
      // until the first plain continuation; keep raw text for fidelity but do
      // not swallow the next header-less engine message.
      if (/^\s+/.test(line) && current.at === undefined) {
        current.rawLines.push(line.trimEnd());
        continue;
      }
      // Any other line ends the block.
      flush();
    }
  }
  flush();

  return diagnostics;
}
