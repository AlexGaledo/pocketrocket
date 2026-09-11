// Optional PocketRocket account (Supabase Auth). The hub owns the session; the UI only ever sees AccountState.

export type Plan = 'free' | 'pro';

export interface AccountUser {
  id: string;
  email: string;
  displayName: string | null;
  plan: Plan;
}

export interface AccountState {
  /** False when the hub has no Supabase URL/key configured; the UI hides the Account section's sign-in. */
  enabled: boolean;
  signedIn: boolean;
  user: AccountUser | null;
  /** OAuth providers switched on in the Supabase project (read from its public auth settings). */
  oauth: { google: boolean; github: boolean };
  /** Set after POST /api/account/magic-link until the link is used, a code is verified, or it is cancelled. */
  pendingEmail: string | null;
}

export const SIGNED_OUT: AccountState = {
  enabled: false, signedIn: false, user: null, oauth: { google: false, github: false }, pendingEmail: null,
};
