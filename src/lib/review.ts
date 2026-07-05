/**
 * Pure helpers for deriving a check's *display* status from the append-only
 * verdict log, and a ticket's rollup from its checks.
 *
 * The canonical `check.status` is what the agent last wrote to `review.json`.
 * But between your click and the agent's next `screens review pull`, the fresh
 * verdict lives only in `verdicts.jsonl`. So the sidebar overlays the log: the
 * latest verdict whose `round` matches the check's current `round` wins. When
 * the agent re-requests review it bumps the round, so stale verdicts stop
 * matching and the check reverts to `awaiting`. Mirrors `bin/screens.mjs`.
 */
import type {
  CheckStatus,
  Priority,
  ReviewCheck,
  ReviewTicket,
  TicketRollup,
  Verdict,
} from '../types';

export function displayStatus(check: ReviewCheck, verdicts: Verdict[]): CheckStatus {
  const round = check.round ?? 0;
  let latest: Verdict | null = null;
  for (const v of verdicts) {
    if (v.checkId === check.id && (v.round ?? 0) === round) {
      if (!latest || (v.ts ?? 0) >= (latest.ts ?? 0)) latest = v;
    }
  }
  return latest ? latest.verdict : (check.status ?? 'awaiting');
}

/** The most recent note attached to the check's current-round verdict, if any. */
export function latestNote(check: ReviewCheck, verdicts: Verdict[]): string | null {
  const round = check.round ?? 0;
  let latest: Verdict | null = null;
  for (const v of verdicts) {
    if (v.checkId === check.id && (v.round ?? 0) === round) {
      if (!latest || (v.ts ?? 0) >= (latest.ts ?? 0)) latest = v;
    }
  }
  return latest?.note ?? null;
}

export function rollup(ticket: ReviewTicket, verdicts: Verdict[]): TicketRollup {
  const checks = ticket.checks ?? [];
  if (checks.length === 0) return 'empty';
  const statuses = checks.map((c) => displayStatus(c, verdicts));
  if (statuses.some((s) => s === 'fail' || s === 'changes')) return 'needs-work';
  if (statuses.every((s) => s === 'pass')) return 'passed';
  return 'awaiting';
}

/** Count of checks still awaiting a ruling — drives the Review tab badge. */
export function awaitingCount(tickets: ReviewTicket[], verdicts: Verdict[]): number {
  let n = 0;
  for (const t of tickets) {
    for (const c of t.checks ?? []) {
      if (displayStatus(c, verdicts) === 'awaiting') n++;
    }
  }
  return n;
}

// ─── Review queue (the keyboard flow) ────────────────────────────────────────

export const PRIORITY_ORDER: Record<Priority, number> = {
  Highest: 0,
  High: 1,
  Medium: 2,
  Low: 3,
};

export function priorityRank(p?: Priority): number {
  return p ? PRIORITY_ORDER[p] : 2; // unset sorts as Medium
}

/** The three review lenses. `todo` is the daily driver — it shrinks to empty. */
export type ReviewFilter = 'todo' | 'needswork' | 'all';

export interface QueueItem {
  ticket: ReviewTicket;
  check: ReviewCheck;
  status: CheckStatus;
}

function matchesFilter(status: CheckStatus, filter: ReviewFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'todo') return status === 'awaiting';
  return status === 'fail' || status === 'changes'; // needswork
}

/**
 * Flatten tickets → an ordered, filtered list of checks. Order: ticket priority
 * (Highest first), then the ticket's given order, then the check's given order.
 * This is the exact sequence `j`/`k` walk and that auto-advance follows.
 */
export function buildQueue(
  tickets: ReviewTicket[],
  verdicts: Verdict[],
  filter: ReviewFilter,
): QueueItem[] {
  const ordered = [...tickets].sort(
    (a, b) => priorityRank(a.priority) - priorityRank(b.priority),
  );
  const out: QueueItem[] = [];
  for (const ticket of ordered) {
    for (const check of ticket.checks ?? []) {
      const status = displayStatus(check, verdicts);
      if (matchesFilter(status, filter)) out.push({ ticket, check, status });
    }
  }
  return out;
}

/** The next queue item to focus after ruling `ruledCheckId`, given the queue as
 *  it was *before* the ruling. Prefers the following item, else the previous,
 *  else null (queue exhausted). Used for auto-advance. */
export function nextAfter(queue: QueueItem[], ruledCheckId: string): QueueItem | null {
  const i = queue.findIndex((q) => q.check.id === ruledCheckId);
  if (i === -1) return queue[0] ?? null;
  return queue[i + 1] ?? queue[i - 1] ?? null;
}
