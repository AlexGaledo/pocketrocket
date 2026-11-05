import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHub, type Hub } from '../hub.js';
import { ContextRepo, MAX_PENDING_CONTEXT } from '../db/contextRepo.js';
import { Db } from '../db/db.js';
import { scrubContext } from '../services/contextScrub.js';
import { deviceMayAccess } from './guard.js';

const TOKEN = 'context-test-token';
let hub: Hub;
let port: number;
const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-context-projects-'));
const script = path.resolve(__dirname, '../../../../scripts/context-import.mjs');
// Fake credential shapes, assembled so no scanner reads this file as holding real ones.
const SAMPLES = ['sk-' + 'a'.repeat(24), 'ghp_' + 'b'.repeat(24), 'eyJ' + 'c'.repeat(12) + '.eyJ' + 'd'.repeat(12) + '.' + 'e'.repeat(12), 'xoxb-' + '1'.repeat(14)];

beforeAll(async () => {
  hub = createHub({ port: 0, dbFile: ':memory:', skipBootstrap: true, token: TOKEN, projectsDir });
  port = await hub.listen();
});
afterAll(async () => { await hub.shutdown(); fs.rmSync(projectsDir, { recursive: true, force: true }); });

function request(method: string, p: string, opts: { body?: unknown; token?: string | null } = {}) {
  const headers: Record<string, string> = { host: '127.0.0.1:' + port, 'content-type': 'application/json' };
  if (opts.token !== null) headers.authorization = 'Bearer ' + (opts.token ?? TOKEN);
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => { let json: unknown = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ } resolve({ status: res.statusCode ?? 0, json }); });
    });
    req.on('error', reject);
    req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body));
  });
}

async function connectorClient(p: string) {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + port + p)));
  return client;
}

