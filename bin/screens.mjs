#!/usr/bin/env node
/**
 * `screens` — fully agent-driven CLI for the Screens desktop app.
 *
 * Stores everything under `~/.screens/` (overrideable via the `$SCREENS_HOME`
 * env var for tests). Talks to the running desktop app, when one is open,
 * through an append-only inbox at `~/.screens/inbox.jsonl`.
 *
 * Zero external dependencies — just Node 18+.
 */
import { argv, exit, env } from 'node:process';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  SCREENS_HOME,
  PROJECTS_DIR,
  INBOX_PATH,
  ensureStore,
  readRegistry,
  setCurrentSlug,
  currentSlug,
  listProjects,
  createProject,
  deleteProject,
  renameProject,
  projectExists,
  readProjectMeta,
  writeProjectMeta,
  readScreens,
  writeScreens,
  readAccounts,
  writeAccounts,
  attachScreenshot,
  detachScreenshot,
  emitInbox,
  pathFromInput,
  deriveScreenId,
  guessGroup,
  deriveTitle,
  autoPlace,
  SCREEN_STATUSES,
  readReview,
  writeReview,
  pullVerdicts,
  readVerdicts,
  CHECK_STATUSES,
  TICKET_STATUSES,
} from './lib/store.mjs';

// ─── Command dispatch ──────────────────────────────────────────────────────

const COMMANDS = {
  // meta
  help: cmdHelp,
  version: cmdVersion,
  home: cmdHome,

  // projects
  project: cmdProject,

  // current-project ops
  add: cmdAdd,
  remove: cmdRemove,
  rm: cmdRemove,
  list: cmdList,
  ls: cmdList,
  edge: cmdEdge,
  group: cmdGroup,
  status: cmdStatus,
  move: cmdMove,
  shot: cmdShot,

  // accounts
  account: cmdAccount,

  // review cockpit
  review: cmdReview,

  // runtime (CLI → running app)
  open: cmdOpen,
  go: cmdGo,
  reload: cmdReload,
  devtools: cmdDevtools,
  capture: cmdCapture,
  view: cmdView,
  'base-url': cmdBaseUrl,
};

const [, , topCmd, ...rest] = argv;

try {
  ensureStore();
  const handler = COMMANDS[topCmd] ?? (topCmd ? notFound : cmdHelp);
  handler(parseArgs(rest));
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

// ───────────────────────────────────────────────────────────────────────────
// help / version
// ───────────────────────────────────────────────────────────────────────────

function cmdHelp() {
  console.log(`screens — agent-driven CLI for the Screens desktop app

Usage:
  screens <command> [args]

Project management:
  project init    <slug> --base-url=<url> [--name=<n>]
  project list                              List all projects.
  project switch  <slug>                    Make <slug> the current project.
  project current                           Print the current project slug.
  project remove  <slug>                    Delete project + its data.
  project rename  <old> <new>
  project show    [<slug>]                  Print project metadata.

Screens (operates on the current project unless --project=<slug> is passed):
  add    <pathOrUrl> [--id --title --group --x --y --status]
  remove <id>
  list                                       List all screens (table).
  edge   <fromId> <toId>                     Add a directed edge.
  edge --remove <fromId> <toId>              Remove an edge.
  group  <id> --label=<l> [--x --y --w --h --color]
  status <id> <captured|stale|missing>
  move   <id> --x=<n> --y=<n>
  shot   <id> <pngPath>                      Attach a screenshot.

Accounts:
  account list
  account add    <id> --email=<e> [--name --role --password --color
                                   --login.url --login.email-selector
                                   --login.password-selector --login.submit-selector
                                   --login.success-url]
  account remove <id>
  account use    <id>                        Switch active account (runtime).
  account default <id>                       Make <id> the default for the project.

Review cockpit (agent emits checks; you rule them in the app, agent drains verdicts):
  review add-ticket <id> --title=<t> [--ref --pr --summary --status]
  review check      <ticketId> --title=<t> [--path=/x | --screen=<id>] [--account --detail --id]
  review list       [--json]
  review pull       [--json]                 Reviewer verdicts you haven't seen; advances cursor.
  review resolve    <checkId> <awaiting|pass|fail|changes>
  review reopen     <checkId>                Bump round + await re-review (after a fix).

Runtime (require the desktop app to be running):
  open                                       Launch the desktop app.
  go      <idOrPath>                         Navigate the embedded browser.
  reload                                     Reload the embedded browser.
  devtools                                   Open DevTools on the embedded page.
  capture [<id>]                             Capture the current (or named) screen.
  view    <map|split|app|review>
  base-url <newUrl>                          Update current project's base URL.

Global flags:
  --project=<slug>   Target a project other than the current one.

Environment:
  SCREENS_HOME       Override the data dir (default: ~/.screens)

Examples:
  screens project init resona-web --base-url=http://localhost:3000
  screens add http://localhost:3000/login --group=auth
  screens add /signup
  screens edge login app-home
  screens shot login ./tmp/login.png
  screens go /app/settings
  screens capture login
  screens account add tester --email=t@test.io --password=hunter2 \\
    --login.url=/login --login.email-selector='input[type=email]' \\
    --login.password-selector='input[type=password]' \\
    --login.submit-selector='button[type=submit]'
`);
}

function cmdVersion() {
  const pkg = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
      'utf8',
    ),
  );
  console.log(`screens ${pkg.version}`);
}

