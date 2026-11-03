import fs from 'node:fs';
import { MAX_ROUTING_BYTES } from '@pocketrocket/shared';
import { ROUTING_PATH } from '../config.js';

/** Written on first start. The comment is for the person editing the file; bots never see it. */
export const DEFAULT_ROUTING = `<!-- Your routing rules. Bots read them on every turn and can only propose edits. Keep them under 2 KB. -->
- Do the work yourself unless another bot clearly owns it.
- Move up to a stronger model for multi-step design, hard debugging, or work that is costly to get wrong.
`;

/**
 * `data/routing.md`: the owner's rules for moving work between models and bots. It is prompt data, not enforcement:
 * budgets, tools, approvals and room membership stay in code. Only the owner's REST route and a line the owner
 * approved on a card ever write it. Read per turn, so an edit applies from the next turn.
 */
export class RoutingRules {
  constructor(private file: string = ROUTING_PATH) {}

  /** Seeds the default once. Never overwrites the owner's file. */
  ensureSeeded() {
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, DEFAULT_ROUTING);
  }
  read(): string {
    try {
      return fs.readFileSync(this.file, 'utf8');
    } catch {
      return DEFAULT_ROUTING;
    }
  }
  /** What goes in the prompt: comments stripped, capped however large the file was edited to on disk. */
  promptText(): string {
    const text = this.read().replace(/<!--[\s\S]*?-->/g, '').trim();
    const raw = Buffer.from(text, 'utf8');
    if (raw.length <= MAX_ROUTING_BYTES) return text;
    return raw.subarray(0, MAX_ROUTING_BYTES).toString('utf8').replace(/\uFFFD+$/, '').trim();
  }
  write(text: string) {
    if (Buffer.byteLength(text, 'utf8') > MAX_ROUTING_BYTES) throw new Error('Routing rules are limited to ' + MAX_ROUTING_BYTES + ' bytes');
    fs.writeFileSync(this.file, text);
  }
  /** The file as it would be with `line` added. Throws when that does not fit. */
  withLine(line: string): string {
    const text = this.read().replace(/\s*$/, '') + '\n- ' + line + '\n';
    if (Buffer.byteLength(text, 'utf8') > MAX_ROUTING_BYTES) throw new Error('Routing rules are full (' + MAX_ROUTING_BYTES + ' bytes)');
    return text;
  }
}
