/** The PocketRocket app mark (same drawing as the app icon). Decorative, so hidden from screen readers. */
export function RocketMark({ size = 88 }: { size?: number }) {
  return (
    <svg aria-hidden viewBox="0 0 1024 1024" width={size} height={size} className="shrink-0">
      <circle cx="512" cy="512" r="512" fill="#111214" />
      <g transform="translate(512 512) rotate(45) translate(-512 -512)" fill="#FFFFFF">
        <path d="M512 176c96 0 168 128 168 336v168H344V512c0-208 72-336 168-336z" />
        <path d="M344 560l-96 96v128l96-64zM680 560l96 96v128l-96-64z" />
        <circle cx="512" cy="452" r="58" fill="#111214" />
        <circle cx="512" cy="452" r="34" fill="#FFFFFF" />
        <path d="M440 680h144l24 56H416z" />
      </g>
      <circle cx="318" cy="742" r="46" fill="#FFFFFF" opacity="0.9" />
      <circle cx="236" cy="808" r="30" fill="#FFFFFF" opacity="0.6" />
    </svg>
  );
}
