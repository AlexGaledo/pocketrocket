import {
  DEFAULT_MACHINE_POLICY, MACHINE_POLICIES, PC_MACHINE_ID, VPS_MACHINE_ID,
  type MachineInfo, type MachinePolicy,
} from '@pocketrocket/shared';
import type { Db } from '../db/db.js';
import type { PcRunner } from './PcRunner.js';

/**
 * The machines a bot's work can run on (B4): its own computer (`vps`) and the owner's one paired PC (`pc`).
 * Policies live in `machine_policies`; no row means 'ask'. Only the owner writes one, over REST; no bot tool does.
 *
 * `always` is a label for "the owner is happy with this machine", not a bypass: for the PC it changes nothing,
 * because run_on_pc keeps its approval card (signed-in browsers only) and the PC's own prompt on every job.
 */
export class Machines {
  constructor(private db: Db, private pc?: PcRunner, private now: () => number = Date.now) {}

  /** Ids a policy can be set for. The bot's own computer is governed by the approvals setting, not by this. */
  static readonly SETTABLE: readonly string[] = [PC_MACHINE_ID];

  policy(id: string): MachinePolicy {
    // The bot's own computer is not gated by this table: approvals settings already govern it.
    if (id === VPS_MACHINE_ID) return 'always';
    const r = this.db.get<{ policy: string }>('SELECT policy FROM machine_policies WHERE machine=?', id);
    return (MACHINE_POLICIES as readonly string[]).includes(r?.policy ?? '') ? (r!.policy as MachinePolicy) : DEFAULT_MACHINE_POLICY;
  }

  /** False for a machine that does not exist or has no configurable policy. */
  setPolicy(id: string, policy: MachinePolicy): boolean {
    if (!Machines.SETTABLE.includes(id)) return false;
    this.db.run(
      'INSERT INTO machine_policies (machine, policy, updated_at) VALUES (?,?,?) ON CONFLICT(machine) DO UPDATE SET policy=excluded.policy, updated_at=excluded.updated_at',
      id, policy, this.now(),
    );
    return true;
  }

  list(): MachineInfo[] {
    const paired = !!this.pc?.isPaired();
    return [
      { id: VPS_MACHINE_ID, label: 'Your own computer', kind: 'own', online: true, paired: true, policy: this.policy(VPS_MACHINE_ID) },
      { id: PC_MACHINE_ID, label: "Owner's PC", kind: 'pc', online: paired && !!this.pc?.online(), paired, policy: this.policy(PC_MACHINE_ID) },
    ];
  }

  get(id: string): MachineInfo | undefined {
    return this.list().find((m) => m.id === id);
  }
}
