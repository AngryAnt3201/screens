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
