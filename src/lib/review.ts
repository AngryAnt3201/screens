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
import type { CheckStatus, ReviewCheck, ReviewTicket, TicketRollup, Verdict } from '../types';

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
