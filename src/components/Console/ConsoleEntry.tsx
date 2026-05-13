import { useState } from 'react';
import { InspectValue } from '../../lib/console/inspectValue';
import type { LogEntry } from '../../lib/console/types';

interface Props {
  entry: LogEntry;
}

/**
 * Renders one entry. Visual treatment mirrors Chrome:
 *  - level icon left
 *  - args inline, separated by ' '
 *  - source link right-aligned in muted text
 *  - stack trace (errors only) collapsed below, expandable
 */
export function ConsoleEntry({ entry }: Props) {
  const [stackOpen, setStackOpen] = useState(entry.level === 'error');
  const icon = ICONS[entry.level];

  return (
    <div className={`console-entry level-${entry.level} subtype-${entry.subtype ?? 'none'}`}>
      <span className="console-gutter" aria-hidden="true">{icon}</span>
      <div className="console-body">
        <div className="console-args">
          {entry.subtype === 'eval-input' ? (
            <span className="console-eval-input">› {entry.text}</span>
          ) : entry.subtype === 'eval-result' ? (
            <>
              <span className="console-eval-marker">←</span>
              {entry.args.map((p, i) => (
                <span key={i} className="console-arg">
                  <InspectValue preview={p} />
                </span>
              ))}
            </>
          ) : (
            entry.args.map((p, i) => (
              <span key={i} className="console-arg">
                <InspectValue preview={p} />
              </span>
            ))
          )}
        </div>
        {entry.stack && (
          <button
            type="button"
            className={`console-stack-toggle ${stackOpen ? 'open' : ''}`}
            onClick={() => setStackOpen((v) => !v)}
          >
            {stackOpen ? '▾' : '▸'} stack
          </button>
        )}
        {entry.stack && stackOpen && (
          <pre className="console-stack">{entry.stack}</pre>
        )}
      </div>
      {entry.source && <span className="console-source">{entry.source}</span>}
    </div>
  );
}

const ICONS: Record<LogEntry['level'], string> = {
  log: ' ',
  info: 'ℹ',
  warn: '⚠',
  error: '⊘',
  debug: '·',
  trace: '⤷',
};
