// The one esbuild configuration for the hub bundle, shared by the desktop build (scripts/build-hub.mjs,
// build/hub.mjs next to a deployed node_modules) and the VPS build (scripts/build-hub-server.mjs,
// packages/hub/dist/hub.mjs next to the workspace node_modules). Keeping it in one place means the
// server runs exactly what the installer ships.
//
// Every runtime dep stays external on purpose (see docs/research/xai-tauri.md): `ws` optional native
// addons, `http-proxy` dynamic requires and the Claude Agent SDK's platform-specific optional deps all
// break when bundled. `@pocketrocket/shared` is the one exception: it is a workspace package whose
// "main" points at TypeScript, which Node cannot run, so it is compiled in.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB_ENTRY = path.join(ROOT, 'packages', 'hub', 'src', 'index.ts');
const SHARED_ENTRY = path.join(ROOT, 'packages', 'shared', 'src', 'index.ts');

/** Bundle packages/hub/src/index.ts into `outfile` (ESM, Node 22+). */
export async function bundleHub(outfile) {
  await esbuild.build({
    entryPoints: [HUB_ENTRY],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    sourcemap: false,
    logLevel: 'info',
    // Some CJS deps pulled in through the bundle expect `require` to exist in module scope.
    banner: { js: "import{createRequire as __prCreateRequire}from'node:module';const require=__prCreateRequire(import.meta.url);" },
    plugins: [
      {
        // `packages: 'external'` externalises every bare specifier and there is no way to
        // un-externalise one of them from the CLI, so resolve the workspace package by hand.
        name: 'inline-shared',
        setup(build) {
          build.onResolve({ filter: /^@pocketrocket\/shared(\/.*)?$/ }, () => ({ path: SHARED_ENTRY }));
        },
      },
    ],
  });
}
