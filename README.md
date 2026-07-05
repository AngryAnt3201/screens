# Screens

Native macOS / Windows / Linux desktop app for keeping a visual map of every route in *any number of* your web projects. Real embedded browser pane (WebView2 / WKWebView / WebKitGTK — DevTools, cookies, the lot) and a **CLI that an AI agent can drive end-to-end** to create projects, add screens by URL, switch accounts, and remote-control the running app.

## Architecture in one screenful

```
┌─ Your terminal / coding agent ──────────────────────┐
│  $ screens project init my-app --base-url=…         │
│  $ screens add http://localhost:3000/login          │
│  $ screens go /signup                               │
└─────────────────────────────────────────────────────┘
                      │ writes
                      ▼
            ~/.screens/
            ├── projects.json
            ├── inbox.jsonl
            └── projects/<slug>/{project,screens,accounts}.json
                              └─ screenshots/<id>.png
                      ▲
                      │ reads + watches
┌─ Screens.app (Tauri) ───────────────────────────────┐
│   ┌────── top bar (project switcher, view tabs) ──┐ │
│   │ Sidebar │           Canvas    │  Embedded     │ │
│   │ routes  │   @xyflow/react     │  WebView      │ │
│   │ accounts│   draggable nodes   │  + DevTools   │ │
│   └────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

## Prerequisites

- **Node 18+**
- **Rust 1.77+** (`rustup default stable`)
- macOS: **Xcode CLT**; Windows: MSVC build tools; Linux: `webkit2gtk`

## Install

```bash
git clone <repo>
cd "Screen Visualiser"
npm install
npm link               # makes `screens` available globally
```

After `npm link`, the `screens` CLI is on your `$PATH`. Without it, prefix everything with `npm run screens --` or `./bin/screens.mjs`.

## Use it

```bash
# 1. Initialise a project (writes to ~/.screens/projects/my-app/)
screens project init my-app --base-url=http://localhost:3000 --name="My App"

# 2. Boot the desktop app
npm run app:dev        # or `screens open` once you've built once
```

The window opens on the project you just created. From here on, **everything** is driveable from the CLI:

```bash
# Add screens by URL or path
screens add http://localhost:3000/login
screens add /signup --group=auth
screens add /app --title="Dashboard"

# Wire link relationships
screens edge login app

# Drop in screenshots
screens shot login ./tmp/login.png

# Capture from inside the running app
screens go /signup
screens capture
screens devtools

# Test-account flows (cookies isolated per account)
screens account add tester \
  --email=t@test.io --password=hunter2 \
  --login.url=/login \
  --login.email-selector='input[type=email]' \
  --login.password-selector='input[type=password]' \
  --login.submit-selector='button[type=submit]'

screens account use tester      # tells the running app to switch
```

`screens help` prints the full reference. Some highlights:

| Group     | Commands |
| --------- | -------- |
| Projects  | `project init/list/switch/current/remove/rename/show` |
| Screens   | `add`, `remove`, `list`, `edge`, `group`, `status`, `move`, `shot` |
| Accounts  | `account list/add/remove/use/default` |
| Runtime   | `open`, `go`, `reload`, `devtools`, `capture`, `view`, `base-url` |
| Meta      | `help`, `version`, `home` |

All commands accept `--project=<slug>` to target a project other than the current one. The `$SCREENS_HOME` env var moves the store off `~/.screens` (handy for tests).

## In-app console

The right pane has a Chrome-style Console docked to its right edge.

- Toggle: button in the URL bar or `⌘\`` / `Ctrl+\``.
- Filter: regex, level chips (Errors / Warnings / Info / Verbose).
- Evaluate: type JS into the prompt — `(0, eval)(…)` semantics, so it runs in
  the page's global scope, exactly like Chrome.
- Preserve log on navigation: on by default.

For deep debugging (Elements, Network, Sources, …), the existing `[🔍]`
button still pops the real native DevTools window.

## Review cockpit

The **Review** view (`⌘4` / `Ctrl+4`) turns a day of agent work into a few
minutes of clicking — or rather, keypresses. An agent emits tickets + checks via
`screens review …`; you rule each one and your verdicts flow back for the agent
to fix and re-request.

Built for speed — one key per check, mouse optional:

| Key | Action |
| --- | ------ |
| `J` / `K` | Move through the review queue (priority-ordered, Highest first) |
| `↵` | Open the focused check's page in the embedded browser (+ switch to its account) |
| `P` / `C` / `F` | Pass / Changes / Fail — then **auto-advance to the next check and load its page** |
| `N` | Jump to the note field for the focused check |
| `A` | Cycle the filter: To review → Needs work → All |
| `?` | Toggle the shortcut hints |

The **To review** filter (default) shrinks to empty as you go, ending on an
"All caught up" state. Verdicts are written to `verdicts.jsonl`; the agent drains
them with `screens review pull`. See **AGENTS.md** for the full protocol.

## How the runtime control works

The CLI commands `go / reload / devtools / capture / view / account use` write a JSON line to `~/.screens/inbox.jsonl`. The desktop app watches that file via the Rust `notify` crate and dispatches each command into the React UI. Latency is well under 100ms in practice.

No commands are lost if the app isn't running — they queue up and are drained on next launch.

## Auto-login

When an account has a `login` block:

```jsonc
"login": {
  "url": "/login",
  "emailSelector": "input[type=email]",
  "passwordSelector": "input[type=password]",
  "submitSelector": "button[type=submit]",
  "successUrl": "/app"
}
```

Switching to that account makes the embedded browser:

1. Navigate to `baseUrl + login.url`
2. Poll the DOM (up to 5s) for each selector
3. Fill via the React-aware native value-setter
4. Click submit
5. Optionally navigate to `successUrl`

Cookies persist in `~/Library/Application Support/dev.screens.app/accounts/<project>/<account>/` (macOS path — analogous on other platforms), so subsequent sessions stay signed in.

## Scripts

| Command               | What it does                                              |
| --------------------- | --------------------------------------------------------- |
| `screens <cmd>`       | The CLI (after `npm link`)                                |
| `npm run app:dev`     | Build + launch the desktop app in dev mode                |
| `npm run app:build`   | Bundle a `.dmg` / `.msi` / `.AppImage`                    |
| `npm run dev`         | Pure-web preview (no Tauri, iframe fallback)              |
| `npm run typecheck`   | Strict TS check                                           |
| `npm run screens`     | Run the CLI without linking (`npm run screens -- list`)   |

## For AI agents

See **AGENTS.md** — the canonical operating manual covering every CLI command, file schema, and the inbox protocol.
