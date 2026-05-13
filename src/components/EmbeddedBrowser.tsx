import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Account, LoginAutomation } from '../types';
import { accountDataDir, embed, isTauri } from '../lib/tauri';
import { buildInjectScript } from '../lib/console/consoleInject';
import { Back, Camera, Forward, Globe, Reload, Search } from './icons';

interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface EmbeddedBrowserProps {
  /** Current project slug — used to isolate per-account cookie dirs. */
  projectSlug: string;
  baseUrl: string;
  path: string;
  account: Account | null;
  history: string[];
  hIdx: number;
  setHIdx: (n: number) => void;
  onNavigate: (path: string) => void;
  onCapture: () => void;
  /**
   * Pushed up to the parent every time the webview's container rectangle
   * changes (mount / resize / pane reflow). The screenshot pipeline needs
   * the live bounds to feed `embed_capture` even when the click originates
   * outside this component (CLI inbox, Inspector button, …).
   */
  onBoundsChange?: (b: Bounds | null) => void;
}

/**
 * Hosts the native Tauri child webview. The rendered DOM is essentially a
 * placeholder div whose `getBoundingClientRect()` we feed to Rust on every
 * layout change — the real WebView is drawn on top of it by the OS.
 *
 * When not running inside Tauri (e.g. `npm run dev` in Safari), this
 * gracefully falls back to a plain `<iframe>` so the React UI is still
 * inspectable for design work.
 */
export function EmbeddedBrowser({
  projectSlug,
  baseUrl,
  path,
  account,
  history,
  hIdx,
  setHIdx,
  onNavigate,
  onCapture,
  onBoundsChange,
}: EmbeddedBrowserProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fallbackIframeRef = useRef<HTMLIFrameElement | null>(null);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [tauriMode] = useState(() => isTauri());

  const cleanedBase = baseUrl.replace(/\/$/, '');
  const fullUrl = cleanedBase + path;
  const canBack = hIdx > 0;
  const canFwd = hIdx < history.length - 1;

  // Track which account the live webview is using. Switching this forces
  // a destroy+recreate so the OS WebView gets a fresh `data_directory`.
  const liveAccountRef = useRef<string | null>(null);
  // The URL the webview was last told to load. Used to decide whether a
  // path change needs a navigate or whether `embed_open` already covered it.
  const liveUrlRef = useRef<string | null>(null);

  // ---- Bounds tracking ----
  useLayoutEffect(() => {
    if (!tauriMode) return;
    const el = containerRef.current;
    if (!el) return;

    let frame = 0;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const next: Bounds = { x: r.left, y: r.top, w: r.width, h: r.height };
      setBounds((prev) => {
        if (
          prev &&
          prev.x === next.x &&
          prev.y === next.y &&
          prev.w === next.w &&
          prev.h === next.h
        ) {
          return prev;
        }
        return next;
      });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    measure();
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    window.addEventListener('resize', schedule);
    // Catch the case where a flex pane changes share without resizing
    // the window itself (e.g. sidebar collapse later).
    const interval = window.setInterval(schedule, 500);

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('resize', schedule);
      window.clearInterval(interval);
    };
  }, [tauriMode]);

  // ---- Webview lifecycle ----
  useEffect(() => {
    if (!tauriMode || !bounds) return;

    // Key the live webview on project+account so switching either forces
    // a destroy/recreate with the correct cookie-jar directory.
    const liveKey = `${projectSlug}::${account?.id ?? ''}`;
    const keyChanged = liveAccountRef.current !== liveKey;
    const firstMount = liveAccountRef.current === null;
    const targetUrl = pickInitialUrl(cleanedBase, path, account);

    if (keyChanged || firstMount) {
      liveAccountRef.current = liveKey;
      liveUrlRef.current = targetUrl;
      (async () => {
        const dir = account ? await accountDataDir(projectSlug, account.id) : null;
        await embed.open({
          url: targetUrl,
          ...bounds,
          dataDir: dir ?? undefined,
          initScript: buildInjectScript(),
        });
        // Try auto-login if configured. Outcome detection lives in App.tsx
        // (it polls `embed_url` for the `successUrl`); here we just fire
        // the injection.
        if (account?.login && account.password) {
          // Wait for the login page to lay out before injecting. The script
          // itself also polls for selectors, so the delay is just to let
          // the document start loading.
          window.setTimeout(() => {
            const js = buildLoginScript(account.login!, account, baseUrl);
            embed.evalJs(js);
          }, 600);
        }
      })();
      return;
    }
  }, [account?.id, projectSlug, bounds, baseUrl, path, tauriMode, cleanedBase]);

  // ---- Bounds push (separate so it isn't gated by account changes) ----
  useEffect(() => {
    if (!tauriMode || !bounds) return;
    embed.bounds(bounds);
  }, [bounds, tauriMode]);

  // ---- Surface bounds to the parent so capture has live coords ----
  useEffect(() => {
    if (!onBoundsChange) return;
    onBoundsChange(bounds);
    return () => onBoundsChange(null);
  }, [bounds, onBoundsChange]);

  // ---- Path-only navigation ----
  useEffect(() => {
    if (!tauriMode) return;
    if (liveAccountRef.current === null) return; // not opened yet
    if (liveUrlRef.current === fullUrl) return;
    liveUrlRef.current = fullUrl;
    embed.navigate(fullUrl);
  }, [fullUrl, tauriMode]);

  // ---- Teardown when the pane unmounts (e.g. view switched to map) ----
  useEffect(() => {
    return () => {
      if (tauriMode) {
        embed.close();
        liveAccountRef.current = null;
        liveUrlRef.current = null;
      }
    };
  }, [tauriMode]);

  return (
    <div className="iframe-pane">
      <div className="iframe-chrome">
        <div className="nav-btns">
          <button
            type="button"
            disabled={!canBack}
            onClick={() => setHIdx(hIdx - 1)}
            title="Back"
          >
            <Back />
          </button>
          <button
            type="button"
            disabled={!canFwd}
            onClick={() => setHIdx(hIdx + 1)}
            title="Forward"
          >
            <Forward />
          </button>
          <button
            type="button"
            onClick={() => {
              if (tauriMode) embed.reload();
              else fallbackIframeRef.current?.contentWindow?.location.reload();
            }}
            title="Reload"
          >
            <Reload />
          </button>
        </div>
        <div className="addr" title={fullUrl}>
          <Globe />
          <span style={{ color: 'var(--text-3)' }}>{cleanedBase}</span>
          <span className="path">{path}</span>
        </div>
        {account && (
          <div className="session-pill" title={`Signed in as ${account.email}`}>
            <span
              className="av"
              style={{ background: `oklch(0.62 0.13 ${account.color})` }}
            >
              {account.name
                .split(' ')
                .map((s) => s[0])
                .join('')}
            </span>
            {account.role}
          </div>
        )}
        <button
          className="icon-btn"
          type="button"
          title="Open DevTools (real Chrome DevTools)"
          onClick={() => embed.openDevtools()}
        >
          <Search />
        </button>
        <button
          className="icon-btn"
          type="button"
          title="Capture screenshot"
          onClick={onCapture}
        >
          <Camera />
        </button>
      </div>
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
      {/* Bridge: in-webview apps can post messages back to update history. */}
      <MessageBridge onNavigate={onNavigate} />
    </div>
  );
}

