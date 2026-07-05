// All filesystem ops for the Screens project store live here so both the
// CLI and (eventually) any standalone scripts can share them.
//
// Layout (see AGENTS.md for the full spec):
//
//   ~/.screens/
//   ├── projects.json
//   ├── inbox.jsonl
//   └── projects/<slug>/{project.json,screens.json,accounts.json,screenshots/}
//
// Every read/write goes through this module — never reach into the
// filesystem directly from `screens.mjs`.

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, appendFileSync, readdirSync, statSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';

export const SCREENS_HOME = process.env.SCREENS_HOME
  ? resolve(process.env.SCREENS_HOME)
  : join(homedir(), '.screens');

export const PROJECTS_DIR = join(SCREENS_HOME, 'projects');
export const REGISTRY_PATH = join(SCREENS_HOME, 'projects.json');
export const INBOX_PATH = join(SCREENS_HOME, 'inbox.jsonl');

/** Make sure the entire store directory tree exists. Idempotent. */
export function ensureStore() {
  if (!existsSync(SCREENS_HOME)) mkdirSync(SCREENS_HOME, { recursive: true });
  if (!existsSync(PROJECTS_DIR)) mkdirSync(PROJECTS_DIR, { recursive: true });
  if (!existsSync(REGISTRY_PATH)) {
    writeJson(REGISTRY_PATH, { current: null, projects: [] });
  }
}

// ─── Registry ──────────────────────────────────────────────────────────────

export function readRegistry() {
  ensureStore();
  return readJson(REGISTRY_PATH);
}

export function writeRegistry(reg) {
  writeJson(REGISTRY_PATH, reg);
}

export function listProjects() {
  return readRegistry().projects.map((slug) => readProjectMeta(slug)).filter(Boolean);
}

export function currentSlug() {
  return readRegistry().current ?? null;
}

export function setCurrentSlug(slug) {
  const reg = readRegistry();
  if (!reg.projects.includes(slug)) {
    throw new Error(`unknown project: "${slug}"`);
  }
  reg.current = slug;
  writeRegistry(reg);
}

// ─── Project lifecycle ─────────────────────────────────────────────────────

const SCREEN_STATUSES = new Set(['captured', 'stale', 'missing']);
const SLUG_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/;

export function projectDir(slug) {
  return join(PROJECTS_DIR, slug);
}

export function projectExists(slug) {
  return existsSync(join(projectDir(slug), 'project.json'));
}