function cmdHome() {
  console.log(SCREENS_HOME);
}

// ───────────────────────────────────────────────────────────────────────────
// project
// ───────────────────────────────────────────────────────────────────────────

function cmdProject(args) {
  const [sub, ...subRest] = args.positional;
  if (!sub || sub === 'help') return projectHelp();
  const subArgs = { ...args, positional: subRest };
  const sub2 = {
    init: pInit, list: pList, switch: pSwitch, current: pCurrent,
    remove: pRemove, rm: pRemove, rename: pRename, show: pShow,
  }[sub];
  if (!sub2) fail(`unknown project subcommand: ${sub}`);
  sub2(subArgs);
}

function projectHelp() {
  console.log(`screens project <init|list|switch|current|remove|rename|show> ...`);
}

function pInit(args) {
  const [slug] = args.positional;
  if (!slug) fail('project init: <slug> required');
  if (!args.flags['base-url']) fail('project init: --base-url=<url> required');
  const project = createProject({
    slug,
    name: args.flags.name,
    baseUrl: args.flags['base-url'],
  });
  ok(`created project "${project.slug}" at ${join(PROJECTS_DIR, project.slug)}`);
  const reg = readRegistry();
  if (reg.current === slug) console.log(`  (also set as current project)`);
}

function pList() {
  const reg = readRegistry();
  const projects = listProjects();
  if (projects.length === 0) {
    console.log('no projects yet — run `screens project init <slug> --base-url=<url>`');
    return;
  }
  const w = Math.max(...projects.map((p) => p.slug.length), 4);
  console.log(`${' '.padEnd(2)}${'slug'.padEnd(w)}  base url                          name`);
  for (const p of projects) {
    const cur = reg.current === p.slug ? '★ ' : '  ';
    console.log(`${cur}${p.slug.padEnd(w)}  ${(p.baseUrl ?? '').padEnd(32)}  ${p.name}`);
  }
}

function pSwitch(args) {
  const [slug] = args.positional;
  if (!slug) fail('project switch: <slug> required');
  setCurrentSlug(slug);
  ok(`current project: ${slug}`);
  emitInbox('project.switch', { slug });
}

function pCurrent() {
  const slug = currentSlug();
  console.log(slug ?? '(none)');
}

function pRemove(args) {
  const [slug] = args.positional;
  if (!slug) fail('project remove: <slug> required');
  if (!args.flags.force && !args.flags.f) {
    fail(`refusing to delete project "${slug}" without --force`);
  }
  deleteProject(slug);
  ok(`deleted project "${slug}"`);
}

