// Drives the Settings window for tools/settings-shots.mjs. The main process
// loads it (RAVENRY_DRIVER) once the main window has loaded. Everything is
// offscreen. Never part of the app itself.
//
// It opens Settings through the app menu's own Settings… item (Cmd+,),
// changes settings with the window's own controls, and captures:
//   settings-appearance-<dark|light>.png   the Appearance tab
//   settings-behavior-<dark|light>.png     the Behavior tab
//   settings-import-light.png              after importing a theme file
//   settings-follow-off-dark.png           Follow the system unticked
//   theme-<id>.png                         a real xterm.js in that theme
//                                          (tools/theme-page.ts)
// and writes checks.json: what the settings file and the API said.
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, Menu, nativeTheme, app } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.SETTINGS_SHOTS_OUT;
const IMPORT = process.env.SETTINGS_SHOTS_IMPORT;
const THEME_PAGE = process.env.SETTINGS_SHOTS_THEME_PAGE;

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
    if (v) return;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${expr}`);
    await sleep(50);
  }
}

async function shot(w, name) {
  await sleep(350);
  const img = await w.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name), img.toPNG());
  const s = img.getSize();
  console.log(`shot ${name} ${s.width}x${s.height}`);
  return s;
}

module.exports = async function drive() {
  const checks = {};
  const item = findItem(Menu.getApplicationMenu().items, 'Settings…');
  if (!item) throw new Error('no Settings… item in the app menu');
  checks.menuAccelerator = item.accelerator;
  item.click();
  let sw = null;
  for (let i = 0; i < 100 && !sw; i++) {
    sw = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/settings.html')) || null;
    if (!sw) await sleep(50);
  }
  if (!sw) throw new Error('the Settings window did not open');
  const wc = sw.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  await until(wc, 'document.body.dataset.ready === "1"');
  checks.fonts = await js('[...document.querySelectorAll(".pop select option")].map((o) => o.value)');

  // The picture's Behavior tab has Left picked: picked here with the window's own control.
  await js('document.querySelector("[data-tab=behavior]").click()');
  await until(wc, '!!document.querySelector("[aria-label=\\"Use Option as Meta\\"] [data-value=left]")');
  await js('document.querySelector("[aria-label=\\"Use Option as Meta\\"] [data-value=left]").click()');
  await until(wc, 'document.querySelector("[aria-label=\\"Use Option as Meta\\"] [data-value=left]").getAttribute("aria-checked") === "true"');
  checks.settingsFile = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));

  for (const theme of ['dark', 'light']) {
    nativeTheme.themeSource = theme;
    await sleep(400);
    await js('document.querySelector("[data-tab=appearance]").click()');
    await until(wc, '!document.getElementById("pane-appearance").hidden');
    checks[`appearance-${theme}`] = await shot(sw, `settings-appearance-${theme}.png`);
    checks[`previewTheme-${theme}`] = await js('document.querySelector(".prev").getAttribute("aria-label")');
    await js('document.querySelector("[data-tab=behavior]").click()');
    await until(wc, '!document.getElementById("pane-behavior").hidden');
    checks[`behavior-${theme}`] = await shot(sw, `settings-behavior-${theme}.png`);
  }

  // Import a theme: the window's button, the file given by the test (no dialog offscreen).
  process.env.RAVENRY_SETTINGS_IMPORT = IMPORT;
  await js('document.querySelector("[data-tab=appearance]").click()');
  await until(wc, '!!document.getElementById("import")');
  await js('document.getElementById("import").click()');
  await until(wc, '!!document.getElementById("import-note")');
  checks.importNote = await js('document.getElementById("import-note").textContent');
  checks.importedCard = await js('!!document.querySelector("[data-theme^=\\"user:\\"]")');
  await shot(sw, 'settings-import-light.png');

  // Follow the system unticked: one grid.
  nativeTheme.themeSource = 'dark';
  await sleep(300);
  await js('document.getElementById("follow").click()');
  await until(wc, '!!document.querySelector("[aria-label=Use]")');
  await shot(sw, 'settings-follow-off-dark.png');
  await js('document.getElementById("follow").click()');
  await until(wc, '!document.querySelector("[aria-label=Use]")');

  // The main window's API answers with the same settings.
  const main = BrowserWindow.getAllWindows().find((w) => w !== sw);
  checks.mainApi = await main.webContents.executeJavaScript('window.ravenry.settings.get().then((s) => ({ optionAsMeta: s.settings.optionAsMeta, themeId: s.terminal.themeId, macOptionIsMeta: s.terminal.xterm.macOptionIsMeta, themes: s.themes.length }))', true);

  // A real xterm.js in each Ravenry theme.
  if (THEME_PAGE) {
    for (const [id, theme] of [['ravenry-light', 'light'], ['ravenry-dark', 'dark']]) {
      nativeTheme.themeSource = theme;
      const tw = new BrowserWindow({ width: 1148, height: 850, show: false, useContentSize: true, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } });
      tw.webContents.setFrameRate(60);
      await tw.loadFile(THEME_PAGE, { query: { theme: id } });
      await until(tw.webContents, 'document.body.dataset.ready === "1"');
      await shot(tw, `theme-${id}.png`);
      tw.destroy();
    }
  }

  sw.close();
  fs.writeFileSync(path.join(OUT, 'checks.json'), JSON.stringify(checks, null, 2) + '\n');
};
