import { createHub } from './hub.js';

// The SDK warns every turn that bare allowedTools entries (WebSearch/WebFetch/mcp__pocketrocket__*) bypass
// canUseTool. That is intentional here; file/shell tools are never pre-approved. Silence just that warning.
const origEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  if (String(warning).includes('canUseTool will not be invoked')) return;
  (origEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const hub = createHub();
await hub.listen();

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  console.log('[pocketrocket] ' + signal + ': shutting down');
  const force = setTimeout(() => process.exit(0), 8000);
  force.unref();
  try {
    await hub.shutdown();
  } catch (e) {
    console.error(e);
  }
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