function pRename(args) {
  const [oldSlug, newSlug] = args.positional;
  if (!oldSlug || !newSlug) fail('project rename: <old> <new> required');
  renameProject(oldSlug, newSlug);
  ok(`renamed "${oldSlug}" → "${newSlug}"`);
}

function pShow(args) {
  const [slug] = args.positional;
  const target = slug ?? currentSlug();
  if (!target) fail('no current project');
  const meta = readProjectMeta(target);
  if (!meta) fail(`unknown project: "${target}"`);
  console.log(JSON.stringify(meta, null, 2));
}

// ───────────────────────────────────────────────────────────────────────────
// add / remove / list / edge / group / status / move / shot
// ───────────────────────────────────────────────────────────────────────────

function cmdAdd(args) {
  const slug = resolveProject(args);
  const [input] = args.positional;
  if (!input) fail('add: <pathOrUrl> required (e.g. /login or http://app/login)');
  const meta = readProjectMeta(slug);
  const data = readScreens(slug);
  const path = pathFromInput(input, meta.baseUrl);
  const id =
    args.flags.id ?? deriveScreenId(path, new Set(data.screens.map((s) => s.id)));
  if (data.screens.some((s) => s.id === id)) fail(`screen "${id}" already exists`);
  const group = args.flags.group ?? guessGroup(path, data.groups);
  const pos = autoPlace(data, group);
  const x = parseInt(args.flags.x ?? pos.x, 10);
  const y = parseInt(args.flags.y ?? pos.y, 10);
  const status = args.flags.status ?? 'missing';
  if (!SCREEN_STATUSES.has(status)) fail(`invalid status: ${status}`);
  const screen = {
    id,
    group,
    title: args.flags.title ?? deriveTitle(path),
    path,
    x,
    y,
    status,
    visitedAt: null,
  };
  data.screens.push(screen);
  writeScreens(slug, data);
  ok(`added screen "${id}" → ${path} (group "${group}") at (${x}, ${y})`);
}

function cmdRemove(args) {
  const slug = resolveProject(args);
  const [id] = args.positional;
  if (!id) fail('remove: <id> required');
  const data = readScreens(slug);
  const before = data.screens.length;
  data.screens = data.screens.filter((s) => s.id !== id);
  if (data.screens.length === before) fail(`screen "${id}" not found`);
  data.edges = data.edges.filter(([a, b]) => a !== id && b !== id);
  writeScreens(slug, data);
  detachScreenshot(slug, id);
  ok(`removed screen "${id}"`);
}

function cmdList(args) {
  const slug = resolveProject(args);
  const data = readScreens(slug);
  if (data.screens.length === 0) {
    console.log(`(no screens yet in "${slug}" — run \`screens add <pathOrUrl>\`)`);
    return;
  }
  const w = Math.max(...data.screens.map((s) => s.id.length), 4);
  const p = Math.max(...data.screens.map((s) => s.path.length), 4);
  console.log(`${'id'.padEnd(w)}  ${'path'.padEnd(p)}  group        status`);
  for (const s of data.screens) {
    console.log(
      `${s.id.padEnd(w)}  ${s.path.padEnd(p)}  ${(s.group ?? '').padEnd(11)}  ${s.status ?? '—'}`,
    );
  }
  console.log(
    `\n${data.screens.length} screens · ${data.edges.length} edges · ${data.groups.length} groups · project "${slug}"`,
  );
}

function cmdEdge(args) {
  const slug = resolveProject(args);
  const [from, to] = args.positional;
  if (!from || !to) fail('edge: <from> <to> required (use --remove to delete)');
  const data = readScreens(slug);
  if (!data.screens.some((s) => s.id === from)) fail(`unknown screen: ${from}`);
  if (!data.screens.some((s) => s.id === to)) fail(`unknown screen: ${to}`);
  if (args.flags.remove) {
    const before = data.edges.length;
    data.edges = data.edges.filter(([a, b]) => !(a === from && b === to));
    if (data.edges.length === before) fail(`edge ${from} → ${to} not found`);
    writeScreens(slug, data);
    ok(`removed edge ${from} → ${to}`);
    return;
  }
  if (data.edges.some(([a, b]) => a === from && b === to)) fail(`edge already exists`);
  data.edges.push([from, to]);
  writeScreens(slug, data);
  ok(`added edge ${from} → ${to}`);
}

