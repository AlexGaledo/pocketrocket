import { nanoid } from 'nanoid';
import type { VoiceProposal } from '@pocketrocket/shared';
import type { Repos } from '../db/repos.js';
import { events } from '../events.js';
import type { MemoryService } from './MemoryService.js';

/** Pending proposals kept per bot; older ones drop off when AutoMemory adds more. */
export const MAX_PENDING_VOICE = 10;

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * P7 (7.2): style notes for a bot's voice.md that AutoMemory *proposes*. Nothing reaches voice.md until the
 * user approves it in the Memory tab, because voice.md rides every prompt: an auto-applied note would be a
 * standing instruction nobody agreed to.
 */
export class VoiceProposals {
  constructor(private repos: Repos, private memory: MemoryService) {}

  list(botId: string): VoiceProposal[] {
    return this.repos.db
      .all<{ id: string; bot_id: string; text: string; created_at: number }>(
        'SELECT * FROM voice_proposals WHERE bot_id=? ORDER BY created_at, rowid', botId,
      )
      .map((r) => ({ id: r.id, botId: r.bot_id, text: r.text, createdAt: r.created_at }));
  }

  /** Stores the notes that are not already in voice.md or pending. Returns how many were added. */
  propose(botId: string, notes: string[]): number {
    const seen = new Set([
      ...this.memory.readVoice(botId).split('\n').map((l) => normalize(l.replace(/^[\s\-*]+/, ''))),
      ...this.list(botId).map((p) => normalize(p.text)),
    ]);
    let added = 0;
    for (const n of notes) {
      const text = n.replace(/\s+/g, ' ').trim().slice(0, 200);
      const key = normalize(text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      this.repos.db.run('INSERT INTO voice_proposals (id, bot_id, text, created_at) VALUES (?, ?, ?, ?)', nanoid(10), botId, text, Date.now());
      added++;
    }
    const all = this.list(botId);
    for (const p of all.slice(0, Math.max(0, all.length - MAX_PENDING_VOICE))) this.repos.db.run('DELETE FROM voice_proposals WHERE id=?', p.id);
    if (added) events.emitEvent({ type: 'voice.updated', botId });
    return added;
  }

  /** Approve: append the note to voice.md as a bullet. Dismiss: drop it. Returns false for an unknown id. */
  decide(botId: string, id: string, decision: 'approve' | 'dismiss'): boolean {
    const p = this.list(botId).find((x) => x.id === id);
    if (!p) return false;
    this.repos.db.run('DELETE FROM voice_proposals WHERE id=?', id);
    if (decision === 'approve') {
      const cur = this.memory.readVoice(botId).replace(/\s+$/, '');
      this.memory.writeVoice(botId, (cur ? cur + '\n' : '') + '- ' + p.text + '\n');
    } else {
      events.emitEvent({ type: 'voice.updated', botId });
    }
    return true;
  }

  removeForBot(botId: string) {
    this.repos.db.run('DELETE FROM voice_proposals WHERE bot_id=?', botId);
  }
}
