// The launch page's product pictures, demo content only. <div data-rv="mac"></div> etc.
// Each picture has a fixed size and is scaled to the width of its box.
(function () {
  const RAVEN = '<path d="M95 34 C89 28 82 24 75 23 C66 21 58 24 54 30 C50 36 46 40 40 46 C32 54 24 64 18 74 L6 92 L20 94 L28 84 C36 80 48 78 56 76 C68 72 76 62 76 52 C76 46 74 43 78 40 C84 37 90 36 95 34 Z" fill="currentColor"/><path d="M50 74 h5 v12 h-5 Z M60 72 h5 v14 h-5 Z M34 85 H86 a3 3 0 0 1 0 6 H34 a3 3 0 0 1 0 -6 Z" fill="currentColor"/>';
  const mark = (size, eye = '#0A84FF') => `<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true"><g transform="translate(4.77 -2.10) scale(0.8954)">${RAVEN}<circle cx="65" cy="32" r="6.5" fill="${eye}"/></g></svg>`;
  window.RVMARK = mark;
  const ring = '<i class="rv-ring"></i>';
  const askIc = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="2.5" width="12" height="9" rx="2"/><path d="M5 14l2-2.5M5.5 6h5M5.5 8.5h3"/></svg>';
  const runIc = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M4.5 6.5l2 1.5-2 1.5M8 10h3"/></svg>';
  const keyIc = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="5" cy="11" r="3"/><path d="M7.2 8.8L13 3M11 5l2 2"/></svg>';
  const picIc = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="M2 11l4-4 3 3 2-2 3 3"/></svg>';
  const touch = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 6.5a4 4 0 0 1 8 0v2M6 7a2 2 0 0 1 4 0v3M8 7.5v4.5M3.5 9.5v1M12 10.5c0 1.5-.5 2.5-1 3.5M5.5 10c0 2 .5 3 1 4"/></svg>';
  const boat = (tilt, hull) => `<svg viewBox="0 0 120 80"><rect width="120" height="80" fill="#D7E6F2"/><path d="M0 58 Q30 ${50 - tilt} 60 58 T120 58 V80 H0Z" fill="#6FA3CF"/><g transform="rotate(${tilt} 60 52)"><path d="M34 50 H86 L78 62 H42Z" fill="${hull}"/><path d="M60 22 V50 M60 24 L80 46 H60" stroke="#333" stroke-width="1.5" fill="#fff"/></g></svg>`;
  const nav = (n, extra = '') => `<div><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="7" cy="7" r="5"/></svg>${n}${extra}</div>`;

  const sidebar = (o = {}) => `
    <div class="rv-side">
      <div class="rv-lights"><i></i><i></i><i></i></div>
      <div class="rv-brand">${mark(18)}Ravenry<span class="plus">+</span></div>
      <div class="rv-tri"><i></i><i></i><i></i></div>
      <div class="rv-sec you"><div class="rv-sh">${ring}Needs you<span class="rv-cnt">2</span></div>
        <div class="rv-proj">paper-boat<span>12:12</span></div>
        <div class="rv-row on"><div class="rv-r1"><i class="rv-dot you"></i>Tilting the hull<span class="rv-tag">Claude</span><span class="rv-pct hot">59%</span></div><div class="rv-r2">Tilt the hull with the slope too, or keep it level?</div></div>
        <div class="rv-proj">garden-planner<span>12:10</span></div>
        <div class="rv-row"><div class="rv-r1"><i class="rv-dot you"></i>Planting reminders<span class="rv-tag">Claude</span><span class="rv-pct">31%</span></div><div class="rv-r2">Run npm test and commit the reminders?</div></div>
      </div>
      <div class="rv-sec work"><div class="rv-sh">${ring}Working<span class="rv-cnt">2</span></div>
        <div class="rv-proj">notes-app<span>now</span></div>
        <div class="rv-row"><div class="rv-r1"><i class="rv-dot work"></i>Sync settings<span class="rv-tag">Codex</span><span class="rv-pct">12%</span></div></div>
        <div class="rv-proj">recipe-box<em><svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" style="vertical-align:-1px;margin-right:3px"><rect x="1.5" y="1.5" width="9" height="4" rx="1"/><rect x="1.5" y="6.5" width="9" height="4" rx="1"/><circle cx="3.6" cy="3.5" r=".5" fill="currentColor"/><circle cx="3.6" cy="8.5" r=".5" fill="currentColor"/></svg>studio</em><span>now</span></div>
        <div class="rv-row"><div class="rv-r1"><i class="rv-dot work"></i>Old recipe import<span class="rv-tag">Claude</span><span class="rv-pct">40%</span></div></div>
      </div>
      <div class="rv-sec idle"><div class="rv-sh">${ring}Idle<span class="rv-cnt">3</span></div></div>
      ${o.nav === false ? '' : `<div class="rv-nav">${nav('Objectives')}${nav('Plans', '<b>1 running</b>')}${nav('Ideas')}${nav('Rules')}${nav('Ship')}${nav('Decisions')}</div>
      <div class="rv-foot"><i></i><i></i><i></i><i></i><span>Claude 2.8 GB</span></div>`}
    </div>`;

  const term = `<span class="g">  ▐▛███▜▌</span>   <span class="w">Claude Code</span>
<span class="g"> ▝▜█████▛▘</span>  <span class="g">~/Projects/paper-boat</span>

<span class="pr"><span class="g">›</span> Make the boat rock with the waves</span>
<span class="o">●</span> The hull now follows the wave height under its middle.

<span class="o">●</span> <span class="w">Update</span>(src/boat.ts)
  <span class="g">⎿  Added 14 lines, removed 3 lines</span>

<span class="o">●</span> <span class="w">Bash</span>(npm test)
  <span class="g">⎿  42 passed</span>

<span class="o">●</span> The boat rocks with the waves. On a slope it stays level,
  which looks odd on the test pond.
<span class="box"><span class="a">☐ Hull</span>

<span class="w">Tilt the hull with the slope too, or keep it level?</span>

<span class="sel">› 1. Tilt it with the slope</span>
  2. Keep it level
  3. Try both and show me
  4. Type something.</span><span class="g">  Answered in Ravenry's panel or on your phone.</span>`;

  const askCard = (o = {}) => `
    <div class="rv-card">
      <div class="rv-ch">${askIc}Claude asks<span>waiting 2 min</span></div>
      <div class="rv-q">Tilt the hull with the slope too, or keep it level?</div>
      <div class="rv-p">The slope is 8 degrees on the test pond.</div>
      ${o.dec === false ? '' : `<div class="rv-dec"><b>Checked your decisions first</b><p>"Test on the pond before the bath" today</p><p>"The hull stays level on slopes under 10 degrees" Nov 13</p></div>`}
      <div class="rv-opt"><i>1</i>Tilt it with the slope</div>
      <div class="rv-opt"><i>2</i>Keep it level</div>
      <div class="rv-opt"><i>3</i>Try both and show me</div>
      <div class="rv-own">Or answer in your own words<span>↑</span></div>
    </div>`;
  const approveCard = () => `
    <div class="rv-card">
      <div class="rv-ch">${runIc}Claude wants to run<span>waiting 1 min</span></div>
      <div class="rv-cmd mono">npm publish --tag beta</div>
      <dl class="rv-kv"><dt>Folder</dt><dd class="mono">~/Projects/notes-app</dd><dt>Machine</dt><dd>This Mac</dd></dl>
      <div class="rv-warn">⚠<span>Ravenry's guess: <b>publishing can't be undone</b></span></div>
      <div class="rv-acts"><span class="rv-btn pri rv-touch">${touch}Run on this Mac</span><span class="rv-btn">Edit</span><span class="rv-btn red">Refuse</span></div>
    </div>`;
  const secretCard = () => `
    <div class="rv-card">
      <div class="rv-ch">${keyIc}Claude needs a secret<span>waiting 2 min</span></div>
      <div class="rv-q">Paste the API token for the map tiles</div>
      <div class="rv-p">For <span class="mono">tiles secret put TILES_TOKEN</span> in ~/Projects/garden-planner</div>
      <div class="rv-field"><span class="rv-dots">••••••••••••••••</span><span>◉</span></div>
      <div class="rv-lock">Goes straight to that command, not to Claude</div>
      <div class="rv-lock">Not kept in logs, history or on your phone</div>
      <div class="rv-acts"><span class="rv-btn pri">Send to the terminal</span><span class="rv-btn ghost">Not now</span></div>
    </div>`;
  const pickCard = () => `
    <div class="rv-card">
      <div class="rv-ch">${picIc}Claude asks you to pick<span>waiting 1 min</span></div>
      <div class="rv-q">Which hull colour?</div>
      <div class="rv-pics"><div>${boat(0, '#C45640')}<span>A. Red</span></div><div class="on">${boat(5, '#4878BE')}<span>B. Blue</span></div><div>${boat(-4, '#5AA060')}<span>C. Green</span></div></div>
      <div class="rv-acts"><span class="rv-btn pri">Pick B</span><span class="rv-btn ghost">None of these</span></div>
    </div>`;

  const panel = `
    <div class="rv-panel">
      <div class="rv-ph">paper-boat<span class="rv-tag">Claude</span></div>
      <div class="rv-since">${ring}Needs you since 12:12</div>
      ${askCard()}
      <div class="rv-box" style="margin-top:10px"><h5>Context<span>312k of 1M</span></h5><div class="rv-bar"><i></i><b></b></div><div style="display:flex;justify-content:space-between;align-items:center"><span class="rv-link">Hands off at 50%</span><span class="rv-btn">Hand off now</span></div></div>
      <div class="rv-box"><h5>Brief<span>›</span></h5><div style="font-size:12.5px">Goal: a paper boat that floats on any pond, made in a minute.</div><div style="font-size:12px;color:var(--tx2);margin-top:4px">Next: waves, then the folding guide.</div></div>
    </div>`;

  const mac = () => `<div class="rv-mac">${sidebar()}<div class="rv-mid"><div class="rv-tabs"><span class="sq"></span><span class="rv-tab">›_ zsh ~</span><span class="rv-tab on"><i class="rv-dot you"></i>Tilting the hull <span class="p">paper-boat</span></span><span class="rv-tab">+</span></div><div class="rv-term mono">${term}</div></div>${panel}</div>`;

  const decisions = () => `<div class="rv-list" style="width:420px">
    <div class="rv-li"><q>The hull stays level on slopes under 10 degrees.</q><small><b>paper-boat</b> · Nov 13 · from a question you answered</small></div>
    <div class="rv-li"><q>Test on the pond before the bath.</q><small><b>paper-boat</b> · today · from a question you answered</small></div>
    <div class="rv-li"><q>Reminders go out a week before sowing.</q><small><b>garden-planner</b> · Nov 11 · from a picture you picked</small></div>
    <div class="rv-li"><q>Never publish without a dry run first.</q><small><b>All projects</b> · Nov 9 · a rule you wrote</small></div>
  </div>`;
  const handoff = () => `<div class="rv-list" style="width:420px;padding:14px 16px">
    <div style="display:flex;justify-content:space-between;font-weight:600;font-size:13px;margin-bottom:8px">Hand-off<span style="color:var(--tx2);font-weight:400">at 50% of context</span></div>
    <div class="rv-bar"><i style="width:50%"></i><b></b></div>
    <div style="font-size:13.5px;font-weight:500;margin-bottom:4px">Sowing windows and frost dates are in.</div>
    <div style="color:var(--tx2);font-size:12px;margin-bottom:10px">Next: the reminder card, then the settings screen. Open items: one question on the first frost-free day.</div>
    <div style="display:flex;gap:8px"><span class="rv-btn pri">Continue in a fresh session</span><span class="rv-btn">Read the brief</span></div>
  </div>`;
  const board = () => `<div class="rv-mac" style="width:260px;height:auto;padding:6px">${sidebar({ nav: false })}</div>`;

  // The Sessions page (SESS-029): the memory by state, the idle ones ticked,
  // the ones left for you unticked with the reason, Recently closed with Reopen.
  const check = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5.2l2 2L8 3" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const crow = (on, name, mem, line, age, why = '') => `<div class="rv-crow"><span class="rv-tick${on ? ' on' : ''}">${on ? check : ''}</span><div class="rv-cm"><div class="rv-c1"><b>${name}</b>${why ? `<span class="rv-why">${why}</span>` : ''}<span class="rv-mem">${mem}</span></div><div class="rv-c2"><span>${line}</span><em>${age}</em></div></div></div>`;
  const scard = (title, sub, body) => `<div class="rv-scard"><div class="rv-sch">${title}<span>${sub}</span></div>${body}</div>`;
  const sessions = () => `<div class="rv-mac rv-sess" style="width:460px;height:auto;flex-direction:column;gap:0;padding:8px 8px 10px">
    <div class="rv-lights" style="padding:6px 6px 12px"><i></i><i></i><i></i></div>
    <div class="rv-shead"><div><h4>Sessions</h4><p>7 sessions hold <b>4.1 GB</b> of memory.</p></div><span class="rv-btn pri">Close 2 sessions, frees 1.1 GB</span></div>
    <div class="rv-mbar"><i style="flex:1210;background:var(--you)"></i><i style="flex:1499;background:var(--work)"></i><i style="flex:1506;background:var(--idle)"></i></div>
    <div class="rv-legend"><span><i style="background:var(--you)"></i>Needs you <b>1.2 GB</b></span><span><i style="background:var(--work)"></i>Working <b>1.5 GB</b></span><span><i style="background:var(--idle)"></i>Idle <b>1.5 GB</b></span></div>
    ${scard('Handed off', '1 session, 803 MB', crow(true, 'trail-log', '803 MB', 'Map tiles cached for offline use.', 'handed off 2 d'))}
    ${scard('No activity for 1 h or more', '1 session, 291 MB', crow(true, 'weather-widget', '291 MB', 'Done: whole degrees everywhere, tests pass.', '3 d'))}
    ${scard('Left for you', '2 sessions, 1.0 GB', crow(false, 'garden-planner', '598 MB', 'Run npm test and commit the reminders?', '12 min', 'Asked you a question') + crow(false, 'pocket-scanner', '412 MB', 'Scan receipts into the monthly sheet', '5 h', 'Half-typed reply'))}
    ${scard('Recently closed', '1 session, kept for 14 days', `<div class="rv-crow rv-closed"><div class="rv-cm"><div class="rv-c1"><b>lighthouse</b><em>closed 1 d ago</em><span class="rv-mem">402 MB</span></div><div class="rv-c2"><span>Audit scores up to 98 on every page.</span></div></div><span class="rv-btn">Reopen</span></div>`)}
  </div>`;

  const termOnly = () => `<div class="rv-mac" style="width:900px;height:520px;padding:0;gap:0"><div class="rv-mid" style="border-radius:12px"><div class="rv-tabs"><span style="display:flex;gap:7px;margin:0 10px 0 4px" class="rv-lights"><i></i><i></i><i></i></span><span class="rv-tab">›_ zsh ~</span><span class="rv-tab on"><i class="rv-dot work"></i>Sync settings <span class="p">notes-app</span></span><span class="rv-tab">Old recipe import <span class="p">recipe-box</span></span><span class="rv-tab">+</span></div>
    <div style="display:flex;flex:1;min-height:0"><div class="rv-term mono" style="flex:1;border-right:1px solid #2A2A2E"><span class="g">~/Projects/notes-app ›</span> codex
<span class="w">Codex</span> <span class="g">in ~/Projects/notes-app</span>

<span class="pr"><span class="g">›</span> Sync the settings across devices</span>
<span class="b">•</span> Reading src/settings/*.ts
<span class="b">•</span> Adding a sync store with a last-write-wins merge
<span class="b">•</span> Running the tests
  <span class="o">✓ 118 passed</span>  <span class="g">in 2.4 s</span>
<span class="b">•</span> Writing the migration for old settings files<span class="g">…</span></div>
    <div class="rv-term mono" style="flex:0.8"><span class="g">~/Projects/notes-app ›</span> npm run dev

  <span class="o">ready</span> in 412 ms
  Local: <span class="b">http://localhost:5173/</span>

<span class="g">17:24:02</span> page reload src/settings/sync.ts
<span class="g">17:24:09</span> page reload src/settings/store.ts</div></div></div></div>`;

  // The phones: the Android app's real screens, emulator screenshots on
  // the demo board (paper-boat asks the question the Mac window shows).
  // card: the alert tapped, the app open on the question; board: the same
  // question in place on the board; alerts: the notification shade.
  const phoneShot = (name, eager) => () => `<div class="rv-phone"><div class="rv-screen"><img src="assets/phone-${name}.webp" alt="" width="600" height="1334"${eager ? '' : ' loading="lazy"'}></div></div>`;
  const SIZES = { mac: [1280, 800, mac], board: [260, 0, board], ask: [340, 0, askCard], approve: [340, 0, approveCard], secret: [340, 0, secretCard], pick: [340, 0, pickCard], decisions: [420, 0, decisions], handoff: [420, 0, handoff], phone: [380, 800, phoneShot('board')], shade: [380, 800, phoneShot('alerts')], term: [900, 520, termOnly], sessions: [460, 0, sessions], appQ: [380, 800, phoneShot('card', true)] };
  function mount() {
    for (const el of document.querySelectorAll('[data-rv]')) {
      const [w, h, fn] = SIZES[el.dataset.rv];
      el.classList.add('rv-fit');
      const inner = document.createElement('div');
      inner.className = 'rv rv-inner'; inner.dataset.theme = el.dataset.theme || 'dark';
      inner.style.width = w + 'px';
      inner.innerHTML = fn();
      if (el.dataset.rv === 'mac' || el.dataset.rv === 'board' || el.dataset.rv === 'term' || el.dataset.rv === 'sessions') inner.firstElementChild.classList.add('rv'), inner.firstElementChild.dataset.theme = inner.dataset.theme;
      if (el.dataset.rv === 'phone' || el.dataset.rv === 'shade' || el.dataset.rv === 'appQ') inner.style.padding = '10px';
      el.appendChild(inner);
      const fit = () => { const s = el.clientWidth / w; inner.style.transform = `scale(${s})`; el.style.height = (h || inner.offsetHeight) * s + 'px'; };
      fit(); new ResizeObserver(fit).observe(el);
    }
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', mount) : mount();
})();
