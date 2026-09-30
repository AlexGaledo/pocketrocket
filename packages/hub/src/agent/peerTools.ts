import { z } from 'zod';
import type { HubTool } from '../providers/types.js';
import { PeerError, type PeerClient, type DirEntry, type RunResult } from '../services/PeerService.js';
import { err, hubTool, text } from './botTools.js';

/**
 * Tools for the linked hub's machine. Offered only while a peer is configured. `peer_run` additionally needs
 * the bot itself to hold Bash: a bot that may not run commands here may not run them over there either.
 * The other machine still applies its own limits to every call.
 */
export function createPeerTools(peer: PeerClient, opts: { canRun: boolean }): HubTool[] {
  if (!peer.enabled) return [];
  const where = 'the linked machine "' + peer.name + '"';
  const guard = async (f: () => Promise<string>) => {
    try {
      return text(await f());
    } catch (e) {
      return err(e instanceof PeerError ? e.message : 'Peer call failed: ' + String(e));
    }
  };
  const tools: HubTool[] = [
    hubTool('peer_info', 'Describe ' + where + ': its workspace path, which folders you may read there, whether you may run commands, and its OS.', {},
      () => guard(async () => JSON.stringify(await peer.call('info'), null, 2)), { readOnly: true }),
    hubTool('peer_list_dir', 'List a folder on ' + where + '. Relative paths resolve against its workspace.',
      { path: z.string().optional().describe('Folder to list. Omit for the peer workspace.') },
      (a) => guard(async () => {
        const r = await peer.call<{ path: string; entries: DirEntry[]; truncated: boolean }>('list', { path: a.path });
        const lines = r.entries.map((e) => (e.type === 'dir' ? e.name + '/' : e.name + (e.size !== null ? '  (' + e.size + ' B)' : '')));
        return r.path + '\n' + (lines.join('\n') || '(empty)') + (r.truncated ? '\n… more entries not shown' : '');
      }), { readOnly: true }),
    hubTool('peer_read_file', 'Read a text file on ' + where + '. Large files come back in slices; pass offset to continue.',
      { path: z.string(), offset: z.number().int().min(0).optional().describe('Byte offset to start at'), limit: z.number().int().min(1).optional().describe('Max bytes') },
      (a) => guard(async () => {
        const r = await peer.call<{ path: string; size: number; offset: number; text: string; truncated: boolean }>('read', a);
        return r.text + (r.truncated ? '\n… truncated: file is ' + r.size + ' bytes, continue with offset=' + (r.offset + Buffer.byteLength(r.text)) : '');
      }), { readOnly: true }),
  ];
  if (opts.canRun) {
    tools.push(hubTool('peer_run', 'Run a shell command on ' + where + ' (its shell, its OS; check peer_info first). Fails if that machine has not switched this on.',
      { command: z.string().min(1), cwd: z.string().optional().describe('Working folder on the peer. Omit for its workspace.') },
      (a) => guard(async () => {
        const r = await peer.call<RunResult>('run', a);
        return 'exit ' + (r.timedOut ? 'timed out' : r.exitCode) + (r.stdout ? '\n--- stdout\n' + r.stdout : '') + (r.stderr ? '\n--- stderr\n' + r.stderr : '');
      })));
  }
  return tools;
}
