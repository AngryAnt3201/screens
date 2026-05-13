# In-app Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Chrome-style Console panel that docks to the right of the embedded browser pane, captures `console.*` / errors / unhandled-rejections from the child webview, and lets you evaluate JS in the page.

**Architecture:** The embedded child webview loads an external origin and can't share `window` with the React host. We bridge it via a custom Tauri URI scheme (`screens-ipc://`): an injected init-script hooks console methods and `fetch()`es serialised payloads to that scheme. Tauri intercepts the request, emits a Tauri event to the main webview, and the React store appends entries to a docked, drag-resizable drawer. Evaluation goes the other way through the existing `embed.evalJs()` path.

**Tech Stack:** React 18 + TypeScript, Tauri 2 (`unstable` feature for multi-webview + `register_asynchronous_uri_scheme_protocol`), Vitest + jsdom for unit tests.

**Spec:** `docs/superpowers/specs/2026-05-13-in-app-console-design.md`

---

## File map (locks in decomposition)

```
src/lib/console/
  types.ts                 (NEW)  Wire types: LogLevel, LogEntry, IpcMessage…
  inspectValue.tsx         (NEW)  Pure recursive value renderer.
  inspectValue.test.tsx    (NEW)  Vitest for inspectValue.
  consoleStore.tsx         (NEW)  React context + reducer (JSX, hence .tsx).
  consoleStore.test.ts     (NEW)  Vitest for the reducer.
  consoleInject.ts         (NEW)  Builds the JS init-script string +
                                  exports its pure helpers for testing.
  consoleInject.test.ts    (NEW)  Vitest for the helpers (serialiser etc.).
  useConsoleBridge.ts      (NEW)  Tauri event listener → reducer dispatch.

src/components/Console/
  ConsoleDrawer.tsx        (NEW)  Right-docked container + resize handle.
  ConsoleFilter.tsx        (NEW)  Top bar: regex, level chips, counters,
                                  preserve toggle, clear, close.
  ConsoleLog.tsx           (NEW)  List of entries (non-virtualised in v1,
                                  measure before promoting).
  ConsoleEntry.tsx         (NEW)  One row.
  ConsoleInput.tsx         (NEW)  Eval prompt.

src/components/EmbeddedBrowser.tsx   (EDIT)  Mount drawer + toggle button +
                                             keyboard shortcuts.
src/components/icons.tsx             (EDIT)  Add the Terminal icon.
src/App.tsx                          (EDIT)  Wrap with ConsoleStoreProvider.
src/lib/tauri.ts                     (EDIT)  Add initScript arg to embed.open.
src/styles.css                       (EDIT)  All `.console-*` rules; chrome-
                                             matching colors per theme.

src-tauri/src/lib.rs                 (EDIT)  Register screens-ipc URI scheme;
                                             accept init_script arg in
                                             embed_open; emit "console:event"
                                             on inbound messages.

vite.config.ts                       (EDIT)  Add Vitest test config block.
package.json                         (EDIT)  Add vitest, jsdom, @testing-
                                             library/react, scripts.
```

Each file has one responsibility; nothing console-shaped leaks into `EmbeddedBrowser.tsx` beyond mounting the drawer.

---

## Task 1: Add Vitest test infrastructure

**Files:**
- Modify: `package.json`
- Modify: `vite.config.ts`
- Create: `src/lib/__smoke.test.ts`

- [ ] **Step 1: Install Vitest + jsdom + testing-library**

Run from project root:

```bash
npm install --save-dev vitest@^2.1 jsdom@^25 @testing-library/react@^16 @testing-library/jest-dom@^6 @testing-library/user-event@^14
```

Expected: dependencies added, no peer-dep errors. If React 18 peer-dep warnings appear from `@testing-library/react@16`, install `@testing-library/react@^15` instead (the v15 line targets React 18).

- [ ] **Step 2: Add Vitest config + scripts**

Edit `package.json` — add to `"scripts"`:

```jsonc
"test": "vitest",
"test:run": "vitest run"
```

Edit `vite.config.ts`. Current file is short; replace it with:

```ts
/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: false,
    hmr: { protocol: 'ws', host: 'localhost', port: 1421 },
    watch: { ignored: ['**/src-tauri/**'] },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['src/lib/__test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
}));
```

(If your current `vite.config.ts` has different server settings, keep yours — only add the `test:` block and the triple-slash directive at the top.)

- [ ] **Step 3: Add the test setup file**

Create `src/lib/__test-setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 4: Write the smoke test**

Create `src/lib/__smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