describe('scrubbing', () => {
  it('removes labelled credentials and vendor key shapes, on the hub and in the PC script alike', async () => {
    const { scrub } = await import(pathToImport(script));
    const inputs = ['password: hunter2hunter', 'api_key="abc123def456"', 'my password is correcthorse', ...SAMPLES];
    for (const s of inputs) {
      const secret = s.replace(/^.*?(?:: |="|is )/, '').replace(/"$/, '');
      expect(scrubContext(s)).not.toContain(secret);
      expect(scrub(s).text).not.toContain(secret);
      expect(scrub(s).hits).toBeGreaterThan(0);
    }
  });
  it('removes contact details, government ids and credentials in URLs or env lines, on the hub and in the PC script alike', async () => {
    const { scrub } = await import(pathToImport(script));
    const cases: [string, string][] = [
      ['write to jane.doe@gmail.com today', 'write to [email] today'],
      ['call 0917 123 4567 now', 'call [phone] now'],
      ['call +639171234567 now', 'call [phone] now'],
      ['TIN: 123-456-789-00000 on file', 'TIN: [id] on file'],
      ['SERVICE_API_KEY=abc123def', 'SERVICE_API_KEY=[redacted]'],
      ['postgres://admin:hunter2@db.example.com/app', '[redacted]'],
    ];
    for (const [input, want] of cases) {
      expect(scrub(input).text).toBe(want);
      expect(scrubContext(input)).toBe(want);
    }
  });
  it('leaves ordinary prose alone, including the word password', async () => {
    const { scrub } = await import(pathToImport(script));
    const prose = 'We reset the password flow on Tuesday; the client is on AxisCare.';
    expect(scrubContext(prose)).toBe(prose);
    expect(scrub(prose).text).toBe(prose);
  });
  it('cannot catch a bare password, which is why a person reviews the text', () => {
    expect(scrubContext('hunter2hunter')).toBe('hunter2hunter');
  });
});

describe('the PC script', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-context-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads a drop folder and names what it skipped', async () => {
    const { readDropFolder } = await import(pathToImport(script));
    const d = path.join(dir, 'drop');
    fs.mkdirSync(path.join(d, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(d, 'a.md'), 'alpha');
    fs.writeFileSync(path.join(d, 'sub', 'b.txt'), 'beta');
    fs.writeFileSync(path.join(d, 'c.pdf'), 'x');
    const { files, skipped } = readDropFolder(d);
    expect(files.map((f: { title: string }) => f.title).sort()).toEqual(['a.md', 'sub/b.txt']);
    expect(skipped).toEqual(['c.pdf']);
  });
  it('reads chats and projects from an export, and copes when projects are absent', async () => {
    const { readExport } = await import(pathToImport(script));
    const d = path.join(dir, 'export');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'conversations.json'), JSON.stringify([
      { uuid: 'u', name: 'Pricing', chat_messages: [
        { sender: 'human', text: 'hi', content: [{ type: 'text', text: 'hi' }] },
        { sender: 'assistant', text: 'ignored', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_result', content: 'tool output' }, { type: 'text', text: 'hello' }] },
        { sender: 'human', text: '' },
      ] },
    ]));
    expect(readExport(d).projects).toEqual([]);
    expect(readExport(d).chats[0]).toEqual({ name: 'Pricing', date: '', body: '**human:** hi\n\n**assistant:** hello' });
    fs.mkdirSync(path.join(d, 'projects'));
    fs.mkdirSync(path.join(d, 'memories'));
    fs.writeFileSync(path.join(d, 'projects', 'a.json'), JSON.stringify({ uuid: 'a', name: 'P', updated_at: '2026-03-04T01:02:03Z', description: 'about', prompt_template: 'be brief', docs: [{ filename: 'f.md', created_at: '2026-01-02T00:00:00Z', content: 'body' }] }));
    fs.writeFileSync(path.join(d, 'projects', 'b.json'), JSON.stringify({ uuid: 'b', name: '', docs: null }));
    fs.writeFileSync(path.join(d, 'memories', 'm.json'), JSON.stringify({ conversations_memory: 'personal', project_memories: { a: 'remembered' } }));
    expect(readExport(d).projects).toEqual([{ name: 'P', date: '2026-03-04', description: 'about', instructions: 'be brief', memory: 'remembered', docs: [{ name: 'f.md', date: '2026-01-02', body: 'body' }] }]);
  });
});

describe('/api/context', () => {
  it('is for the owner: no token is refused, and a paired phone cannot reach it', async () => {
    expect((await request('GET', '/api/context', { token: null })).status).toBe(401);
    for (const [m, p] of [['GET', '/api/context'], ['POST', '/api/context'], ['POST', '/api/context/connector'], ['POST', '/api/context/x/approve']] as const) {
      expect(deviceMayAccess(m, p)).toBe(false);
    }
  });
  it('imports into a project folder, scrubs it again, and a re-import replaces the file', async () => {
    await request('POST', '/api/projects', { body: { name: 'Reimport' } });
    const first = await request('POST', '/api/context', { body: { source: 'drop-folder', project: 'Reimport', title: 'a.md', body: 'password: hunter2hunter', date: '2026-02-03' } });
    expect(first.json).toEqual({ project: 'reimport', path: 'imports/drop-folder/a.md' });
    const file = path.join(projectsDir, 'reimport', 'imports', 'drop-folder', 'a.md');
    expect(fs.readFileSync(file, 'utf8')).toContain('password: [redacted]');
    expect(fs.readFileSync(file, 'utf8')).toContain('updated: 2026-02-03');
    await request('POST', '/api/context', { body: { source: 'drop-folder', project: 'Reimport', title: 'a.md', body: 'new' } });
    expect(fs.readFileSync(file, 'utf8')).not.toContain('redacted');
  });
  it('refuses an import for a project that does not exist', async () => {
    expect((await request('POST', '/api/context', { body: { source: 'export', project: 'Nope', title: 't', body: 'b' } })).status).toBe(404);
  });
  it('keeps a hostile title inside the project folder', async () => {
    await request('POST', '/api/projects', { body: { name: 'Titles' } });
    const r = await request('POST', '/api/context', { body: { source: 'export', project: 'Titles', title: '../../../evil', body: 'x' } });
    expect(r.json.path).toBe('imports/export/evil.md');
    expect(fs.existsSync(path.join(projectsDir, 'evil.md'))).toBe(false);
  });
  it('will not import as anything but the PC sources', async () => {
    expect((await request('POST', '/api/context', { body: { source: 'connector', project: 'p', title: 't', body: 'b' } })).status).toBe(400);
  });
});

