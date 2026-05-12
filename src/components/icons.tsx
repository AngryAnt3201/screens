/**
 * Inline SVG icons matching the prototype. Keeping them inline (vs. an icon
 * library) preserves the exact stroke widths and proportions the design uses.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const base = (size: number): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
});

export const CaretDown = ({ size = 10, ...p }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 10 10"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.2}
    strokeLinecap="round"
    {...p}
  >
    <path d="M2 4l3 3 3-3" />
  </svg>
);

export const Search = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <circle cx="7" cy="7" r="4" />
    <path d="M10 10l3 3" />
  </svg>
);

export const Settings = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 2v2M8 12v2M2 8h2M12 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4" />
  </svg>
);

export const Camera = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <rect x="2" y="4" width="12" height="9" rx="1.5" />
    <circle cx="8" cy="8.5" r="2.4" />
    <path d="M6 4l1-1.4h2L10 4" />
  </svg>
);

export const Lock = ({ size = 10, ...p }: IconProps) => (
  <svg {...base(size)} {...p} viewBox="0 0 12 12">
    <rect x="2" y="5" width="8" height="6" rx="1" />
    <path d="M4 5V3a2 2 0 1 1 4 0v2" />
  </svg>
);

export const Back = ({ size = 12, ...p }: IconProps) => (
  <svg {...base(size)} {...p} viewBox="0 0 12 12">
    <path d="M7.5 2.5L4 6l3.5 3.5" />
  </svg>
);

export const Forward = ({ size = 12, ...p }: IconProps) => (
  <svg {...base(size)} {...p} viewBox="0 0 12 12">
    <path d="M4.5 2.5L8 6l-3.5 3.5" />
  </svg>
);

export const Reload = ({ size = 12, ...p }: IconProps) => (
  <svg {...base(size)} {...p} viewBox="0 0 12 12">
    <path d="M2 6a4 4 0 1 1 1.2 2.8M2 3v3h3" />
  </svg>
);

export const ExternalArrow = ({ size = 12, ...p }: IconProps) => (
  <svg {...base(size)} {...p} viewBox="0 0 12 12">
    <path d="M3 9L9 3M5 3h4v4" />
  </svg>
);

export const Close = ({ size = 12, ...p }: IconProps) => (
  <svg {...base(size)} {...p} viewBox="0 0 12 12">
    <path d="M3 3l6 6M9 3l-6 6" />
  </svg>
);

export const Check = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M3 8.5l3 3 7-7" strokeWidth={1.6} />
  </svg>
);

export const Plus = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M8 3v10M3 8h10" />
  </svg>
);

export const Minus = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M3 8h10" />
  </svg>
);

export const Fit = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" />
  </svg>
);

export const Globe = ({ size = 10, ...p }: IconProps) => (
  <svg {...base(size)} {...p} viewBox="0 0 12 12" strokeWidth={1.2}>
    <rect x="2" y="5" width="8" height="6" rx="1" />
    <path d="M4 5V3a2 2 0 1 1 4 0v2" />
  </svg>
);

export const Chevron = ({ size = 10, ...p }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 10 10"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...p}
  >
    <path d="M2.5 4l2.5 2.5L7.5 4" />
  </svg>
);

export const Sun = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <circle cx="8" cy="8" r="2.6" />
    <path d="M8 2v1.6M8 12.4V14M2 8h1.6M12.4 8H14M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
  </svg>
);

export const Moon = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <path d="M12.4 9.4A5 5 0 1 1 6.6 3.6a4 4 0 0 0 5.8 5.8z" />
  </svg>
);

export const Monitor = ({ size = 14, ...p }: IconProps) => (
  <svg {...base(size)} {...p}>
    <rect x="2" y="3" width="12" height="8.5" rx="1.4" />
    <path d="M5.5 14h5M8 11.5V14" />
  </svg>
);