describe('vitest smoke', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run it**

```bash
npm run test:run
```

Expected: `1 passed` in the output.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vite.config.ts src/lib/__test-setup.ts src/lib/__smoke.test.ts
git commit -m "test: add vitest + jsdom + testing-library"
```

---

## Task 2: Verify the Tauri URI-scheme bridge actually works (spike)

This is a *spike* task — temporary code that proves the IPC channel works end-to-end. We keep the scheme registration but throw away the smoke handler at the end.

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json` (only if it restricts schemes — most likely not)
- Temporary: console.log in `src/App.tsx`

- [ ] **Step 1: Register the URI scheme in Rust**

Modify `src-tauri/src/lib.rs`. Find the `pub fn run()` function and the call to `tauri::Builder::default()`. Add a `.register_asynchronous_uri_scheme_protocol(...)` call before `.setup(...)`:

```rust
use tauri::http::{Response, StatusCode};

// inside pub fn run():
tauri::Builder::default()
    .register_asynchronous_uri_scheme_protocol("screens-ipc", |app, request, responder| {
        let app = app.clone();
        // Read body (the inject script POSTs JSON).
        let body_bytes = request.body().to_vec();
        let path = request.uri().path().trim_start_matches('/').to_string();
        tauri::async_runtime::spawn(async move {
            // For the spike: log everything and emit a smoke event.
            let payload_str = String::from_utf8_lossy(&body_bytes).to_string();
            log::info!("[screens-ipc] path={} body={}", path, payload_str);
            let _ = app.emit("console:event", serde_json::json!({
                "path": path,
                "raw": payload_str,
            }));
            // Reply with 204 + permissive CORS so the inject fetch resolves.
            let resp = Response::builder()
                .status(StatusCode::NO_CONTENT)
                .header("Access-Control-Allow-Origin", "*")
                .header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
                .header("Access-Control-Allow-Headers", "Content-Type")
                .body(Vec::new())
                .unwrap();
            responder.respond(resp);
        });
    })
    .setup(|app| { /* existing setup body unchanged */ Ok(()) })
```

Notes:
- The exact signature of `register_asynchronous_uri_scheme_protocol` in Tauri 2.11 takes a closure `Fn(&AppHandle, Request<Vec<u8>>, UriSchemeResponder) + Send + Sync + 'static`. Use `app.clone()` to move into the spawn.
- Add `use tauri::Emitter;` if not already imported (needed for `app.emit`).
- If `tauri::http::Response` import path differs in your Tauri version, see the official Tauri 2 docs page "Custom URI Scheme Protocol".

- [ ] **Step 2: Add a smoke init-script to the embedded webview**

In `src-tauri/src/lib.rs`, inside `embed_open`, after building `WebviewBuilder::new(...)` and before the `if let Some(dir)` block, add:

```rust
let mut builder = WebviewBuilder::new(EMBEDDED, WebviewUrl::External(parsed_url))
    .devtools(true)
    .initialization_script(r#"
        try {
          fetch('screens-ipc://ping', {
            method: 'POST',
            body: JSON.stringify({ hello: 'world', t: Date.now() }),
          }).catch(function(e){ /* silent */ });
        } catch (_) {}
    "#);
```

- [ ] **Step 3: Listen for the event in React**

Modify `src/App.tsx`. At the top imports, add:

```tsx
import { listen } from '@tauri-apps/api/event';
```

Inside the `Shell` component, add a `useEffect` near the existing `onInbox` effect:

```tsx
useEffect(() => {
  const off = listen('console:event', (e) => {
    // TEMPORARY SPIKE LOGGING — removed at the end of this task.
    // eslint-disable-next-line no-console
    console.log('[spike] console:event payload =', e.payload);
  });
  return () => { off.then((f) => f()); };
}, []);
```

- [ ] **Step 4: Boot the app and verify the round-trip**

```bash
npm run app:dev
```

Open the **main window's** DevTools (right-click the React UI, "Inspect Element"). You should see, in that DevTools console, a log line:

```
[spike] console:event payload = { path: 'ping', raw: '{"hello":"world","t":1736...}' }
```

If you see that line, the bridge works on macOS WKWebView. **Pause to verify this** — every subsequent task depends on it.

- [ ] **Step 5: Troubleshooting branch (only if Step 4 failed)**

If the line doesn't appear, the embedded page's CSP is likely blocking `fetch` to a custom scheme. Diagnose by adding a `console.warn` to the inject script's `.catch`. Then add a CSP-strip via `on_web_resource_request` to the `WebviewBuilder` for the embedded webview only:

```rust
builder = builder.on_web_resource_request(|_request, response| {
    let h = response.headers_mut();
    h.remove("content-security-policy");
    h.remove("content-security-policy-report-only");
});
```

Re-run. If still failing on a non-macOS host, fall back to the localhost HTTP server plan documented in the spec's "Open questions" section — *do not proceed past this task until the round-trip works*.

- [ ] **Step 6: Strip the temporary spike code**

- Remove the `console.log('[spike] …')` and the temporary `useEffect` listener from `src/App.tsx`.
- Remove the temporary `initialization_script(r#"...ping..."#)` from `embed_open` (we'll re-add the real inject script in Task 7).
- Keep: the `register_asynchronous_uri_scheme_protocol` registration.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lib.rs src/App.tsx
git commit -m "feat(tauri): register screens-ipc URI scheme for child→host messaging"
```

---

## Task 3: Wire types

**Files:**
- Create: `src/lib/console/types.ts`

- [ ] **Step 1: Define the types**

Create `src/lib/console/types.ts`:

```ts
// All log levels we represent. `error` covers uncaught + unhandled-rejection.
export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace';

// Optional sub-type for distinct visual treatment (group bars, table grid…).
export type LogSubtype =
  | null
  | 'group'
  | 'groupCollapsed'
  | 'groupEnd'
  | 'table'
  | 'assert'
  | 'count'
  | 'time'
  | 'eval-input'
  | 'eval-result'
  | 'eval-error';

// A serialised value preview. Recursive; capped server-side.
// `kind === 'collapsed'` means deeper data is fetchable via the expand channel.
export type Preview =
  | { kind: 'primitive'; type: 'string' | 'number' | 'bigint' | 'boolean' | 'null' | 'undefined' | 'symbol' | 'function'; value: string }
  | { kind: 'object'; ctor: string; entries: Array<[string, Preview]>; truncated?: number; path: string }
  | { kind: 'array'; ctor: string; items: Preview[]; truncated?: number; path: string }
  | { kind: 'element'; tag: string; attrs: Array<[string, string]>; truncated?: number; path: string }
  | { kind: 'collapsed'; ctor: string; path: string }
  | { kind: 'cyclic'; path: string };

// A single console entry as held by the store.
export interface LogEntry {
  id: string;            // local unique id ("e0", "e1", …)
  level: LogLevel;
  subtype: LogSubtype;
  args: Preview[];       // [] for eval-input rows, the source code is in `text`
  text?: string;         // raw text for eval-input rows
  source: string | null; // "file.js:42:17" or null
  ts: number;            // wall-clock ms
  navigationId: number;
  stack?: string | null; // present for level=='error' or trace
}

// Message coming OUT of the embedded webview (over screens-ipc://post).
export type InjectOutgoing =
  | {
      kind: 'log';
      level: LogLevel;
      subtype: LogSubtype;
      args: Preview[];
      source: string | null;
      ts: number;
      navigationId: number;
      stack?: string | null;
    }
  | { kind: 'eval-result'; id: string; value: Preview }
  | { kind: 'eval-error'; id: string; error: Preview; stack?: string | null }
  | { kind: 'expand-response'; reqId: string; preview: Preview }
  | { kind: 'navigated'; navigationId: number; url: string };

// Filter state held by ConsoleStore.
export interface FilterState {
  regex: string;            // raw regex source ("" = no filter)
  levels: Record<'errors' | 'warnings' | 'info' | 'verbose', boolean>;
  preserveLog: boolean;
}

export const DEFAULT_FILTER: FilterState = {
  regex: '',
  levels: { errors: true, warnings: true, info: true, verbose: true },
  preserveLog: true,
};

// Hard cap on entries before oldest are dropped.
export const BUFFER_LIMIT = 5000;
// Number dropped per overflow cycle.
export const BUFFER_DROP_BATCH = 500;
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: passes (the file is self-contained; only adds types).

- [ ] **Step 3: Commit**

```bash
git add src/lib/console/types.ts
git commit -m "feat(console): wire types"
```

---

## Task 4: `inspectValue.tsx` — recursive renderer

Renders a `Preview` to React nodes the way Chrome does. Pure, no React state.

**Files:**
- Create: `src/lib/console/inspectValue.tsx`
- Create: `src/lib/console/inspectValue.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/console/inspectValue.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InspectValue } from './inspectValue';
import type { Preview } from './types';

describe('InspectValue', () => {
  it('renders a string primitive in green', () => {
    const p: Preview = { kind: 'primitive', type: 'string', value: 'hello' };
    render(<InspectValue preview={p} />);
    const el = screen.getByText('"hello"');
    expect(el).toHaveAttribute('data-type', 'string');
  });

  it('renders a number primitive', () => {
    const p: Preview = { kind: 'primitive', type: 'number', value: '42' };
    render(<InspectValue preview={p} />);
    expect(screen.getByText('42')).toHaveAttribute('data-type', 'number');
  });

  it('renders null and undefined as keywords', () => {
    const { rerender } = render(
      <InspectValue preview={{ kind: 'primitive', type: 'null', value: 'null' }} />,
    );
    expect(screen.getByText('null')).toBeInTheDocument();
    rerender(<InspectValue preview={{ kind: 'primitive', type: 'undefined', value: 'undefined' }} />);
    expect(screen.getByText('undefined')).toBeInTheDocument();
  });

  it('renders an array preview inline', () => {
    const p: Preview = {
      kind: 'array',
      ctor: 'Array(2)',
      path: '$',
      items: [
        { kind: 'primitive', type: 'number', value: '1' },
        { kind: 'primitive', type: 'number', value: '2' },
      ],
    };
    render(<InspectValue preview={p} />);
    expect(screen.getByText(/Array\(2\)/)).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders an object preview with k: v pairs', () => {
    const p: Preview = {
      kind: 'object',
      ctor: 'Object',
      path: '$',
      entries: [
        ['name', { kind: 'primitive', type: 'string', value: 'Ada' }],
        ['age', { kind: 'primitive', type: 'number', value: '36' }],
      ],
    };
    render(<InspectValue preview={p} />);
    expect(screen.getByText(/name/)).toBeInTheDocument();
    expect(screen.getByText('"Ada"')).toBeInTheDocument();
    expect(screen.getByText('36')).toBeInTheDocument();
  });

  it('renders a cyclic marker', () => {
    const p: Preview = { kind: 'cyclic', path: '$.a.b' };
    render(<InspectValue preview={p} />);
    expect(screen.getByText(/\[Circular/)).toBeInTheDocument();
  });

  it('renders a collapsed object with a chevron', () => {
    const p: Preview = { kind: 'collapsed', ctor: 'HTMLElement', path: '$' };
    render(<InspectValue preview={p} />);
    expect(screen.getByText('HTMLElement')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /expand/i })).toBeInTheDocument();
  });

  it('renders truncated objects with an N-more note', () => {
    const p: Preview = {
      kind: 'object',
      ctor: 'Object',
      path: '$',
      entries: [['x', { kind: 'primitive', type: 'number', value: '1' }]],
      truncated: 7,
    };
    render(<InspectValue preview={p} />);
    expect(screen.getByText(/7 more/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npm run test:run -- inspectValue
```

Expected: all tests fail (the module doesn't exist yet).

- [ ] **Step 3: Implement**

Create `src/lib/console/inspectValue.tsx`:

```tsx
import { useState } from 'react';
import type { Preview } from './types';

interface Props {
  preview: Preview;
  /** Called when the user clicks an "expand" chevron on a collapsed value. */
  onExpand?: (path: string) => void;
  /** Visual depth (for indentation of nested objects/arrays). */
  depth?: number;
}

/**
 * Recursive renderer for a serialised value. Mirrors Chrome DevTools' inline
 * preview style: `Array(3) [1, 2, 3]`, `Object {key: "v", …}`, etc.
 *
 * Children of objects/arrays render inline up to the cap the inject script
 * already applied. The `collapsed` Preview kind signals there's more data
 * fetchable via `onExpand(path)`.
 */
export function InspectValue({ preview, onExpand, depth = 0 }: Props) {
  switch (preview.kind) {
    case 'primitive':
      return <Primitive preview={preview} />;
    case 'array':
      return (
        <ArrayPreview preview={preview} onExpand={onExpand} depth={depth} />
      );
    case 'object':
      return (
        <ObjectPreview preview={preview} onExpand={onExpand} depth={depth} />
      );
    case 'element':
      return <ElementPreview preview={preview} />;
    case 'collapsed':
      return (
        <span className="console-collapsed">
          <button
            type="button"
            className="console-chevron"
            aria-label="Expand"
            onClick={() => onExpand?.(preview.path)}
          >
            ▶
          </button>
          <span className="console-ctor">{preview.ctor}</span>
        </span>
      );
    case 'cyclic':
      return <span className="console-cyclic">[Circular &lt;{preview.path}&gt;]</span>;
  }
}

function Primitive({ preview }: { preview: Extract<Preview, { kind: 'primitive' }> }) {
  const display =
    preview.type === 'string' ? `"${preview.value}"` :
    preview.type === 'symbol' ? preview.value :
    preview.type === 'function' ? `ƒ ${preview.value}` :
    preview.value;
  return (
    <span className={`console-primitive console-p-${preview.type}`} data-type={preview.type}>
      {display}
    </span>
  );
}

function ArrayPreview({
  preview,
  onExpand,
  depth,
}: {
  preview: Extract<Preview, { kind: 'array' }>;
  onExpand?: (p: string) => void;
  depth: number;
}) {
  const [open, setOpen] = useState(depth === 0);
  return (
    <span className="console-array">
      <button
        type="button"
        className={`console-chevron ${open ? 'open' : ''}`}
        aria-label={open ? 'Collapse' : 'Expand'}
        onClick={() => setOpen((v) => !v)}
      >
        ▶
      </button>
      <span className="console-ctor">{preview.ctor}</span>
      <span className="console-bracket">[</span>
      {preview.items.map((item, i) => (
        <span key={i}>
          {i > 0 && <span className="console-sep">, </span>}
          <InspectValue preview={item} onExpand={onExpand} depth={depth + 1} />
        </span>
      ))}
      {preview.truncated ? (
        <span className="console-truncated">, … {preview.truncated} more</span>
      ) : null}
      <span className="console-bracket">]</span>
    </span>
  );
}

function ObjectPreview({
  preview,
  onExpand,
  depth,
}: {
  preview: Extract<Preview, { kind: 'object' }>;
  onExpand?: (p: string) => void;
  depth: number;
}) {
  const [open, setOpen] = useState(depth === 0);
  return (
    <span className="console-object">
      <button
        type="button"
        className={`console-chevron ${open ? 'open' : ''}`}
        aria-label={open ? 'Collapse' : 'Expand'}
        onClick={() => setOpen((v) => !v)}
      >
        ▶
      </button>
      <span className="console-ctor">{preview.ctor}</span>
      <span className="console-bracket">{' { '}</span>
      {preview.entries.map(([k, v], i) => (
        <span key={k}>
          {i > 0 && <span className="console-sep">, </span>}
          <span className="console-key">{k}</span>
          <span className="console-sep">: </span>
          <InspectValue preview={v} onExpand={onExpand} depth={depth + 1} />
        </span>
      ))}
      {preview.truncated ? (
        <span className="console-truncated">, … {preview.truncated} more</span>
      ) : null}
      <span className="console-bracket">{' }'}</span>
    </span>
  );
}

function ElementPreview({
  preview,
}: {
  preview: Extract<Preview, { kind: 'element' }>;
}) {
  return (
    <span className="console-element">
      <span className="console-bracket">&lt;</span>
      <span className="console-tag">{preview.tag}</span>
      {preview.attrs.map(([k, v]) => (
        <span key={k}>
          {' '}
          <span className="console-attr-name">{k}</span>
          <span className="console-sep">=</span>
          <span className="console-attr-val">"{v}"</span>
        </span>
      ))}
      <span className="console-bracket">&gt;</span>
      {preview.truncated ? (
        <span className="console-truncated"> …</span>
      ) : null}
    </span>
  );
}
```

- [ ] **Step 4: Run tests**

```bash
npm run test:run -- inspectValue
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/console/inspectValue.tsx src/lib/console/inspectValue.test.tsx
git commit -m "feat(console): InspectValue renderer + tests"
```

---

## Task 5: `consoleStore.ts` — reducer + context

The store holds the log buffer, filter state, eval-input history, and the navigation id. Implemented as a `useReducer` exposed via context.

**Files:**
- Create: `src/lib/console/consoleStore.tsx`  (JSX inside; must be `.tsx`)
- Create: `src/lib/console/consoleStore.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/console/consoleStore.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { consoleReducer, initialState } from './consoleStore';
import type { LogEntry } from './types';

const mkEntry = (over: Partial<LogEntry> = {}): LogEntry => ({
  id: 'e0',
  level: 'log',
  subtype: null,
  args: [{ kind: 'primitive', type: 'string', value: 'hi' }],
  source: 'app.js:1:1',
  ts: 1000,
  navigationId: 1,
  ...over,
});

describe('consoleReducer', () => {
  it('appends entries with unique ids', () => {
    const s = consoleReducer(initialState(), { type: 'append', entry: mkEntry({ id: '' }) });
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0].id).toMatch(/^e\d+$/);
    expect(s.nextId).toBe(1);
  });

  it('respects the buffer limit and drops oldest 500 on overflow', () => {
    let s = initialState();
    for (let i = 0; i < 5001; i++) {
      s = consoleReducer(s, { type: 'append', entry: mkEntry({ id: '', ts: i }) });
    }
    expect(s.entries.length).toBeLessThanOrEqual(5000);
    expect(s.entries[0].ts).toBeGreaterThan(0);
    expect(s.droppedSinceClear).toBeGreaterThanOrEqual(500);
  });

  it('clears entries and dropped counter on clear', () => {
    let s = consoleReducer(initialState(), { type: 'append', entry: mkEntry() });
    s = consoleReducer(s, { type: 'clear' });
    expect(s.entries).toEqual([]);
    expect(s.droppedSinceClear).toBe(0);
  });

  it('bumps navigationId and may filter entries when preserveLog is off', () => {
    let s = initialState();
    s = consoleReducer(s, { type: 'append', entry: mkEntry({ navigationId: 1 }) });
    s = consoleReducer(s, { type: 'setPreserve', value: false });
    s = consoleReducer(s, { type: 'navigated', navigationId: 2 });
    // preserveLog false → entries from previous nav are filtered out
    expect(s.entries).toEqual([]);
    expect(s.currentNavigationId).toBe(2);
  });

  it('keeps entries across navigation when preserveLog is on', () => {
    let s = initialState();
    s = consoleReducer(s, { type: 'append', entry: mkEntry({ navigationId: 1 }) });
    s = consoleReducer(s, { type: 'navigated', navigationId: 2 });
    expect(s.entries).toHaveLength(1);
  });

  it('toggles level chips in the filter', () => {
    let s = consoleReducer(initialState(), {
      type: 'setLevels',
      patch: { errors: false },
    });
    expect(s.filter.levels.errors).toBe(false);
    expect(s.filter.levels.warnings).toBe(true);
  });

  it('records eval input history with most recent last', () => {
    let s = consoleReducer(initialState(), { type: 'pushHistory', text: 'a' });
    s = consoleReducer(s, { type: 'pushHistory', text: 'b' });
    expect(s.history).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
npm run test:run -- consoleStore
```

Expected: imports fail (module missing).

- [ ] **Step 3: Implement**

Create `src/lib/console/consoleStore.tsx`:

```ts
import {
  createContext,
  type Dispatch,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from 'react';
import type { FilterState, LogEntry, Preview } from './types';
import { BUFFER_DROP_BATCH, BUFFER_LIMIT, DEFAULT_FILTER } from './types';
import { usePersistedState } from '../../hooks/usePersistedState';

export interface ConsoleState {
  entries: LogEntry[];
  filter: FilterState;
  history: string[];          // eval input history, oldest → newest
  nextId: number;
  currentNavigationId: number;
  droppedSinceClear: number;
}

export type ConsoleAction =
  | { type: 'append'; entry: LogEntry }
  | { type: 'clear' }
  | { type: 'navigated'; navigationId: number }
  | { type: 'setRegex'; value: string }
  | { type: 'setLevels'; patch: Partial<FilterState['levels']> }
  | { type: 'setPreserve'; value: boolean }
  | { type: 'pushHistory'; text: string }
  | { type: 'replaceCollapsed'; path: string; with: Preview }
  | { type: 'hydrate'; filter: FilterState };

export function initialState(): ConsoleState {
  return {
    entries: [],
    filter: { ...DEFAULT_FILTER, levels: { ...DEFAULT_FILTER.levels } },
    history: [],
    nextId: 0,
    currentNavigationId: 0,
    droppedSinceClear: 0,
  };
}

export function consoleReducer(
  state: ConsoleState,
  action: ConsoleAction,
): ConsoleState {
  switch (action.type) {
    case 'append': {
      const entry: LogEntry = action.entry.id
        ? action.entry
        : { ...action.entry, id: `e${state.nextId}` };
      let entries = state.entries.concat(entry);
      let droppedSinceClear = state.droppedSinceClear;
      if (entries.length > BUFFER_LIMIT) {
        droppedSinceClear += BUFFER_DROP_BATCH;
        entries = entries.slice(BUFFER_DROP_BATCH);
      }
      return {
        ...state,
        entries,
        droppedSinceClear,
        nextId: state.nextId + 1,
      };
    }
    case 'clear':
      return { ...state, entries: [], droppedSinceClear: 0 };
    case 'navigated': {
      if (state.filter.preserveLog) {
        return { ...state, currentNavigationId: action.navigationId };
      }
      return {
        ...state,
        entries: state.entries.filter((e) => e.navigationId === action.navigationId),
        currentNavigationId: action.navigationId,
      };
    }
    case 'setRegex':
      return { ...state, filter: { ...state.filter, regex: action.value } };
    case 'setLevels':
      return {
        ...state,
        filter: {
          ...state.filter,
          levels: { ...state.filter.levels, ...action.patch },
        },
      };
    case 'setPreserve':
      return { ...state, filter: { ...state.filter, preserveLog: action.value } };
    case 'pushHistory':
      return { ...state, history: state.history.concat(action.text).slice(-200) };
    case 'replaceCollapsed': {
      // Walk every entry's args and replace any collapsed preview whose path matches.
      const entries = state.entries.map((e) => ({
        ...e,
        args: e.args.map((a) => replaceCollapsed(a, action.path, action.with)),
      }));
      return { ...state, entries };
    }
    case 'hydrate':
      return { ...state, filter: action.filter };
  }
}

function replaceCollapsed(p: Preview, path: string, withP: Preview): Preview {
  if (p.kind === 'collapsed' && p.path === path) return withP;
  if (p.kind === 'object') {
    return { ...p, entries: p.entries.map(([k, v]) => [k, replaceCollapsed(v, path, withP)]) };
  }
  if (p.kind === 'array') {
    return { ...p, items: p.items.map((v) => replaceCollapsed(v, path, withP)) };
  }
  return p;
}

// ── React context ─────────────────────────────────────────────────────────

interface ConsoleContextValue {
  state: ConsoleState;
  dispatch: Dispatch<ConsoleAction>;
}

const Ctx = createContext<ConsoleContextValue | null>(null);

export function ConsoleStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(consoleReducer, undefined, initialState);

  // Persist filter prefs only; not the buffer itself.
  const [persistedFilter, setPersistedFilter] = usePersistedState<FilterState>(
    'screens:console:filter',
    DEFAULT_FILTER,
  );

  // Hydrate from persisted filter on mount.
  useEffect(() => {
    dispatch({ type: 'hydrate', filter: persistedFilter });
    // run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror filter changes back to storage.
  useEffect(() => {
    setPersistedFilter(state.filter);
  }, [state.filter, setPersistedFilter]);

  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useConsoleStore(): ConsoleContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useConsoleStore must be used inside ConsoleStoreProvider');
  return v;
}

// Derives the entries that the filter currently shows.
export function selectVisible(state: ConsoleState): LogEntry[] {
  const rx = state.filter.regex ? safeRegex(state.filter.regex) : null;
  const L = state.filter.levels;
  return state.entries.filter((e) => {
    if (e.level === 'error' && !L.errors) return false;
    if (e.level === 'warn' && !L.warnings) return false;
    if ((e.level === 'info' || e.level === 'log') && !L.info) return false;
    if ((e.level === 'debug' || e.level === 'trace') && !L.verbose) return false;
    if (rx) {
      const haystack =
        (e.text ?? '') +
        ' ' +
        e.args.map(previewText).join(' ');
      if (!rx.test(haystack)) return false;
    }
    return true;
  });
}

function safeRegex(src: string): RegExp | null {
  try {
    return new RegExp(src, 'i');
  } catch {
    return null;
  }
}

function previewText(p: Preview): string {
  switch (p.kind) {
    case 'primitive':
      return p.value;
    case 'object':
      return p.entries.map(([k, v]) => `${k}:${previewText(v)}`).join(' ');
    case 'array':
      return p.items.map(previewText).join(' ');
    case 'element':
      return p.tag;
    case 'collapsed':
      return p.ctor;
    case 'cyclic':
      return '[Circular]';
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npm run test:run -- consoleStore
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/console/consoleStore.tsx src/lib/console/consoleStore.test.ts
git commit -m "feat(console): store reducer + provider + selectVisible"
```

---

## Task 6: `consoleInject.ts` — the JS init-script

This is the JS string we hand to `WebviewBuilder::initialization_script`. We keep it as a TS template literal for VCS friendliness and export its pure helpers (the value serialiser) for unit testing.

**Files:**
- Create: `src/lib/console/consoleInject.ts`
- Create: `src/lib/console/consoleInject.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/console/consoleInject.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { serialiseForTest } from './consoleInject';

describe('inject-script serialiser', () => {
  it('serialises primitives', () => {
    expect(serialiseForTest('hi')).toMatchObject({ kind: 'primitive', type: 'string', value: 'hi' });
    expect(serialiseForTest(42)).toMatchObject({ kind: 'primitive', type: 'number', value: '42' });
    expect(serialiseForTest(true)).toMatchObject({ kind: 'primitive', type: 'boolean', value: 'true' });
    expect(serialiseForTest(null)).toMatchObject({ kind: 'primitive', type: 'null' });
    expect(serialiseForTest(undefined)).toMatchObject({ kind: 'primitive', type: 'undefined' });
  });

  it('serialises arrays up to the cap', () => {
    const p = serialiseForTest([1, 2, 3]);
    expect(p.kind).toBe('array');
    if (p.kind !== 'array') throw new Error('unreachable');
    expect(p.items).toHaveLength(3);
    expect(p.ctor).toBe('Array(3)');
  });

  it('serialises objects to depth 2', () => {
    const p = serialiseForTest({ a: { b: { c: 'deep' } } });
    expect(p.kind).toBe('object');
    if (p.kind !== 'object') throw new Error('unreachable');
    const [, av] = p.entries[0];
    expect(av.kind).toBe('object');
    if (av.kind !== 'object') throw new Error('unreachable');
    const [, bv] = av.entries[0];
    // At depth 2 we should have a collapsed marker for { c: 'deep' }
    expect(bv.kind === 'collapsed' || bv.kind === 'object').toBe(true);
  });

  it('handles cycles', () => {
    const o: any = { name: 'a' };
    o.self = o;
    const p = serialiseForTest(o);
    if (p.kind !== 'object') throw new Error('unreachable');
    const [, selfPreview] = p.entries.find(([k]) => k === 'self')!;
    expect(selfPreview.kind).toBe('cyclic');
  });

  it('caps object keys at 200', () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 250; i++) big[`k${i}`] = i;
    const p = serialiseForTest(big);
    if (p.kind !== 'object') throw new Error('unreachable');
    expect(p.entries.length).toBe(200);
    expect(p.truncated).toBe(50);
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
npm run test:run -- consoleInject
```

Expected: import error (module missing).

- [ ] **Step 3: Implement**

Create `src/lib/console/consoleInject.ts`:

```ts
/**
 * The string of JavaScript we inject into the child webview via Tauri 2's
 * `WebviewBuilder::initialization_script`. The whole thing is wrapped in an
 * IIFE so it doesn't pollute the user's global scope beyond a single
 * `window.__SCREENS_CONSOLE__` namespace.
 *
 * The script:
 *   1. Captures every console method we care about, serialises the arguments
 *      with a cycle-safe, depth-2 walker (see `serialiseFn` below), and
 *      `fetch`es a JSON envelope to `screens-ipc://post`.
 *   2. Captures uncaught errors via `window.addEventListener('error', …)`
 *      and unhandled rejections via `'unhandledrejection'`.
 *   3. Increments `__SCREENS_CONSOLE__.nav` on each `pageshow` and signals
 *      `{ kind: 'navigated' }` so the host can gate Preserve-log behaviour.
 *   4. Receives commands from the host via `window.__SCREENS_CONSOLE__.run`
 *      (called via `embed.evalJs(...)` from the host). Supported commands:
 *      `{ op: 'expand', path, reqId }` and `{ op: 'eval', code, id }`.
 *
 * The serialiser is also exported as a pure JS function (`serialiseForTest`)
 * so we can unit-test it without spinning up a child webview.
 */

// ── Pure helpers (exported for tests) ──────────────────────────────────────

const MAX_DEPTH = 2;
const MAX_KEYS = 200;
const MAX_STRING = 10_000;

// Shape mirrors Preview in types.ts but kept as a plain object literal so
// the JSON survives a stringify/parse round-trip without class instances.
export type WirePreview =
  | { kind: 'primitive'; type: 'string' | 'number' | 'bigint' | 'boolean' | 'null' | 'undefined' | 'symbol' | 'function'; value: string }
  | { kind: 'object'; ctor: string; entries: Array<[string, WirePreview]>; truncated?: number; path: string }
  | { kind: 'array'; ctor: string; items: WirePreview[]; truncated?: number; path: string }
  | { kind: 'element'; tag: string; attrs: Array<[string, string]>; path: string; truncated?: number }
  | { kind: 'collapsed'; ctor: string; path: string }
  | { kind: 'cyclic'; path: string };

interface SerialiseCtx {
  seen: WeakMap<object, string>;
  depth: number;
  path: string;
}

export function serialiseForTest(value: unknown): WirePreview {
  return serialise(value, { seen: new WeakMap(), depth: 0, path: '$' });
}

function serialise(v: unknown, ctx: SerialiseCtx): WirePreview {
  if (v === null) return { kind: 'primitive', type: 'null', value: 'null' };
  const t = typeof v;
  if (t === 'undefined') return { kind: 'primitive', type: 'undefined', value: 'undefined' };
  if (t === 'string') {
    const s = v as string;
    const value = s.length > MAX_STRING ? s.slice(0, MAX_STRING) + `… (${s.length - MAX_STRING} more chars)` : s;
    return { kind: 'primitive', type: 'string', value };
  }
  if (t === 'number') return { kind: 'primitive', type: 'number', value: String(v) };
  if (t === 'bigint') return { kind: 'primitive', type: 'bigint', value: (v as bigint).toString() + 'n' };
  if (t === 'boolean') return { kind: 'primitive', type: 'boolean', value: String(v) };
  if (t === 'symbol') return { kind: 'primitive', type: 'symbol', value: (v as symbol).toString() };
  if (t === 'function') return { kind: 'primitive', type: 'function', value: (v as Function).name || '(anonymous)' };

  // Objects (incl. arrays, elements, errors, etc.)
  const obj = v as object;
  if (ctx.seen.has(obj)) return { kind: 'cyclic', path: ctx.seen.get(obj)! };
  ctx.seen.set(obj, ctx.path);

  if (ctx.depth >= MAX_DEPTH) {
    return { kind: 'collapsed', ctor: ctor(obj), path: ctx.path };
  }

  if (Array.isArray(obj)) {
    const items: WirePreview[] = [];
    const cap = Math.min(obj.length, MAX_KEYS);
    for (let i = 0; i < cap; i++) {
      items.push(serialise(obj[i], { ...ctx, depth: ctx.depth + 1, path: `${ctx.path}[${i}]` }));
    }
    const truncated = obj.length - cap;
    return {
      kind: 'array',
      ctor: `Array(${obj.length})`,
      items,
      ...(truncated > 0 ? { truncated } : {}),
      path: ctx.path,
    };
  }

  // DOM element check (works in both jsdom and real browsers).
  if (typeof (globalThis as any).Element !== 'undefined' && obj instanceof (globalThis as any).Element) {
    const el = obj as Element;
    const attrs: Array<[string, string]> = Array.from(el.attributes ?? []).slice(0, 12).map((a) => [a.name, a.value]);
    return { kind: 'element', tag: el.tagName.toLowerCase(), attrs, path: ctx.path };
  }

  // Generic object: enumerable own keys, up to MAX_KEYS.
  const keys = Object.keys(obj);
  const cap = Math.min(keys.length, MAX_KEYS);
  const entries: Array<[string, WirePreview]> = [];
  for (let i = 0; i < cap; i++) {
    const k = keys[i];
    let child: WirePreview;
    try {
      child = serialise((obj as any)[k], { ...ctx, depth: ctx.depth + 1, path: `${ctx.path}.${k}` });
    } catch (err) {
      child = { kind: 'primitive', type: 'string', value: `[getter threw: ${(err as Error).message}]` };
    }
    entries.push([k, child]);
  }
  const truncated = keys.length - cap;
  return {
    kind: 'object',
    ctor: ctor(obj),
    entries,
    ...(truncated > 0 ? { truncated } : {}),
    path: ctx.path,
  };
}

function ctor(o: object): string {
  return (o as any).constructor?.name || 'Object';
}

// ── The injected script string ─────────────────────────────────────────────

/**
 * Returns the JS source we feed to Tauri's `initialization_script`. The
 * body inlines `serialise` so the page doesn't need to import anything.
 */
export function buildInjectScript(): string {
  // The IIFE body is *plain JS* — must not include any TS-only syntax.
  return `
(function() {
  if (window.__SCREENS_CONSOLE__) return; // already installed (Tauri injects on every navigation)
  var MAX_DEPTH = ${MAX_DEPTH};
  var MAX_KEYS = ${MAX_KEYS};
  var MAX_STRING = ${MAX_STRING};
  var nav = 1;
  var bufferedPreMount = [];
  var POST_URL = 'screens-ipc://post';
  var SELF = (window.__SCREENS_CONSOLE__ = { nav: nav, buffer: bufferedPreMount });

  function ctor(o) { try { return (o && o.constructor && o.constructor.name) || 'Object'; } catch (_) { return 'Object'; } }
  function serialise(v, ctx) {
    if (v === null) return { kind: 'primitive', type: 'null', value: 'null' };
    var t = typeof v;
    if (t === 'undefined') return { kind: 'primitive', type: 'undefined', value: 'undefined' };
    if (t === 'string') {
      var s = v;
      var value = s.length > MAX_STRING ? s.slice(0, MAX_STRING) + '… (' + (s.length - MAX_STRING) + ' more chars)' : s;
      return { kind: 'primitive', type: 'string', value: value };
    }
    if (t === 'number')  return { kind: 'primitive', type: 'number',  value: String(v) };
    if (t === 'bigint')  return { kind: 'primitive', type: 'bigint',  value: v.toString() + 'n' };
    if (t === 'boolean') return { kind: 'primitive', type: 'boolean', value: String(v) };
    if (t === 'symbol')  return { kind: 'primitive', type: 'symbol',  value: v.toString() };
    if (t === 'function')return { kind: 'primitive', type: 'function',value: v.name || '(anonymous)' };
    if (ctx.seen.has(v)) return { kind: 'cyclic', path: ctx.seen.get(v) };
    ctx.seen.set(v, ctx.path);
    if (ctx.depth >= MAX_DEPTH) return { kind: 'collapsed', ctor: ctor(v), path: ctx.path };
    if (Array.isArray(v)) {
      var items = [];
      var cap = Math.min(v.length, MAX_KEYS);
      for (var i = 0; i < cap; i++) items.push(serialise(v[i], { seen: ctx.seen, depth: ctx.depth + 1, path: ctx.path + '[' + i + ']' }));
      var truncated = v.length - cap;
      var out = { kind: 'array', ctor: 'Array(' + v.length + ')', items: items, path: ctx.path };
      if (truncated > 0) out.truncated = truncated;
      return out;
    }
    if (typeof Element !== 'undefined' && v instanceof Element) {
      var attrs = [];
      var atts = v.attributes || [];
      for (var j = 0; j < atts.length && j < 12; j++) attrs.push([atts[j].name, atts[j].value]);
      return { kind: 'element', tag: v.tagName.toLowerCase(), attrs: attrs, path: ctx.path };
    }
    var keys = [];
    try { keys = Object.keys(v); } catch (_) {}
    var cap2 = Math.min(keys.length, MAX_KEYS);
    var entries = [];
    for (var k = 0; k < cap2; k++) {
      var key = keys[k];
      var child;
      try { child = serialise(v[key], { seen: ctx.seen, depth: ctx.depth + 1, path: ctx.path + '.' + key }); }
      catch (err) { child = { kind: 'primitive', type: 'string', value: '[getter threw: ' + (err && err.message || err) + ']' }; }
      entries.push([key, child]);
    }
    var truncated2 = keys.length - cap2;
    var obj = { kind: 'object', ctor: ctor(v), entries: entries, path: ctx.path };
    if (truncated2 > 0) obj.truncated = truncated2;
    return obj;
  }

  function sourceOf(err) {
    var stack = (err && err.stack) || (new Error().stack) || '';
    var lines = stack.split('\\n');
    for (var i = 0; i < lines.length; i++) {
      // Skip frames inside this inject script (they have no source map → look for screens-ipc or our function names).
      var m = lines[i].match(/\\(?(https?:\\/\\/[^\\s)]+|file:\\/\\/[^\\s)]+):(\\d+):(\\d+)\\)?/);
      if (m && lines[i].indexOf('screens-ipc') === -1 && lines[i].indexOf('SCREENS_CONSOLE') === -1) {
        return m[1].replace(/^https?:\\/\\/[^/]+/, '') + ':' + m[2] + ':' + m[3];
      }
    }
    return null;
  }

  function send(payload) {
    try {
      fetch(POST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(function(){ /* CSP/network — silent */ });
    } catch (_) {}
  }

  function emitLog(level, subtype, args) {
    var src = sourceOf(new Error());
    var previews = [];
    for (var i = 0; i < args.length; i++) previews.push(serialise(args[i], { seen: new WeakMap(), depth: 0, path: '$' + i }));
    send({
      kind: 'log',
      level: level,
      subtype: subtype || null,
      args: previews,
      source: src,
      ts: Date.now(),
      navigationId: nav,
    });
  }

  // ─ Hook console.* ─
  var orig = {};
  var levelMap = {
    log: 'log', info: 'info', debug: 'debug', warn: 'warn', error: 'error', trace: 'trace',
    dir: 'log', table: 'log', group: 'log', groupCollapsed: 'log', groupEnd: 'log',
    assert: 'warn', count: 'log', countReset: 'log', time: 'log', timeEnd: 'log', timeLog: 'log',
  };
  var subtypeMap = {
    group: 'group', groupCollapsed: 'groupCollapsed', groupEnd: 'groupEnd',
    table: 'table', assert: 'assert', count: 'count', time: 'time', timeEnd: 'time', timeLog: 'time',
  };
  Object.keys(levelMap).forEach(function(name) {
    var fn = console[name];
    if (typeof fn !== 'function') return;
    orig[name] = fn;
    console[name] = function() {
      try { emitLog(levelMap[name], subtypeMap[name] || null, [].slice.call(arguments)); } catch (_) {}
      try { return orig[name].apply(console, arguments); } catch (_) {}
    };
  });

  // ─ Uncaught errors ─
  window.addEventListener('error', function(ev) {
    var err = ev.error || ev.message || ev;
    var preview = serialise(err, { seen: new WeakMap(), depth: 0, path: '$err' });
    var stack = (ev.error && ev.error.stack) || null;
    var src = ev.filename ? (ev.filename + ':' + (ev.lineno || 0) + ':' + (ev.colno || 0)) : null;
    send({
      kind: 'log', level: 'error', subtype: null,
      args: [preview],
      source: src, ts: Date.now(), navigationId: nav,
      stack: stack,
    });
  });
  window.addEventListener('unhandledrejection', function(ev) {
    var reason = ev.reason;
    var preview = serialise(reason, { seen: new WeakMap(), depth: 0, path: '$err' });
    var stack = (reason && reason.stack) || null;
    send({
      kind: 'log', level: 'error', subtype: null,
      args: [preview],
      source: null, ts: Date.now(), navigationId: nav,
      stack: stack,
    });
  });

  // ─ Navigation marker ─
  window.addEventListener('pageshow', function() {
    nav += 1; SELF.nav = nav;
    send({ kind: 'navigated', navigationId: nav, url: location.href });
  });

  // ─ Inbound command handler (host calls window.__SCREENS_CONSOLE__.run from eval) ─
  SELF.run = function(cmd) {
    if (!cmd || typeof cmd !== 'object') return;
    if (cmd.op === 'expand') {
      // Walk the global heap by path is too dangerous; instead the host
      // re-serialises the *args* of a specific log entry. To keep this
      // simple, the host can also re-issue console.log via eval to refresh
      // the entry. For v1 we just respond with a stub so the UI knows to
      // request via re-evaluation.
      send({ kind: 'expand-response', reqId: cmd.reqId, preview: { kind: 'collapsed', ctor: '(expand not supported in v1)', path: cmd.path } });
      return;
    }
    if (cmd.op === 'eval') {
      (async function() {
        try {
          var result = await (0, eval)(cmd.code);
          send({ kind: 'eval-result', id: cmd.id, value: serialise(result, { seen: new WeakMap(), depth: 0, path: '$r' }) });
        } catch (err) {
          send({
            kind: 'eval-error', id: cmd.id,
            error: serialise(err, { seen: new WeakMap(), depth: 0, path: '$e' }),
            stack: (err && err.stack) || null,
          });
        }
      })();
    }
  };
})();
`;
}
```

Two notes on this script:
- **Lazy deep-expand** is stubbed in v1 (the inject side responds with a "not supported" collapsed preview). The host still renders the chevron, but clicking it shows a small "(expand not supported in v1)" label. This avoids the complexity of holding live object references on the inject side. Promote to a real feature later if needed.
- The `console:event` payload from Rust is the raw JSON string the inject script POSTed. The host parses it.

- [ ] **Step 4: Run tests**

```bash
npm run test:run -- consoleInject
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/console/consoleInject.ts src/lib/console/consoleInject.test.ts
git commit -m "feat(console): inject script + serialiser tests"
```

---

## Task 7: Wire the inject script into Rust

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Pass the inject script through to `embed_open`**

We need React to ship the inject-script string into Rust. Two options:
- (A) Ship it as a Tauri command argument every time `embed_open` is called.
- (B) Hardcode it in Rust.

(A) keeps the script next to its tests in TS. Do (A).

Modify `embed_open` in `src-tauri/src/lib.rs`:

```rust
#[tauri::command]
async fn embed_open(
    app: AppHandle,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    data_dir: Option<String>,
    init_script: Option<String>,
) -> Result<(), String> {
    if let Some(existing) = app.webviews().get(EMBEDDED).cloned() {
        let _ = existing.close();
    }
    let main = app
        .get_window("main")
        .ok_or_else(|| "no main window".to_string())?;

    let parsed_url = parse_url(&url)?;
    let mut builder = WebviewBuilder::new(EMBEDDED, WebviewUrl::External(parsed_url))
        .devtools(true);
    if let Some(script) = init_script {
        builder = builder.initialization_script(script);
    }
    if let Some(dir) = data_dir {
        builder = builder.data_directory(PathBuf::from(dir));
    }
    main.add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 2: Wire the TS side**

Modify `src/lib/tauri.ts`. Change the `OpenArgs` and `embed.open` to accept and forward `initScript`:

```ts
interface OpenArgs extends Bounds {
  url: string;
  dataDir?: string;
  initScript?: string;
}

// inside `embed`:
async open({ url, x, y, w, h, dataDir, initScript }: OpenArgs) {
  return safeInvoke<void>('embed_open', {
    url,
    x, y, w, h,
    dataDir: dataDir ?? null,
    initScript: initScript ?? null,
  });
},
```

- [ ] **Step 3: Pass the build product to `embed.open` from `EmbeddedBrowser.tsx`**

Modify `src/components/EmbeddedBrowser.tsx`:

Imports:
```tsx
import { buildInjectScript } from '../lib/console/consoleInject';
```

Inside the existing `embed.open({...})` call, add `initScript`:

```tsx
await embed.open({
  url: targetUrl,
  ...bounds,
  dataDir: dir ?? undefined,
  initScript: buildInjectScript(),
});
```

- [ ] **Step 4: Typecheck + build the rust side**

```bash
npm run typecheck
cd src-tauri && cargo check && cd ..
```

Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src/lib/tauri.ts src/components/EmbeddedBrowser.tsx
git commit -m "feat(console): inject script into the embedded webview on open"
```

---

## Task 8: Convert the Rust spike handler into a real forwarder

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Parse + forward in the URI scheme handler**

Replace the spike handler from Task 2 with one that parses the JSON envelope and emits a typed event. Final version:

```rust
.register_asynchronous_uri_scheme_protocol("screens-ipc", |app, request, responder| {
    let app = app.clone();
    let body_bytes = request.body().to_vec();
    let path = request.uri().path().trim_start_matches('/').to_string();
    tauri::async_runtime::spawn(async move {
        // Only `screens-ipc://post` is meaningful. Anything else just 204s.
        if path == "post" {
            // Parse the JSON envelope and forward as-is. The frontend knows the
            // shape (InjectOutgoing).
            match serde_json::from_slice::<serde_json::Value>(&body_bytes) {
                Ok(v) => {
                    let _ = app.emit("console:event", v);
                }
                Err(e) => log::warn!("[screens-ipc] bad payload: {}", e),
            }
        }
        let resp = tauri::http::Response::builder()
            .status(tauri::http::StatusCode::NO_CONTENT)
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "POST, OPTIONS")
            .header("Access-Control-Allow-Headers", "Content-Type")
            .body(Vec::new())
            .unwrap();
        responder.respond(resp);
    });
})
```

- [ ] **Step 2: Rust check**

```bash
cd src-tauri && cargo check && cd ..
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(console): URI scheme forwards parsed payloads as console:event"
```

---

## Task 9: Listen for `console:event` in React → reducer

**Files:**
- Create: `src/lib/console/useConsoleBridge.ts`

- [ ] **Step 1: Implement the bridge hook**

Create `src/lib/console/useConsoleBridge.ts`:

```ts
import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauri } from '../tauri';
import { useConsoleStore } from './consoleStore';
import type { InjectOutgoing, LogEntry } from './types';

/**
 * Subscribes to the Tauri "console:event" event and dispatches into the
 * console reducer. Also handles "navigated" / "eval-result" / "eval-error"
 * messages. Runs once at the app level; the embedded webview emits at most
 * one event per console call.
 */
export function useConsoleBridge() {
  const { dispatch } = useConsoleStore();
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  useEffect(() => {
    if (!isTauri()) return;
    let off: UnlistenFn | null = null;
    let cancelled = false;
    listen<InjectOutgoing>('console:event', (e) => {
      const msg = e.payload;
      const d = dispatchRef.current;
      switch (msg.kind) {
        case 'log': {
          const entry: LogEntry = {
            id: '',
            level: msg.level,
            subtype: msg.subtype,
            args: msg.args,
            source: msg.source ?? null,
            ts: msg.ts,
            navigationId: msg.navigationId,
            stack: msg.stack ?? null,
          };
          d({ type: 'append', entry });
          break;
        }
        case 'navigated':
          d({ type: 'navigated', navigationId: msg.navigationId });
          break;
        case 'eval-result':
          d({
            type: 'append',
            entry: {
              id: '',
              level: 'log',
              subtype: 'eval-result',
              args: [msg.value],
              source: null,
              ts: Date.now(),
              navigationId: 0,
            },
          });
          break;
        case 'eval-error':
          d({
            type: 'append',
            entry: {
              id: '',
              level: 'error',
              subtype: 'eval-error',
              args: [msg.error],
              source: null,
              ts: Date.now(),
              navigationId: 0,
              stack: msg.stack ?? null,
            },
          });
          break;
        case 'expand-response':
          d({ type: 'replaceCollapsed', path: msg.reqId, with: msg.preview });
          break;
      }
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else off = unlisten;
    });
    return () => {
      cancelled = true;
      if (off) off();
    };
  }, []);
}
```

- [ ] **Step 2: Mount the bridge inside the provider**

Edit `src/lib/console/consoleStore.tsx`. Add a sibling component that calls `useConsoleBridge` (since the hook needs access to the store):

Add at the bottom:

```tsx
import { useConsoleBridge } from './useConsoleBridge';

function BridgeMount() {
  useConsoleBridge();
  return null;
}
```

And change `ConsoleStoreProvider`'s JSX to include it:

```tsx
return (
  <Ctx.Provider value={value}>
    <BridgeMount />
    {children}
  </Ctx.Provider>
);
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/console/useConsoleBridge.ts src/lib/console/consoleStore.tsx
git commit -m "feat(console): Tauri event → reducer bridge"
```

---

## Task 10: `ConsoleEntry.tsx` — one row

**Files:**
- Create: `src/components/Console/ConsoleEntry.tsx`

- [ ] **Step 1: Implement**

Create `src/components/Console/ConsoleEntry.tsx`:

```tsx
import { useState } from 'react';
import { InspectValue } from '../../lib/console/inspectValue';
import type { LogEntry } from '../../lib/console/types';

interface Props {
  entry: LogEntry;
}

/**
 * Renders one entry. Visual treatment mirrors Chrome:
 *  - level icon left
 *  - args inline, separated by ' '
 *  - source link right-aligned in muted text
 *  - stack trace (errors only) collapsed below, expandable
 */
export function ConsoleEntry({ entry }: Props) {
  const [stackOpen, setStackOpen] = useState(entry.level === 'error');
  const icon = ICONS[entry.level];

  return (
    <div className={`console-entry level-${entry.level} subtype-${entry.subtype ?? 'none'}`}>
      <span className="console-gutter" aria-hidden="true">{icon}</span>
      <div className="console-body">
        <div className="console-args">
          {entry.subtype === 'eval-input' ? (
            <span className="console-eval-input">› {entry.text}</span>
          ) : entry.subtype === 'eval-result' ? (
            <>
              <span className="console-eval-marker">←</span>
              {entry.args.map((p, i) => (
                <span key={i} className="console-arg">
                  <InspectValue preview={p} />
                </span>
              ))}
            </>
          ) : (
            entry.args.map((p, i) => (
              <span key={i} className="console-arg">
                <InspectValue preview={p} />
              </span>
            ))
          )}
        </div>
        {entry.stack && (
          <button
            type="button"
            className={`console-stack-toggle ${stackOpen ? 'open' : ''}`}
            onClick={() => setStackOpen((v) => !v)}
          >
            {stackOpen ? '▾' : '▸'} stack
          </button>
        )}
        {entry.stack && stackOpen && (
          <pre className="console-stack">{entry.stack}</pre>
        )}
      </div>
      {entry.source && <span className="console-source">{entry.source}</span>}
    </div>
  );
}

const ICONS: Record<LogEntry['level'], string> = {
  log: ' ',
  info: 'ℹ',
  warn: '⚠',
  error: '⊘',
  debug: '·',
  trace: '⤷',
};
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/Console/ConsoleEntry.tsx
git commit -m "feat(console): ConsoleEntry row component"
```

---

## Task 11: `ConsoleLog.tsx` — entries list

**Files:**
- Create: `src/components/Console/ConsoleLog.tsx`

- [ ] **Step 1: Implement (non-virtualised v1)**

5,000 entries × ~40 lines DOM is heavy but workable; we'll measure before adding `react-virtuoso`. Drop a TODO if it ever feels slow.

Create `src/components/Console/ConsoleLog.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { ConsoleEntry } from './ConsoleEntry';
import { selectVisible, useConsoleStore } from '../../lib/console/consoleStore';

export function ConsoleLog() {
  const { state } = useConsoleStore();
  const visible = selectVisible(state);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  // Track whether the user has scrolled up from the bottom; if so, we stop
  // auto-scrolling so they can read old entries.
  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - (el.scrollTop + el.clientHeight);
    stickToBottom.current = dist < 8;
  }

  useEffect(() => {
    if (!stickToBottom.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  return (
    <div className="console-log" ref={scrollRef} onScroll={onScroll}>
      {state.droppedSinceClear > 0 && (
        <div className="console-dropped">
          Older entries dropped ({state.droppedSinceClear} total since last clear)
        </div>
      )}
      {visible.length === 0 ? (
        <div className="console-empty">No console entries yet.</div>
      ) : (
        visible.map((entry) => <ConsoleEntry key={entry.id} entry={entry} />)
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/Console/ConsoleLog.tsx
git commit -m "feat(console): ConsoleLog list with sticky bottom auto-scroll"
```

---

## Task 12: `ConsoleFilter.tsx` — top bar

**Files:**
- Create: `src/components/Console/ConsoleFilter.tsx`

- [ ] **Step 1: Implement**

Create `src/components/Console/ConsoleFilter.tsx`:

```tsx
import { selectVisible, useConsoleStore } from '../../lib/console/consoleStore';
import type { FilterState } from '../../lib/console/types';

interface Props {
  onClose: () => void;
}

export function ConsoleFilter({ onClose }: Props) {
  const { state, dispatch } = useConsoleStore();
  const visible = selectVisible(state);
  const errors = state.entries.filter((e) => e.level === 'error').length;
  const warns = state.entries.filter((e) => e.level === 'warn').length;
  const infos = state.entries.filter((e) => e.level === 'info' || e.level === 'log').length;

  return (
    <div className="console-filter">
      <div className="console-filter-row">
        <input
          className="console-filter-input"
          type="text"
          placeholder="Filter (regex)"
          value={state.filter.regex}
          onChange={(e) => dispatch({ type: 'setRegex', value: e.target.value })}
          spellCheck={false}
        />
        <button
          type="button"
          className="console-icon-btn"
          title="Clear console"
          onClick={() => dispatch({ type: 'clear' })}
        >
          🗑
        </button>
        <button
          type="button"
          className="console-icon-btn"
          title="Close console"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="console-filter-row">
        <Chip label="Errors" active={state.filter.levels.errors} onClick={() => toggle('errors', state.filter, dispatch)} />
        <Chip label="Warnings" active={state.filter.levels.warnings} onClick={() => toggle('warnings', state.filter, dispatch)} />
        <Chip label="Info" active={state.filter.levels.info} onClick={() => toggle('info', state.filter, dispatch)} />
        <Chip label="Verbose" active={state.filter.levels.verbose} onClick={() => toggle('verbose', state.filter, dispatch)} />
        <span className="console-counter">
          <span className="c-err">⊘ {errors}</span>
          <span className="c-warn">⚠ {warns}</span>
          <span className="c-info">ℹ {infos}</span>
        </span>
        <label className="console-toggle" title="Preserve log on navigation">
          <input
            type="checkbox"
            checked={state.filter.preserveLog}
            onChange={(e) => dispatch({ type: 'setPreserve', value: e.target.checked })}
          />
          Preserve log
        </label>
        <span className="console-visible-count">{visible.length} shown</span>
      </div>
    </div>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`console-chip ${active ? 'on' : 'off'}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function toggle(
  key: keyof FilterState['levels'],
  filter: FilterState,
  dispatch: ReturnType<typeof useConsoleStore>['dispatch'],
) {
  dispatch({ type: 'setLevels', patch: { [key]: !filter.levels[key] } });
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/Console/ConsoleFilter.tsx
git commit -m "feat(console): ConsoleFilter top bar"
```

---

## Task 13: `ConsoleInput.tsx` — eval prompt

**Files:**
- Create: `src/components/Console/ConsoleInput.tsx`

- [ ] **Step 1: Implement**

Create `src/components/Console/ConsoleInput.tsx`:

```tsx
import { useCallback, useRef, useState } from 'react';
import { useConsoleStore } from '../../lib/console/consoleStore';
import { embed, isTauri } from '../../lib/tauri';

let evalCounter = 0;

export function ConsoleInput() {
  const { state, dispatch } = useConsoleStore();
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState('');
  const [histIdx, setHistIdx] = useState<number | null>(null);

  const disabled = !isTauri();

  const submit = useCallback(() => {
    const code = draft.trim();
    if (!code) return;

    // 1. Record the input as a row.
    dispatch({
      type: 'append',
      entry: {
        id: '',
        level: 'log',
        subtype: 'eval-input',
        args: [],
        text: code,
        source: null,
        ts: Date.now(),
        navigationId: state.currentNavigationId,
      },
    });
    dispatch({ type: 'pushHistory', text: code });

    // 2. Ship to the embedded webview. The inject script's `SCREENS_CONSOLE.run`
    //    handles the response via the URI scheme.
    const evalId = `r${++evalCounter}`;
    const wrapped =
      `window.__SCREENS_CONSOLE__ && window.__SCREENS_CONSOLE__.run(` +
      JSON.stringify({ op: 'eval', code, id: evalId }) +
      `);`;
    embed.evalJs(wrapped);

    setDraft('');
    setHistIdx(null);
  }, [draft, dispatch, state.currentNavigationId]);

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'ArrowUp' && draft === '' && state.history.length) {
      e.preventDefault();
      const next = histIdx === null ? state.history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(next);
      setDraft(state.history[next]);
    } else if (e.key === 'ArrowDown' && histIdx !== null) {
      e.preventDefault();
      const next = histIdx + 1;
      if (next >= state.history.length) {
        setHistIdx(null);
        setDraft('');
      } else {
        setHistIdx(next);
        setDraft(state.history[next]);
      }
    }
  }

  return (
    <div className="console-input">
      <span className="console-input-glyph">›</span>
      <textarea
        ref={taRef}
        className="console-input-ta"
        rows={1}
        spellCheck={false}
        placeholder={disabled ? 'Evaluate requires the desktop app (npm run app:dev)' : 'Evaluate JS in the page'}
        value={draft}
        disabled={disabled}
        onChange={(e) => {
          setDraft(e.target.value);
          // auto-grow to a few lines max
          const ta = e.currentTarget;
          ta.style.height = 'auto';
          ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
        }}
        onKeyDown={onKey}
      />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/Console/ConsoleInput.tsx
git commit -m "feat(console): ConsoleInput eval prompt with history"
```

---

## Task 14: `ConsoleDrawer.tsx` — right-docked container + resize

**Files:**
- Create: `src/components/Console/ConsoleDrawer.tsx`

- [ ] **Step 1: Implement**

Create `src/components/Console/ConsoleDrawer.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConsoleFilter } from './ConsoleFilter';
import { ConsoleLog } from './ConsoleLog';
import { ConsoleInput } from './ConsoleInput';
import { usePersistedState } from '../../hooks/usePersistedState';
import { isTauri } from '../../lib/tauri';

interface Props {
  /** Whether the drawer is open. */
  open: boolean;
  /** Called when the user clicks the × in the drawer header. */
  onClose: () => void;
}

const MIN_WIDTH = 240;
const DEFAULT_WIDTH = 380;

/**
 * Right-docked, drag-resizable drawer. When `open` is false, the component
 * still renders (so transition / state is preserved) but its outer wrapper
 * has `aria-hidden` and `display: none` via the `closed` class.
 */
export function ConsoleDrawer({ open, onClose }: Props) {
  const [width, setWidth] = usePersistedState<number>(
    'screens:console:width',
    DEFAULT_WIDTH,
  );
  const draggingRef = useRef(false);
  const startRef = useRef<{ x: number; width: number }>({ x: 0, width: DEFAULT_WIDTH });
  const [, force] = useState(0);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      draggingRef.current = true;
      startRef.current = { x: e.clientX, width };
      (e.target as Element).setPointerCapture(e.pointerId);
    },
    [width],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      const dx = startRef.current.x - e.clientX;       // drag left → grow
      const next = clamp(startRef.current.width + dx, MIN_WIDTH, window.innerWidth * 0.8);
      setWidth(next);
      force((n) => n + 1);
    },
    [setWidth],
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    draggingRef.current = false;
    (e.target as Element).releasePointerCapture(e.pointerId);
  }, []);

  // Clamp on window resize.
  useEffect(() => {
    function clampOnResize() {
      setWidth((w) => clamp(w, MIN_WIDTH, window.innerWidth * 0.8));
    }
    window.addEventListener('resize', clampOnResize);
    return () => window.removeEventListener('resize', clampOnResize);
  }, [setWidth]);

  if (!open) return null;

  return (
    <aside className="console-drawer" style={{ width }}>
      <div
        className="console-resize-handle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title="Drag to resize"
      />
      <ConsoleFilter onClose={onClose} />
      {!isTauri() && (
        <div className="console-fallback-banner">
          Console capture requires the desktop app. Run <code>npm run app:dev</code>.
        </div>
      )}
      <ConsoleLog />
      <ConsoleInput />
    </aside>
  );
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/Console/ConsoleDrawer.tsx
git commit -m "feat(console): ConsoleDrawer container + drag-resize"
```

---

## Task 15: Mount drawer in `EmbeddedBrowser.tsx` + toggle button + shortcuts

**Files:**
- Modify: `src/components/EmbeddedBrowser.tsx`
- Modify: `src/components/icons.tsx`

- [ ] **Step 1: Add a Terminal icon**

In `src/components/icons.tsx`, append:

```tsx
export const Terminal = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1.4" />
    <path d="M5 7l2 1.5L5 10M8.5 10.5h3" />
  </svg>
);
```

- [ ] **Step 2: Edit `EmbeddedBrowser.tsx`**

Imports — add:

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
// (existing imports)
import { ConsoleDrawer } from './Console/ConsoleDrawer';
import { Terminal } from './icons';
import { usePersistedState } from '../hooks/usePersistedState';
```

In the component body, near other persisted state:

```tsx
const [consoleOpen, setConsoleOpen] = usePersistedState<boolean>(
  'screens:console:open',
  false,
);
```

Keyboard shortcut effect (place near the existing `useEffect`s):

```tsx
useEffect(() => {
  function onKey(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === '`') {
      e.preventDefault();
      setConsoleOpen((v) => !v);
    } else if (meta && e.altKey && (e.key === 'J' || e.key === 'j')) {
      e.preventDefault();
      setConsoleOpen(true);
    }
  }
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}, [setConsoleOpen]);
```

Render — add the toggle button in `.iframe-chrome` between the DevTools `<Search />` button and the camera button:

```tsx
<button
  className={`icon-btn ${consoleOpen ? 'active' : ''}`}
  type="button"
  title="Toggle console (⌘`)"
  onClick={() => setConsoleOpen((v) => !v)}
>
  <Terminal />
</button>
```

Render — change the `<div className="iframe-body">` wrapper into a horizontal flex container so the drawer can sit beside it. Wrap the existing `iframe-body` and the new `<ConsoleDrawer>` in a new flex container:

Replace this block:

```tsx
<div className="iframe-body" ref={containerRef}>
  {!tauriMode && (
    <iframe … />
  )}
  {tauriMode && !bounds && <BootingHint />}
</div>
```

with:

```tsx
<div className="iframe-body-row">
  <div className="iframe-body" ref={containerRef}>
    {!tauriMode && (
      <iframe
        ref={fallbackIframeRef}
        src={fullUrl}
        title="Embedded app (fallback iframe)"
        sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
      />
    )}
    {tauriMode && !bounds && <BootingHint />}
  </div>
  <ConsoleDrawer open={consoleOpen} onClose={() => setConsoleOpen(false)} />
</div>
```

(The exact same iframe content stays inside `iframe-body`; the drawer hangs to its right.)

- [ ] **Step 3: Wrap App with the store provider**

Edit `src/App.tsx`. Add import:

```tsx
import { ConsoleStoreProvider } from './lib/console/consoleStore';
```

Change the existing `<ScreensStoreProvider>` wrapper in `App()` to nest the console provider:

```tsx
export function App() {
  return (
    <ScreensStoreProvider>
      <ConsoleStoreProvider>
        <Shell />
      </ConsoleStoreProvider>
    </ScreensStoreProvider>
  );
}
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/icons.tsx src/components/EmbeddedBrowser.tsx src/App.tsx
git commit -m "feat(console): mount drawer + toggle button + Cmd-backtick shortcut"
```

---

## Task 16: Styles — match Chrome's docked-right Console

**Files:**
- Modify: `src/styles.css`

- [ ] **Step 1: Append the console rules**

Append to `src/styles.css`:

```css
/* ──────────────────────────────────────────────────────────────────────
   Console drawer (right-docked, Chrome-style)
   ─────────────────────────────────────────────────────────────────── */

.iframe-body-row {
  flex: 1; display: flex; flex-direction: row;
  min-height: 0; min-width: 0;
}
.iframe-body-row > .iframe-body { flex: 1; min-width: 0; }

.console-drawer {
  position: relative;
  display: flex; flex-direction: column;
  min-width: 240px;
  background: var(--surface);
  border-left: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text);
}

.console-resize-handle {
  position: absolute;
  top: 0; left: -3px; bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 2;
}
.console-resize-handle:hover {
  background: var(--border-strong);
  opacity: 0.5;
}

/* Top filter bar */
.console-filter {
  flex-shrink: 0;
  display: flex; flex-direction: column;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.console-filter-row {
  display: flex; align-items: center; gap: 6px;
}
.console-filter-input {
  flex: 1;
  height: 22px;
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 8px;
  outline: none;
}
.console-filter-input:focus { border-color: var(--border-strong); }
.console-icon-btn {
  width: 22px; height: 22px;
  border-radius: 4px;
  color: var(--text-3);
  background: transparent;
  display: grid; place-items: center;
  font-size: 14px;
}
.console-icon-btn:hover { background: var(--hover); color: var(--text); }

.console-chip {
  height: 20px;
  padding: 0 8px;
  font-size: 10.5px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-3);
}
.console-chip.on  { background: var(--selected); color: var(--text); }
.console-chip.off { opacity: 0.55; }

.console-counter {
  margin-left: auto;
  display: inline-flex; gap: 8px;
  font-size: 10.5px;
  color: var(--text-3);
}
.console-counter .c-err  { color: oklch(0.62 0.18 25); }
.console-counter .c-warn { color: oklch(0.78 0.18 80); }
.console-counter .c-info { color: oklch(0.7  0.15 230); }

.console-toggle {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 10.5px;
  color: var(--text-3);
  cursor: pointer;
}
.console-toggle input { margin: 0; }

.console-visible-count {
  font-size: 10.5px;
  color: var(--text-4);
}

.console-fallback-banner {
  padding: 8px 10px;
  font-size: 11px;
  background: oklch(0.95 0.04 80);
  color: oklch(0.4 0.06 80);
  border-bottom: 1px solid var(--border);
}
:root.dark .console-fallback-banner { background: oklch(0.25 0.04 80); color: oklch(0.85 0.06 80); }
.console-fallback-banner code {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 1px 4px;
}

/* Log list */
.console-log {
  flex: 1;
  overflow-y: auto;
  background: var(--bg);
}
.console-empty {
  padding: 16px;
  text-align: center;
  color: var(--text-4);
  font-size: 11px;
}
.console-dropped {
  padding: 4px 10px;
  font-size: 10.5px;
  color: var(--text-4);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

/* Entry */
.console-entry {
  display: grid;
  grid-template-columns: 16px 1fr auto;
  gap: 6px;
  align-items: flex-start;
  padding: 2px 8px;
  border-bottom: 1px solid var(--border);
  line-height: 16px;
}
.console-entry .console-gutter {
  font-size: 11px;
  color: var(--text-3);
  text-align: center;
  user-select: none;
}
.console-entry .console-source {
  font-size: 10px;
  color: var(--text-4);
  white-space: nowrap;
}
.console-entry.level-error  { background: oklch(0.96 0.04 25 / 0.4); }
.console-entry.level-error  .console-gutter { color: oklch(0.55 0.18 25); }
.console-entry.level-warn   { background: oklch(0.97 0.05 80 / 0.4); }
.console-entry.level-warn   .console-gutter { color: oklch(0.7 0.18 80); }
.console-entry.level-info   .console-gutter { color: oklch(0.6 0.14 230); }
.console-entry.level-info   { border-left: 2px solid oklch(0.7 0.14 230); padding-left: 6px; }
.console-entry.level-debug  .console-gutter,
.console-entry.level-trace  .console-gutter { color: var(--text-4); }
.console-entry.subtype-eval-input { background: oklch(0.97 0 0 / 0.6); }
:root.dark .console-entry.level-error { background: oklch(0.32 0.06 25 / 0.45); }
:root.dark .console-entry.level-warn  { background: oklch(0.34 0.06 80 / 0.4); }

.console-args { display: flex; flex-wrap: wrap; gap: 6px; }
.console-arg  { display: inline-block; }

/* Value styling */
.console-primitive.console-p-string { color: oklch(0.58 0.14 130); }    /* green */
.console-primitive.console-p-number,
.console-primitive.console-p-bigint { color: oklch(0.58 0.18 270); }     /* purple */
.console-primitive.console-p-boolean { color: oklch(0.55 0.18 30); }
.console-primitive.console-p-null,
.console-primitive.console-p-undefined { color: var(--text-3); font-style: italic; }
.console-primitive.console-p-function { color: oklch(0.62 0.14 200); font-style: italic; }
.console-primitive.console-p-symbol { color: oklch(0.62 0.18 50); }

.console-ctor  { color: var(--text-2); margin-right: 2px; }
.console-key   { color: oklch(0.5 0.12 280); }
.console-sep   { color: var(--text-3); }
.console-bracket { color: var(--text-3); }
.console-truncated { color: var(--text-4); font-style: italic; }
.console-cyclic { color: oklch(0.55 0.15 25); }
.console-tag    { color: oklch(0.55 0.15 0); }
.console-attr-name { color: oklch(0.55 0.15 80); }
.console-attr-val  { color: oklch(0.58 0.14 130); }

.console-chevron {
  display: inline-block;
  background: transparent;
  border: 0;
  color: var(--text-3);
  font-size: 9px;
  cursor: pointer;
  transition: transform 80ms;
  margin-right: 2px;
}
.console-chevron.open { transform: rotate(90deg); color: var(--text); }

.console-stack-toggle {
  display: inline-block;
  background: transparent; border: 0;
  color: var(--text-3);
  font-size: 10.5px;
  padding: 0;
  margin-top: 2px;
  cursor: pointer;
}
.console-stack {
  font-family: var(--font-mono);
  font-size: 10.5px;
  white-space: pre;
  color: var(--text-2);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 4px 6px;
  margin: 4px 0 0;
  max-height: 200px;
  overflow: auto;
}

.console-eval-marker { color: var(--text-3); margin-right: 6px; }
.console-eval-input  { color: var(--text-2); }

/* Input row */
.console-input {
  flex-shrink: 0;
  display: flex; align-items: flex-start; gap: 6px;
  border-top: 1px solid var(--border);
  background: var(--surface);
  padding: 4px 8px;
}
.console-input-glyph { color: var(--text-3); padding-top: 2px; }
.console-input-ta {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text);
  background: transparent;
  border: 0;
  outline: 0;
  resize: none;
  padding: 0;
  line-height: 16px;
  min-height: 16px;
}
.console-input-ta:disabled { color: var(--text-4); }
```

- [ ] **Step 2: Boot the dev app and visually verify**

```bash
npm run app:dev
```

Open any project, switch to App view, click the new Terminal icon in the URL bar (or press `Cmd + ``` ). The drawer should open on the right.

Visual checklist:
- Drawer right-docked, slim border on its left.
- Resize handle on the left edge changes the cursor on hover.
- Filter bar with regex input, chips, counters, preserve-log toggle, clear, ×.
- Log area below — for now likely shows "No console entries yet." until the page logs something.
- Input row at the bottom with `›` glyph.
- Toggle button highlights when open.
- `Cmd + ``` closes it; `Cmd + Alt + J` opens + focuses.

Trigger a log: navigate the embedded webview to a page that calls `console.log('hi')` (e.g. open the URL bar and visit a JS-heavy demo, or open the native DevTools and type `console.log('hi')` there — the inject hook overrides both paths).

- [ ] **Step 3: Commit**

```bash
git add src/styles.css
git commit -m "feat(console): Chrome-style stylesheet"
```

---

## Task 17: End-to-end smoke test

**Files:**
- Modify: `index.html` *(temporary — reverted at end of step)*

- [ ] **Step 1: Add a temporary fixture page**

We don't ship E2E infra in this plan, but we should verify the round-trip works against real fixtures before declaring done.

Pick any project you have set up. Boot:

```bash
npm run app:dev
```

In the embedded pane, navigate to any page on your dev server that runs JS. Open the in-app console drawer. From the input prompt, type:

```js
console.log({ a: 1, nested: { b: 2 }, list: [1, 2, 3] })
```

Verify:
- The row appears with the level icon for `log`.
- The object expands inline with chevrons.
- `Array(3)` shows `[1, 2, 3]`.

Then type:

```js
throw new Error('boom')
```

Verify:
- An eval-error row appears with red gutter, stack trace expanded by default.

Then click the level chip `Errors` to toggle off and confirm the error row hides.

Click `Clear`. Confirm everything goes away.

- [ ] **Step 2: If anything's broken, fix it inline**

Common issues:
- Eval result doesn't appear → check `embed.evalJs` calls `window.__SCREENS_CONSOLE__.run(...)` correctly (it should be re-installed at every page load via the init script).
- Logs from page load don't appear → confirm the inject script runs before user code. If not, this may be a Tauri 2 timing issue on your platform; the workaround is to also poll `__SCREENS_CONSOLE__.buffer` on first `console:event` arrival.
- Resize handle invisible → confirm `.console-resize-handle` has a hover state.

Commit any fixes:

```bash
git add -A
git commit -m "fix(console): post-smoke adjustments"
```

(If nothing needed adjusting, skip this commit.)

---

## Task 18: Documentation

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md` (only if a CLI command is added — skip otherwise)

- [ ] **Step 1: README update**

Edit `README.md`. Under the line about DevTools (`DevTools, cookies, the lot` in the architecture box) and again in the run-commands section, add a short subsection right after the "Use it" block:

```markdown
## In-app console

The right pane has a Chrome-style Console docked to its right edge.

- Toggle: button in the URL bar or `⌘\`` / `Ctrl+\``.
- Filter: regex, level chips (Errors / Warnings / Info / Verbose).
- Evaluate: type JS into the prompt — `(0, eval)(…)` semantics, so it runs in
  the page's global scope, exactly like Chrome.
- Preserve log on navigation: on by default.

For deep debugging (Elements, Network, Sources, …), the existing `[🔍]`
button still pops the real native DevTools window.
```

- [ ] **Step 2: Typecheck + verify clean state**

```bash
npm run typecheck
npm run test:run
cd src-tauri && cargo check && cd ..
```

Expected: all three clean.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README mentions the in-app console"
```

---

## Done

Final verification before declaring complete:

- `npm run test:run` — all green.
- `npm run typecheck` — clean.
- `cd src-tauri && cargo check` — clean.
- `npm run app:dev` boots; the drawer opens, captures logs, evaluates JS,
  filters, clears, and resizes.
- Dark mode toggle (existing) doesn't break the console palette.

If any of those fail, fix them — do not declare the feature complete with a
known broken path.
