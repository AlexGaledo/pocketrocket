import {
  Anchor, Atom, Bot, Brain, Compass, Cpu, Database, Feather, Globe, Hammer, Hexagon, Map as MapIcon, Orbit, Palette, Pen, Radar, Rocket, Search,
  Shield, Smile, Sparkles, Terminal, Wrench, type LucideIcon,
} from 'lucide-react';
import { isBotIconKey, type BotIconKey } from '@pocketrocket/shared';

const ICONS: Record<BotIconKey, LucideIcon> = {
  bot: Bot, cpu: Cpu, compass: Compass, wrench: Wrench, pen: Pen, smile: Smile, brain: Brain, shield: Shield, radar: Radar, anchor: Anchor,
  atom: Atom, feather: Feather, hammer: Hammer, map: MapIcon, orbit: Orbit, hexagon: Hexagon,
  search: Search, terminal: Terminal, globe: Globe, sparkles: Sparkles, palette: Palette, rocket: Rocket, database: Database,
};

/** Picked from for a bot with no icon. Leaves out glyphs that already mean something else here: tool chips, Settings, the brand. */
const DERIVED: readonly BotIconKey[] = ['bot', 'cpu', 'compass', 'wrench', 'pen', 'smile', 'brain', 'shield', 'radar', 'anchor', 'atom', 'feather', 'hammer', 'map', 'orbit', 'hexagon'];
const TINTS = 8; // --tint-1 to --tint-8 in index.css

function fnv1a(s: string) {
  let h = 0x811c9dc5;
  for (const c of s) { h ^= c.codePointAt(0)!; h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Any value that is not a key falls through to the default glyph, so an emoji still in the data never renders. */
export const iconGlyph = (key: unknown): LucideIcon => (isBotIconKey(key) ? ICONS[key] : Bot);

/** The same bot always gets the same glyph and tint, whatever it is renamed to. */
export function botIcon(bot: { id: string; avatar: string }) {
  const h = fnv1a(bot.id);
  return {
    Glyph: ICONS[isBotIconKey(bot.avatar) ? bot.avatar : DERIVED[h % DERIVED.length]],
    tint: 'var(--tint-' + (((h >>> 16) % TINTS) + 1) + ')',
  };
}
