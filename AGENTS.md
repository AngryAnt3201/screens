# Agent operating manual

You are an AI coding agent driving **Screens**, a desktop tool for visualising every route in a web project. This document is the canonical contract — every action you take is either a CLI invocation or a file edit under `~/.screens/`.

## Mental model

```
~/.screens/
├── projects.json            # { current: <slug>, projects: [<slug>, ...] }
├── inbox.jsonl              # append-only command queue → running app
└── projects/<slug>/
    ├── project.json         # { slug, name, baseUrl, defaultAccountId, createdAt }
    ├── screens.json         # { groups, screens, edges }
    ├── accounts.json        # { defaultAccountId, accounts }
    └── screenshots/<id>.png
```

- The CLI mutates these files. The desktop app reads + watches them.
- Whenever a screens/accounts file changes, the running app reloads that project automatically.
- Whenever the CLI appends a line to `inbox.jsonl`, the running app processes it.

Set `$SCREENS_HOME` to override the location (useful in CI / tests).

## Bootstrap flow (do this once per project)

```bash
screens project init <slug> --base-url=<full-url> [--name="Pretty Name"]
```

- `<slug>` must match `[a-z0-9][a-z0-9_-]{0,63}`.
- `--base-url` is required; everything you add later is resolved against it.
- This becomes the **current** project automatically if there isn't one.

## Adding screens

```bash
screens add <pathOrUrl> [flags]
```

Accepts either a project-relative path (`/login`) or a full URL whose origin matches the project's `baseUrl` (`http://localhost:3000/login`). URL origin mismatches throw. The CLI derives:

| Field    | From                                                                  |
| -------- | --------------------------------------------------------------------- |
| `id`     | last meaningful path segment, slugified; collisions get `-2`, `-3`, … |
| `path`   | the URL pathname (+ search)                                           |
| `title`  | title-cased last segment                                              |
| `group`  | recognised conventions (`auth`, `app`, `settings`, `admin`) → first path segment otherwise |
| `x`/`y`  | snake-packed into the group's bbox                                    |
| `status` | `missing` (until you attach a screenshot)                             |

Override any of these with `--id --title --group --x --y --status`. To re-place an existing screen later, use `screens move <id> --x --y`.

### Bulk add

There's no single "bulk add" command yet — invoke `screens add` per URL. The atomic writes mean the desktop app never sees a half-written file.

## Edges & groups

```bash
screens edge <fromId> <toId>
screens edge --remove <fromId> <toId>
screens group <id> --label=<l> [--x --y --w --h --color]
```

Adding a screen into a group that doesn't exist yet creates a synthetic group below the existing canvas.

## Status & screenshots

```bash
screens status <id> <captured|stale|missing>
screens shot   <id> <pngPath>     # also flips status → captured
```

Recommended screenshot size: **480×260** (2× card dimensions). The card uses `object-fit: cover` from the top.

## Test accounts

```bash
screens account add <id> \
  --email=<e> [--name --role --password --color] \
  [--login.url=/login \
   --login.email-selector='input[type=email]' \
   --login.password-selector='input[type=password]' \
   --login.submit-selector='button[type=submit]' \
   --login.success-url=/app]

screens account remove <id>
screens account list
screens account default <id>      # make <id> the default
screens account use <id>          # tell running app to switch (runtime)
```

When an account has a `login` block, switching to it triggers an embedded-webview auto-login:

1. Navigate to `baseUrl + login.url`
2. Poll DOM up to 5s for each selector
3. Fill via the React-aware native value-setter
4. Click submit
5. Optionally navigate to `successUrl`

Cookies are isolated per **project × account** under `~/Library/Application Support/dev.screens.app/accounts/<project>/<account>/` (macOS) — analogous paths on Windows / Linux. Switching account → automatic destroy + recreate of the embedded webview with the new cookie jar.

## Review cockpit (the review loop)

You emit review items; the human rules them in the app; you drain their verdicts
and iterate. This is the *return leg* of the store: `review.json` is written
**only by you** (the CLI); `verdicts.jsonl` is written **only by the app**. One
writer per file — never hand-edit `verdicts.jsonl`.

```bash
# 1. One ticket group per Jira/Dart ticket (or per logical unit of work).
screens review add-ticket DX-123 \
  --title="Billing widget on dashboard" \
  --ref="https://dexiq.atlassian.net/browse/DX-123" \
  --pr="https://github.com/org/repo/pull/45"

# 2. One check per atomic thing the human must verify. `--path` (or --screen)
#    is where clicking the check jumps the embedded browser; `--account`
#    switches session (triggers auto-login) before you land there.
screens review check DX-123 \
  --title="Dashboard shows billing widget" \
  --path=/app/dashboard --account=tester \
  --detail="Widget top-right, shows current plan name."

# 3. Later, read what the human ruled (advances a cursor — each verdict once).
screens review pull            # or --json for machine parsing

# 4. For each fail / changes: fix the code, then re-request review. `reopen`
#    bumps the check's round so the stale verdict no longer applies and it
#    shows as awaiting again in the sidebar.
screens review reopen dx-123-dashboard-shows-billing-widget

# Housekeeping
screens review list [--json]                 # tickets + checks + display status
screens review resolve <checkId> <status>    # set canonical status directly
screens review remove-ticket <id> | remove-check <checkId>
```

