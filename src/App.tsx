import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { Canvas } from './components/Canvas';
import { Inspector } from './components/Inspector';
import { EmbeddedBrowser } from './components/EmbeddedBrowser';
import { Check } from './components/icons';
import { ScreensStoreProvider, useStore } from './lib/screensStore';
import { embed, isTauri } from './lib/tauri';
import type { Account, ActivityEntry, Screen, ScreensConfig, ViewMode } from './types';
import { usePersistedState } from './hooks/usePersistedState';

interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Time the embedded webview gets to settle after a CLI-driven navigate
 *  before we trigger the screenshot. Matches roughly the time real dev
 *  servers need for initial paint after route change. */
const CAPTURE_SETTLE_MS = 1500;

export function App() {
  return (
    <ScreensStoreProvider>
      <Shell />
    </ScreensStoreProvider>
  );
}

const TOAST_MS = 1800;
const MAX_ACTIVITY = 30;

function Shell() {
  const { ready, current, projects, updateProjectMeta, writeScreens, onInbox } = useStore();

  // Persisted view + history; baseUrl now lives in the project meta so each
  // project remembers its own server.
  const [view, setView] = usePersistedState<ViewMode>('screens:view', 'split');

  // Resolve the project bundle once on every render — but keep stable refs
  // for downstream effects via individual variables.
  const projectMeta = current?.project ?? null;
  const screensCfg = current?.screens ?? null;
  const accountsCfg = current?.accounts ?? null;
  const slug = projectMeta?.slug ?? null;

  const accounts = accountsCfg?.accounts ?? [];
  const groups = screensCfg?.groups ?? [];
  const screens = screensCfg?.screens ?? [];
  const edges = screensCfg?.edges ?? [];

  // Active account is persisted per-project so switching projects doesn't
  // wedge you on an account that doesn't exist in the new project.
  const accountStorageKey = `screens:accountId:${slug ?? 'none'}`;
  const [accountId, setAccountId] = usePersistedState<string | null>(
    accountStorageKey,
    accountsCfg?.defaultAccountId ?? null,
  );

  // Reset accountId when its project doesn't contain that account.
  useEffect(() => {
    if (!accountsCfg) return;
    if (accountId && !accountsCfg.accounts.some((a) => a.id === accountId)) {
      setAccountId(accountsCfg.defaultAccountId ?? accountsCfg.accounts[0]?.id ?? null);
    } else if (!accountId && accountsCfg.defaultAccountId) {
      setAccountId(accountsCfg.defaultAccountId);
    }
  }, [accountsCfg, accountId, setAccountId]);

  // Navigation history (per session, in-memory).
  const initialPath = screens[0]?.path ?? '/';
  const [history, setHistory] = useState<string[]>([initialPath]);
  const [hIdx, setHIdx] = useState(0);
  // When the current project changes, reset history.
  useEffect(() => {
    setHistory([screens[0]?.path ?? '/']);
    setHIdx(0);
  }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps
  const path = history[hIdx] ?? '/';

  const [selectedScreenId, setSelectedScreenId] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  // Live bounds of the embedded webview pane, pushed up by EmbeddedBrowser.
  // Kept in a ref (not state) so capture can read the latest value without
  // re-creating the callback whenever the pane resizes.
  const boundsRef = useRef<Bounds | null>(null);
  // The screens config in a ref too — `capture` is invoked from the inbox
  // listener which closes over its dependencies once; without this ref it'd
  // operate on a stale array after a write.
  const screensCfgRef = useRef(screensCfg);
  useEffect(() => {
    screensCfgRef.current = screensCfg;
  }, [screensCfg]);

  const account: Account | null = useMemo(
    () => accounts.find((a) => a.id === accountId) ?? null,
    [accounts, accountId],
  );
  const selected = useMemo(
    () => screens.find((s) => s.id === selectedScreenId),
    [screens, selectedScreenId],
  );

  const currentScreenId = useMemo(() => {
    if (!path) return null;
    const exact = screens.find((s) => s.path === path);
    if (exact) return exact.id;
    const prefix = screens.find(
      (s) =>
        s.path.includes(':') && path.startsWith(s.path.split(':')[0] ?? ''),
    );
    return prefix?.id ?? null;
  }, [path, screens]);

  const log = useCallback(
    (verb: string, text: string, level: ActivityEntry['level'] = 'info') => {
      const ts = new Date().toLocaleTimeString('en-GB');
      setActivity((a) => [{ ts, verb, text, level }, ...a].slice(0, MAX_ACTIVITY));
    },
    [],
  );

  const navigate = useCallback(
    (target: string | Screen) => {
      const nextPath = typeof target === 'string' ? target : target.path;
      if (nextPath === path) return;
      setHistory((h) => {
        const truncated = h.slice(0, hIdx + 1);
        truncated.push(nextPath);
        return truncated;
      });
      setHIdx((i) => i + 1);
      log('visited', nextPath);
    },
    [path, hIdx, log],
  );

  const openNode = useCallback(
    (s: Screen) => {
      navigate(s);
      if (view === 'map') setView('split');
    },
    [navigate, view, setView],
  );

  const pickAccount = useCallback(
    (a: Account) => {
      setAccountId(a.id);
      log('switched', `session → ${a.email}`);
      if (a.login) {
        log('login', `auto-fill queued for ${a.email}`);
        setToast(`Signing in as ${a.name}…`);
      } else {
        setToast(`Switched to ${a.name}`);
      }
    },
    [log, setAccountId],
  );

  const capture = useCallback(
    async (screenIdOverride?: string) => {
      const cfg = screensCfgRef.current;
      if (!cfg || !slug) {
        log('captured', 'no project loaded', 'warn');
        return;
      }
      const targetId = screenIdOverride ?? currentScreenId;
      const screen = cfg.screens.find((s) => s.id === targetId);
      if (!screen) {
        log('captured', 'no current screen to capture', 'warn');
        return;
      }
      // Browser fallback (`npm run dev`) has no native pane to grab.
      if (!isTauri()) {
        log('captured', 'screenshots require the desktop build', 'warn');
        setToast('Screenshots require the desktop app');
        return;
      }
      const b = boundsRef.current;
      if (!b || b.w < 2 || b.h < 2) {
        log('captured', 'embedded browser pane not ready', 'warn');
        setToast('Switch to split / app view first');
        return;
      }
      try {
        const result = await embed.capture({
          slug,
          screenId: screen.id,
          x: b.x,
          y: b.y,
          w: b.w,
          h: b.h,
        });
        if (!result) {
          // safeInvoke swallows the error to keep React renders alive — the
          // detailed reason is in `console.warn`. Bubble a short hint.
          throw new Error('capture failed (see DevTools console)');
        }
        const now = Date.now();
        const next: ScreensConfig = {
          ...cfg,
          screens: cfg.screens.map((s) =>
            s.id === screen.id
              ? {
                  ...s,
                  status: 'captured',
                  visitedAt: 'just now',
                  capturedAt: now,
                }
              : s,
          ),
        };
        await writeScreens(slug, next);
        // Eagerly reflect the write so the canvas refreshes even before the
        // file-watcher round-trips through the store.
        screensCfgRef.current = next;
        log('captured', `${screen.path} → ${screen.id}.png`);
        setToast(`Captured ${screen.path}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log('captured', msg, 'warn');
        setToast(`Capture failed: ${msg.slice(0, 80)}`);
      }
    },
    [slug, currentScreenId, writeScreens, log],
  );

  // ── Wire CLI inbox commands ────────────────────────────────────────────
  useEffect(() => {
    const off = onInbox((cmd, args) => {
      log('cli', `${cmd} ${JSON.stringify(args)}`);
      switch (cmd) {
        case 'navigate': {
          const t = String(args.target ?? '');
          if (!t) return;
          // Accept either a screen id or a literal path.
          const byId = screens.find((s) => s.id === t);
          if (byId) navigate(byId);
          else navigate(t);
          break;
        }
        case 'reload':
          embed.reload();
          break;
        case 'devtools':
          embed.openDevtools();
          break;
        case 'capture': {
          // `screens capture <id>` should land on that screen first so the
          // resulting PNG matches the requested route. Navigate, give the
          // embedded webview a moment to repaint, *then* snap. When no id is
          // supplied we capture whatever's already showing.
          const id = (args.id as string) ?? null;
          if (id) {
            const s = screens.find((s) => s.id === id);
            if (s) {
              navigate(s);
              window.setTimeout(() => capture(id), CAPTURE_SETTLE_MS);
              break;
            }
          }
          capture();
          break;
        }
        case 'view': {
          const mode = args.mode as ViewMode;
          if (mode === 'map' || mode === 'split' || mode === 'app') setView(mode);
          break;
        }
        case 'account.use': {
          const id = String(args.accountId ?? '');
          const a = accounts.find((a) => a.id === id);
          if (a) pickAccount(a);
          break;
        }
        case 'project.switch':
          // No-op here — the store reacts via store:registry events.
          break;
        default:
          // Unknown commands are logged but ignored.
          break;
      }
    });
    return off;
  }, [onInbox, screens, accounts, navigate, capture, pickAccount, setView, log]);

  // Toast auto-dismiss.
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(t);
  }, [toast]);

  // Keyboard shortcuts.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if ((e.metaKey || e.ctrlKey) && e.key === '1') { e.preventDefault(); setView('map'); }
      else if ((e.metaKey || e.ctrlKey) && e.key === '2') { e.preventDefault(); setView('split'); }
      else if ((e.metaKey || e.ctrlKey) && e.key === '3') { e.preventDefault(); setView('app'); }
      else if (e.key === 'Escape') setSelectedScreenId(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setView]);

  // ── First-run / empty state ────────────────────────────────────────────
  if (!ready) return <BootingScreen />;
  if (projects.length === 0) return <EmptyState />;
  if (!projectMeta) return <BootingScreen />;

  const baseUrl = projectMeta.baseUrl;
  const setBaseUrl = (newUrl: string) =>
    updateProjectMeta(projectMeta.slug, { baseUrl: newUrl });

  return (
    <div className="app">
      <TopBar
        baseUrl={baseUrl}
        setBaseUrl={setBaseUrl}
        view={view}
        setView={setView}
        agentConnected={true}
      />
      <Sidebar
        groups={groups}
        screens={screens}
        currentScreenId={currentScreenId}
        selectedScreenId={selectedScreenId}
        onPickScreen={(s) => {
          setSelectedScreenId(s.id);
          openNode(s);
        }}
        accounts={accounts}
        currentAccountId={accountId}
        defaultAccountId={accountsCfg?.defaultAccountId ?? null}
        onPickAccount={pickAccount}
        activity={activity}
      />
      <div className="main">
        {(view === 'map' || view === 'split') && (
          <div className="pane" style={{ position: 'relative' }}>
            <Canvas
              groups={groups}
              screens={screens}
              edges={edges}
              currentScreenId={currentScreenId}
              selectedScreenId={selectedScreenId}
              onSelect={setSelectedScreenId}
              onNavigate={openNode}
            />
            <Inspector
              screen={selected}
              account={account}
              onNavigate={openNode}
              onClose={() => setSelectedScreenId(null)}
              onCapture={() => capture()}
            />
          </div>
        )}
        {view === 'split' && <div className="split-divider" />}
        {(view === 'app' || view === 'split') && (
          <div
            className="pane"
            style={{ maxWidth: view === 'split' ? '50%' : 'none' }}
          >
            <EmbeddedBrowser
              projectSlug={projectMeta.slug}
              baseUrl={baseUrl}
              path={path}
              account={account}
              history={history}
              hIdx={hIdx}
              setHIdx={setHIdx}
              onNavigate={navigate}
              onCapture={() => capture()}
              onBoundsChange={(b) => {
                boundsRef.current = b;
              }}
            />
          </div>
        )}
        {toast && (
          <div className="toast" role="status">
            <Check />
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}

function BootingScreen() {
  return (
    <div className="boot">
      <div className="boot-inner">
        <div className="brand-mark">N</div>
        <div className="boot-label">screens</div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-shell">
      <div className="empty-card">
        <div className="brand-mark big">N</div>
        <h2>Welcome to Screens</h2>
        <p>
          No projects yet. Initialise one from your terminal — the desktop app
          will pick it up automatically.
        </p>
        <pre>
          <code>
            screens project init my-app \{'\n'}
            {'  '}--base-url=http://localhost:3000
          </code>
        </pre>
        <p className="hint">
          Or, in the top bar, click the project pill → "New project…"
        </p>
      </div>
    </div>
  );
}
