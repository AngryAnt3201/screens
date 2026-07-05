import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { Canvas } from './components/Canvas';
import { Inspector } from './components/Inspector';
import { EmbeddedBrowser } from './components/EmbeddedBrowser';
import { ReviewPanel } from './components/Review/ReviewPanel';
import { Check } from './components/icons';
import { ScreensStoreProvider, useStore } from './lib/screensStore';
import { ConsoleStoreProvider } from './lib/console/consoleStore';
import { embed, isTauri } from './lib/tauri';
import { awaitingCount } from './lib/review';
import type {
  Account,
  ActivityEntry,
  ReviewCheck,
  ReviewTicket,
  Screen,
  ScreensConfig,
  Verdict,
  VerdictKind,
  ViewMode,
} from './types';
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

/** How long after the most recent inbox command the agent-status pill stays
 *  in its "live" state. After this window we flip back to "idle". */
const AGENT_LIVE_MS = 30_000;

/** Auto-login outcome polling: how often to ask the embedded webview for its
 *  current URL, and how long before we give up and report a likely failure. */
const AUTOLOGIN_POLL_MS = 500;
const AUTOLOGIN_TIMEOUT_MS = 10_000;

export function App() {
  return (
    <ScreensStoreProvider>
      <ConsoleStoreProvider>
        <Shell />
      </ConsoleStoreProvider>
    </ScreensStoreProvider>
  );
}

const TOAST_MS = 1800;
const MAX_ACTIVITY = 30;

