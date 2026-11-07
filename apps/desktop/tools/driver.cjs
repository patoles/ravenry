// Drives the app's window for screenshots, checks and measurements. The
// main process loads it when RAVENRY_DRIVER names it, and runs the steps in
// RAVENRY_DRIVE (a JSON file), then quits. Never part of the app itself.
//
// Steps (each an object with one of these keys):
//   ready: true                 wait for the page to finish booting
//   js: "code"                  run code in the page (window.__ravenry is the app)
//   until: "expr", timeout      wait until expr is truthy in the page
//   sleep: ms
//   size: [w, h]                set the window's content size
//   type: "text"                type it as key events ("\r" is Enter)
//   typeJs: "expr"              type the text expr gives in the page
//   key: "Backspace", modifiers  one key (modifiers: ["control"], ...)
//   click: "css selector"       a real mouse click on it (press, hold, release);
//                               clickJs: true when click is an expression
//   shot: "file.png", el        capture the window, or the element el (a
//                               CSS selector) at the window's scale
//   signal: "file"              write a file (for the script that started the app)
//   wait: "file", timeout       wait for a file to exist
//   echo: { n, out }            measure keystroke echo (see below)
//   save: { expr, out }         write the value of expr as JSON
//   theme: "dark" | "light"     switch the window's theme (nativeTheme), so
//                               one state is shot in both
const fs = require('node:fs');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function drive(win, ctx) {
  const plan = JSON.parse(fs.readFileSync(process.env.RAVENRY_DRIVE, 'utf8'));
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const until = async (expr, timeout = 15000) => {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try { v = await js(`(() => { try { return !!(${expr}); } catch (e) { return false; } })()`); } catch { /* reloading */ }
      if (v) return;
      if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${expr}`);
      await sleep(50);
    }
  };
  const key = (keyCode, char, modifiers = []) => {
    // A capital letter needs Shift, as on a keyboard.
    if (/^[A-Z]$/.test(char || '')) modifiers = [...modifiers, 'shift'];
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (char) wc.sendInputEvent({ type: 'char', keyCode: char, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  const type = (text) => {
    for (const ch of text) {
      if (ch === '\r' || ch === '\n') key('Return', '\r');
      else key(ch, ch);
    }
  };
  wc.focus();
  try {
    await runSteps();
  } catch (e) {
    // What the window showed when it failed, beside the plan.
    try {
      fs.writeFileSync(process.env.RAVENRY_DRIVE + '.fail.png', (await wc.capturePage()).toPNG());
      fs.writeFileSync(process.env.RAVENRY_DRIVE + '.fail.txt', String(await js('window.__ravenry && window.__ravenry.text ? window.__ravenry.text() : document.body.innerText')));
    } catch { /* the window is gone */ }
    throw e;
  }

  async function runSteps() {
  for (const step of plan.steps) {
    if (process.env.RAVENRY_DRIVE_LOG) console.log('step', JSON.stringify(step).slice(0, 120));
    if (step.ready) await until('document.body.dataset.ready === "1"', step.timeout || 20000);
    else if (step.js) await js(step.js);
    else if (step.until) await until(step.until, step.timeout);
    else if (step.sleep) await sleep(step.sleep);
    else if (step.size) { win.setContentSize(step.size[0], step.size[1]); await sleep(300); }
    else if (step.type) { type(step.type); await sleep(step.after ?? 100); }
    else if (step.typeJs) { type(String(await js(step.typeJs))); await sleep(step.after ?? 100); }
    else if (step.key) { key(step.key, step.char, step.modifiers); await sleep(step.after ?? 100); }
    else if (step.click) {
      // A real mouse click in the middle of the element: press, a person's
      // pause, release (the page may draw itself again in between).
      const r = await js(`(() => { const e = typeof ${JSON.stringify(step.click)} === 'string' ? (${step.clickJs ? step.click : `document.querySelector(${JSON.stringify(step.click)})`}) : null; if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
      if (!r) throw new Error(`no element ${step.click} to click`);
      wc.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
      wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      await sleep(step.hold ?? 120);
      wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      await sleep(step.after ?? 100);
    }
    else if (step.shot) {
      // Two frames, so what was just written is drawn.
      await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
      await sleep(step.settle || 150);
      let rect;
      if (step.el) {
        const r = await js(`(() => { const e = document.querySelector(${JSON.stringify(step.el)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.floor(b.x), y: Math.floor(b.y), width: Math.ceil(b.width), height: Math.ceil(b.height) }; })()`);
        if (!r) throw new Error(`no element ${step.el} to capture`);
        rect = r;
      }
      const img = rect ? await wc.capturePage(rect) : await wc.capturePage();
      fs.mkdirSync(path.dirname(step.shot), { recursive: true });
      fs.writeFileSync(step.shot, img.toPNG());
    } else if (step.signal) fs.writeFileSync(step.signal, String(Date.now()));
    else if (step.wait) {
      const t0 = Date.now();
      while (!fs.existsSync(step.wait)) { if (Date.now() - t0 > (step.timeout || 20000)) throw new Error('timed out waiting for ' + step.wait); await sleep(50); }
    } else if (step.echo) await echo(step.echo);
    else if (step.save) fs.writeFileSync(step.save.out, JSON.stringify(await js(step.save.expr), null, 2) + '\n');
    else if (step.theme) { require('electron').nativeTheme.themeSource = step.theme; await sleep(step.after ?? 250); }
  }
  }

  // Keystroke echo: the time from the keydown event in the page to xterm.js
  // drawing the echoed cell (its render callback after the cell changed).
  // The shell runs `cat`, so the kernel echoes; alternately "a" and
  // Backspace, one at a time, each after the screen was still.
  async function echo({ n = 200, out }) {
    await js(`(() => {
      const term = window.__ravenry.term().term;
      const E = window.__echo = { t0: 0, want: null, parsed: null, res: [], back: [] };
      window.addEventListener('keydown', () => { E.t0 = performance.now(); E.parsed = null; }, true);
      // Parsed: the echo reached xterm.js through the daemon and was parsed.
      term.onWriteParsed(() => {
        if (E.want !== null && E.parsed === null && term.buffer.active.cursorX === E.want) E.parsed = performance.now();
      });
      // Drawn: xterm.js rendered the rows with the echoed cell.
      term.onRender(() => {
        if (E.want === null || E.parsed === null) return;
        if (term.buffer.active.cursorX === E.want) { E.res.push(performance.now() - E.t0); E.back.push(E.parsed - E.t0); E.want = null; }
      });
    })()`);
    const x0 = await js('window.__ravenry.term().term.buffer.active.cursorX');
    let lost = 0;
    for (let i = 0; i < n; i++) {
      const add = i % 2 === 0;
      await js(`window.__echo.want = ${add ? x0 + 1 : x0}`);
      if (add) key('A', 'a'); else key('Backspace');
      const t0 = Date.now();
      while (await js('window.__echo.want !== null')) {
        if (Date.now() - t0 > 2000) { lost++; await js('window.__echo.want = null'); break; }
        await sleep(2);
      }
      await sleep(40 + Math.floor(Math.random() * 40));
    }
    const stats = (xs) => {
      const s = [...xs].sort((a, b) => a - b);
      const q = (p) => +s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))].toFixed(2);
      return { median_ms: q(0.5), p95_ms: q(0.95), min_ms: q(0), max_ms: q(1) };
    };
    const res = await js('window.__echo.res');
    const back = await js('window.__echo.back');
    const r = {
      samples: res.length, lost,
      keydown_to_drawn: stats(res),
      keydown_to_parsed: stats(back),
      renderer: await js('window.__ravenry.term().renderer'),
      frame_rate: wc.getFrameRate(),
    };
    fs.writeFileSync(out, JSON.stringify(r, null, 2) + '\n');
  }
};
