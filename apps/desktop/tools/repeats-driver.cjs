// Drives the Settings window for tools/repeats-switch-test.mjs (PAGE-018):
// opens Settings from the app menu, the Behavior tab, and turns Rule
// suggestions on and off again with the window's own box, each time
// reading what the board says and what its projects.json saved. Offscreen;
// never part of the app itself.
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, Menu } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.REPEATS_OUT;
const HUB = process.env.RAVENRY_HUB_URL;
const REG = process.env.REPEATS_REGISTRY;

function findItem(items, label) {
  for (const it of items) {
    if (it.label === label) return it;
    if (it.submenu) { const f = findItem(it.submenu.items, label); if (f) return f; }
  }
  return null;
}
async function until(wc, expr, timeout = 15000) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await wc.executeJavaScript(`(() => { try { return !!(${expr}); } catch { return false; } })()`, true); } catch { /* loading */ }
    if (v) return true;
    if (Date.now() - t0 > timeout) return false;
    await sleep(50);
  }
}
// A picture for the look (the checks never depend on it): scrolled to the switch, painted first.
async function shot(w, name) {
  await w.webContents.executeJavaScript('document.getElementById("repeats").scrollIntoView({ block: "center" })', true).catch(() => {});
  for (let i = 0; i < 5; i++) {
    await sleep(400);
    try { fs.writeFileSync(path.join(OUT, name), (await w.webContents.capturePage()).toPNG()); return; } catch (e) { console.log(`shot ${name}: ${e.message}`); }
  }
}
const saved = () => { try { return JSON.parse(fs.readFileSync(REG, 'utf8')).settings?.repeatsAuto; } catch { return undefined; } };
const board = async () => (await fetch(HUB + '/api/settings/repeats')).json();

module.exports = async function drive() {
  // What the app runs with, for run-app.mjs's check (as driver.cjs records it).
  try { fs.writeFileSync(process.env.RAVENRY_DRIVE + '.env.json', JSON.stringify(Object.keys(process.env).filter((k) => /^(RAVENRY_|TERM_PROGRAM|CMUX_|ITERM_SESSION_ID$|TMUX$|REX_)/.test(k)).sort())); } catch { /* checked by the tool */ }
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  findItem(Menu.getApplicationMenu().items, 'Settings…').click();
  let sw = null;
  for (let i = 0; i < 100 && !sw; i++) { sw = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/settings.html')) || null; if (!sw) await sleep(50); }
  if (!sw) throw new Error('the Settings window did not open');
  const wc = sw.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  await until(wc, 'document.body.dataset.ready === "1"');
  await js('document.querySelector("[data-tab=behavior]").click()');
  check('repeats_box_drawn_off', await until(wc, '!!document.getElementById("repeats") && !document.getElementById("repeats").disabled && !document.getElementById("repeats").checked'),
    await js('[...document.querySelectorAll("#pane-behavior .sec, #pane-behavior .fr2")].map((e) => e.textContent).slice(-2)'));
  check('repeats_off_hint', (await js('document.getElementById("repeats").closest(".fr2").textContent')).includes('Off. Turned on, once a day'), await js('document.getElementById("repeats").closest(".fr2").textContent'));
  await shot(sw, 'electron-repeats-off.png');
  // On, with the window's own box (a click on its label, as the person's).
  await js('document.getElementById("repeats").click()');
  check('repeats_on_drawn', await until(wc, 'document.getElementById("repeats").checked && !document.getElementById("repeats").disabled'), await js('document.getElementById("repeats").closest(".fr2").textContent'));
  const b1 = await board();
  check('repeats_on_saved', b1.on === true && saved() === true, { board: b1, projectsJson: saved() });
  await sleep(1500);
  await shot(sw, 'electron-repeats-on.png');
  // Off again.
  await js('document.getElementById("repeats").click()');
  check('repeats_off_drawn', await until(wc, '!document.getElementById("repeats").checked && !document.getElementById("repeats").disabled'));
  const b2 = await board();
  check('repeats_off_saved', b2.on === false && saved() === false, { board: b2, projectsJson: saved() });
  sw.close();
  fs.writeFileSync(path.join(OUT, 'checks.json'), JSON.stringify(checks, null, 2) + '\n');
};
