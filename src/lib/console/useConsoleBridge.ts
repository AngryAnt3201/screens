import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauri } from '../tauri';
import { useConsoleStore } from './consoleStore';
import type { InjectOutgoing, LogEntry } from './types';

/**
 * Subscribes to the Tauri "console:event" event and dispatches into the
 * console reducer. Runs once at the app level; the embedded webview emits
 * at most one event per console call.
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
