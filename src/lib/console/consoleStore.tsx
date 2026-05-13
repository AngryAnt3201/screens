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