function cmdGroup(args) {
  const slug = resolveProject(args);
  const [id] = args.positional;
  if (!id) fail('group: <id> required');
  const data = readScreens(slug);
  const existing = data.groups.find((g) => g.id === id);
  const merged = {
    id,
    label: args.flags.label ?? existing?.label ?? '/' + id,
    color: args.flags.color ?? existing?.color ?? `var(--c-${id})`,
    x: parseInt(args.flags.x ?? existing?.x ?? 40, 10),
    y: parseInt(args.flags.y ?? existing?.y ?? 40, 10),
    w: parseInt(args.flags.w ?? existing?.w ?? 640, 10),
    h: parseInt(args.flags.h ?? existing?.h ?? 280, 10),
  };
  if (existing) Object.assign(existing, merged);
  else data.groups.push(merged);
  writeScreens(slug, data);
  ok(`${existing ? 'updated' : 'added'} group "${id}"`);
}

function cmdStatus(args) {
  const slug = resolveProject(args);
  const [id, value] = args.positional;
  if (!id || !value) fail('status: <id> <captured|stale|missing>');
  if (!SCREEN_STATUSES.has(value)) fail(`invalid status: ${value}`);
  const data = readScreens(slug);
  const s = data.screens.find((x) => x.id === id);
  if (!s) fail(`screen "${id}" not found`);
  s.status = value;
  // Epoch-ms; the desktop UI renders it as a live "Nm ago" label.
  if (value === 'captured') s.visitedAt = Date.now();
  writeScreens(slug, data);
  ok(`set ${id} → ${value}`);
}

function cmdMove(args) {
  const slug = resolveProject(args);
  const [id] = args.positional;
  if (!id) fail('move: <id> required');
  const data = readScreens(slug);
  const s = data.screens.find((x) => x.id === id);
  if (!s) fail(`screen "${id}" not found`);
  if (args.flags.x != null) s.x = parseInt(args.flags.x, 10);
  if (args.flags.y != null) s.y = parseInt(args.flags.y, 10);
  writeScreens(slug, data);
  ok(`moved ${id} → (${s.x}, ${s.y})`);
}

function cmdShot(args) {
  const slug = resolveProject(args);
  const [id, src] = args.positional;
  if (!id || !src) fail('shot: <id> <pngPath>');
  attachScreenshot(slug, id, src);
  const data = readScreens(slug);
  const s = data.screens.find((x) => x.id === id);
  if (s) {
    s.status = 'captured';
    s.visitedAt = Date.now();
    writeScreens(slug, data);
  }
  ok(`attached screenshot for "${id}"`);
}

// ───────────────────────────────────────────────────────────────────────────
// account
// ───────────────────────────────────────────────────────────────────────────

function cmdAccount(args) {
  const [sub, ...subRest] = args.positional;
  if (!sub) return console.log(`screens account <list|add|remove|use|default> ...`);
  const subArgs = { ...args, positional: subRest };
  const sub2 = {
    list: aList, ls: aList,
    add: aAdd,
    remove: aRemove, rm: aRemove,
    use: aUse,
    default: aDefault,
  }[sub];
  if (!sub2) fail(`unknown account subcommand: ${sub}`);
  sub2(subArgs);
}

