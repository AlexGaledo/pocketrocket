// Run with `node --test "packages/web/test/*.test.mjs"` (Node 24+ strips the .ts types itself).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paneAutoStep } from '../src/lib/paneAutoClose.ts';

/** Feeds (inline, open) frames through the step and collects what it asks for. */
function run(frames, start = { inline: true, autoClosed: false }) {
  let state = start;
  const acts = [];
  for (const f of frames) {
    const { next, act } = paneAutoStep(state, f.inline, f.open);
    state = next;
    acts.push(act);
  }
  return { state, acts };
}

test('shrinking past the breakpoint closes an open pane and growing back reopens it', () => {
  const { acts } = run([
    { inline: true, open: true },
    { inline: false, open: true }, // 1440 -> 390
    { inline: false, open: false }, // closed by us
    { inline: true, open: false }, // 390 -> 1440
  ]);
  assert.deepEqual(acts, [null, 'close', null, 'open']);
});

test('a pane the user had closed stays closed when the window grows back', () => {
  const { acts } = run([
    { inline: true, open: false },
    { inline: false, open: false },
    { inline: true, open: false },
  ]);
  assert.deepEqual(acts, [null, null, null]);
});

test('opening then closing the drawer while narrow makes that close stick', () => {
  const { acts } = run([
    { inline: true, open: true },
    { inline: false, open: true },
    { inline: false, open: false },
    { inline: false, open: true }, // user opens the drawer
    { inline: false, open: false }, // and closes it
    { inline: true, open: false },
  ]);
  assert.deepEqual(acts, [null, 'close', null, null, null, null]);
});

test('a drawer left open while narrow is not touched when the window grows back', () => {
  const { acts } = run([
    { inline: true, open: true },
    { inline: false, open: true },
    { inline: false, open: false },
    { inline: false, open: true },
    { inline: true, open: true },
  ]);
  assert.deepEqual(acts, [null, 'close', null, null, null]);
});

test('closes again on the next shrink after a reopen', () => {
  const { acts, state } = run([
    { inline: true, open: true },
    { inline: false, open: true },
    { inline: false, open: false },
    { inline: true, open: false },
    { inline: true, open: true },
    { inline: false, open: true },
  ]);
  assert.deepEqual(acts, [null, 'close', null, 'open', null, 'close']);
  assert.equal(state.autoClosed, true);
});
