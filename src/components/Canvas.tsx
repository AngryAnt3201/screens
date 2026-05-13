import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  type Node,
  type Edge as RFEdge,
  type NodeTypes,
  useReactFlow,
  Position,
} from '@xyflow/react';
import type { Edge, Group, Screen } from '../types';
import { NodeCard, type ScreenNodeData } from './NodeCard';
import { GroupFrame, type GroupFrameData } from './GroupFrame';
import { Fit, Minus, Plus } from './icons';
import { useStore } from '../lib/screensStore';

interface CanvasProps {
  groups: Group[];
  screens: Screen[];
  edges: Edge[];
  currentScreenId: string | null;
  selectedScreenId: string | null;
  onSelect: (id: string | null) => void;
  onNavigate: (s: Screen) => void;
}

// Card dimensions — must stay in sync with `.node` in styles.css.
const NODE_W = 240;
const NODE_H = 192;
// Padding around the group bbox so the frame sits *around* the cards.
const GROUP_PAD = 16;

const nodeTypes: NodeTypes = {
  screen: NodeCard,
  groupFrame: GroupFrame,
};

function CanvasInner({
  groups,
  screens,
  edges,
  currentScreenId,
  selectedScreenId,
  onSelect,
  onNavigate,
}: CanvasProps) {
  const rf = useReactFlow();
  const [zoom, setZoom] = useState(1);
  const { current, writeScreens } = useStore();
  const projectSlug = current?.project.slug ?? 'demo';

  // Persist screen positions when a card is dropped. We work from the
  // store's `current.screens` rather than the prop so two captures racing
  // a drag don't clobber each other (the prop is one render behind the
  // last write).
  const handleNodeDragStop = useCallback(
    (_e: unknown, node: Node) => {
      if (node.type !== 'screen') return;
      if (!current) return;
      const slug = current.project.slug;
      const nx = Math.round(node.position.x);
      const ny = Math.round(node.position.y);
      const existing = current.screens.screens.find((s) => s.id === node.id);
      if (!existing) return;
      if (existing.x === nx && existing.y === ny) return; // no-op micro-drags
      const next = {
        ...current.screens,
        screens: current.screens.screens.map((s) =>
          s.id === node.id ? { ...s, x: nx, y: ny } : s,
        ),
      };
      void writeScreens(slug, next);
    },
    [current, writeScreens],
  );

  const screenById = useMemo(
    () => Object.fromEntries(screens.map((s) => [s.id, s])),
    [screens],
  );

  // Edges incident to the selected screen — used to fade/highlight.
  const incident = useMemo(() => {
    if (!selectedScreenId) return null;
    return new Set(
      edges
        .filter(([a, b]) => a === selectedScreenId || b === selectedScreenId)
        .map(([a, b]) => `${a}→${b}`),
    );
  }, [edges, selectedScreenId]);

  const rfNodes = useMemo<Node[]>(() => {
    const groupNodes: Node[] = groups.map((g) => ({
      id: `group:${g.id}`,
      type: 'groupFrame',
      position: { x: g.x - GROUP_PAD, y: g.y - GROUP_PAD },
      style: { width: g.w + GROUP_PAD * 2, height: g.h + GROUP_PAD * 2 },
      data: {
        label: g.label,
        color: `var(--c-${g.id}, var(--c-default))`,
      } satisfies GroupFrameData,
      draggable: false,
      selectable: false,
      focusable: false,
      // Sit underneath the screen cards.
      zIndex: -1,
    }));

    const screenNodes: Node[] = screens.map((s) => ({
      id: s.id,
      type: 'screen',
      position: { x: s.x, y: s.y },
      data: {
        screen: s,
        projectSlug,
        current: currentScreenId === s.id,
      } satisfies ScreenNodeData,
      selected: selectedScreenId === s.id,
      // Default handles are top/bottom — but we route from the side that
      // points toward the target. React Flow picks the closest handle.
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      // Card has its own border radius / shadow; no react-flow chrome.
      style: { background: 'transparent' },
      // Cards are draggable so the user can rearrange the map.
      draggable: true,
    }));

    return [...groupNodes, ...screenNodes];
  }, [groups, screens, currentScreenId, selectedScreenId, projectSlug]);

  const rfEdges = useMemo<RFEdge[]>(
    () =>
      edges
        .filter(([a, b]) => screenById[a] && screenById[b])
        .map(([a, b]) => {
          const key = `${a}→${b}`;
          const highlighted = incident?.has(key) ?? false;
          const dimmed = incident !== null && !highlighted;
          return {
            id: key,
            source: a,
            target: b,
            type: 'bezier',
            // No arrow marker — the prototype uses a dot instead, which we
            // emulate by tightening the stroke. (markerEnd left empty.)
            className:
              (highlighted ? 'highlighted' : '') +
              (dimmed ? ' dimmed' : ''),
          };
        }),
    [edges, screenById, incident],
  );

  // Re-fit on mount and whenever the screen set changes substantially.
  const hasFittedRef = useRef(false);
  useEffect(() => {
    if (hasFittedRef.current) return;
    hasFittedRef.current = true;
    // Defer to next frame so the container has size.
    const t = requestAnimationFrame(() => {
      rf.fitView({ padding: 0.08, minZoom: 0.4, maxZoom: 0.85 });
    });
    return () => cancelAnimationFrame(t);
  }, [rf]);

  // Track zoom for the readout pill.
  useEffect(() => {
    const unsub = rf.getViewport
      ? // react-flow doesn't expose a subscription helper, so poll via the
        // onMove handler below. This effect just sets the initial value.
        (setZoom(rf.getViewport().zoom), () => {})
      : () => {};
    return unsub;
  }, [rf]);

  return (
    <div className="canvas">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        elementsSelectable={true}
        zoomOnDoubleClick={false}
        panOnDrag
        panOnScroll={false}
        selectionOnDrag={false}
        deleteKeyCode={null}
        minZoom={0.25}
        maxZoom={2}
        onMove={(_, viewport) => setZoom(viewport.zoom)}
        onNodeClick={(_, node) => {
          if (node.type === 'screen') onSelect(node.id);
        }}
        onNodeDoubleClick={(_, node) => {
          if (node.type === 'screen') {
            const s = screenById[node.id];
            if (s) onNavigate(s);
          }
        }}
        onNodeDragStop={handleNodeDragStop}
        onPaneClick={() => onSelect(null)}
        // We control selection via data prop — disable RF's multi-select drag.
        multiSelectionKeyCode={null}
        // Edge defaults
        defaultEdgeOptions={{
          type: 'bezier',
          interactionWidth: 0,
        }}
      >
        {/* Background is drawn via CSS on `.canvas .react-flow` for fidelity. */}
      </ReactFlow>

      <div className="zoom-readout">{Math.round(zoom * 100)}%</div>

      <div className="canvas-controls">
        <button
          title="Zoom in"
          type="button"
          onClick={() => rf.zoomTo(Math.min(2, zoom * 1.2))}
        >
          <Plus />
        </button>
        <button
          title="Zoom out"
          type="button"
          onClick={() => rf.zoomTo(Math.max(0.25, zoom * 0.8))}
        >
          <Minus />
        </button>
        <button
          title="Fit"
          type="button"
          onClick={() =>
            rf.fitView({ padding: 0.08, minZoom: 0.4, maxZoom: 0.85 })
          }
        >
          <Fit />
        </button>
      </div>
    </div>
  );
}

export function Canvas(props: CanvasProps) {
  // ReactFlowProvider gives access to `useReactFlow` for our overlay controls.
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

// Keep these alongside the component to make the layout assumptions explicit.
export const NODE_DIMENSIONS = { w: NODE_W, h: NODE_H };