describe('the connector', () => {
  it('is off until the owner turns it on, and a wrong secret finds nothing', async () => {
    expect((await request('POST', '/mcp/context/guess', { token: null, body: {} })).status).toBe(404);
    const { path: p } = (await request('POST', '/api/context/connector', {})).json;
    expect((await request('POST', p + 'x', { token: null, body: {} })).status).toBe(404);
    await request('DELETE', '/api/context/connector');
    expect((await request('POST', p, { token: null, body: {} })).status).toBe(404);
  });
  it('a wrong secret does not trip the limiter, or anyone on the internet could lock the owner out', async () => {
    for (let i = 0; i < 15; i++) await request('POST', '/mcp/context/guess' + i, { token: null, body: {} });
    expect((await request('GET', '/api/context')).status).toBe(200);
  });
  it('offers one tool, which queues scrubbed text for review and reads nothing back', async () => {
    const { path: p } = (await request('POST', '/api/context/connector', {})).json;
    const client = await connectorClient(p);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['save_project_context']);

    const out = await client.callTool({ name: 'save_project_context', arguments: { project: 'Conn', title: 'Instructions', content: 'be brief. password: hunter2hunter' } });
    expect(JSON.stringify(out)).not.toContain('be brief');

    const pending = (await request('GET', '/api/context')).json;
    const row = pending.find((r: { project: string }) => r.project === 'Conn');
    expect((await request('GET', '/api/context/' + row.id)).json.body).toBe('be brief. password: [redacted]');
    expect(fs.existsSync(path.join(projectsDir, 'conn'))).toBe(false);

    // Approving needs the project to exist, and keeps the item until it does.
    expect((await request('POST', '/api/context/' + row.id + '/approve', {})).status).toBe(404);
    expect((await request('GET', '/api/context/' + row.id)).status).toBe(200);
    await request('POST', '/api/projects', { body: { name: 'Conn' } });
    expect((await request('POST', '/api/context/' + row.id + '/approve', {})).json.path).toBe('imports/connector/Instructions.md');
    expect((await request('GET', '/api/context/' + row.id)).status).toBe(404);
    await client.close();
    await request('DELETE', '/api/context/connector');
  });
  it('the secret stays out of the audit log', async () => {
    const { path: p } = (await request('POST', '/api/context/connector', {})).json;
    await request('POST', p, { token: null, body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
    const secret = p.split('/').pop()!;
    const rows = hub.repos.db.all('SELECT target, detail FROM audit_log');
    expect(JSON.stringify(rows)).not.toContain(secret);
    await request('DELETE', '/api/context/connector');
  });
});

describe('ContextRepo', () => {
  it('keeps only the hash of the connector secret', () => {
    const db = new Db(':memory:');
    const c = new ContextRepo(db);
    const token = c.mintConnectorToken();
    expect(JSON.stringify(db.all('SELECT * FROM context_connector'))).not.toContain(token);
    expect(c.connectorTokenMatches(token)).toBe(true);
    const next = c.mintConnectorToken();
    expect(c.connectorTokenMatches(token)).toBe(false);
    expect(c.connectorTokenMatches(next)).toBe(true);
  });
  it('stops at the cap the connector checks', () => {
    expect(MAX_PENDING_CONTEXT).toBe(200);
  });
});

function pathToImport(p: string): string {
  return 'file:///' + p.replaceAll('\\', '/').replace(/^\//, '');
}
