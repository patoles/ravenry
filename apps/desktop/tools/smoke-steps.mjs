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
    // No board: the first launch shows, and a plain shell works anyway.
    { until: `${R}.S.hubStatus && !${R}.S.hubStatus.reachable && !document.getElementById('start').hidden` },
    { shot: path.join(OUT, 'smoke-first.png') },
    { js: `${R}.newShell()` },
    { until: `${attachedTo(0)} && ${has('$ ')}`, timeout: 20000 },
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
