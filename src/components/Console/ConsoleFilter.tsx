import { selectVisible, useConsoleStore } from '../../lib/console/consoleStore';
import type { FilterState } from '../../lib/console/types';

interface Props {
  onClose: () => void;
}

export function ConsoleFilter({ onClose }: Props) {
  const { state, dispatch } = useConsoleStore();
  const visible = selectVisible(state);
  const errors = state.entries.filter((e) => e.level === 'error').length;
  const warns = state.entries.filter((e) => e.level === 'warn').length;
  const infos = state.entries.filter((e) => e.level === 'info' || e.level === 'log').length;

  return (
    <div className="console-filter">
      <div className="console-filter-row">
        <input
          className="console-filter-input"
          type="text"
          placeholder="Filter (regex)"
          value={state.filter.regex}
          onChange={(e) => dispatch({ type: 'setRegex', value: e.target.value })}
          spellCheck={false}
        />
        <button
          type="button"
          className="console-icon-btn"
          title="Clear console"
          onClick={() => dispatch({ type: 'clear' })}
        >
          🗑
        </button>
        <button
          type="button"
          className="console-icon-btn"
          title="Close console"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="console-filter-row">
        <Chip label="Errors" active={state.filter.levels.errors} onClick={() => toggle('errors', state.filter, dispatch)} />
        <Chip label="Warnings" active={state.filter.levels.warnings} onClick={() => toggle('warnings', state.filter, dispatch)} />
        <Chip label="Info" active={state.filter.levels.info} onClick={() => toggle('info', state.filter, dispatch)} />
        <Chip label="Verbose" active={state.filter.levels.verbose} onClick={() => toggle('verbose', state.filter, dispatch)} />
        <span className="console-counter">
          <span className="c-err">⊘ {errors}</span>
          <span className="c-warn">⚠ {warns}</span>
          <span className="c-info">ℹ {infos}</span>
        </span>
        <label className="console-toggle" title="Preserve log on navigation">
          <input
            type="checkbox"
            checked={state.filter.preserveLog}
            onChange={(e) => dispatch({ type: 'setPreserve', value: e.target.checked })}
          />
          Preserve log
        </label>
        <span className="console-visible-count">{visible.length} shown</span>
      </div>
    </div>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`console-chip ${active ? 'on' : 'off'}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function toggle(
  key: keyof FilterState['levels'],
  filter: FilterState,
  dispatch: ReturnType<typeof useConsoleStore>['dispatch'],
) {
  dispatch({ type: 'setLevels', patch: { [key]: !filter.levels[key] } });
}
