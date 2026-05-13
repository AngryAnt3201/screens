import type { Account, Screen } from '../types';
import { Camera, Close, ExternalArrow } from './icons';
import { formatRelative } from '../lib/time';
import { useMinuteClock } from '../hooks/useMinuteClock';

interface InspectorProps {
  screen: Screen | undefined;
  account: Account | null;
  onNavigate: (s: Screen) => void;
  onClose: () => void;
  onCapture: () => void;
}

export function Inspector({
  screen,
  account,
  onNavigate,
  onClose,
  onCapture,
}: InspectorProps) {
  useMinuteClock();
  if (!screen) return null;
  return (
    <div className="inspector">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <div style={{ flex: 1 }}>
          <h4>{screen.title}</h4>
          <div className="insp-url">{screen.path}</div>
        </div>
        <button className="icon-btn" onClick={onClose} type="button" title="Close">
          <Close />
        </button>
      </div>
      <div className="row">
        <span className="k">group</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>{screen.group}</span>
      </div>
      <div className="row">
        <span className="k">status</span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            textTransform: 'capitalize',
          }}
        >
          {screen.status ?? 'unknown'}
        </span>
      </div>
      <div className="row">
        <span className="k">last visit</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>
          {formatRelative(screen.visitedAt)}
        </span>
      </div>
      <div className="row">
        <span className="k">session</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>
          {account ? account.email : 'signed out'}
        </span>
      </div>
      <div className="actions">
        <button type="button" onClick={onCapture}>
          <Camera />
          Capture
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => onNavigate(screen)}
        >
          Open
          <ExternalArrow />
        </button>
      </div>
    </div>
  );
}
