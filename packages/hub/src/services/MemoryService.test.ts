import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { botHome } from '../config.js';
import { MAX_MEMORY_BYTES, MemoryService, TRIM_NOTE, capMemory } from './MemoryService.js';

/**
 * Memory rides the system prompt on every turn, so it is capped. These cover the cap itself and the
 * append path that would otherwise grow without bound.
 */

const line = (i: number) => 'note ' + i + ': ' + 'x'.repeat(80);

/** A unique id per test so the real BOTS_DIR is never shared between them. */
let n = 0;
function bot() {
  return 'memtest-' + process.pid + '-' + n++;
}

function cleanup(botId: string) {
  fs.rmSync(botHome(botId), { recursive: true, force: true });
}

describe('capMemory', () => {
  it('leaves text under the ceiling untouched', () => {
    const text = 'short and factual\n';
    expect(capMemory(text)).toEqual({ text, trimmed: false });
  });

  it('drops the oldest lines and keeps the newest under the ceiling', () => {
    const many = Array.from({ length: 400 }, (_, i) => line(i)).join('\n');
    expect(Buffer.byteLength(many, 'utf8')).toBeGreaterThan(MAX_MEMORY_BYTES);

    const out = capMemory(many);
    expect(out.trimmed).toBe(true);
    expect(Buffer.byteLength(out.text, 'utf8')).toBeLessThanOrEqual(MAX_MEMORY_BYTES);
    expect(out.text.startsWith(TRIM_NOTE)).toBe(true);
    // Newest survives, oldest does not.
    expect(out.text).toContain(line(399));
    expect(out.text).not.toContain(line(0));
  });

  it('never splits a line it keeps', () => {
    const many = Array.from({ length: 400 }, (_, i) => line(i)).join('\n');
    const kept = capMemory(many).text.split('\n').slice(1).filter(Boolean);
    for (const l of kept) expect(l).toMatch(/^note \d+: x{80}$/);
  });

  it('hard-cuts a single line longer than the whole budget', () => {
    const out = capMemory('y'.repeat(MAX_MEMORY_BYTES * 2));
    expect(out.trimmed).toBe(true);
    expect(Buffer.byteLength(out.text, 'utf8')).toBeLessThanOrEqual(MAX_MEMORY_BYTES);
  });
});

describe('MemoryService', () => {
  it('round-trips a write and reports no trim', () => {
    const id = bot();
    const mem = new MemoryService();
    try {
      expect(mem.write(id, 'hello\n')).toBe(false);
      expect(mem.read(id)).toBe('hello\n');
    } finally {
      cleanup(id);
    }
  });

  it('reads empty for a bot that never wrote', () => {
    expect(new MemoryService().read(bot())).toBe('');
  });

  it('keeps appending bounded and says when it trimmed', () => {
    const id = bot();
    const mem = new MemoryService();
    try {
      // Each append is a full read + write, so use few large chunks rather than many small ones:
      // 20 x ~1 KB comfortably overshoots the 8 KB ceiling without 300 round trips to disk.
      const chunk = (i: number) => 'entry ' + i + '\n' + Array.from({ length: 12 }, (_, j) => line(j)).join('\n');
      let everTrimmed = false;
      for (let i = 0; i < 20; i++) everTrimmed = mem.append(id, chunk(i)) || everTrimmed;

      expect(everTrimmed).toBe(true);
      expect(Buffer.byteLength(mem.read(id), 'utf8')).toBeLessThanOrEqual(MAX_MEMORY_BYTES);
      expect(mem.read(id)).toContain('entry 19');
      expect(mem.read(id)).not.toContain('entry 0\n');
    } finally {
      cleanup(id);
    }
  });

  it('patch replaces in place and leaves the rest alone', () => {
    const id = bot();
    const mem = new MemoryService();
    try {
      mem.write(id, 'alpha\nbeta\n');
      expect(mem.patch(id, 'beta', 'gamma')).toBe(true);
      expect(mem.read(id)).toBe('alpha\ngamma\n');
      expect(mem.patch(id, 'nope', 'x')).toBe(false);
    } finally {
      cleanup(id);
    }
  });
});
