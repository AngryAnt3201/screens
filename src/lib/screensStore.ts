/**
 * React-friendly facade over the on-disk store at `~/.screens/`.
 *
 * In Tauri:  reads via invoke commands, hot-updates on `store:*` events.
 * In browser dev (no Tauri): falls back to an in-memory store seeded with
 * the example "demo" project — handy for visual design work.
 */
import { createContext, createElement, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauri } from './tauri';
import type { AccountsConfig, ReviewConfig, ScreensConfig, Verdict } from '../types';
import { demoSeed } from './seed';

export interface ProjectMeta {
  slug: string;
  name: string;
  baseUrl: string;
  defaultAccountId?: string | null;
  createdAt?: string;
}

interface Registry {
  current: string | null;
  projects: string[];
}

export interface ProjectBundle {
  project: ProjectMeta;
  screens: ScreensConfig;
  accounts: AccountsConfig;
  /** Agent-authored review tickets + checks. May be absent on older projects. */
  review?: ReviewConfig;
  /** App-authored verdict log (append-only), parsed. */
  verdicts?: Verdict[];
}

interface InboxCommand {
  ts: number;
  cmd: string;
  args: Record<string, unknown>;
}

export interface InboxHandler {
  (cmd: string, args: Record<string, unknown>): void;
}

interface StoreContextValue {
  ready: boolean;
  registry: Registry;
  projects: ProjectMeta[];
  current: ProjectBundle | null;
  /** Switch active project. */
  setCurrent: (slug: string) => Promise<void>;
  /** Create a new empty project. */
  createProject: (input: { slug: string; baseUrl: string; name?: string }) => Promise<void>;
  /** Update a project's metadata (baseUrl, name, defaultAccountId). */
  updateProjectMeta: (slug: string, patch: Partial<ProjectMeta>) => Promise<void>;
  /** Persist screens/edges/groups. */
  writeScreens: (slug: string, data: ScreensConfig) => Promise<void>;
  writeAccounts: (slug: string, data: AccountsConfig) => Promise<void>;
  /** Append a reviewer verdict to `verdicts.jsonl` (the app is its sole writer).
   *  Optimistically updates the in-memory bundle so the sidebar reacts at once;
   *  the canonical value re-arrives via the file watcher. */
  appendVerdict: (slug: string, verdict: Verdict) => Promise<void>;
  /** Resolve a screen-shot URL (file:// in Tauri, /seed/... in fallback). */
  screenshotUrl: (slug: string, screenId: string) => string | null;
  /** Subscribe to CLI commands (only emits in Tauri). */
  onInbox: (handler: InboxHandler) => () => void;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore: missing <ScreensStoreProvider>');
  return ctx;
}

interface ProviderProps {
  children: ReactNode;
}

