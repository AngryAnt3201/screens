import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';

export interface GroupFrameData extends Record<string, unknown> {
  label: string;
  color: string;
}

/**
 * Non-interactive dashed frame behind a cluster of screens. React Flow lets us
 * stack this under the regular nodes by giving it `zIndex: -1`.
 */
function GroupFrameImpl({ data }: NodeProps) {
  const { label, color } = data as GroupFrameData;
  return (
    <div className="group-frame">
      <span className="label">
        <span className="swatch" style={{ background: color }} />
        {label}
      </span>
    </div>
  );
}

export const GroupFrame = memo(GroupFrameImpl);
