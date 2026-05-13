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

  if (typeof (globalThis as any).Element !== 'undefined' && obj instanceof (globalThis as any).Element) {
    const el = obj as Element;
    const attrs: Array<[string, string]> = Array.from(el.attributes ?? []).slice(0, 12).map((a) => [a.name, a.value]);
    return { kind: 'element', tag: el.tagName.toLowerCase(), attrs, path: ctx.path };
  }

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
 * body inlines its own serialise() so the page doesn't need to import
 * anything at runtime.
 */
export function buildInjectScript(): string {
  // The IIFE body is *plain JS* — must not include any TS-only syntax.
  return `
(function() {
  if (window.__SCREENS_CONSOLE__) return; // already installed
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

  window.addEventListener('pageshow', function() {
    nav += 1; SELF.nav = nav;
    send({ kind: 'navigated', navigationId: nav, url: location.href });
  });

  SELF.run = function(cmd) {
    if (!cmd || typeof cmd !== 'object') return;
    if (cmd.op === 'expand') {
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
