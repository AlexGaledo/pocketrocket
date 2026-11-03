// P2 (docs/specs/grok-bot-parity.md §2.2): `request_takeover`, the bot's way to hand its own computer to the
// user for something only a person should do (log in, pass a captcha, confirm a payment page).
import { z } from 'zod';
import type { Bot, Room, TakeoverPayload } from '@pocketrocket/shared';
import type { Repos } from '../db/repos.js';
import { events } from '../events.js';
import { settings } from '../services/SettingsStore.js';
import type { ComputerControlService } from '../services/ComputerControl.js';
import type { HubTool } from '../providers/types.js';
import { err, hubTool, text } from './botTools.js';

export interface TakeoverToolCtx {
  bot: Bot;
  room: Room;
  turnId: string;
  hop: number;
  causeId: string;
  runId?: string;
  repos: Repos;
  control: ComputerControlService;
  signal: AbortSignal;
  setState: (s: 'waiting' | 'working') => void;
  /** Ends this turn; the bot is resumed (with the hand-back note) by a new turn later. */
  park: (why: string) => void;
}

export const TAKEOVER_PARKED =
  'The user has not handed your computer back yet. Your turn ends now: say nothing more and do not retry. ' +
  'When they hand it back you get a new turn with their note.';

export function takeoverTool(ctx: TakeoverToolCtx): HubTool {
  const userName = settings.get().userName;
  return hubTool(
    'request_takeover',
    'Hand your computer to ' + userName + ' for something only a person should do (log in, pass a captcha, ' +
      'approve a payment page, a 2FA prompt). Posts a card in the room, gives them control of your screen and ' +
      'waits until they hand it back; returns their note. Your browser and desktop tools do not act meanwhile. ' +
      'Say exactly what they need to do, e.g. "Log in to example.com as the shop account".',
    { reason: z.string().min(3).max(300).describe('What the user needs to do on your screen') },
    async (a) => {
      const cur = ctx.control.get(ctx.bot.id);
      if (cur.control === 'paused') return err('You are paused by ' + userName + '; wait until you are resumed.');
      const payload: TakeoverPayload = { botId: ctx.bot.id, reason: a.reason, status: 'waiting' };
      const msg = ctx.repos.insertMessage({
        roomId: ctx.room.id, authorType: 'bot', authorId: ctx.bot.id, kind: 'takeover',
        text: '@' + ctx.bot.handle + ' needs you: ' + a.reason, payload,
        causeId: ctx.causeId, hop: ctx.hop, turnId: ctx.turnId,
      });
      events.emitEvent({ type: 'message.new', message: msg });
      ctx.control.beginTakeover(ctx.bot.id, {
        messageId: msg.id, roomId: ctx.room.id, reason: a.reason, causeId: ctx.causeId, hop: ctx.hop, runId: ctx.runId ?? null,
      });
      ctx.setState('waiting');
      const h = await ctx.control.waitHandBack(ctx.bot.id, ctx.signal);
      ctx.setState('working');
      if (h.kind === 'handed-back') {
        return text(userName + ' handed your computer back.' + (h.note ? ' Their note: ' + h.note : ' They left no note.') +
          ' Take a screenshot (or a browser snapshot) to see where things are now, then continue.');
      }
      if (h.kind === 'aborted') {
        ctx.control.dropTakeover(ctx.bot.id);
        return err('Your turn was interrupted while waiting for the takeover.');
      }
      ctx.control.parkTakeover(ctx.bot.id);
      ctx.park('waiting for ' + userName + ' to hand the computer back');
      return text(TAKEOVER_PARKED);
    },
  );
}