export function createProject({ slug, name, baseUrl }) {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid project slug: "${slug}"`);
  if (!baseUrl) throw new Error('baseUrl is required');
  validateUrl(baseUrl);
  ensureStore();
  const dir = projectDir(slug);
  if (existsSync(dir)) throw new Error(`project "${slug}" already exists`);
  mkdirSync(join(dir, 'screenshots'), { recursive: true });
  writeJson(join(dir, 'project.json'), {
    slug,
    name: name ?? toTitle(slug),
    baseUrl: baseUrl.replace(/\/$/, ''),
    createdAt: new Date().toISOString(),
  });
  writeJson(join(dir, 'screens.json'), { groups: [], screens: [], edges: [] });
  writeJson(join(dir, 'accounts.json'), { defaultAccountId: null, accounts: [] });
  const reg = readRegistry();
  if (!reg.projects.includes(slug)) reg.projects.push(slug);
  if (!reg.current) reg.current = slug;
  writeRegistry(reg);
  return readProjectMeta(slug);
}

export function deleteProject(slug) {
  const reg = readRegistry();
  if (!reg.projects.includes(slug)) throw new Error(`unknown project: "${slug}"`);
  rmSync(projectDir(slug), { recursive: true, force: true });
  reg.projects = reg.projects.filter((s) => s !== slug);
  if (reg.current === slug) reg.current = reg.projects[0] ?? null;
  writeRegistry(reg);
}

export function renameProject(oldSlug, newSlug) {
  if (!SLUG_RE.test(newSlug)) throw new Error(`invalid project slug: "${newSlug}"`);
  const reg = readRegistry();
  if (!reg.projects.includes(oldSlug)) throw new Error(`unknown project: "${oldSlug}"`);
  if (reg.projects.includes(newSlug)) throw new Error(`project "${newSlug}" already exists`);
  renameSync(projectDir(oldSlug), projectDir(newSlug));
  // Rewrite slug inside project.json.
  const meta = readJson(join(projectDir(newSlug), 'project.json'));
  meta.slug = newSlug;
  writeJson(join(projectDir(newSlug), 'project.json'), meta);
  reg.projects = reg.projects.map((s) => (s === oldSlug ? newSlug : s));
  if (reg.current === oldSlug) reg.current = newSlug;
  writeRegistry(reg);
}

export function readProjectMeta(slug) {
  const path = join(projectDir(slug), 'project.json');
  if (!existsSync(path)) return null;
  return readJson(path);
}

export function writeProjectMeta(slug, patch) {
  const path = join(projectDir(slug), 'project.json');
  const cur = readJson(path);
  const next = { ...cur, ...patch };
  if (next.baseUrl) {
    validateUrl(next.baseUrl);
    next.baseUrl = next.baseUrl.replace(/\/$/, '');
  }
  writeJson(path, next);
  return next;
}

// ─── Screens config ────────────────────────────────────────────────────────

export function readScreens(slug) {
  const path = join(projectDir(slug), 'screens.json');
  if (!existsSync(path)) throw new Error(`project "${slug}" not initialized`);
  const raw = readJson(path);
  return {
    groups: raw.groups ?? [],
    screens: raw.screens ?? [],
    edges: raw.edges ?? [],
  };
}

export function writeScreens(slug, data) {
  writeJson(join(projectDir(slug), 'screens.json'), data);
}

export function readAccounts(slug) {
  const path = join(projectDir(slug), 'accounts.json');
  if (!existsSync(path)) throw new Error(`project "${slug}" not initialized`);
  const raw = readJson(path);
  return {
    defaultAccountId: raw.defaultAccountId ?? null,
    accounts: raw.accounts ?? [],
  };
}

export function writeAccounts(slug, data) {
  writeJson(join(projectDir(slug), 'accounts.json'), data);
}

// ─── Screenshots ───────────────────────────────────────────────────────────

export function screenshotPath(slug, screenId) {
  return join(projectDir(slug), 'screenshots', `${screenId}.png`);
}

export function attachScreenshot(slug, screenId, srcPath) {
  if (!existsSync(srcPath)) throw new Error(`source not found: ${srcPath}`);
  const dest = screenshotPath(slug, screenId);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(srcPath, dest);
  return dest;
}

export function detachScreenshot(slug, screenId) {
  const dest = screenshotPath(slug, screenId);
  if (existsSync(dest)) rmSync(dest);
}

// ─── Inbox (CLI → running app) ─────────────────────────────────────────────

export function emitInbox(cmd, args = {}) {
  ensureStore();
  const entry = { ts: Date.now(), cmd, args };
  appendFileSync(INBOX_PATH, JSON.stringify(entry) + '\n');
  return entry;
}

// ─── Review (agent → app) + verdicts (app → agent) ─────────────────────────
//
// `review.json`   is written ONLY by the CLI (the agent). Read by the app.
// `verdicts.jsonl` is written ONLY by the app. Drained here via a line cursor.
// This mirrors screens.json + inbox.jsonl in the opposite direction; keeping a
// single writer per file is what lets us skip locking. See the review cockpit
// spec.

export function reviewPath(slug) {
  return join(projectDir(slug), 'review.json');
}

export function verdictsPath(slug) {
  return join(projectDir(slug), 'verdicts.jsonl');
}

export function verdictsCursorPath(slug) {
  return join(projectDir(slug), 'verdicts.cursor');
}

export function readReview(slug) {
  const path = reviewPath(slug);
  if (!existsSync(path)) return { tickets: [] };
  const raw = readJson(path);
  return { tickets: raw.tickets ?? [] };
}

export function writeReview(slug, data) {
  writeJson(reviewPath(slug), { tickets: data.tickets ?? [] });
}

/** All verdict lines ever recorded (parsed, blank/garbage lines skipped). */
export function readVerdicts(slug) {
  const path = verdictsPath(slug);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Append a verdict line. The running app is the normal writer of this file;
 * this helper exists so the CLI (and tests) can simulate a verdict without the
 * desktop app. Kept append-only + newline-terminated to match the app.
 */
export function appendVerdict(slug, verdict) {
  appendFileSync(verdictsPath(slug), JSON.stringify(verdict) + '\n');
  return verdict;
}

/** Read the drain cursor: number of verdict lines already pulled. */
export function readVerdictCursor(slug) {
  const path = verdictsCursorPath(slug);
  if (!existsSync(path)) return 0;
  const n = parseInt(readFileSync(path, 'utf8').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function writeVerdictCursor(slug, n) {
  // Cursor is agent-owned bookkeeping, not watched config — a plain write is
  // fine, but keep it atomic for consistency with the rest of the store.
  const path = verdictsCursorPath(slug);
  const tmp = path + '.tmp-' + process.pid;
  writeFileSync(tmp, String(n));
  renameSync(tmp, path);
}

/**
 * Return verdict lines the agent hasn't seen yet and advance the cursor.
 * If the log was truncated below the cursor (shouldn't happen in normal use),
 * reset and return everything.
 */
export function pullVerdicts(slug) {
  const all = readVerdicts(slug);
  let cursor = readVerdictCursor(slug);
  if (cursor > all.length) cursor = 0;
  const fresh = all.slice(cursor);
  writeVerdictCursor(slug, all.length);
  return fresh;
}

const CHECK_STATUSES = new Set(['awaiting', 'pass', 'fail', 'changes']);
const TICKET_STATUSES = new Set(['in-progress', 'in-review', 'done']);

export { CHECK_STATUSES, TICKET_STATUSES };

// ─── URL parsing / utilities ───────────────────────────────────────────────

/**
 * Given a path-or-URL like `/login` or `http://app/login`, plus a project's
 * baseUrl, return the path component. Throws if the URL is rooted at a
 * different origin than the project.
 */
export function pathFromInput(input, baseUrl) {
  if (input.startsWith('/')) return stripTrailingSlash(input);
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`not a path or URL: "${input}"`);
  }
  if (baseUrl) {
    const projectOrigin = new URL(baseUrl).origin;
    if (parsed.origin !== projectOrigin) {
      throw new Error(
        `URL origin "${parsed.origin}" does not match project baseUrl origin "${projectOrigin}"`,
      );
    }
  }
  return stripTrailingSlash(parsed.pathname + parsed.search);
}

