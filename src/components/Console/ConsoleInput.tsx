import { useCallback, useRef, useState } from 'react';
import { useConsoleStore } from '../../lib/console/consoleStore';
import { embed, isTauri } from '../../lib/tauri';

let evalCounter = 0;

export function ConsoleInput() {
  const { state, dispatch } = useConsoleStore();
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState('');
  const [histIdx, setHistIdx] = useState<number | null>(null);

  const disabled = !isTauri();

  const submit = useCallback(() => {
    const code = draft.trim();
    if (!code) return;

    dispatch({
      type: 'append',
      entry: {
        id: '',
        level: 'log',
        subtype: 'eval-input',
        args: [],
        text: code,
        source: null,
        ts: Date.now(),
        navigationId: state.currentNavigationId,
      },
    });
    dispatch({ type: 'pushHistory', text: code });

    const evalId = `r${++evalCounter}`;
    const wrapped =
      `window.__SCREENS_CONSOLE__ && window.__SCREENS_CONSOLE__.run(` +
      JSON.stringify({ op: 'eval', code, id: evalId }) +
      `);`;
    embed.evalJs(wrapped);

    setDraft('');
    setHistIdx(null);
  }, [draft, dispatch, state.currentNavigationId]);

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'ArrowUp' && draft === '' && state.history.length) {
      e.preventDefault();
      const next = histIdx === null ? state.history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(next);
      setDraft(state.history[next]);
    } else if (e.key === 'ArrowDown' && histIdx !== null) {
      e.preventDefault();
      const next = histIdx + 1;
      if (next >= state.history.length) {
        setHistIdx(null);
        setDraft('');
      } else {
        setHistIdx(next);
        setDraft(state.history[next]);
      }
    }
  }

  return (
    <div className="console-input">
      <span className="console-input-glyph">›</span>
      <textarea
        ref={taRef}
        className="console-input-ta"
        rows={1}
        spellCheck={false}
        placeholder={disabled ? 'Evaluate requires the desktop app (npm run app:dev)' : 'Evaluate JS in the page'}
        value={draft}
        disabled={disabled}
        onChange={(e) => {
          setDraft(e.target.value);
          const ta = e.currentTarget;
          ta.style.height = 'auto';
          ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
        }}
        onKeyDown={onKey}
      />
    </div>
  );
}
