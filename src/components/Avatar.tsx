interface AvatarProps {
  /** OKLCH hue (0-360). */
  color: number;
  name: string;
  size?: number;
}

export function Avatar({ color, name, size = 20 }: AvatarProps) {
  const init = name
    .split(' ')
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('');
  return (
    <div
      className="avatar"
      style={{
        background: `oklch(0.62 0.13 ${color})`,
        width: size,
        height: size,
        fontSize: Math.max(8, Math.floor(size * 0.42)),
      }}
    >
      {init}
    </div>
  );
}