function aList(args) {
  const slug = resolveProject(args);
  const cfg = readAccounts(slug);
  if (cfg.accounts.length === 0) {
    console.log(`(no accounts yet in "${slug}")`);
    return;
  }
  const w = Math.max(...cfg.accounts.map((a) => a.id.length), 4);
  console.log(`${'id'.padEnd(w)}  email                       role      auto-login  default`);
  for (const a of cfg.accounts) {
    const def = cfg.defaultAccountId === a.id ? '★' : ' ';
    console.log(
      `${a.id.padEnd(w)}  ${(a.email ?? '').padEnd(26)}  ${(a.role ?? '').padEnd(8)}  ${a.login ? 'yes' : 'no'}        ${def}`,
    );
  }
}

function aAdd(args) {
  const slug = resolveProject(args);
  const [id] = args.positional;
  if (!id) fail('account add: <id> required');
  if (!args.flags.email) fail('account add: --email=<e> required');
  const cfg = readAccounts(slug);
  if (cfg.accounts.some((a) => a.id === id)) fail(`account "${id}" already exists`);
  const a = {
    id,
    name: args.flags.name ?? id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    email: args.flags.email,
    role: args.flags.role ?? 'member',
    color: parseInt(args.flags.color ?? nextHue(cfg), 10),
  };
  if (args.flags.password) a.password = args.flags.password;
  if (args.flags['login.url']) {
    a.login = {
      url: args.flags['login.url'],
      emailSelector: args.flags['login.email-selector'] ?? 'input[type=email], input[name=email]',
      passwordSelector: args.flags['login.password-selector'] ?? 'input[type=password]',
      submitSelector: args.flags['login.submit-selector'] ?? 'button[type=submit]',
    };
    if (args.flags['login.success-url']) a.login.successUrl = args.flags['login.success-url'];
  }
  cfg.accounts.push(a);
  if (!cfg.defaultAccountId) cfg.defaultAccountId = id;
  writeAccounts(slug, cfg);
  ok(`added account "${id}" (${a.email})`);
}

function aRemove(args) {
  const slug = resolveProject(args);
  const [id] = args.positional;
  if (!id) fail('account remove: <id> required');
  const cfg = readAccounts(slug);
  const before = cfg.accounts.length;
  cfg.accounts = cfg.accounts.filter((a) => a.id !== id);
  if (cfg.accounts.length === before) fail(`account "${id}" not found`);
  if (cfg.defaultAccountId === id) cfg.defaultAccountId = cfg.accounts[0]?.id ?? null;
  writeAccounts(slug, cfg);
  ok(`removed account "${id}"`);
}

function aUse(args) {
  const slug = resolveProject(args);
  const [id] = args.positional;
  if (!id) fail('account use: <id> required');
  const cfg = readAccounts(slug);
  if (!cfg.accounts.some((a) => a.id === id)) fail(`account "${id}" not found`);
  emitInbox('account.use', { project: slug, accountId: id });
  ok(`asked running app to switch to "${id}"`);
}

function aDefault(args) {
  const slug = resolveProject(args);
  const [id] = args.positional;
  if (!id) fail('account default: <id> required');
  const cfg = readAccounts(slug);
  if (!cfg.accounts.some((a) => a.id === id)) fail(`account "${id}" not found`);
  cfg.defaultAccountId = id;
  writeAccounts(slug, cfg);
  ok(`default account: ${id}`);
}

function nextHue(cfg) {
  const used = new Set(cfg.accounts.map((a) => a.color));
  for (const h of [240, 80, 160, 30, 310, 200, 120, 60, 0, 270, 100, 340]) {
    if (!used.has(h)) return h;
  }
  return 200;
}

// ───────────────────────────────────────────────────────────────────────────
// review — the review cockpit (agent emits tickets/checks; drains verdicts)
// ───────────────────────────────────────────────────────────────────────────

function cmdReview(args) {
  const [sub, ...subRest] = args.positional;
  if (!sub || sub === 'help') return reviewHelp();
  const subArgs = { ...args, positional: subRest };
  const sub2 = {
    'add-ticket': rAddTicket,
    ticket: rAddTicket,
    check: rCheck,
    list: rList,
    ls: rList,
    pull: rPull,
    resolve: rResolve,
    reopen: rReopen,
    'remove-ticket': rRemoveTicket,
    'remove-check': rRemoveCheck,
  }[sub];
  if (!sub2) fail(`unknown review subcommand: ${sub}`);
  sub2(subArgs);
}

