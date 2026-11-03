import { TURN_FAILURE_BEHAVIOUR, type TurnFailurePayload } from '@pocketrocket/shared';

/** Stopped by someone, signed out, out of budget or out of reach: none of it says anything about how the bot works. */
const EXTERNAL = new RegExp(
  [
    'interrupted', 'aborted',
    'not logged in', 'not signed in', 'signed out', 'please (?:log|sign) in', 'authenticat', 'unauthori[sz]ed', 'api key',
    'budget', 'credit balance', 'usage limit', 'rate.?limit', 'quota', 'overloaded',
    'failed to start', 'executable not found', 'claude update', 'econn', 'etimedout', 'enotfound', 'fetch failed', 'network',
  ].join('|'),
  'i',
);

/** The note a failed turn leaves in its room. training reads the payload, never the wording. */
export function turnFailureNote(botName: string, error: string, aborted: boolean): { text: string; payload: TurnFailurePayload } {
  return {
    text: botName + ' turn ended: ' + error,
    payload: { turnFailure: aborted || EXTERNAL.test(error) ? 'external' : TURN_FAILURE_BEHAVIOUR },
  };
}
