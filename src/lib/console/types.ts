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
