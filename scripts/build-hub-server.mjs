// Build the hub for a server install: packages/hub/dist/hub.mjs, run by deploy/pocketrocket.service
// with plain `node` instead of `tsx src/index.ts`. No TypeScript compiler at runtime, one process
// instead of two, faster restarts.
//
// It sits at the same depth as src/, and dist/ has no node_modules or package.json of its own, so
// config.ts resolves HUB_DIR, ROOT_DIR and VERSION exactly as it does from source.
//
// Run: pnpm hub:server-bundle (scripts/deploy.sh does, after `pnpm build` typechecks the hub).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleHub } from './hub-esbuild.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'packages', 'hub', 'dist');

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
await bundleHub(path.join(DIST, 'hub.mjs'));
console.log('[hub:server-bundle] wrote packages/hub/dist/hub.mjs');
