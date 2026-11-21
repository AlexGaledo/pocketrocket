/** The Toki app mark (same drawing as the app icon). Decorative, so hidden from screen readers. */
export function TokiMark({ size = 88 }: { size?: number }) {
  return (
    <svg aria-hidden viewBox="0 0 100 100" width={size} height={size} className="shrink-0">
      <circle cx="50" cy="50" r="50" fill="#3a2d23" />
      <g fill="#FFFFFF">
        <path d="M30 88C30 66 36 52 50 52C64 52 70 66 70 88Z" />
        <circle cx="50" cy="40" r="16" />
        <path d="M36 33L37 16L47 26Z" />
        <path d="M64 33L63 16L53 26Z" />
      </g>
      <path d="M68 84C82 84 84 72 76 64" fill="none" stroke="#FFFFFF" strokeWidth="6" strokeLinecap="round" />
      <ellipse cx="44" cy="41" rx="2.4" ry="3" fill="#3a2d23" />
      <ellipse cx="56" cy="41" rx="2.4" ry="3" fill="#3a2d23" />
    </svg>
  );
}
