import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from './bundle-budget.mjs';

function dist(js) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-'));
  fs.mkdirSync(path.join(d, 'assets'));
  fs.writeFileSync(path.join(d, 'index.html'), '<script src="/theme-init.js"></script><script type="module" crossorigin src="/assets/index-x.js"></script>');
  fs.writeFileSync(path.join(d, 'assets', 'index-x.js'), js);
  return d;
}

test('passes a small clean entry chunk', () => {
  assert.deepEqual(check(dist('console.log(1)'), 1000).problems, []);
});
test('flags xyflow code and an oversized chunk', () => {
  assert.equal(check(dist('a="react-flow__node"'), 1000).problems.length, 1);
  assert.equal(check(dist('x'.repeat(2000)), 1000).problems.length, 1);
});
