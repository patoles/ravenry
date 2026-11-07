// The smoke test's steps (driver.cjs), shared by tools/smoke.mjs (the app
// from this folder) and tools/package-check.mjs (a packaged app): it finds
// no daemon and starts one, shows the first launch with no board running,
// opens a real shell, types, pastes, checks the pane's size, opens a second
// shell and switches back, follows `ravenryd focus`, shows the status an
// assistant's hook reports on its tab, and closes a tab. Screenshots go to
// out; the open tabs before the close go to <out>/.work/before-close.json.
// The shells run ravenryd as $SMOKE_RAVENRYD (ravenryd keeps RAVENRY_*
// variables out of panes).
import path from 'node:path';

export function smokeSteps(OUT, WORK = path.join(OUT, '.work')) {
  const R = 'window.__ravenry';
  const has = (s) => `${R}.text().includes(${JSON.stringify(s)})`;
  const attachedTo = (i) => `${R}.term().ready && ${R}.term().attached.pane === ${R}.S.tabs[${i}].pane`;
  return [
    { ready: true },
    // No board: the launch still ends with a working shell in front.
    { until: `${R}.S.hubStatus && !${R}.S.hubStatus.reachable && ${R}.S.tabs.length === 1 && ${attachedTo(0)} && ${has('$ ')}`, timeout: 20000 },
    { shot: path.join(OUT, 'smoke-first.png') },
    { type: 'echo smoke-$((40+2))\r' },
    { until: has('smoke-42') },
    // A paste goes to the daemon as one paste.
    { js: `(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'echo pasted-$((1+1))'); document.querySelector('#term textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()` },
    { sleep: 300 },
    { key: 'Return', char: '\r' },
    { until: has('pasted-2') },
    // The pane has the terminal's size.
    { type: 'stty size\r' },
    { until: `${R}.text().includes(${R}.term().term.rows + ' ' + ${R}.term().term.cols)` },
    // A second shell, then back: the first comes back from a snapshot.
    // Keys typed at once, while the new shell is still being attached, are kept.
    { js: `${R}.newShell()` },
    { until: `${R}.S.tabs.length === 2` },
    { type: 'echo second-tab\r', after: 0 },
    { until: `${attachedTo(1)} && ${has('second-tab')} && !${has('smoke-42')}`, timeout: 20000 },
    { js: `${R}.onCommand('next-tab', 1)` },
    { until: `${attachedTo(0)} && ${has('smoke-42')} && ${has('pasted-2')}` },
    { shot: path.join(OUT, 'smoke-shell.png') },
    // ravenryd focus, run in the first shell, brings the second one up.
    { typeJs: `'"$SMOKE_RAVENRYD" focus ' + ${R}.S.tabs[1].pane + '\\r'` },
    { until: attachedTo(1) },
    // An assistant's hook says it needs you: the tab shows it.
    { type: `echo '{"hook_event_name":"Notification","session_id":"smoke"}' | "$SMOKE_RAVENRYD" hook --assistant claude --state needs_you --need permission\r` },
    { until: `${R}.S.tabs[1].status && ${R}.S.tabs[1].status.state === 'needs_you' && document.querySelectorAll('#tabs .tab .sd').length === 1` },
    { shot: path.join(OUT, 'smoke-status.png') },
    { save: { expr: `({ tabs: ${R}.S.tabs.map((t) => t.pane), active: ${R}.term().attached.pane, renderer: ${R}.term().renderer, cols: ${R}.term().term.cols, rows: ${R}.term().term.rows })`, out: path.join(WORK, 'before-close.json') } },
    // Closing the tab ends its pane.
    { js: `${R}.onCommand('close-tab')` },
    { until: `${R}.S.tabs.length === 1 && ${attachedTo(0)}` },
    { sleep: 500 },
  ];
}