**Free-dump intake:** there's no magic parser. Given a paste of tasks or a ticket
body, *you* decide the tickets + checks and call `add-ticket` / `check`. A check's
display status in the app is derived from the latest verdict whose `round`
matches the check's current `round`; `reopen` is what makes re-review work.

### Review file schemas

`review.json` (you write):

```jsonc
{ "tickets": [ {
  "id": "DX-123", "title": "...", "ref": "https://…", "pr": "https://…",
  "status": "in-review", "createdAt": 1778625844000,
  "checks": [ {
    "id": "dx-123-c1", "title": "what to verify", "detail": "what done looks like",
    "path": "/app/dashboard", "screenId": "dashboard", "account": "tester",
    "status": "awaiting", "round": 0
  } ]
} ] }
```

`verdicts.jsonl` (the app writes; you only `pull`):

```jsonc
{ "ts": 1778625851000, "ticketId": "DX-123", "checkId": "dx-123-c1", "round": 0, "verdict": "pass" }
{ "ts": 1778625860000, "ticketId": "DX-123", "checkId": "dx-123-c2", "round": 0, "verdict": "fail", "note": "overflows on mobile" }
```

`verdict ∈ {pass, fail, changes}`. The cursor lives in `verdicts.cursor`.

## Runtime control (CLI ↔ running app)

These commands append to `~/.screens/inbox.jsonl`; the desktop app drains them via a file watcher:

| Command                    | Effect inside the running app                                  |
| -------------------------- | -------------------------------------------------------------- |
| `screens go <id\|path>`     | Navigate the embedded browser. `<id>` resolves to its `path`. |
| `screens reload`           | Hard-reload the embedded page                                  |
| `screens devtools`         | Open DevTools on the embedded page                             |
| `screens capture [<id>]`   | Capture the current (or named) screen                          |
| `screens view <map\|split\|app\|review>` | Switch view mode (`review` = the review cockpit)  |
| `screens account use <id>` | Switch active account (triggers auto-login)                    |
| `screens project switch <slug>` | Switch the current project                                |
| `screens base-url <url>`   | Change the current project's `baseUrl`                         |

Commands are FIFO and lossless across app restarts.

## Project management

```bash
screens project list            # list all projects (★ marks current)
screens project switch <slug>
screens project current         # prints the current slug, or "(none)"
screens project show [<slug>]   # JSON dump of project.json
screens project rename <old> <new>
screens project remove <slug> --force
```

Every other command also accepts `--project=<slug>` to target a non-current project ad-hoc.

## Recommended agent loop

```text
1. Discover the routes of the target codebase (walk react-router, next/app, etc.).
2. screens project init <slug> --base-url=<dev-server-url>
3. For each discovered route:
     screens add <full-url-or-path> [--group=<g>] [--title="..."]
4. For obvious link-flows between routes:
     screens edge <from> <to>
5. For each test-account flow:
     screens account add ... [--login.url=... --login.*-selector=...]
6. screens open                           # launch the desktop app
7. For each route to capture:
     screens go <id>
     <take a screenshot via your usual tooling>
     screens shot <id> <pngFile>
8. Iterate as the codebase changes.
```

## File schemas

### `~/.screens/projects.json`

```jsonc
{ "current": "my-app", "projects": ["my-app", "another"] }
```

### `~/.screens/projects/<slug>/project.json`

```jsonc
{
  "slug": "my-app",
  "name": "My App",
  "baseUrl": "http://localhost:3000",
  "defaultAccountId": "owner",
  "createdAt": "1778625844"
}
```

### `~/.screens/projects/<slug>/screens.json`

```jsonc
{
  "groups": [
    { "id": "auth", "label": "/auth", "color": "var(--c-auth)",
      "x": 40, "y": 360, "w": 640, "h": 480 }
  ],
  "screens": [
    { "id": "login", "group": "auth", "title": "Login", "path": "/login",
      "x": 80, "y": 400, "status": "captured", "visitedAt": "just now" }
  ],
  "edges": [ ["login", "app-home"] ]
}
```

### `~/.screens/projects/<slug>/accounts.json`

```jsonc
{
  "defaultAccountId": "owner",
  "accounts": [
    {
      "id": "owner", "name": "Ada", "email": "ada@test", "role": "owner",
      "color": 240, "password": "secret",
      "login": {
        "url": "/login",
        "emailSelector": "input[type=email]",
        "passwordSelector": "input[type=password]",
        "submitSelector": "button[type=submit]",
        "successUrl": "/app"
      }
    }
  ]
}
```

### `~/.screens/inbox.jsonl`

Append-only, one JSON object per line:

```jsonc
{ "ts": 1778625844671, "cmd": "navigate",     "args": { "target": "/signup" } }
{ "ts": 1778625845102, "cmd": "view",         "args": { "mode": "map" } }
{ "ts": 1778625845800, "cmd": "account.use",  "args": { "project": "my-app", "accountId": "owner" } }
```

Recognised commands: `navigate`, `reload`, `devtools`, `capture`, `view`, `account.use`, `project.switch`. Unknown commands are logged but ignored — safe to extend.

## Things to avoid

- Don't edit `~/.screens/` files outside of the CLI unless you really need to — the CLI's atomic writes prevent the running app from seeing torn JSON.
- Don't store production credentials in `accounts.json` — it's plaintext.
- Don't manually `rm -rf ~/.screens/projects/<slug>/`; use `screens project remove <slug> --force` so the registry stays consistent.
