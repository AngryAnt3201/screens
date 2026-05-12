/**
 * Thin wrapper around the Tauri command surface so the rest of the app can
 * `await embed.open(...)` without checking `window.__TAURI__` every time.
 *
 * Detects whether we're running inside Tauri vs. a plain browser (e.g. `npm
 * run dev` opened in Safari). In the latter case every method becomes a
 * no-op so the React UI stays functional for design work.
 */
import { invoke } from '@tauri-apps/api/core';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface OpenArgs extends Bounds {
  url: string;
  dataDir?: string;
}

async function safeInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    // Surface errors but don't let them crash React renders.
    console.warn(`[screens] invoke ${cmd} failed:`, err);
    return null;
  }
}

export const embed = {
  async open({ url, x, y, w, h, dataDir }: OpenArgs) {
    return safeInvoke<void>('embed_open', {
      url,
      x,
      y,
      w,
      h,
      dataDir: dataDir ?? null,
    });
  },
  async bounds({ x, y, w, h }: Bounds) {
    return safeInvoke<void>('embed_bounds', { x, y, w, h });
  },
  async navigate(url: string) {
    return safeInvoke<void>('embed_navigate', { url });
  },
  async evalJs(js: string) {
    return safeInvoke<void>('embed_eval', { js });
  },
  async close() {
    return safeInvoke<void>('embed_close', {});
  },
  async reload() {
    return safeInvoke<void>('embed_reload', {});
  },
  async openDevtools() {
    return safeInvoke<void>('embed_devtools', {});
  },
};

export async function accountDataDir(project: string, accountId: string): Promise<string | null> {
  return safeInvoke<string>('account_data_dir', { project, accountId });
}