function reviewHelp() {
  console.log(`screens review <add-ticket|check|list|pull|resolve|reopen|remove-ticket|remove-check> ...

  add-ticket <id> --title=<t> [--ref=<url> --pr=<url> --summary=<s> --status=<in-progress|in-review|done> --priority=<Highest|High|Medium|Low>]
  check      <ticketId> --title=<t> [--path=/x | --screen=<screenId>] [--account=<id> --detail=<d> --id=<checkId>]
  list       [--json]                     Tickets + checks + current display status.
  pull       [--json]                     Print reviewer verdicts you haven't seen; advance the cursor.
  resolve    <checkId> <awaiting|pass|fail|changes>   Set a check's canonical status.
  reopen     <checkId>                    Bump the review round + set awaiting (re-request review after a fix).
  remove-ticket <id> | remove-check <checkId>`);
}

function findCheck(review, checkId) {
  for (const t of review.tickets) {
    const c = (t.checks ?? []).find((x) => x.id === checkId);
    if (c) return { ticket: t, check: c };
  }
  return null;
}

/** Slugify a free-form string into an id-safe token. */
function slugToken(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'x';
}

function rAddTicket(args) {
  const slug = resolveProject(args);
  const [id] = args.positional;
  if (!id) fail('review add-ticket: <id> required');
  if (!args.flags.title) fail('review add-ticket: --title=<t> required');
  if (args.flags.status && !TICKET_STATUSES.has(args.flags.status)) {
    fail(`invalid ticket status: ${args.flags.status}`);
  }
  const PRIORITIES = new Set(['Highest', 'High', 'Medium', 'Low']);
  if (args.flags.priority && !PRIORITIES.has(args.flags.priority)) {
    fail(`invalid priority: ${args.flags.priority} (Highest|High|Medium|Low)`);
  }
  const review = readReview(slug);
  let ticket = review.tickets.find((t) => t.id === id);
  if (!ticket) {
    ticket = { id, checks: [], createdAt: Date.now() };
    review.tickets.push(ticket);
  }
  ticket.title = args.flags.title;
  if (args.flags.ref != null) ticket.ref = args.flags.ref;
  if (args.flags.pr != null) ticket.pr = args.flags.pr;
  if (args.flags.summary != null) ticket.summary = args.flags.summary;
  if (args.flags.priority != null) ticket.priority = args.flags.priority;
  ticket.status = args.flags.status ?? ticket.status ?? 'in-review';
  writeReview(slug, review);
  ok(`ticket "${id}" — ${ticket.title}`);
}

function rCheck(args) {
  const slug = resolveProject(args);
  const [ticketId] = args.positional;
  if (!ticketId) fail('review check: <ticketId> required');
  if (!args.flags.title) fail('review check: --title=<t> required');
  const review = readReview(slug);
  const ticket = review.tickets.find((t) => t.id === ticketId);
  if (!ticket) fail(`unknown ticket: "${ticketId}" (run \`screens review add-ticket ${ticketId} --title=…\` first)`);
  ticket.checks = ticket.checks ?? [];
  const existingIds = new Set(review.tickets.flatMap((t) => (t.checks ?? []).map((c) => c.id)));
  let id = args.flags.id;
  if (!id) {
    const base = `${slugToken(ticketId)}-${slugToken(args.flags.title)}`.slice(0, 56);
    id = base;
    for (let i = 2; existingIds.has(id); i++) id = `${base}-${i}`;
  } else if (existingIds.has(id)) {
    fail(`check "${id}" already exists`);
  }
  const check = {
    id,
    title: args.flags.title,
    status: 'awaiting',
    round: 0,
  };
  if (args.flags.detail != null) check.detail = args.flags.detail;
  if (args.flags.path != null) check.path = args.flags.path;
  if (args.flags.screen != null) check.screenId = args.flags.screen;
  if (args.flags.account != null) check.account = args.flags.account;
  ticket.checks.push(check);
  writeReview(slug, review);
  ok(`check "${id}" → ticket "${ticketId}"`);
}

