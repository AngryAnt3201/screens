import { useMemo, useState } from 'react';
import type {
  ReviewCheck,
  ReviewTicket,
  TicketRollup,
  Verdict,
  VerdictKind,
} from '../../types';
import { displayStatus, latestNote, rollup } from '../../lib/review';
import { CaretDown, Check, ExternalArrow } from '../icons';

interface ReviewPanelProps {
  tickets: ReviewTicket[];
  verdicts: Verdict[];
  currentAccountId: string | null;
  /** Jump the embedded browser to a check's page (+ switch account). */
  onGoToCheck: (check: ReviewCheck) => void;
  /** Record a verdict for a check. */
  onVerdict: (ticket: ReviewTicket, check: ReviewCheck, kind: VerdictKind, note: string) => void;
  /** The check currently loaded in the embedded browser, if any. */
  activeCheckId: string | null;
}

const ROLLUP_LABEL: Record<TicketRollup, string> = {
  empty: 'no checks',
  awaiting: 'to review',
  'needs-work': 'needs work',
  passed: 'all passed',
};

export function ReviewPanel({
  tickets,
  verdicts,
  currentAccountId,
  onGoToCheck,
  onVerdict,
  activeCheckId,
}: ReviewPanelProps) {
  const total = tickets.reduce((n, t) => n + (t.checks?.length ?? 0), 0);

  if (tickets.length === 0) {
    return (
      <aside className="review-panel">
        <div className="review-head">
          <span className="review-title">Review</span>
        </div>
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
      </aside>
    );
  }

  return (
    <aside className="review-panel">
      <div className="review-head">
        <span className="review-title">Review</span>
        <span className="review-count">
          {tickets.length} tickets · {total} checks
        </span>
      </div>
      <div className="review-list">
        {tickets.map((t) => (
          <TicketGroup
            key={t.id}
            ticket={t}
            verdicts={verdicts}
            currentAccountId={currentAccountId}
            onGoToCheck={onGoToCheck}
            onVerdict={onVerdict}
            activeCheckId={activeCheckId}
          />
        ))}
      </div>
    </aside>
  );
}

function TicketGroup({
  ticket,
  verdicts,
  currentAccountId,
  onGoToCheck,
  onVerdict,
  activeCheckId,
}: {
  ticket: ReviewTicket;
  verdicts: Verdict[];
  currentAccountId: string | null;
  onGoToCheck: (check: ReviewCheck) => void;
  onVerdict: (ticket: ReviewTicket, check: ReviewCheck, kind: VerdictKind, note: string) => void;
  activeCheckId: string | null;
}) {
  const roll = useMemo(() => rollup(ticket, verdicts), [ticket, verdicts]);
  const [open, setOpen] = useState(roll !== 'passed');

  return (
    <div className={`review-ticket rollup-${roll}`}>
      <button
        type="button"
        className="review-ticket-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={`caret ${open ? 'open' : ''}`}>
          <CaretDown />
        </span>
        <span className={`rollup-pill rollup-${roll}`}>{ROLLUP_LABEL[roll]}</span>
        <span className="review-ticket-id">{ticket.id}</span>
        <span className="review-ticket-title">{ticket.title}</span>
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
          {(ticket.checks ?? []).map((c) => (
            <CheckRow
              key={c.id}
              ticket={ticket}
              check={c}
              status={displayStatus(c, verdicts)}
              note={latestNote(c, verdicts)}
              currentAccountId={currentAccountId}
              onGoToCheck={onGoToCheck}
              onVerdict={onVerdict}
              active={activeCheckId === c.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const VERDICT_BTNS: Array<{ kind: VerdictKind; label: string }> = [
  { kind: 'pass', label: 'Pass' },
  { kind: 'changes', label: 'Changes' },
  { kind: 'fail', label: 'Fail' },
];

function CheckRow({
  ticket,
  check,
  status,
  note,
  currentAccountId,
  onGoToCheck,
  onVerdict,
  active,
}: {
  ticket: ReviewTicket;
  check: ReviewCheck;
  status: ReturnType<typeof displayStatus>;
  note: string | null;
  currentAccountId: string | null;
  onGoToCheck: (check: ReviewCheck) => void;
  onVerdict: (ticket: ReviewTicket, check: ReviewCheck, kind: VerdictKind, note: string) => void;
  active: boolean;
}) {
  const [draft, setDraft] = useState('');
  const where = check.path ?? (check.screenId ? `#${check.screenId}` : null);

  return (
    <div className={`review-check status-${status}${active ? ' active' : ''}`}>
      <button
        type="button"
        className="review-check-main"
        onClick={() => onGoToCheck(check)}
        title="Jump to this page"
      >
        <span className={`check-mark status-${status}`}>
          {status === 'pass' ? <Check /> : status === 'awaiting' ? '' : status === 'fail' ? '✗' : '~'}
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
          placeholder="note (optional)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
        />
        {VERDICT_BTNS.map(({ kind, label }) => (
          <button
            key={kind}
            type="button"
            className={`verdict-btn verdict-${kind}${status === kind ? ' on' : ''}`}
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
