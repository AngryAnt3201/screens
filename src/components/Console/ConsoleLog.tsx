import { useEffect, useRef } from 'react';
import { ConsoleEntry } from './ConsoleEntry';
import { selectVisible, useConsoleStore } from '../../lib/console/consoleStore';

export function ConsoleLog() {
  const { state } = useConsoleStore();
  const visible = selectVisible(state);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - (el.scrollTop + el.clientHeight);
    stickToBottom.current = dist < 8;
  }

  useEffect(() => {
    if (!stickToBottom.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  return (
    <div className="console-log" ref={scrollRef} onScroll={onScroll}>
      {state.droppedSinceClear > 0 && (
        <div className="console-dropped">
          Older entries dropped ({state.droppedSinceClear} total since last clear)
        </div>
      )}
      {visible.length === 0 ? (
        <div className="console-empty">No console entries yet.</div>
      ) : (
        visible.map((entry) => <ConsoleEntry key={entry.id} entry={entry} />)
      )}
    </div>
  );
}