/** Compute the display status of a check from the verdict log (round-matched). */
function displayStatus(check, verdicts) {
  let latest = null;
  for (const v of verdicts) {
    if (v.checkId === check.id && (v.round ?? 0) === (check.round ?? 0)) {
      if (!latest || (v.ts ?? 0) >= (latest.ts ?? 0)) latest = v;
    }
  }
  return latest ? latest.verdict : (check.status ?? 'awaiting');
}

function rollup(ticket, verdicts) {
  const checks = ticket.checks ?? [];
  if (checks.length === 0) return 'empty';
  const statuses = checks.map((c) => displayStatus(c, verdicts));
  if (statuses.some((s) => s === 'fail' || s === 'changes')) return 'needs-work';
  if (statuses.every((s) => s === 'pass')) return 'passed';
  return 'awaiting';
}

function rList(args) {
  const slug = resolveProject(args);
  const review = readReview(slug);
  const verdicts = readVerdicts(slug);
  if (args.flags.json) {
    console.log(JSON.stringify({ tickets: review.tickets }, null, 2));
    return;
  }
  if (review.tickets.length === 0) {
    console.log(`(no review tickets yet in "${slug}" — run \`screens review add-ticket <id> --title=…\`)`);
    return;
  }
  for (const t of review.tickets) {
    const roll = rollup(t, verdicts);
    console.log(`\n● ${t.id} — ${t.title}  [${roll}]${t.ref ? `  ${t.ref}` : ''}`);
    for (const c of t.checks ?? []) {
      const st = displayStatus(c, verdicts);
      const mark = { pass: '✓', fail: '✗', changes: '~', awaiting: '·' }[st] ?? '·';
      const where = c.path ?? (c.screenId ? `#${c.screenId}` : '—');
      const acct = c.account ? `  @${c.account}` : '';
      console.log(`   ${mark} [${st.padEnd(8)}] ${c.title}  →  ${where}${acct}  (${c.id})`);
    }
  }
  const total = review.tickets.reduce((n, t) => n + (t.checks?.length ?? 0), 0);
  console.log(`\n${review.tickets.length} tickets · ${total} checks · project "${slug}"`);
}

function rPull(args) {
  const slug = resolveProject(args);
  const fresh = pullVerdicts(slug);
  if (args.flags.json) {
    console.log(JSON.stringify(fresh, null, 2));
    return;
  }
  if (fresh.length === 0) {
    console.log('(no new verdicts)');
    return;
  }
  for (const v of fresh) {
    const mark = { pass: '✓', fail: '✗', changes: '~' }[v.verdict] ?? '?';
    console.log(`${mark} ${v.verdict.padEnd(8)} ${v.checkId}${v.note ? `  — ${v.note}` : ''}`);
  }
  console.log(`\n${fresh.length} new verdict(s). Fix fails, then \`screens review reopen <checkId>\`.`);
}

function rResolve(args) {
  const slug = resolveProject(args);
  const [checkId, status] = args.positional;
  if (!checkId || !status) fail('review resolve: <checkId> <awaiting|pass|fail|changes>');
  if (!CHECK_STATUSES.has(status)) fail(`invalid check status: ${status}`);
  const review = readReview(slug);
  const found = findCheck(review, checkId);
  if (!found) fail(`check "${checkId}" not found`);
  found.check.status = status;
  writeReview(slug, review);
  ok(`resolved ${checkId} → ${status}`);
}

