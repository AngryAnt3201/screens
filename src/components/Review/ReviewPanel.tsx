import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Priority,
  ReviewCheck,
  ReviewTicket,
  TicketRollup,
  Verdict,
  VerdictKind,
} from '../../types';
import {
  awaitingCount,
  displayStatus,
  latestNote,
  priorityRank,
  rollup,
  type ReviewFilter,
} from '../../lib/review';
import { CaretDown, Check, ExternalArrow } from '../icons';

interface ReviewPanelProps {
  tickets: ReviewTicket[];
  verdicts: Verdict[];
  filter: ReviewFilter;
  setFilter: (f: ReviewFilter) => void;
  /** Total checks across all tickets (for the progress readout). */
  total: number;
  currentAccountId: string | null;
  /** The check highlighted in the queue (focused, not necessarily loaded). */
  activeCheckId: string | null;
  showHelp: boolean;
  /** Move the highlight (no navigation). */
  onFocus: (checkId: string) => void;
  /** Load a check's page in the embedded browser (+ switch account). */
  onOpen: (check: ReviewCheck) => void;
  /** Record a verdict (auto-advances to the next check). */
  onVerdict: (ticket: ReviewTicket, check: ReviewCheck, kind: VerdictKind, note: string) => void;
}

const FILTERS: Array<{ key: ReviewFilter; label: string }> = [
  { key: 'todo', label: 'To review' },
  { key: 'needswork', label: 'Needs work' },
  { key: 'all', label: 'All' },
];

const ROLLUP_LABEL: Record<TicketRollup, string> = {
  empty: 'no checks',
  awaiting: 'to review',
  'needs-work': 'needs work',
  passed: 'all passed',
};

function checkVisible(status: string, filter: ReviewFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'todo') return status === 'awaiting';
  return status === 'fail' || status === 'changes';
}

