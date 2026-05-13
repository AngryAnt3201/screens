# In-app Console — Design

**Date:** 2026-05-13
**Status:** Approved (pending user spec-review)
**Scope:** Add a Chrome-style Console panel docked to the right of the embedded
browser pane in `EmbeddedBrowser.tsx`. Console-only — no Elements / Network /
Sources / etc.

## Problem & goals

The embedded child webview already has a real native DevTools window
(`embed.openDevtools()` pops it out as a separate OS window). That's enough
for deep debugging but breaks flow when you want to glance at logs without
leaving the visual map. Goals:

1. **In-app, right-docked.** The user can see logs without managing another OS
   window. Drag-resizable from its left edge.
2. **Chrome fidelity.** Looks indistinguishable from Chrome's docked-right
   Console tab at a glance: same fonts, level colours, chevron expansion,
   filter chips, counter triplet, "Preserve log" toggle, evaluate prompt.
3. **No regressions in fallback `iframe` mode.** When running `npm run dev`
   without Tauri, the panel still renders but explains that capture requires
   the desktop app.

Non-goals:

- Other DevTools tabs (Elements/Network/Sources/...). The pop-out native
  DevTools button covers those.
- A custom "Default levels" dropdown. Four level chips are enough for v1.
- Editing the embedded page's storage/cookies from the panel.

## Architecture