// Checkpoints, answered through the window (tools/smoke.mjs runs these
// after smokeSteps, in the shell left open): a real `ravenryd ask` answered
// with the 1 key, one answered in words with Enter, a `ravenryd approve`
// whose command runs once Run is pressed (then one the window edits before
// it runs, with the agent's own warning, and one it refuses with a reason),
// and a `ravenryd secret` whose
// program checks the secret (by its checksum, `sum`) without printing it.
// The secret is typed into the card's field; a half-typed one is gone once
// the field loses focus. What the window held afterwards goes to
// <WORK>/checkpoints.json for smoke.mjs to search for the secret.
export function checkpointSteps(OUT, WORK, { secret, sum }) {
  const R = 'window.__ravenry';
  const has = (s) => `${R}.text().includes(${JSON.stringify(s)})`;
  const card = (kind) => `document.querySelector('#panel .cp[data-cp]:not(.after)') && ${R}.S.cps.get(document.querySelector('#panel .cp[data-cp]:not(.after)').dataset.cp).cp.kind === ${JSON.stringify(kind)}`;
  const after = (head) => `[...document.querySelectorAll('#panel .cp.after .cp-h')].some((e) => e.textContent.includes(${JSON.stringify(head)}))`;
  const click = (label) => `[...document.querySelectorAll('#panel .cp button')].find((b) => b.textContent.startsWith(${JSON.stringify(label)})).click()`;
  return [
    { type: 'clear\r', after: 300 },
    // 1. A question with buttons: the 1 key answers it.
    { type: `"$SMOKE_RAVENRYD" ask 'Ship the beta to the testers?' --option 'Ship it' --option 'Not yet' --text; echo "ask-exit=$?"\r` },
    { until: card('ask'), timeout: 20000 },
    { until: `document.querySelectorAll('#panel .cp .opt').length === 2 && document.querySelector('#panel .cp .fi')` },
    { shot: path.join(OUT, 'smoke-ask.png') },
    { js: `document.querySelector('#panel .cp[data-cp]').focus()` },
    { key: '1', char: '1' },
    { until: `${has('ask-exit=0')} && ${R}.text().split('\\n').some((l) => l.trim() === 'Ship it')`, timeout: 20000 },
    { until: after('Answered') },
    { shot: path.join(OUT, 'smoke-ask-after.png') },
    // 2. In words: typed in the card's field, Enter sends it.
    { type: `"$SMOKE_RAVENRYD" ask 'Which branch?' --text; echo "ask2-exit=$?"\r` },
    { until: `${card('ask')} && document.querySelector('#panel .cp .fi')`, timeout: 20000 },
    { js: `document.querySelector('#panel .cp .fi').focus()` },
    { type: 'the release branch', after: 200 },
    { key: 'Return', char: '\r' },
    { until: `${has('ask2-exit=0')} && ${R}.text().split('\\n').some((l) => l.trim() === 'the release branch')`, timeout: 20000 },
    // 3. A command to approve: it runs once Run is pressed.
    { type: `"$SMOKE_RAVENRYD" approve 'echo approved-$((40+2))' --why 'The smoke test checks it'; echo "approve-exit=$?"\r` },
    { until: card('approve'), timeout: 20000 },
    { until: `[...document.querySelectorAll('#panel .cp button')].some((b) => /^Run on this (Mac|computer)$/.test(b.textContent))` },
    { shot: path.join(OUT, 'smoke-approve.png') },
    { js: click('Run on') },
    { until: `${has('approved-42')} && ${has('approve-exit=0')}`, timeout: 20000 },
    { until: after('Ran on') },
    { shot: path.join(OUT, 'smoke-approve-after.png') },
    // 3b. The agent's own warning, and edit then run: the edited command
    // runs, the proposed one never does, and the agent is told.
    { type: `"$SMOKE_RAVENRYD" approve 'echo proposed-ran' --warn 'The smoke test warns about this'; echo "edit-exit=$?"\r` },
    { until: `${card('approve')} && document.querySelector('#panel .cp .risk.agent')`, timeout: 20000 },
    { until: `document.querySelector('#panel .cp .risk.agent').textContent === 'The agent warns: The smoke test warns about this'` },
    { js: click('Edit') },
    { until: `document.querySelector('#panel .cp .cmd-in')` },
    { js: `(() => { const t = document.querySelector('#panel .cp .cmd-in'); t.value = 'echo edited-$((40+3))'; t.dispatchEvent(new Event('input')); })()` },
    { shot: path.join(OUT, 'smoke-approve-edit.png') },
    { js: click('Run edited command') },
    { until: `${has('edit-exit=0')} && ${R}.text().split('\\n').some((l) => l.trim() === 'edited-43')`, timeout: 20000 },
    { until: `${has('a person edited the command before approving it; it ran as:')} && !${R}.text().split('\\n').some((l) => l.trim() === 'proposed-ran')` },
    { until: after('Ran on') },
    { shot: path.join(OUT, 'smoke-approve-edited-after.png') },
    // 3c. Refuse with a reason: the agent reads it.
    { type: `"$SMOKE_RAVENRYD" approve 'echo never-$((1+1))'; echo "refuse-exit=$?"\r` },
    { until: card('approve'), timeout: 20000 },
    { js: click('Refuse') },
    { until: `document.querySelector('#panel .cp input.rsn')` },
    { js: `document.querySelector('#panel .cp input.rsn').focus()` },
    { type: 'Run the tests first', after: 200 },
    { shot: path.join(OUT, 'smoke-refuse-reason.png') },
    { key: 'Return', char: '\r' },
    { until: `${has('refuse-exit=125')} && ${has(': Run the tests first')} && !${has('never-2')}`, timeout: 20000 },
    { until: after('Refused') },
    { shot: path.join(OUT, 'smoke-refuse-after.png') },
    // 4. A secret for a program: typed into the card, never into the terminal.
    { type: `"$SMOKE_RAVENRYD" secret 'Smoke test key' -- sh -c 'printf "Key: "; IFS= read -r k; [ "$(printf %s "$k" | cksum)" = "${sum}" ]'; echo "secret-exit=$?"\r` },
    { until: card('secret'), timeout: 20000 },
    { until: `document.querySelector('#panel .cp input.si')` },
    // Half typed, then the focus goes back to the terminal: it is gone.
    { js: `document.querySelector('#panel .cp input.si').focus()` },
    { type: secret.slice(0, 6), after: 200 },
    { until: `document.querySelector('#panel .cp input.si').value.length === 6` },
    // (An offscreen window never has the focus, so the page gets no blur
    // event of its own when the terminal takes it: the step sends it.)
    { js: `${R}.term().focus(); document.querySelector('#panel .cp input.si').dispatchEvent(new FocusEvent('blur'))` },
    { until: `document.querySelector('#panel .cp input.si').value === ''` },
    { js: `document.querySelector('#panel .cp input.si').focus()` },
    { type: secret, after: 200 },
    { until: `document.querySelector('#panel .cp .cnt-c').textContent === '${[...secret].length} characters'` },
    { shot: path.join(OUT, 'smoke-secret.png') },
    { js: click('Send to the terminal') },
    { until: `${has('secret-exit=0')}`, timeout: 20000 },
    { until: after('Secret sent') },
    { shot: path.join(OUT, 'smoke-secret-after.png') },
    { save: { expr: `({ text: ${R}.text(), page: document.body.innerText, html: document.documentElement.outerHTML, inputs: [...document.querySelectorAll('input, textarea')].map((e) => e.value), cps: [...${R}.S.cps.items.values()].map((k) => k.cp) })`, out: path.join(WORK, 'checkpoints.json') } },
  ];
}