export function ReviewPanel({
  tickets,
  verdicts,
  filter,
  setFilter,
  total,
  currentAccountId,
  activeCheckId,
  showHelp,
  onFocus,
  onOpen,
  onVerdict,
}: ReviewPanelProps) {
  const awaiting = useMemo(() => awaitingCount(tickets, verdicts), [tickets, verdicts]);
  const reviewed = total - awaiting;
  const pct = total > 0 ? Math.round((reviewed / total) * 100) : 0;

  // Priority-ordered tickets, each carrying only the checks visible under the
  // current filter. Tickets with nothing visible drop out.
  const groups = useMemo(() => {
    return [...tickets]
      .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
      .map((ticket) => ({
        ticket,
        roll: rollup(ticket, verdicts),
        checks: (ticket.checks ?? [])
          .map((check) => ({ check, status: displayStatus(check, verdicts) }))
          .filter(({ status }) => checkVisible(status, filter)),
      }))
      .filter((g) => g.checks.length > 0);
  }, [tickets, verdicts, filter]);

  const empty = tickets.length === 0;
  const nothingHere = !empty && groups.length === 0;

  return (
    <aside className="review-panel">
      <div className="review-head">
        <span className="review-title">Review</span>
        {total > 0 && (
          <span className="review-progress-num">
            {awaiting > 0 ? (
              <>
                <strong>{awaiting}</strong> left
              </>
            ) : (
              <>all clear</>
            )}
          </span>
        )}
      </div>

      {total > 0 && (
        <div className="review-toolbar">
          <div className="review-progress-bar" title={`${reviewed}/${total} reviewed`}>
            <div className="review-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="review-filter" role="tablist" aria-label="Review filter">
            {FILTERS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={filter === key}
                className={filter === key ? 'active' : ''}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="review-list">
        {empty && (
          <div className="review-empty">
            <p>No review items yet.</p>
            <p className="hint">
              The agent emits them as it works:
              <br />
              <code>screens review add-ticket …</code>
              <br />
              <code>screens review check …</code>
            </p>
          </div>
        )}

        {nothingHere && (
          <div className="review-zero">
            <div className="review-zero-mark">
              <Check />
            </div>
            <p className="review-zero-title">
              {filter === 'todo' ? 'All caught up' : 'Nothing here'}
            </p>
            <p className="review-zero-sub">
              {filter === 'todo'
                ? `${total} check${total === 1 ? '' : 's'} reviewed. You're done for now.`
                : 'No checks match this filter.'}
            </p>
          </div>
        )}

        {groups.map(({ ticket, roll, checks }) => (
          <TicketGroup
            key={ticket.id}
            ticket={ticket}
            roll={roll}
            checks={checks}
            verdicts={verdicts}
            currentAccountId={currentAccountId}
            activeCheckId={activeCheckId}
            onFocus={onFocus}
            onOpen={onOpen}
            onVerdict={onVerdict}
          />
        ))}
      </div>

      {showHelp && total > 0 && (
        <div className="review-hints">
          <Hint k="J / K" label="move" />
          <Hint k="↵" label="open" />
          <Hint k="P" label="pass" />
          <Hint k="C" label="changes" />
          <Hint k="F" label="fail" />
          <Hint k="N" label="note" />
          <Hint k="A" label="filter" />
        </div>
      )}
    </aside>
  );
}

function Hint({ k, label }: { k: string; label: string }) {
  return (
    <span className="review-hint">
      <kbd>{k}</kbd>
      {label}
    </span>
  );
}

const PRIORITY_TONE: Record<Priority, string> = {
  Highest: 'p-highest',
  High: 'p-high',
  Medium: 'p-medium',
  Low: 'p-low',
};

function TicketGroup({
  ticket,
  roll,
  checks,
  verdicts,
  currentAccountId,
  activeCheckId,
  onFocus,
  onOpen,
  onVerdict,
}: {
  ticket: ReviewTicket;
  roll: TicketRollup;
  checks: Array<{ check: ReviewCheck; status: string }>;
  verdicts: Verdict[];
  currentAccountId: string | null;
  activeCheckId: string | null;
  onFocus: (checkId: string) => void;
  onOpen: (check: ReviewCheck) => void;
  onVerdict: (ticket: ReviewTicket, check: ReviewCheck, kind: VerdictKind, note: string) => void;
}) {
  const hasActive = checks.some((c) => c.check.id === activeCheckId);
  const [collapsed, setCollapsed] = useState(false);
  const open = hasActive || !collapsed; // never hide the active check

  return (
    <div className={`review-ticket rollup-${roll}`}>
      <button
        type="button"
        className="review-ticket-head"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={open}
      >
        <span className={`caret ${open ? 'open' : ''}`}>
          <CaretDown />
        </span>
        {ticket.priority && (
          <span className={`prio-chip ${PRIORITY_TONE[ticket.priority]}`} title={`${ticket.priority} priority`}>
            {ticket.priority === 'Highest' ? '↑↑' : ticket.priority === 'High' ? '↑' : ticket.priority === 'Low' ? '↓' : '–'}
          </span>
        )}
        <span className="review-ticket-id">{ticket.id}</span>
        <span className="review-ticket-title">{ticket.title}</span>
        <span className={`rollup-pill rollup-${roll}`}>{ROLLUP_LABEL[roll]}</span>
        {ticket.ref && (
          <a
            className="review-ref"
            href={ticket.ref}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            title="Open ticket"
          >
            <ExternalArrow />
          </a>
        )}
      </button>
      {open && (
        <div className="review-checks">
          {checks.map(({ check, status }) => (
            <CheckRow
              key={check.id}
              ticket={ticket}
              check={check}
              status={status}
              note={latestNote(check, verdicts)}
              currentAccountId={currentAccountId}
              active={activeCheckId === check.id}
              onFocus={onFocus}
              onOpen={onOpen}
              onVerdict={onVerdict}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const VERDICT_BTNS: Array<{ kind: VerdictKind; label: string; keyHint: string }> = [
  { kind: 'pass', label: 'Pass', keyHint: 'P' },
  { kind: 'changes', label: 'Changes', keyHint: 'C' },
  { kind: 'fail', label: 'Fail', keyHint: 'F' },
];

function CheckRow({
  ticket,
  check,
  status,
  note,
  currentAccountId,
  active,
  onFocus,
  onOpen,
  onVerdict,
}: {
  ticket: ReviewTicket;
  check: ReviewCheck;
  status: string;
  note: string | null;
  currentAccountId: string | null;
  active: boolean;
  onFocus: (checkId: string) => void;
  onOpen: (check: ReviewCheck) => void;
  onVerdict: (ticket: ReviewTicket, check: ReviewCheck, kind: VerdictKind, note: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const where = check.path ?? (check.screenId ? `#${check.screenId}` : null);
  const rowRef = useRef<HTMLDivElement>(null);

  // Keep the focused check on screen as j/k / auto-advance move through.
  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div
      ref={rowRef}
      className={`review-check status-${status}${active ? ' active' : ''}`}
      onMouseEnter={() => onFocus(check.id)}
    >
      <button
        type="button"
        className="review-check-main"
        onClick={() => onOpen(check)}
        title="Open this page"
      >
        <span className={`check-mark status-${status}`}>
          {status === 'pass' ? <Check /> : status === 'fail' ? '✗' : status === 'changes' ? '~' : ''}
        </span>
        <span className="review-check-body">
          <span className="review-check-title">{check.title}</span>
          <span className="review-check-meta">
            {where && <span className="review-where">{where}</span>}
            {check.account && (
              <span className={`review-acct${check.account === currentAccountId ? ' current' : ''}`}>
                @{check.account}
              </span>
            )}
          </span>
          {check.detail && <span className="review-check-detail">{check.detail}</span>}
          {note && status !== 'awaiting' && <span className="review-check-note">“{note}”</span>}
        </span>
      </button>
      <div className="review-verdicts">
        <input
          className="review-note-input"
          data-note-for={check.id}
          placeholder="note (optional)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => onFocus(check.id)}
          spellCheck={false}
        />
        {VERDICT_BTNS.map(({ kind, label, keyHint }) => (
          <button
            key={kind}
            type="button"
            className={`verdict-btn verdict-${kind}${status === kind ? ' on' : ''}`}
            title={`${label} (${keyHint})`}
            onClick={() => {
              onVerdict(ticket, check, kind, draft.trim());
              setDraft('');
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
