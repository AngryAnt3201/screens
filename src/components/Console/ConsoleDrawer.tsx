import { useCallback, useEffect, useRef } from 'react';
import { ConsoleFilter } from './ConsoleFilter';
import { ConsoleLog } from './ConsoleLog';
import { ConsoleInput } from './ConsoleInput';
import { usePersistedState } from '../../hooks/usePersistedState';
import { isTauri } from '../../lib/tauri';

interface Props {
  /** Whether the drawer is open. */
  open: boolean;
  /** Called when the user clicks the × in the drawer header. */
  onClose: () => void;
}

const MIN_WIDTH = 240;
const DEFAULT_WIDTH = 380;

/**
 * Right-docked, drag-resizable drawer. When `open` is false the component
 * returns null (so the resize state is preserved by usePersistedState, not
 * by component identity).
 */
export function ConsoleDrawer({ open, onClose }: Props) {
  const [width, setWidth] = usePersistedState<number>(
    'screens:console:width',
    DEFAULT_WIDTH,
  );
  const draggingRef = useRef(false);
  const startRef = useRef<{ x: number; width: number }>({ x: 0, width: DEFAULT_WIDTH });

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      draggingRef.current = true;
      startRef.current = { x: e.clientX, width };
      (e.target as Element).setPointerCapture(e.pointerId);
    },
    [width],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      const dx = startRef.current.x - e.clientX;       // drag left → grow
      const next = clamp(startRef.current.width + dx, MIN_WIDTH, window.innerWidth * 0.8);
      setWidth(next);
    },
    [setWidth],
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    draggingRef.current = false;
    (e.target as Element).releasePointerCapture(e.pointerId);
  }, []);

  // Clamp on window resize.
  useEffect(() => {
    function clampOnResize() {
      setWidth((w) => clamp(w, MIN_WIDTH, window.innerWidth * 0.8));
    }
    window.addEventListener('resize', clampOnResize);
    return () => window.removeEventListener('resize', clampOnResize);
  }, [setWidth]);

  if (!open) return null;

  return (
    <aside className="console-drawer" style={{ width }}>
      <div
        className="console-resize-handle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title="Drag to resize"
      />
      <ConsoleFilter onClose={onClose} />
      {!isTauri() && (
        <div className="console-fallback-banner">
          Console capture requires the desktop app. Run <code>npm run app:dev</code>.
        </div>
      )}
      <ConsoleLog />
      <ConsoleInput />
    </aside>
  );
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