export function ScreensStoreProvider({ children }: ProviderProps) {
  const tauriMode = isTauri();
  const [ready, setReady] = useState(false);
  const [registry, setRegistry] = useState<Registry>({ current: null, projects: [] });
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [bundle, setBundle] = useState<ProjectBundle | null>(null);

  // Inbox handlers (only one provider lives in the app so a Set is fine).
  const inboxHandlersRef = useRef<Set<InboxHandler>>(new Set());

  // ── Initial load ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (tauriMode) {
        const [reg, list] = await Promise.all([
          invoke<Registry>('store_registry'),
          invoke<ProjectMeta[]>('store_list_projects'),
        ]);
        if (cancelled) return;
        setRegistry(reg);
        setProjects(list);
        if (reg.current) {
          const b = await invoke<ProjectBundle>('store_project', { slug: reg.current });
          if (cancelled) return;
          setBundle(b);
        }
      } else {
        const seed = demoSeed();
        setRegistry({ current: seed.project.slug, projects: [seed.project.slug] });
        setProjects([seed.project]);
        setBundle(seed);
      }
      setReady(true);
    })().catch((err) => console.error('[screens] store init:', err));
    return () => {
      cancelled = true;
    };
  }, [tauriMode]);

  // ── Event subscriptions ──────────────────────────────────────────────────
  useEffect(() => {
    if (!tauriMode) return;
    let unsubs: UnlistenFn[] = [];
    (async () => {
      unsubs.push(
        await listen<Registry>('store:registry', async (e) => {
          setRegistry(e.payload);
          // Project list may have changed.
          const list = await invoke<ProjectMeta[]>('store_list_projects');
          setProjects(list);
          // If the current project changed, reload it.
          if (e.payload.current) {
            const b = await invoke<ProjectBundle>('store_project', { slug: e.payload.current });
            setBundle(b);
          } else {
            setBundle(null);
          }
        }),
      );
      unsubs.push(
        await listen<{ slug: string }>('store:project', async (e) => {
          // Only refresh if the changed project is the current one.
          if (e.payload.slug !== registryCurrentRef.current) return;
          try {
            const b = await invoke<ProjectBundle>('store_project', { slug: e.payload.slug });
            setBundle(b);
          } catch (err) {
            // File may be transiently absent during atomic rename — ignore.
            console.warn('[screens] reload project:', err);
          }
        }),
      );
      unsubs.push(
        await listen<InboxCommand>('inbox:command', (e) => {
          for (const h of inboxHandlersRef.current) {
            try {
              h(e.payload.cmd, e.payload.args ?? {});
            } catch (err) {
              console.warn('[screens] inbox handler:', err);
            }
          }
        }),
      );
    })();
    return () => {
      for (const u of unsubs) u();
    };
  }, [tauriMode]);

  // Keep a ref of the registry's current slug for the listener closure.
  const registryCurrentRef = useRef<string | null>(null);
  useEffect(() => {
    registryCurrentRef.current = registry.current;
  }, [registry.current]);

  // ── Actions ──────────────────────────────────────────────────────────────
  const setCurrent = async (slug: string) => {
    if (tauriMode) {
      await invoke('store_set_current', { slug });
      const b = await invoke<ProjectBundle>('store_project', { slug });
      setBundle(b);
      setRegistry((r) => ({ ...r, current: slug }));
    } else {
      // Fallback supports only the demo project.
      setRegistry((r) => ({ ...r, current: slug }));
    }
  };

  const createProject: StoreContextValue['createProject'] = async ({ slug, baseUrl, name }) => {
    if (tauriMode) {
      await invoke('store_create_project', { slug, baseUrl, name: name ?? null });
    } else {
      console.warn('[screens] createProject only works in Tauri mode');
    }
  };

  const updateProjectMeta: StoreContextValue['updateProjectMeta'] = async (slug, patch) => {
    if (tauriMode) {
      await invoke('store_update_project_meta', { slug, patch });
    } else {
      setBundle((b) => (b ? { ...b, project: { ...b.project, ...patch } } : b));
    }
  };

  const writeScreens: StoreContextValue['writeScreens'] = async (slug, data) => {
    if (tauriMode) {
      await invoke('store_write_screens', { slug, data });
    } else {
      setBundle((b) => (b ? { ...b, screens: data } : b));
    }
  };

  const writeAccounts: StoreContextValue['writeAccounts'] = async (slug, data) => {
    if (tauriMode) {
      await invoke('store_write_accounts', { slug, data });
    } else {
      setBundle((b) => (b ? { ...b, accounts: data } : b));
    }
  };

  const appendVerdict: StoreContextValue['appendVerdict'] = async (slug, verdict) => {
    // Optimistic: reflect the verdict in the current bundle immediately so the
    // check's display status flips without waiting for the watcher round-trip.
    setBundle((b) =>
      b && b.project.slug === slug
        ? { ...b, verdicts: [...(b.verdicts ?? []), verdict] }
        : b,
    );
    if (tauriMode) {
      try {
        await invoke('store_append_verdict', { slug, verdict });
      } catch (err) {
        console.error('[screens] append verdict:', err);
      }
    }
  };

  const screenshotUrl: StoreContextValue['screenshotUrl'] = (_slug, screenId) => {
    if (!tauriMode) return `/screenshots/${encodeURIComponent(screenId)}.png`;
    // Tauri can't easily do a sync call here; NodeCard fetches via invoke.
    return null;
  };

  const onInbox: StoreContextValue['onInbox'] = (handler) => {
    inboxHandlersRef.current.add(handler);
    return () => {
      inboxHandlersRef.current.delete(handler);
    };
  };

  const value = useMemo<StoreContextValue>(
    () => ({
      ready,
      registry,
      projects,
      current: bundle,
      setCurrent,
      createProject,
      updateProjectMeta,
      writeScreens,
      writeAccounts,
      appendVerdict,
      screenshotUrl,
      onInbox,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready, registry, projects, bundle, tauriMode],
  );

  return createElement(StoreContext.Provider, { value }, children);
}

/**
 * Resolve a screenshot URL via invoke (async). NodeCard uses this.
 *
 * Rust returns the absolute filesystem path of the PNG (or null when the
 * file doesn't exist). We wrap with `convertFileSrc()` to produce an
 * `asset://` URL the Tauri webview is permitted to load — `file://` URLs
 * are blocked by Tauri 2's default security policy. The matching
 * `assetProtocol.scope` entry in `tauri.conf.json` authorises reads under
 * `~/.screens/`.
 */
export async function fetchScreenshotUrl(slug: string, screenId: string): Promise<string | null> {
  if (!isTauri()) return `/screenshots/${encodeURIComponent(screenId)}.png`;
  try {
    const path = await invoke<string | null>('store_screenshot_url', { slug, screenId });
    if (!path) return null;
    return convertFileSrc(path);
  } catch {
    return null;
  }
}
