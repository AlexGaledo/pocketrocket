import { useMemo } from 'react';
import { encodeQr } from '../lib/qr';

/**
 * A QR code as one SVG path: crisp at any size, four-module quiet zone, and always black on white (also in
 * dark mode), because that is what phone cameras read most reliably.
 */
export function QrCode({ value, size = 208, label }: { value: string; size?: number; label: string }) {
  const { d, n } = useMemo(() => {
    const m = encodeQr(value);
    let path = '';
    m.forEach((row, y) => row.forEach((dark, x) => { if (dark) path += 'M' + (x + 4) + ' ' + (y + 4) + 'h1v1h-1z'; }));
    return { d: path, n: m.length + 8 };
  }, [value]);
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={'0 0 ' + n + ' ' + n} shapeRendering="crispEdges" className="rounded-md">
      <rect width={n} height={n} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