function rReopen(args) {
  const slug = resolveProject(args);
  const [checkId] = args.positional;
  if (!checkId) fail('review reopen: <checkId> required');
  const review = readReview(slug);
  const found = findCheck(review, checkId);
  if (!found) fail(`check "${checkId}" not found`);
  found.check.round = (found.check.round ?? 0) + 1;
  found.check.status = 'awaiting';
  writeReview(slug, review);
  ok(`reopened ${checkId} → round ${found.check.round} (awaiting re-review)`);
}

function rRemoveTicket(args) {
  const slug = resolveProject(args);
  const [id] = args.positional;
  if (!id) fail('review remove-ticket: <id> required');
  const review = readReview(slug);
  const before = review.tickets.length;
  review.tickets = review.tickets.filter((t) => t.id !== id);
  if (review.tickets.length === before) fail(`ticket "${id}" not found`);
  writeReview(slug, review);
  ok(`removed ticket "${id}"`);
}

function rRemoveCheck(args) {
  const slug = resolveProject(args);
  const [checkId] = args.positional;
  if (!checkId) fail('review remove-check: <checkId> required');
  const review = readReview(slug);
  let removed = false;
  for (const t of review.tickets) {
    const before = (t.checks ?? []).length;
    t.checks = (t.checks ?? []).filter((c) => c.id !== checkId);
    if (t.checks.length !== before) removed = true;
  }
  if (!removed) fail(`check "${checkId}" not found`);
  writeReview(slug, review);
  ok(`removed check "${checkId}"`);
}

// ───────────────────────────────────────────────────────────────────────────
// Runtime / IPC
// ───────────────────────────────────────────────────────────────────────────

function cmdOpen(_args) {
  // Try to start the Tauri dev binary directly if it's already built; otherwise
  // fall back to `npm run app:dev` from the repo root.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const built = join(repoRoot, 'src-tauri', 'target', 'debug', 'screens-app');
  if (existsSync(built)) {
    spawn(built, [], { detached: true, stdio: 'ignore', cwd: repoRoot }).unref();
    ok('launched screens-app');
    return;
  }
  console.log(
    'desktop binary not found — run `npm run app:dev` (first build) or `npm run app:build` once, then `screens open` works.',
  );
  exit(2);
}

function cmdGo(args) {
  const [target] = args.positional;
  if (!target) fail('go: <idOrPath> required');
  emitInbox('navigate', { target });
  ok(`go → ${target}`);
}

function cmdReload() {
  emitInbox('reload', {});
  ok('reload');
}

function cmdDevtools() {
  emitInbox('devtools', {});
  ok('devtools');
}

function cmdCapture(args) {
  const [id] = args.positional;
  emitInbox('capture', { id: id ?? null });
  ok(`capture ${id ?? '(current)'}`);
}

function cmdView(args) {
  const [mode] = args.positional;
  if (!['map', 'split', 'app', 'review'].includes(mode)) fail('view: <map|split|app|review>');
  emitInbox('view', { mode });
  ok(`view ${mode}`);
}

function cmdBaseUrl(args) {
  const slug = resolveProject(args);
  const [url] = args.positional;
  if (!url) {
    const meta = readProjectMeta(slug);
    console.log(meta.baseUrl);
    return;
  }
  writeProjectMeta(slug, { baseUrl: url });
  ok(`baseUrl → ${url}`);
}

// ───────────────────────────────────────────────────────────────────────────
// Plumbing
// ───────────────────────────────────────────────────────────────────────────

function resolveProject(args) {
  const slug = args.flags.project ?? currentSlug();
  if (!slug) {
    fail(
      'no current project — run `screens project init <slug> --base-url=<url>` or pass --project=<slug>',
    );
  }
  if (!projectExists(slug)) fail(`unknown project: "${slug}"`);
  return slug;
}

function notFound() {
  fail(`unknown command: ${argv[2]}\n\nRun \`screens help\` for usage.`);
}

function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (next != null && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function ok(msg) { console.log(`✓ ${msg}`); }
function fail(msg) { console.error(`✗ ${msg}`); exit(1); }

// Touch unused imports so the bundler keeps `INBOX_PATH` exported for tests.
void INBOX_PATH;
void env;
