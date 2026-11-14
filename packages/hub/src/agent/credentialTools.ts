import { z } from 'zod';
import type { Db } from '../db/db.js';
import { hubTool, err, text } from './botTools.js';
import { denyMessage } from '../permissions/messages.js';
import { recordAudit } from '../services/AuditLog.js';
import { fillActivePage, type FillOutcome, type FillRequest } from '../services/browserFill.js';
import type { CredentialStore } from '../services/CredentialStore.js';
import type { HubTool } from '../providers/types.js';

/**
 * `fill_credential` (G4): the bot names a saved login; the hub types it into the page. The secret is read from the
 * store inside the handler and handed to the browser; it is never in the arguments, the card, the result, the
 * audit line or an error. The result is the word "filled".
 */
export interface CredentialToolDeps {
  store: CredentialStore;
  db: Db;
  bot: { id: string };
  roomId: string;
  /** The bot's browser (DevTools endpoint). */
  cdpUrl: string;
  /** The approval card: the broker's askCredentialFill. Absent (unit tests that forgot it) fails closed. */
  confirm?: (a: { credential: string; site: string; field: string; page: string }) => Promise<{ allowed: boolean; message: string }>;
  /** Tests: a fake browser. */
  fill?: (r: FillRequest) => Promise<FillOutcome>;
}

const ALT_NAV = 'open the saved site yourself and try again on that page, or say so in the room';

function refusal(o: Extract<FillOutcome, { ok: false }>, name: string, origin: string): string {
  switch (o.reason) {
    case 'origin':
      return denyMessage('not_allowed', { subject: 'filling "' + name + '" on this page', note: 'the page is not ' + origin + ', the only site this login may be used on', alt: ALT_NAV });
    case 'ambiguous':
      return denyMessage('unavailable', { subject: 'filling "' + name + '"', note: 'more than one tab is in front, so it is unclear which to fill', alt: 'close the extra tabs and try again' });
    case 'no_page':
      return denyMessage('unavailable', { subject: 'filling "' + name + '"', note: 'no page is open in your browser', alt: 'open ' + origin + ' in your browser and try again' });
    case 'no_field':
      return denyMessage('unavailable', { subject: 'filling "' + name + '"', note: 'no matching field was found on the page (click into the field first, or open the sign-in form)', alt: 'put the cursor in the field and try again, or say so in the room' });
    case 'unreachable':
      return denyMessage('unavailable', { subject: 'filling "' + name + '"', note: 'your browser could not be reached', alt: 'say so in the room' });
    default:
      return denyMessage('unavailable', { subject: 'filling "' + name + '"', note: 'it failed and nothing was confirmed', alt: 'say so in the room' });
  }
}

export function credentialTools(d: CredentialToolDeps): HubTool[] {
  const fill = d.fill ?? fillActivePage;
  return [hubTool(
    'fill_credential',
    'Type one of the owner\'s saved logins into the field on the page in your browser, without you ever seeing it. ' +
      'Give the login\'s name and which field: "password" (default) or "username". Click into the sign-in form first. ' +
      'It works only on the exact site the login was saved for, and the owner is asked every time. Returns "filled".',
    {
      name: z.string().min(1).max(100).describe('The saved login\'s name'),
      field: z.enum(['password', 'username']).optional().describe('Default password'),
    },
    async (a) => {
      const cred = d.store.byName(a.name);
      if (!cred) {
        const names = d.store.list().map((c) => c.name).slice(0, 20);
        return err(denyMessage('unavailable', { subject: 'the saved login "' + a.name.slice(0, 60) + '"', note: names.length ? 'no login has that name; saved logins: ' + names.join(', ') : 'no logins are saved', alt: 'ask the owner to add it in Settings, Credentials' }));
      }
      const field = a.field ?? 'password';
      const secret = d.store.readSecret(cred.id);
      if (!secret) return err(denyMessage('unavailable', { subject: '"' + cred.name + '"', note: 'its secret is missing; the owner needs to enter it again in Settings', alt: 'say so in the room' }));
      if (!d.confirm) return err(denyMessage('unavailable', { subject: 'filling "' + cred.name + '"', note: 'the owner\'s approval is needed and none can be asked for here', alt: 'say so in the room' }));

      // Look before asking: a wrong page is refused without bothering the owner. The probe carries no secret.
      const pre = await fill({ cdpUrl: d.cdpUrl, origin: cred.origin, field, secret: '', probe: true });
      if (!pre.ok) return err(refusal(pre, cred.name, cred.origin));
      const r = await d.confirm({ credential: cred.name, site: cred.origin, field, page: cred.origin });
      if (!r.allowed) return err(r.message);

      // After the approval, against the page as it is now (it may have redirected while the card waited).
      const out = await fill({ cdpUrl: d.cdpUrl, origin: cred.origin, field, secret });
      recordAudit(d.db, { kind: 'bot', id: d.bot.id }, out.ok ? 'credential.filled' : 'credential.fill_refused', cred.name, 'room ' + d.roomId + ', ' + cred.origin + ', ' + field + (out.ok ? '' : ', ' + out.reason));
      if (!out.ok) return err(refusal(out, cred.name, cred.origin));
      d.store.markUsed(cred.id);
      return text('filled');
    },
  )];
}
