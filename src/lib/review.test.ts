import { describe, it, expect } from 'vitest';
import {
  displayStatus,
  latestNote,
  rollup,
  awaitingCount,
  buildQueue,
  nextAfter,
  priorityRank,
} from './review';
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

describe('priorityRank', () => {
  it('orders Highest < High < Medium < Low, unset as Medium', () => {
    expect(priorityRank('Highest')).toBeLessThan(priorityRank('High'));
    expect(priorityRank('High')).toBeLessThan(priorityRank('Medium'));
    expect(priorityRank('Medium')).toBeLessThan(priorityRank('Low'));
    expect(priorityRank(undefined)).toBe(priorityRank('Medium'));
  });
});

describe('buildQueue', () => {
  const tickets: ReviewTicket[] = [
    { id: 'low', title: 'L', priority: 'Low', checks: [check({ id: 'l1' })] },
    { id: 'top', title: 'T', priority: 'Highest', checks: [check({ id: 'h1' }), check({ id: 'h2' })] },
    { id: 'mid', title: 'M', priority: 'Medium', checks: [check({ id: 'm1' })] },
  ];

  it('orders by ticket priority, then check order', () => {
    const q = buildQueue(tickets, [], 'all');
    expect(q.map((i) => i.check.id)).toEqual(['h1', 'h2', 'm1', 'l1']);
  });

  it('todo filter keeps only awaiting checks', () => {
    const vs = [verdict({ checkId: 'h1', verdict: 'pass' })];
    const q = buildQueue(tickets, vs, 'todo');
    expect(q.map((i) => i.check.id)).toEqual(['h2', 'm1', 'l1']);
  });

  it('needswork filter keeps only fail/changes', () => {
    const vs = [
      verdict({ checkId: 'h1', verdict: 'fail' }),
      verdict({ checkId: 'm1', verdict: 'changes' }),
      verdict({ checkId: 'l1', verdict: 'pass' }),
    ];
    const q = buildQueue(tickets, vs, 'needswork');
    expect(q.map((i) => i.check.id)).toEqual(['h1', 'm1']);
  });
});

describe('nextAfter (auto-advance)', () => {
  const tickets: ReviewTicket[] = [
    { id: 't', title: 'T', priority: 'Highest', checks: [check({ id: 'a' }), check({ id: 'b' }), check({ id: 'c' })] },
  ];
  const q = buildQueue(tickets, [], 'all');

  it('returns the following item', () => {
    expect(nextAfter(q, 'a')?.check.id).toBe('b');
  });
  it('falls back to the previous item at the end', () => {
    expect(nextAfter(q, 'c')?.check.id).toBe('b');
  });
  it('returns null when the queue has one item', () => {
    const one = buildQueue([{ id: 't', title: 'T', checks: [check({ id: 'a' })] }], [], 'all');
    expect(nextAfter(one, 'a')).toBeNull();
  });
});
