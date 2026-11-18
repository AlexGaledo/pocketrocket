// Entry for `node --test scripts/pc-runner` (package.json main): loads every test file. CI uses the *.test.mjs glob.
import './lib.test.mjs';
import './mcp.test.mjs';
import './mirror.test.mjs';
import './jobs.test.mjs';
