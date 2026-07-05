import { describe, it, expect } from 'vitest';
import { displayStatus, latestNote, rollup, awaitingCount } from './review';
import type { ReviewCheck, ReviewTicket, Verdict } from '../types';

const check = (over: Partial<ReviewCheck> = {}): ReviewCheck => ({
  id: 'c1',
  title: 'do a thing',
  status: 'awaiting',
  round: 0,
  ...over,
});

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  ts: 1,
  ticketId: 't1',
  checkId: 'c1',
  round: 0,
  verdict: 'pass',
  ...over,
});

describe('displayStatus', () => {
  it('is awaiting with no verdicts', () => {
    expect(displayStatus(check(), [])).toBe('awaiting');
  });

  it('reflects the latest verdict for the matching round', () => {
    const verdicts = [verdict({ ts: 1, verdict: 'fail' }), verdict({ ts: 2, verdict: 'pass' })];
    expect(displayStatus(check(), verdicts)).toBe('pass');
  });

  it('ignores verdicts from an older round (the core of re-review)', () => {
    // Check was reopened → round 1. A round-0 fail must NOT stick.
    const verdicts = [verdict({ round: 0, verdict: 'fail' })];
    expect(displayStatus(check({ round: 1 }), verdicts)).toBe('awaiting');
  });

  it('applies a new verdict cast against the new round', () => {
    const verdicts = [
      verdict({ round: 0, verdict: 'fail', ts: 1 }),
      verdict({ round: 1, verdict: 'pass', ts: 2 }),
    ];
    expect(displayStatus(check({ round: 1 }), verdicts)).toBe('pass');
  });

  it('does not cross-contaminate between checks', () => {
    const verdicts = [verdict({ checkId: 'other', verdict: 'fail' })];
    expect(displayStatus(check({ id: 'c1' }), verdicts)).toBe('awaiting');
  });
});

describe('latestNote', () => {
  it('returns the note of the current-round verdict', () => {
    const verdicts = [verdict({ verdict: 'fail', note: 'broken on mobile' })];
    expect(latestNote(check(), verdicts)).toBe('broken on mobile');
  });
  it('is null once the round has moved on', () => {
    const verdicts = [verdict({ round: 0, note: 'stale' })];
    expect(latestNote(check({ round: 1 }), verdicts)).toBeNull();
  });
});

describe('rollup', () => {
  const ticket = (checks: ReviewCheck[]): ReviewTicket => ({ id: 't1', title: 'T', checks });

  it('is empty with no checks', () => {
    expect(rollup(ticket([]), [])).toBe('empty');
  });
  it('is passed only when every check passes', () => {
    const t = ticket([check({ id: 'a' }), check({ id: 'b' })]);
    const vs = [verdict({ checkId: 'a' }), verdict({ checkId: 'b' })];
    expect(rollup(t, vs)).toBe('passed');
  });
  it('is needs-work if any check fails or wants changes', () => {
    const t = ticket([check({ id: 'a' }), check({ id: 'b' })]);
    const vs = [verdict({ checkId: 'a' }), verdict({ checkId: 'b', verdict: 'changes' })];
    expect(rollup(t, vs)).toBe('needs-work');
  });
  it('is awaiting when some checks are unruled but none failed', () => {
    const t = ticket([check({ id: 'a' }), check({ id: 'b' })]);
    const vs = [verdict({ checkId: 'a' })];
    expect(rollup(t, vs)).toBe('awaiting');
  });
});

describe('awaitingCount', () => {
  it('counts unruled checks across tickets', () => {
    const tickets: ReviewTicket[] = [
      { id: 't1', title: 'A', checks: [check({ id: 'a' }), check({ id: 'b' })] },
      { id: 't2', title: 'B', checks: [check({ id: 'c' })] },
    ];
    const vs = [verdict({ checkId: 'a' })]; // a passed → 2 remain
    expect(awaitingCount(tickets, vs)).toBe(2);
  });
});
