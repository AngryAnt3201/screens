import type { ViewMode } from '../types';
import { ProjectSwitcher } from './ProjectSwitcher';
import { ThemeToggle } from './ThemeToggle';

interface TopBarProps {
  baseUrl: string;
  setBaseUrl: (s: string) => void;
  view: ViewMode;
  setView: (v: ViewMode) => void;
  agentConnected: boolean;
}

const TABS: Array<[ViewMode, string]> = [
  ['map', 'Map'],
  ['split', 'Split'],
  ['app', 'App'],
];

export function TopBar({
  baseUrl,
  setBaseUrl,
  view,
  setView,
  agentConnected,
}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">N</div>
        Screens
      </div>
      <div className="divider-v" />
      <ProjectSwitcher />
      <div className="url-bar" title="base URL for the embedded browser">
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          spellCheck={false}
          aria-label="Base URL"
        />
        <span style={{ color: 'var(--text-4)', fontSize: 11 }}>base</span>
      </div>
      <div className="view-tabs" role="tablist" aria-label="View">
        {TABS.map(([k, l]) => (
          <button
            key={k}
            type="button"
            className={view === k ? 'active' : ''}
            onClick={() => setView(k)}
            role="tab"
            aria-selected={view === k}
          >
            {l}
          </button>
        ))}
      </div>
      <div className="topbar-right">
        <div className={'agent-status' + (agentConnected ? '' : ' offline')}>
          <span className="pulse" />
          {agentConnected ? 'agent · live' : 'agent · idle'}
        </div>
        <ThemeToggle />
      </div>
    </header>
  );
}
