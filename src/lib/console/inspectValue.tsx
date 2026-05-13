import { useState } from 'react';
import type { Preview } from './types';

interface Props {
  preview: Preview;
  /** Called when the user clicks an "expand" chevron on a collapsed value. */
  onExpand?: (path: string) => void;
  /** Visual depth (for indentation of nested objects/arrays). */
  depth?: number;
}

/**
 * Recursive renderer for a serialised value. Mirrors Chrome DevTools' inline
 * preview style: `Array(3) [1, 2, 3]`, `Object {key: "v", …}`, etc.
 *
 * Children of objects/arrays render inline up to the cap the inject script
 * already applied. The `collapsed` Preview kind signals there's more data
 * fetchable via `onExpand(path)`.
 */
export function InspectValue({ preview, onExpand, depth = 0 }: Props) {
  switch (preview.kind) {
    case 'primitive':
      return <Primitive preview={preview} />;
    case 'array':
      return (
        <ArrayPreview preview={preview} onExpand={onExpand} depth={depth} />
      );
    case 'object':
      return (
        <ObjectPreview preview={preview} onExpand={onExpand} depth={depth} />
      );
    case 'element':
      return <ElementPreview preview={preview} />;
    case 'collapsed':
      return (
        <span className="console-collapsed">
          <button
            type="button"
            className="console-chevron"
            aria-label="Expand"
            onClick={() => onExpand?.(preview.path)}
          >
            ▶
          </button>
          <span className="console-ctor">{preview.ctor}</span>
        </span>
      );
    case 'cyclic':
      return <span className="console-cyclic">[Circular &lt;{preview.path}&gt;]</span>;
  }
}

function Primitive({ preview }: { preview: Extract<Preview, { kind: 'primitive' }> }) {
  const display =
    preview.type === 'string' ? `"${preview.value}"` :
    preview.type === 'symbol' ? preview.value :
    preview.type === 'function' ? `ƒ ${preview.value}` :
    preview.value;
  return (
    <span className={`console-primitive console-p-${preview.type}`} data-type={preview.type}>
      {display}
    </span>
  );
}

function ArrayPreview({
  preview,
  onExpand,
  depth,
}: {
  preview: Extract<Preview, { kind: 'array' }>;
  onExpand?: (p: string) => void;
  depth: number;
}) {
  const [open, setOpen] = useState(depth === 0);
  return (
    <span className="console-array">
      <button
        type="button"
        className={`console-chevron ${open ? 'open' : ''}`}
        aria-label={open ? 'Collapse' : 'Expand'}
        onClick={() => setOpen((v) => !v)}
      >
        ▶
      </button>
      <span className="console-ctor">{preview.ctor}</span>
      <span className="console-bracket">[</span>
      {preview.items.map((item, i) => (
        <span key={i}>
          {i > 0 && <span className="console-sep">, </span>}
          <InspectValue preview={item} onExpand={onExpand} depth={depth + 1} />
        </span>
      ))}
      {preview.truncated ? (
        <span className="console-truncated">, … {preview.truncated} more</span>
      ) : null}
      <span className="console-bracket">]</span>
    </span>
  );
}

function ObjectPreview({
  preview,
  onExpand,
  depth,
}: {
  preview: Extract<Preview, { kind: 'object' }>;
  onExpand?: (p: string) => void;
  depth: number;
}) {
  const [open, setOpen] = useState(depth === 0);
  return (
    <span className="console-object">
      <button
        type="button"
        className={`console-chevron ${open ? 'open' : ''}`}
        aria-label={open ? 'Collapse' : 'Expand'}
        onClick={() => setOpen((v) => !v)}
      >
        ▶
      </button>
      <span className="console-ctor">{preview.ctor}</span>
      <span className="console-bracket">{' { '}</span>
      {preview.entries.map(([k, v], i) => (
        <span key={k}>
          {i > 0 && <span className="console-sep">, </span>}
          <span className="console-key">{k}</span>
          <span className="console-sep">: </span>
          <InspectValue preview={v} onExpand={onExpand} depth={depth + 1} />
        </span>
      ))}
      {preview.truncated ? (
        <span className="console-truncated">, … {preview.truncated} more</span>
      ) : null}
      <span className="console-bracket">{' }'}</span>
    </span>
  );
}

function ElementPreview({
  preview,
}: {
  preview: Extract<Preview, { kind: 'element' }>;
}) {
  return (
    <span className="console-element">
      <span className="console-bracket">&lt;</span>
      <span className="console-tag">{preview.tag}</span>
      {preview.attrs.map(([k, v]) => (
        <span key={k}>
          {' '}
          <span className="console-attr-name">{k}</span>
          <span className="console-sep">=</span>
          <span className="console-attr-val">"{v}"</span>
        </span>
      ))}
      <span className="console-bracket">&gt;</span>
      {preview.truncated ? (
        <span className="console-truncated"> …</span>
      ) : null}
    </span>
  );
}
