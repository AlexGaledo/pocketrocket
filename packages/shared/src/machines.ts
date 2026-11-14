import { z } from 'zod';

// Where a bot's work can run (B4). Today: the bot's own computer and the one PC the owner paired.

/** What the owner allows on a machine. `always` never removes the sign-in approval or the PC's own prompt. */
export const MACHINE_POLICIES = ['never', 'ask', 'always'] as const;
export type MachinePolicy = (typeof MACHINE_POLICIES)[number];
export const DEFAULT_MACHINE_POLICY: MachinePolicy = 'ask';

/** The bot's own computer (the hub host or its VPS). */
export const VPS_MACHINE_ID = 'vps';
/** The owner's paired PC. */
export const PC_MACHINE_ID = 'pc';

export interface MachineInfo {
  id: string;
  label: string;
  /** `own` is the bot's own computer, `pc` the owner's paired machine. */
  kind: 'own' | 'pc';
  /** Reachable right now. The bot's own computer always is. */
  online: boolean;
  /** Set up for use. The bot's own computer always is; the PC only once the owner paired it. */
  paired: boolean;
  policy: MachinePolicy;
}

/** PUT /api/pc-runner/machines/:id */
export const MachinePolicyInputSchema = z.object({ policy: z.enum(MACHINE_POLICIES) });
export type MachinePolicyInput = z.infer<typeof MachinePolicyInputSchema>;
