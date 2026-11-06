#!/usr/bin/env node
// Stands in for /usr/bin/osascript in tests (MC_OSASCRIPT_BIN), so no test
// ever puts a notification on the Mac's screen: each call's arguments are
// appended as one JSON line to STUB_OSASCRIPT_LOG. STUB_OSASCRIPT_FAIL=1
// makes it fail the way osascript does on a bad script.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.STUB_OSASCRIPT_LOG) fs.appendFileSync(process.env.STUB_OSASCRIPT_LOG, JSON.stringify(args) + '\n');
if (process.env.STUB_OSASCRIPT_FAIL === '1') { process.stderr.write('execution error: stub failure (-2700)\n', () => process.exit(1)); }
else process.exit(0);
