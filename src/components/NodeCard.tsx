import { memo, useEffect, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { Screen } from '../types';
import { fetchScreenshotUrl } from '../lib/screensStore';

export interface ScreenNodeData extends Record<string, unknown> {
  screen: Screen;
  /** Current project slug — used to resolve the screenshot file. */
  projectSlug: string;
  selected?: boolean;
  current?: boolean;
}

/**
 * Card with browser-window chrome + screenshot, matching the prototype.
 * Resolves the screenshot URL asynchronously since under Tauri it has to
 * call a Rust command (`store_screenshot_url`) — in the browser fallback
 * the URL is computed synchronously.
 */
function NodeCardImpl({ data, selected: rfSelected }: NodeProps) {
  const { screen, current, projectSlug } = data as ScreenNodeData;
  const isSelected = rfSelected || (data as ScreenNodeData).selected;

  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    if (screen.status === 'missing') {
      setImgUrl(null);
      return;
    }
    let cancelled = false;
    fetchScreenshotUrl(projectSlug, screen.id).then((url) => {
      if (!cancelled) {
        setImgUrl(url);
        setImgError(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectSlug, screen.id, screen.status]);

  const hasShot = !!imgUrl && !imgError;

  return (
    <div
      className={
        'node' +
        (isSelected ? ' selected' : '') +
        (current ? ' current' : '')
      }
    >
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <Handle type="target" position={Position.Top} id="t" />
      <Handle type="source" position={Position.Bottom} id="b" />

      <div className="node-chrome">
        <div className="tl-dots">
          <span />
          <span />
          <span />
        </div>
        <div className="node-url">{screen.path}</div>
      </div>
      <div className="node-shot">
        {hasShot ? (
          <img
            src={imgUrl!}
            alt={`${screen.title} screenshot`}
            onError={() => setImgError(true)}
            draggable={false}
          />
        ) : (
          <div className="empty">no capture</div>
        )}
      </div>
      <div className="node-meta">
        <span
          className="node-pill"
          style={{ background: `var(--c-${screen.group}, var(--c-default))` }}
        >
          {screen.group}
        </span>
        <span className="node-title">{screen.title}</span>
        <span className="node-stale">{screen.visitedAt || '—'}</span>
      </div>
    </div>
  );
}

export const NodeCard = memo(NodeCardImpl);
