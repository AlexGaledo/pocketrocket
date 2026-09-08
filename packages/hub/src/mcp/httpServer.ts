import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { HOST, PORT, VERSION } from '../config.js';
import type { HubTool } from '../providers/types.js';

/**
 * Hub tools of every in-flight turn, addressed by a bearer token. A CLI provider gets the endpoint URL and
 * its turn's token in `TurnContext.mcp` and configures its own MCP client with them; the token dies with the turn.
 */
export class TurnRegistry {
  private turns = new Map<string, { tools: HubTool[] }>();

  registerTurn(tools: HubTool[]): string {
    const token = randomBytes(24).toString('base64url');
    this.turns.set(token, { tools });
    return token;
  }
  unregister(token: string) {
    this.turns.delete(token);
  }
  tools(token: string): HubTool[] | undefined {
    return this.turns.get(token)?.tools;
  }
  get size() {
    return this.turns.size;
  }
  /** Loopback URL a provider CLI should point at. */
  url(port: number = PORT): string {
    return 'http://' + HOST + ':' + port + '/mcp';
  }
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

/** One McpServer per request (stateless): no session bookkeeping, and tools always match the live turn. */
function buildServer(tools: HubTool[]): McpServer {
  const server = new McpServer({ name: 'pocketrocket', version: VERSION });
  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: t.inputSchema.shape as never,
        annotations: t.readOnly ? { readOnlyHint: true } : undefined,
      },
      (async (args: unknown) => {
        const out = await t.handler((args ?? {}) as Record<string, unknown>);
        return { content: out.content, isError: out.isError } as never;
      }) as never,
    );
  }
  return server;
}

/**
 * Handles POST/GET/DELETE /mcp. Returns true when the request was handled (so index.ts can fall through
 * to the static file server otherwise). Auth is the per-turn bearer token; no token, no tools.
 */
export function createMcpHandler(registry: TurnRegistry) {
  return async function handleMcp(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const token = bearer(req);
    const tools = token ? registry.tools(token) : undefined;
    if (!tools) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unknown or expired turn token' }, id: null }));
      return;
    }
    const server = buildServer(tools);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