The embedded child webview loads an external origin (the user's site) and
therefore does not share a `window` with the React host. The only reliable
bridge is via Rust, using Tauri 2's built-in IPC channel that's available on
every spawned webview regardless of origin.

```
┌─ embedded child webview (user's site) ──────┐
│  injected initialization_script:            │
│    • hooks console.log/.info/.warn/.error/  │
│      .debug/.table/.group/.groupEnd/.trace  │
│      /.assert/.count/.time/.timeEnd/.dir    │
│    • hooks window.onerror &                 │
│      unhandledrejection                     │
│    • serialises args with cycle-safe        │
│      previews (depth-2 by default)          │
│    • posts via window.ipc.postMessage(...)  │
└──────────────────┬──────────────────────────┘
                   │  Tauri 2 IPC
                   ▼
       Rust: on_ipc_message → app.emit(
         "console:event", payload )
                   │
                   ▼
┌─ main webview (React UI) ───────────────────┐
│  ConsoleStore (React context + reducer):    │
│    • buffer (capped at 5_000 entries)       │
│    • filter state (regex, levels)           │
│    • input history                          │
│  ConsoleDrawer (right-docked panel)         │
└─────────────────────────────────────────────┘
```

**Evaluation** goes the other way. The input prompt invokes
`embed.evalJs(wrapped)` where `wrapped` is roughly:

```js
(async () => {
  try {
    const _r = await (0, eval)(USER_INPUT);
    window.ipc.postMessage(JSON.stringify({
      kind: 'eval-result', id, value: previewOf(_r),
    }));
  } catch (err) {
    window.ipc.postMessage(JSON.stringify({
      kind: 'eval-error', id, error: previewOf(err),
    }));
  }
})();
```

The `(0, eval)(…)` form evaluates in the page's global scope, matching
Chrome's behaviour. The result/error echoes back through the same IPC channel
and renders as a `← result` / `‹ error` line under the input.

## Components & file layout

New files, each single-purpose so they stay easy to reason about:

```
src/components/
  Console/
    ConsoleDrawer.tsx     ~120 LOC  panel chrome, left-edge resize handle,
                                    toggle wiring, fallback-mode hint
    ConsoleLog.tsx        ~140 LOC  scrollback list + virtualised rows
    ConsoleEntry.tsx      ~160 LOC  one row: level icon, source link,
                                    expandable preview, stack trace
    ConsoleInput.tsx       ~80 LOC  prompt with multiline auto-grow,
                                    history (↑/↓), eval submit
    ConsoleFilter.tsx      ~60 LOC  level chips, regex filter, clear button,
                                    "Preserve log" toggle, counter triplet
    inspectValue.tsx      ~120 LOC  recursive value renderer
                                    (object, array, function, primitive,
                                    DOM-ish element)

src/lib/
  consoleStore.ts         ~110 LOC  React context + reducer for buffer,
                                    filter, history; persists toggle + width
  consoleInject.ts        ~140 LOC  the JS string we inject into the child
                                    webview. Pure JS source — kept as a TS
                                    template literal for VCS friendliness.

src/components/EmbeddedBrowser.tsx     (edited: mounts the drawer next to
                                        the body, adds the URL-bar toggle
                                        button, wires keyboard shortcuts)
src-tauri/src/lib.rs                   (edited: passes init-script to the
                                        WebviewBuilder; forwards IPC
                                        messages with kind=='log' or
                                        'eval-result'/'eval-error' to the
                                        main webview via app.emit)
```

`inspectValue.tsx` is the piece most likely to grow over time (it's how
Chrome makes objects look good). It's pure and recursive so it's unit-
testable in isolation.

## Inject script (`consoleInject.ts`)

Runs **before** any of the user's page code via Tauri 2's
`WebviewBuilder::initialization_script`. Single IIFE, no globals beyond
`window.__SCREENS_CONSOLE__` (for pre-mount buffering and lazy-expansion
requests).

Captured calls:

- `console.log, info, warn, error, debug, trace, dir, table,
  group, groupEnd, groupCollapsed, assert, count, countReset, time,
  timeEnd, timeLog`
- `window.addEventListener('error', …)` for uncaught exceptions
- `window.addEventListener('unhandledrejection', …)` for promise rejections

Each captured call produces a payload:

```jsonc
{
  "kind": "log",
  "level": "log" | "info" | "warn" | "error" | "debug" | "trace",
  "subtype": "group" | "groupEnd" | "table" | "assert" | "count" | "time" | null,
  "args": [ /* serialised previews, depth 2, ≤200 keys/items each */ ],
  "source": "file.js:42:17",        // first stack frame outside the injector
  "ts": 1736769142091,               // wall-clock ms
  "navigationId": 3                  // increments on top-level navigation
}
```

After posting, the script calls the **original** `console.*` so a popped-out
native DevTools window continues to work normally.

**Pre-mount buffering.** If the host hasn't connected yet (e.g. the page
posts a `console.log` before our React drawer mounts), the inject script
queues up to 500 entries on `window.__SCREENS_CONSOLE__.buffer`. On first
IPC contact, the host drains the buffer in order and clears it.

**Lazy deep-expansion.** Large objects render with `(… N more)` previews.
Clicking the chevron sends `{ kind: 'expand', path: [...], id }` back, which
the inject script answers with a deeper serialisation. This prevents blowing
the IPC buffer on `console.log(window)`.

## Visual fidelity

Pinned to Chrome's docked-right Console:

- Font: `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`, 12px /
  16px line-height.
- Level rows:
  - `log` — neutral text on default background.
  - `info` — blue left-rule, blue ℹ icon.
  - `warn` — amber background tint, amber ⚠ icon.
  - `error` — red background tint, red ❌ icon, stack trace expanded by
    default.
- Chevron expansion for objects/arrays matches Chrome's progressive disclosure.
- Top bar (`ConsoleFilter.tsx`):
  - `[filter regex]` text input on the left.
  - Level chips: `Errors`, `Warnings`, `Info`, `Verbose` (toggle which levels
    show). Mapping mirrors Chrome:
    - `Errors` → `error` + uncaught `window.onerror` + `unhandledrejection`
    - `Warnings` → `warn` + `assert` failures
    - `Info` → `info` + `log`
    - `Verbose` → `debug` + `trace`
  - Counter triplet (right of chips): error count, warn count, info count.
  - "Preserve log" toggle.
  - Clear button (🗑️).
  - Close button (×).