function BootingHint() {
  return (
    <div className="iframe-blocked">
      <div>
        <div className="icon">
          <Globe />
        </div>
        booting embedded webview…
      </div>
    </div>
  );
}

/**
 * If the user's app does `window.postMessage({ type: 'screens:visit', path })`
 * to its parent (the React UI's webview), this picks it up. The native child
 * webview doesn't share a window with us so the message would need a custom
 * channel — wire that up only if you control both apps.
 */
function MessageBridge({ onNavigate }: { onNavigate: (p: string) => void }) {
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (!e.data || typeof e.data !== 'object') return;
      if (e.data.type === 'screens:visit' && typeof e.data.path === 'string') {
        onNavigate(e.data.path);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onNavigate]);
  return null;
}

/**
 * Decides where to point the embedded webview when an account is selected.
 * For accounts with login automation, we land on the login page first so
 * the auto-login script can fill it.
 */
function pickInitialUrl(
  cleanedBase: string,
  path: string,
  account: Account | null,
): string {
  if (account?.login) {
    const u = account.login.url;
    if (/^https?:/i.test(u)) return u;
    return cleanedBase + (u.startsWith('/') ? u : '/' + u);
  }
  return cleanedBase + path;
}

/**
 * Builds the JS that gets injected into the embedded webview to perform an
 * auto-login. Polls the DOM for each selector for up to 5 seconds, then
 * fills, dispatches input/change (so React-controlled inputs see it), and
 * submits. Returns to the caller via console only.
 */
function buildLoginScript(
  login: LoginAutomation,
  account: Account,
  baseUrl: string,
): string {
  const cleanBase = baseUrl.replace(/\/$/, '');
  const successUrl = login.successUrl
    ? /^https?:/i.test(login.successUrl)
      ? login.successUrl
      : cleanBase + login.successUrl
    : null;
  const payload = JSON.stringify({
    emailSel: login.emailSelector,
    passwordSel: login.passwordSelector,
    submitSel: login.submitSelector,
    email: account.email,
    password: account.password ?? '',
    successUrl,
    tag: '[screens]',
  });
  // The injection is wrapped in a self-executing IIFE so multiple injects
  // never collide.
  return `
(function() {
  var cfg = ${payload};
  function wait(sel, ms) {
    return new Promise(function(resolve, reject) {
      var start = Date.now();
      (function tick() {
        var el = document.querySelector(sel);
        if (el) return resolve(el);
        if (Date.now() - start > (ms || 5000)) return reject(new Error('timeout: ' + sel));
        setTimeout(tick, 50);
      })();
    });
  }
  function set(el, v) {
    var setter = Object.getOwnPropertyDescriptor(el.__proto__, 'value') &&
                 Object.getOwnPropertyDescriptor(el.__proto__, 'value').set;
    if (setter) setter.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  (async function() {
    try {
      var emailEl    = await wait(cfg.emailSel);
      var passwordEl = await wait(cfg.passwordSel);
      emailEl.focus(); set(emailEl, cfg.email);
      passwordEl.focus(); set(passwordEl, cfg.password);
      var submitEl = await wait(cfg.submitSel);
      submitEl.click();
      console.log(cfg.tag, 'auto-login submitted for', cfg.email);
      if (cfg.successUrl) {
        setTimeout(function() {
          if (location.href.indexOf(cfg.successUrl) !== 0) location.href = cfg.successUrl;
        }, 1200);
      }
    } catch (err) {
      console.warn(cfg.tag, 'auto-login failed:', err && err.message || err);
    }
  })();
})();
`;
}