function stripTrailingSlash(p) {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

export function deriveScreenId(path, existingIds) {
  const segments = path.split('/').filter(Boolean);
  let base = segments.length === 0 ? 'home' : segments.join('-');
  base = base.replace(/[:?#&=]/g, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/-+/g, '-').toLowerCase();
  base = base.replace(/^-+|-+$/g, '') || 'screen';
  if (!existingIds.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  throw new Error('could not derive a unique id');
}

export function guessGroup(path, existingGroups) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return ensureGroup('public', existingGroups);
  // Recognised conventions
  if (parts[0] === 'admin') return ensureGroup('admin', existingGroups);
  if (parts[0] === 'auth' || ['login', 'signup', 'forgot-password', 'verify', 'reset'].includes(parts[0]))
    return ensureGroup('auth', existingGroups);
  if (parts[0] === 'app' && parts[1] === 'settings') return ensureGroup('settings', existingGroups);
  if (parts[0] === 'app') return ensureGroup('app', existingGroups);
  // Fall back to top-level path segment
  return ensureGroup(parts[0], existingGroups);
}

/** Returns the group id; if not present in `existingGroups`, adds it. */
function ensureGroup(id, existingGroups) {
  if (existingGroups.some((g) => g.id === id)) return id;
  return id; // caller decides whether to push a synthetic group
}

export function deriveTitle(path) {
  const last = path.split('/').filter(Boolean).pop() ?? path;
  return last
    .replace(/^:/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Home';
}

function validateUrl(url) {
  try {
    new URL(url);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
}

function toTitle(s) {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Layout heuristics ─────────────────────────────────────────────────────

const CARD_W = 240;
const CARD_H = 192;
const GAP_X = 60;
const GAP_Y = 60;
const GROUP_W = 980;
const GROUP_H = 480;

/**
 * Place a newly-added screen. Tries to fit it on a row inside its group; if
 * it spills, starts a new row. If the group itself doesn't exist yet, creates
 * a synthetic one in a free area of the canvas.
 */
export function autoPlace(data, groupId) {
  let group = data.groups.find((g) => g.id === groupId);
  if (!group) {
    // Make a new group below all existing ones.
    const maxY = data.groups.reduce((m, g) => Math.max(m, g.y + g.h), 0);
    group = {
      id: groupId,
      label: '/' + groupId,
      color: `var(--c-${groupId})`,
      x: 40,
      y: maxY === 0 ? 40 : maxY + GAP_Y,
      w: GROUP_W,
      h: GROUP_H,
    };
    data.groups.push(group);
  }
  const peers = data.screens.filter((s) => s.group === groupId);
  // Snake-pack inside the group's bbox.
  const cols = Math.max(1, Math.floor((group.w - 40) / (CARD_W + GAP_X)));
  const idx = peers.length;
  const col = idx % cols;
  const row = Math.floor(idx / cols);
  return {
    x: group.x + 40 + col * (CARD_W + GAP_X),
    y: group.y + 40 + row * (CARD_H + GAP_Y),
  };
}

// ─── JSON I/O ──────────────────────────────────────────────────────────────

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  // Atomic write: tmp + rename so the running app never sees a half-flushed
  // file when its watcher fires.
  const tmp = path + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path);
}

// Re-exports for convenience.
export { SCREEN_STATUSES };