- Input prompt: `›` glyph, monospace, multi-line auto-grow, history via ↑/↓.

## Toggle, persistence, keyboard

- A toggle button (`≡ console`) lives in the existing `iframe-chrome` URL
  bar, between the DevTools magnifier and the camera.
- Shortcuts (active when the embedded pane has focus or no `INPUT`/`TEXTAREA`
  is focused):
  - `Cmd/Ctrl + ``` → toggle drawer.
  - `Cmd/Ctrl + Alt + J` → open drawer + focus input.
  - `Esc` while input focused → blur (does not close drawer).
- Persisted (localStorage, via existing `usePersistedState` hook):
  - `screens:console:width` (default 360px, clamped [240, 80% of pane]).
  - `screens:console:open` (default `false`).
  - `screens:console:preserveLog` (default `true` — see below).
  - `screens:console:levels` (default all enabled).

## Log retention on navigation

Default: **Preserve log = ON.** Rationale: this app navigates between
screens constantly via the CLI (`screens go …`), and the most common debug
loop is "click around, then read what happened". Users who want Chrome's
default (clear on navigation) can flip the toggle, and the setting persists.

When Preserve log is off, the buffer is filtered down to entries with
`navigationId === currentNavigationId` on each top-level navigation event.
Entries are never deleted from storage in JS; they're just hidden from the
filtered view.

## Fallback iframe mode (`npm run dev`)

The fallback `<iframe>` is cross-origin and cannot be hooked. Behaviour:

- The drawer still mounts and the toggle still works.
- The log list shows one neutral row: *"Console capture requires the desktop
  app. Run `npm run app:dev`."*
- The eval input is `disabled` with a tooltip explaining why.
- No errors thrown, no warnings spammed.

## Error handling & edge cases

- **CSP-strict pages.** Tauri 2's `initialization_script` runs before the
  page's CSP applies; it doesn't inject `<script>` tags. Should work on any
  CSP including `default-src 'self'`.
- **Circular references** in console args — the cycle-safe serialiser
  replaces revisited objects with `{ __cyclic: true, path: "<root>.a.b" }`.
- **Very long strings** (> 10 KB) are truncated with a "… (N more chars)"
  marker; expanding requests the full value via the lazy-expansion channel.
- **Buffer overflow.** Hard cap of 5,000 entries; on overflow the oldest 500
  are dropped and a single neutral row reads *"Older entries dropped (N
  total since last clear)."*.
- **Eval that returns a `Promise`.** The wrapper `await`s it, so the
  resolved value is what shows as the result. A rejection shows as an
  `eval-error` row.
- **Multiple webviews over a session.** Every `embed_open` recreates the
  child webview; the host treats this as a navigation with a fresh
  `navigationId` and respects the Preserve log toggle.

## Testing

- **Unit (Vitest):**
  - `inspectValue`: primitives, objects, arrays, cycles, depth cap,
    DOM-ish elements, functions, symbols, BigInt.
  - `consoleInject` serialiser (the IIFE is wrapped in a way that lets us
    import the inner functions for testing).
  - `consoleStore` reducer: append, clear, filter, preserve-log gating,
    overflow drop.
- **Smoke (Playwright, optional for v1):** boot `npm run app:dev`, open
  the drawer, navigate to a fixture page that logs each level, assert each
  row renders with the right styling.

## Out of scope (v1)

- Default-levels dropdown (Chrome's "All levels" menu).
- Sidebar source links that open in a separate editor.
- Live network log inside the panel (would require CDP, which we don't
  have).
- Multiple consoles or tabs.
- Snippets / saved scripts.

## Open questions

None at design time. The Tauri 2 IPC channel availability on external-URL
webviews will be verified during the plan's first step; if it doesn't work
out, the fallback is a tiny localhost WebSocket spawned by Rust. That
contingency is captured in the implementation plan, not here.
