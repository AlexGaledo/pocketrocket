import type { BotCharacterKey } from '@pocketrocket/shared';

/** A soft outline with `lobes` bumps, drawn from a circle whose radius wobbles. `depth` is how far each bump reaches. */
function lobed(lobes: number, depth: number, spin = 0): string {
  const points = Array.from({ length: 120 }, (_, i) => {
    const t = (i / 120) * Math.PI * 2;
    const r = 40 + depth * Math.cos(lobes * (t + spin));
    return (50 + r * Math.cos(t)).toFixed(1) + ' ' + (50 + r * Math.sin(t)).toFixed(1);
  });
  return 'M' + points.join('L') + 'Z';
}

const DROP = 'M50 5C66 27 90 45 90 65C90 84 72 95 50 95C28 95 10 84 10 65C10 45 34 27 50 5Z';
const CLOUD = 'M30 82C14 82 5 71 5 59C5 47 14 38 26 38C30 24 42 16 55 18C68 20 77 30 78 41C88 43 95 52 95 63C95 74 85 82 74 82Z';

/** Fills stay the same in both themes: each is a character's colour, and the dark eyes read on all of them. */
const CHARACTERS: Record<BotCharacterKey, { label: string; path: string; fill: string; eyeY?: number; tilt?: number }> = {
  'blob-ember': { label: 'Ember', path: DROP, fill: '#f0445a', eyeY: 58, tilt: 22 },
  'blob-bloom': { label: 'Bloom', path: lobed(6, 7), fill: '#a78bfa' },
  'blob-cloud': { label: 'Cloud', path: CLOUD, fill: '#f5f2ea', eyeY: 54 },
  'blob-pebble': { label: 'Pebble', path: lobed(6, 2.5), fill: '#cdd3da' },
  'blob-clover': { label: 'Clover', path: lobed(4, 7), fill: '#34d399' },
  'blob-star': { label: 'Star', path: lobed(5, 10, Math.PI / 10), fill: '#fbbf24', eyeY: 48 },
  'blob-bean': { label: 'Bean', path: lobed(2, 6, Math.PI / 4), fill: '#fdba8c' },
  'blob-drop': { label: 'Drop', path: DROP, fill: '#38bdf8', eyeY: 58 },
  'blob-gem': { label: 'Gem', path: lobed(3, 5, Math.PI / 2), fill: '#f472b6' },
  'blob-spike': { label: 'Spike', path: lobed(8, 9), fill: '#e11d48', tilt: 22 },
};

export const characterLabel = (key: BotCharacterKey) => CHARACTERS[key].label;

/** A little creature for a bot: a coloured shape with two eyes. Decorative: the caller names the bot. */
export function BotCharacter({ character, size }: { character: BotCharacterKey; size: number }) {
  const { path, fill, eyeY = 46, tilt = 8 } = CHARACTERS[character];
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 100 100" className="block">
      <path d={path} fill={fill} stroke="rgb(0 0 0 / 0.08)" strokeWidth="1" />
      <ellipse cx="40" cy={eyeY} rx="3.8" ry="7" fill="#17171c" transform={'rotate(' + -tilt + ' 40 ' + eyeY + ')'} />
      <ellipse cx="60" cy={eyeY} rx="3.8" ry="7" fill="#17171c" transform={'rotate(' + tilt + ' 60 ' + eyeY + ')'} />
    </svg>
  );
}
