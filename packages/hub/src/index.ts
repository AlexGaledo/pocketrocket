import { createHub } from './hub.js';
import { startWorkspaceWeb } from './api/workspaceWeb.js';
import { WORKSPACE_DIR, WORKSPACE_WEB_PORT } from './config.js';

// The SDK warns every turn that bare allowedTools entries (WebSearch/WebFetch/mcp__pocketrocket__*) bypass
// canUseTool. That is intentional here; file/shell tools are never pre-approved. Silence just that warning.
const origEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning).includes('canUseTool will not be invoked')) return;
  (origEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const hub = createHub({ seedBots: true });
await hub.listen();
// Lets the Browser tool open HTML/images/PDFs from the workspace (Playwright MCP blocks file://).
await startWorkspaceWeb(WORKSPACE_DIR, WORKSPACE_WEB_PORT);

// The same graceful stop POST /api/maintenance/stop uses: shutdown(), then exit, forced after 8 s.
process.on('SIGINT', () => void hub.stop('SIGINT'));
process.on('SIGTERM', () => void hub.stop('SIGTERM'));