function Shell() {
  const { ready, current, projects, updateProjectMeta, writeScreens, appendVerdict, onInbox } =
    useStore();

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
  const reviewTickets = current?.review?.tickets ?? [];
  const verdicts = current?.verdicts ?? [];
  const reviewAwaiting = useMemo(
    () => awaitingCount(reviewTickets, verdicts),
    [reviewTickets, verdicts],
  );

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
  // The review check currently loaded in the embedded browser (highlighted in
  // the review panel). Reset when the project changes.
  const [activeCheckId, setActiveCheckId] = useState<string | null>(null);
  useEffect(() => setActiveCheckId(null), [slug]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  // True for `AGENT_LIVE_MS` after the last inbox command; drives the
  // "agent · live / idle" pill in the top bar.
  const [agentLive, setAgentLive] = useState(false);
  const agentTimerRef = useRef<number | null>(null);

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

  // Tracks the in-flight auto-login outcome poller so a second account
  // switch cancels the first one's observation.
  const autoLoginAbortRef = useRef<(() => void) | null>(null);

  // Polls the embedded webview's URL after an auto-login injection. Resolves
  // when the URL matches the configured `successUrl`, rejects with a timeout
  // string otherwise. No-op outside Tauri (the iframe fallback can't auto-
  // login anyway) and when the account has no `successUrl` configured.
  const watchAutoLoginOutcome = useCallback(
    (account: Account, baseAtFire: string) => {
      autoLoginAbortRef.current?.();
      autoLoginAbortRef.current = null;
      if (!isTauri()) return;
      const target = account.login?.successUrl;
      if (!target) return;
      const cleanBase = baseAtFire.replace(/\/$/, '');
      const fullTarget = /^https?:/i.test(target) ? target : cleanBase + target;
      const startedAt = Date.now();
      let cancelled = false;
      const interval = window.setInterval(async () => {
        if (cancelled) return;
        try {
          const url = await embed.url();
          if (url && url.startsWith(fullTarget)) {
            cancelled = true;
            window.clearInterval(interval);
            autoLoginAbortRef.current = null;
            log('login', `signed in as ${account.email}`);
            setToast(`Signed in as ${account.name}`);
            return;
          }
        } catch {
          // Transient — the webview might be mid-navigation. Try again.
        }
        if (Date.now() - startedAt > AUTOLOGIN_TIMEOUT_MS) {
          cancelled = true;
          window.clearInterval(interval);
          autoLoginAbortRef.current = null;
          log(
            'login',
            `auto-login for ${account.email} didn't reach ${target} — check DevTools`,
            'warn',
          );
          setToast(`Auto-login may have failed`);
        }
      }, AUTOLOGIN_POLL_MS);
      autoLoginAbortRef.current = () => {
        cancelled = true;
        window.clearInterval(interval);
      };
    },
    [log],
  );

  const pickAccount = useCallback(
    (a: Account) => {
      setAccountId(a.id);
      log('switched', `session → ${a.email}`);
      if (a.login) {
        log('login', `auto-fill triggered for ${a.email}`);
        setToast(`Signing in as ${a.name}…`);
        // `baseUrl` may not be defined yet on first render; the destructure
        // below tolerates that. We close over the current base so a base-url
        // change mid-flight doesn't corrupt the comparison.
        const base = projectMeta?.baseUrl ?? '';
        watchAutoLoginOutcome(a, base);
      } else {
        // Cancel any in-flight observation when switching to a no-login
        // account — its target URL is irrelevant.
        autoLoginAbortRef.current?.();
        autoLoginAbortRef.current = null;
        setToast(`Switched to ${a.name}`);
      }
    },
    [log, setAccountId, watchAutoLoginOutcome, projectMeta?.baseUrl],
  );

  // ── Review cockpit ──────────────────────────────────────────────────────
  // Clicking a check jumps the embedded browser to its page and, when the
  // check names an account, switches to it (reusing the auto-login flow).
  const goToCheck = useCallback(
    (check: ReviewCheck) => {
      setActiveCheckId(check.id);
      let target: string | Screen | null = null;
      if (check.screenId) {
        target = screens.find((s) => s.id === check.screenId) ?? check.path ?? null;
      } else if (check.path) {
        target = check.path;
      }
      if (target) navigate(target);
      if (check.account && check.account !== accountId) {
        const a = accounts.find((x) => x.id === check.account);
        if (a) pickAccount(a);
      }
      log('review', `open ${check.path ?? check.screenId ?? check.title}`);
    },
    [screens, accounts, accountId, navigate, pickAccount, log],
  );

  // Recording a verdict appends to `verdicts.jsonl` (the app is its sole
  // writer). The agent drains it via `screens review pull`.
  const recordVerdict = useCallback(
    (ticket: ReviewTicket, check: ReviewCheck, kind: VerdictKind, note: string) => {
      if (!slug) return;
      const verdict: Verdict = {
        ts: Date.now(),
        ticketId: ticket.id,
        checkId: check.id,
        round: check.round ?? 0,
        verdict: kind,
        ...(note ? { note } : {}),
      };
      appendVerdict(slug, verdict);
      log('review', `${kind} · ${check.title}`, kind === 'fail' ? 'warn' : 'info');
      setToast(`${kind === 'pass' ? '✓ Passed' : kind === 'fail' ? '✗ Failed' : '~ Changes'} — ${check.title.slice(0, 40)}`);
    },
    [slug, appendVerdict, log],
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
                  // Epoch-ms so the card ages in real time, not a frozen
                  // "just now" string.
                  visitedAt: now,
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
      // Flip the agent pill to "live" and reset the idle countdown. Any
      // command counts — `navigate`, `view`, `capture`, even malformed ones.
      setAgentLive(true);
      if (agentTimerRef.current !== null) {
        window.clearTimeout(agentTimerRef.current);
      }
      agentTimerRef.current = window.setTimeout(() => {
        setAgentLive(false);
        agentTimerRef.current = null;
      }, AGENT_LIVE_MS);
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
          if (mode === 'map' || mode === 'split' || mode === 'app' || mode === 'review') {
            setView(mode);
          }
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
    return () => {
      off();
      if (agentTimerRef.current !== null) {
        window.clearTimeout(agentTimerRef.current);
        agentTimerRef.current = null;
      }
    };
  }, [onInbox, screens, accounts, navigate, capture, pickAccount, setView, log]);

  // Toast auto-dismiss.
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(t);
  }, [toast]);

  // Cancel any in-flight auto-login URL poller when the shell unmounts so
  // its interval doesn't outlive the React tree.
  useEffect(() => {
    return () => {
      autoLoginAbortRef.current?.();
      autoLoginAbortRef.current = null;
    };
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if ((e.metaKey || e.ctrlKey) && e.key === '1') { e.preventDefault(); setView('map'); }
      else if ((e.metaKey || e.ctrlKey) && e.key === '2') { e.preventDefault(); setView('split'); }
      else if ((e.metaKey || e.ctrlKey) && e.key === '3') { e.preventDefault(); setView('app'); }
      else if ((e.metaKey || e.ctrlKey) && e.key === '4') { e.preventDefault(); setView('review'); }
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
        agentConnected={agentLive}
        reviewBadge={reviewAwaiting}
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
        {view === 'review' && (
          <div className="pane review-pane">
            <ReviewPanel
              tickets={reviewTickets}
              verdicts={verdicts}
              currentAccountId={accountId}
              onGoToCheck={goToCheck}
              onVerdict={recordVerdict}
              activeCheckId={activeCheckId}
            />
          </div>
        )}
        {(view === 'split' || view === 'review') && <div className="split-divider" />}
        {(view === 'app' || view === 'split' || view === 'review') && (
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
