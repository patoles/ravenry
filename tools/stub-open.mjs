#!/usr/bin/env node
// Stands in for macOS `open` on test boards (MC_OPEN_COMMAND), so no test
// opens a Finder window: appends one JSON line with its arguments to
// $STUB_OPEN_LOG. STUB_OPEN_FAIL=1 makes it fail like an `open` that could
// not open the folder.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.STUB_OPEN_LOG) fs.appendFileSync(process.env.STUB_OPEN_LOG, JSON.stringify({ args }) + '\n');
if (process.env.STUB_OPEN_FAIL === '1') { process.stderr.write('The file does not exist.\n'); process.exit(1); }
