/**
 * Exercises the CLI-side review store: the verdict drain-cursor and
 * round-based reconciliation that close the review loop. Plain JS (not
 * typechecked by the app build) so it can freely touch the filesystem.
 * Runs against a throwaway `$SCREENS_HOME`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// store.mjs reads SCREENS_HOME at import time — set it before importing.
process.env.SCREENS_HOME = join(mkdtempSync(join(tmpdir(), 'screens-review-')), 'store');

let S;
beforeAll(async () => {
  S = await import('./store.mjs');
  S.ensureStore();
  S.createProject({ slug: 'dx', baseUrl: 'http://localhost:3000', name: 'Dex IQ' });
});

describe('review store (CLI half of the loop)', () => {
  it('writes and reads tickets + checks', () => {
    S.writeReview('dx', {
      tickets: [
        {
          id: 'DX-1',
          title: 'Widget',
          checks: [
            { id: 'dx-1-a', title: 'shows', path: '/app', status: 'awaiting', round: 0 },
            { id: 'dx-1-b', title: 'hidden for free', path: '/app', status: 'awaiting', round: 0 },
          ],
        },
      ],
    });
    const r = S.readReview('dx');
    expect(r.tickets).toHaveLength(1);
    expect(r.tickets[0].checks).toHaveLength(2);
  });

  it('pullVerdicts drains only fresh lines and advances the cursor', () => {
    S.appendVerdict('dx', { ts: 1, ticketId: 'DX-1', checkId: 'dx-1-a', round: 0, verdict: 'pass' });
    S.appendVerdict('dx', { ts: 2, ticketId: 'DX-1', checkId: 'dx-1-b', round: 0, verdict: 'fail', note: 'nope' });

    const first = S.pullVerdicts('dx');
    expect(first.map((v) => v.checkId)).toEqual(['dx-1-a', 'dx-1-b']);

    // Nothing new the second time.
    expect(S.pullVerdicts('dx')).toEqual([]);

    // A later append is picked up on the next pull.
    S.appendVerdict('dx', { ts: 3, ticketId: 'DX-1', checkId: 'dx-1-a', round: 0, verdict: 'changes' });
    const third = S.pullVerdicts('dx');
    expect(third).toHaveLength(1);
    expect(third[0].verdict).toBe('changes');
  });

  it('readVerdicts returns the full append-only log', () => {
    expect(S.readVerdicts('dx').length).toBeGreaterThanOrEqual(3);
  });
});
