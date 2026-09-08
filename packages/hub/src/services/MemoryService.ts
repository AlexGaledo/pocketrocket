import fs from 'node:fs';
import path from 'node:path';
import { botHome } from '../config.js';
import { events } from '../events.js';

export class MemoryService {
  file(botId: string) {
    return path.join(botHome(botId), 'memory.md');
  }
  identityFile(botId: string) {
    return path.join(botHome(botId), 'CLAUDE.md');
  }
  ensureHome(botId: string) {
    fs.mkdirSync(botHome(botId), { recursive: true });
  }
  read(botId: string): string {
    try {
      return fs.readFileSync(this.file(botId), 'utf8');
    } catch {
      return '';
    }
  }
  readIdentity(botId: string): string {
    try {
      return fs.readFileSync(this.identityFile(botId), 'utf8');
    } catch {
      return '';
    }
  }
  writeIdentity(botId: string, text: string) {
    this.ensureHome(botId);
    fs.writeFileSync(this.identityFile(botId), text);
  }
  write(botId: string, text: string) {
    this.ensureHome(botId);
    fs.writeFileSync(this.file(botId), text);
    events.emitEvent({ type: 'memory.updated', botId, text });
  }
  append(botId: string, text: string) {
    const cur = this.read(botId);
    this.write(botId, (cur ? cur.replace(/\s+$/, '') + '\n' : '') + text.trim() + '\n');
  }
  patch(botId: string, find: string, replace: string): boolean {
    const cur = this.read(botId);
    if (!cur.includes(find)) return false;
    this.write(botId, cur.replace(find, replace));
    return true;
  }
}
