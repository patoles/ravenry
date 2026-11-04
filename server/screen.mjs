// Reads a Claude Code terminal screen (plain text from `cmux read-screen`)
// and says what it shows. Pure functions, no I/O. The rules are written up
// in docs/STATE-RULES.md; keep the two in step.

const RULE = /^\s*─{8,}\s*$/;
// A line that means a shell owns the terminal again (Claude exited).
const SHELL_LINES = [
  /^Resume this session with:/,
  /^➜\s/,                                   // oh-my-zsh prompt
  /^[\w.-]+@[\w.-]+[: ].*[%$#]\s*$/,          // user@host:path %
  /^\S+\s+git:\(.*\)\s*✗?\s*%?\s*$/,
];
// Spinner status above the prompt while Claude works: "· Beaming…",
// "✻ Thinking… (12s · esc to interrupt)", "✶ Waiting for 1 background agent".
const BUSY_LINE = /^\s*[^\w\s"'(\[]\s+([A-Z][\w'’ -]{1,40}…|Waiting for \d+ background agents?)/;
// "✻ Worked for 1h 7m 44s · done 1:09 AM" or "... · done Sunday, Oct 11 at 12:11 PM"
const DONE_LINE = /^\s*[^\w\s]\s+([A-Z][\w'’é-]+) for ([^·]+?)\s+·\s+done\s+([^·]+?)(?:\s+·\s+(.*))?\s*$/;
const DIALOG_HINTS = [
  /Enter to confirm/i,
  /Enter to select/i,
  /Esc to cancel/i,
  /Do you want to (proceed|make this edit|create|run)/i,
  /^\s*❯\s*\d+\.\s/,
];

export function isShellLine(l) {
  return SHELL_LINES.some((re) => re.test(l));
}

function trimLines(text) {
  return String(text || '').replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, ''));
}

// Finds the prompt box "────\n❯ text\n────" nearest the bottom.
function findBox(lines) {
  for (let b = lines.length - 1; b > 0; b--) {
    if (!RULE.test(lines[b])) continue;
    // walk up to the top rule
    for (let a = b - 1; a >= 0 && b - a <= 12; a--) {
      if (RULE.test(lines[a])) {
        const inner = lines.slice(a + 1, b);
        if (inner.length && /^\s*❯/.test(inner[0])) return { top: a, bottom: b, inner };
        break;
      }
    }
  }
  return null;
}

export function parseScreen(text) {
  const lines = trimLines(text);
  const out = {
    readable: text != null,
    claudeLive: false, shell: false, exited: false,
    working: false, busyLine: null,
    done: null, recap: null,
    draft: '', dialog: null,
    agentsRunning: 0,
    resumeId: null,
    body: [], footer: [],
  };
  if (text == null) return out;
  // "Resume this session with: claude --resume <id>" names the session a
  // shell tab last ran, even after Claude exited.
  const rm = [...String(text).matchAll(/claude --resume ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g)].pop();
  if (rm) out.resumeId = rm[1];

  const box = findBox(lines);
  let lastShell = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (isShellLine(lines[i])) { lastShell = i; break; }

  // Dialogs (permission, question, trust) replace the prompt box.
  const dialogAt = (() => {
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
      if (DIALOG_HINTS.slice(0, 4).some((re) => re.test(lines[i]))) return i;
    }
    return -1;
  })();

  if (box && lastShell < box.top) {
    out.claudeLive = true;
  } else if (dialogAt >= 0 && lastShell < dialogAt) {
    out.claudeLive = true;
  } else if (lastShell >= 0) {
    out.shell = true;
    out.exited = !!box || dialogAt >= 0; // Claude UI above, shell below
  }
  if (!out.claudeLive) {
    out.body = lines.filter((l) => l.trim()).slice(-12);
    return out;
  }

  const end = box ? box.top : dialogAt;
  const above = lines.slice(0, end);
  const after = box ? lines.slice(box.bottom + 1) : [];
  out.footer = after.filter((l) => l.trim());

  // Draft: what is typed in the prompt right now.
  if (box) {
    const first = box.inner[0].replace(/^\s*❯\s?/, '');
    const rest = box.inner.slice(1).map((l) => l.replace(/^\s{2}/, ''));
    let draft = [first, ...rest].join('\n').trim();
    if (/^Try "/.test(draft)) draft = ''; // Claude's dim placeholder
    out.draft = draft;
  }

  // Dialog: a question or permission prompt is open.
  // A dialog replaces the prompt box, so hints above a live box are history.
  if (dialogAt >= 0 && (!box || dialogAt > box.bottom)) {
    const zone = lines.slice(Math.max(0, dialogAt - 16), dialogAt + 1);
    const options = [];
    for (const l of zone) {
      const m = l.match(/^\s*(❯)?\s*(\d+)\.\s+(.+?)\s*$/);
      if (m) options.push({ n: Number(m[2]), label: m[3], selected: !!m[1] });
    }
    // Trust dialog uses unnumbered choices.
    if (!options.length) {
      zone.forEach((l) => {
        const m = l.match(/^\s*(❯)?\s{1,4}(Yes[^·]*|No[^·]*)$/);
        if (m) options.push({ n: options.length + 1, label: m[2].trim(), selected: !!m[1] });
      });
    }
    const qLine = [...zone].reverse().find((l) => /\?\s*$/.test(l.trim()) && !/^\s*❯?\s*\d+\./.test(l));
    out.dialog = { question: qLine ? qLine.trim() : null, options, lines: zone.filter((l) => l.trim()).map((l) => l.trim()) };
  }

  // Working: spinner line above the prompt, or the footer offers "esc to interrupt".
  const near = above.slice(-8);
  for (let i = near.length - 1; i >= 0; i--) {
    const l = near[i];
    if (DONE_LINE.test(l)) break;
    const m = l.match(BUSY_LINE);
    if (m) { out.working = true; out.busyLine = l.trim().replace(/^[^\w\s]\s+/, ''); break; }
  }
  if (out.footer.some((l) => /esc to interrupt/i.test(l))) out.working = true;
  out.agentsRunning = out.footer.filter((l) => /^\s*◯\s+\S/.test(l)).length;

  // Done line and recap of the last finished turn.
  for (let i = above.length - 1; i >= Math.max(0, above.length - 40); i--) {
    const m = above[i].match(DONE_LINE);
    if (m) { out.done = { verb: m[1], took: m[2].trim(), when: m[3].trim(), extra: m[4] || null }; break; }
  }
  for (let i = above.length - 1; i >= Math.max(0, above.length - 40); i--) {
    const k = above[i].indexOf('※ recap:');
    if (k >= 0) {
      const parts = [above[i].slice(k + 8).trim()];
      for (let j = i + 1; j < above.length && /^\s{2}\S/.test(above[j]); j++) parts.push(above[j].trim());
      out.recap = parts.join(' ').replace(/\s*\(disable recaps in \/config\)\s*$/, '').trim();
      break;
    }
  }

  // Body: the last lines of real output above the prompt.
  out.body = above.filter((l) => l.trim() && !RULE.test(l)).slice(-12);
  return out;
}

// Titles Claude Code sets on its terminal: "✳ Topic" at rest, a spinner
// glyph while it works. Shell titles look like "user@host:path" or "…/path".
export function parseTitle(title) {
  const t = String(title || '');
  const m = t.match(/^([^\w\s…~/.])\s+(.*)$/u);
  if (!m) return { claude: false, busy: false, topic: null };
  const glyph = m[1];
  return { claude: true, busy: glyph !== '✳', glyph, topic: m[2].trim() };
}

// ------------------------------------------------------------ the live screen
// The board's Live screen (docs/design/LiveScreen.dc.html, variant B) shows
// the terminal trimmed: Claude Code's chrome removed and each tool call as
// one dim line. parseScreen above is left exactly as it was, and the state
// rules keep reading the last 40 lines (tailLines) even when the board read
// 200 lines of scrollback for the selected project.

// The last n lines of a read-screen text, as `cmux read-screen --lines n`
// returns them (its output ends with a newline).
export function tailLines(text, n) {
  if (text == null) return text;
  const s = String(text);
  const parts = s.split('\n');
  const keep = s.endsWith('\n') ? n + 1 : n;
  return parts.length <= keep ? s : parts.slice(-keep).join('\n');
}

// "⏺ Bash(cmd" / "⏺ Web Search(" / "⏺ games - deploy_game (MCP)(html: ...)"
const TOOL_HEAD = /^⏺ ((?:[\w.-]+ - [\w.-]+ \(MCP\))|[A-Z][\w-]*(?: [A-Z][\w-]*)?)\((.*)$/;
// "⏺ Agent "Build phone chips" finished · 8m 7s": a background task's notice.
const TOOL_NOTICE = /^⏺ ([A-Z][\w-]*(?: [a-z]+)?) "[^"]*"/;
// The time at the end of a notice: " · 9m 15s", " · 45s", " · 1h 2m".
const NOTICE_TIME = /\s+·\s+\d+(?:\.\d+)?[hms](?:\s+\d+(?:\.\d+)?[hms])*\s*$/;
// Claude Code prints a background task's notice each time the task stops,
// and an agent that waits on its own background work stops again and again:
// "⏺ Agent "X" is waiting on its own background work · 9m 15s" can fill the
// screen. A run of notices with the same text (their times aside) is one
// entry with the count in `x` and the newest notice's text in `b`. Only the
// shown entries count: blank lines and lines the trim drops sit inside a
// run, any other entry ends it. Notices of other agents, or of the same
// agent with other words ("finished"), are their own runs.
export function foldNotices(entries) {
  const out = [];
  const key = (b) => b.replace(NOTICE_TIME, '');
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (e.k === 't' && e.b && prev && prev.k === 't' && prev.b && key(prev.b) === key(e.b)) {
      out[out.length - 1] = { ...e, x: (prev.x || 1) + 1 };
      continue;
    }
    out.push(e);
  }
  return out;
}
// Lines of a tool's output that are Claude Code's own notes, not output.
const OUT_CHROME = [
  /^Shell cwd was reset/,
  /^Allowed by auto mode/,
  /^\(timeout \d/,
  /^\(another command ran/,
  /^Backgrounded agent/,
  /^Running in the background/,
  /^\((?:No content|No output)\)$/,
  /ctrl\+o to expand/,
];
// Box drawing at the start of a line: a table or a frame, kept unwrapped.
export const BOX_LINE = /^\s*[│├┼┤└┘┌┐╭╮╰╯┃━┏┓┗┛║═╔╗╚╝┬┴]/;
const MARKER = /^(\s*)((?:[-*•]|\d{1,3}[.)])\s+)?/;

const cols = (s) => Array.from(s).length;
const indentOf = (s) => s.match(/^ */)[0].length;
const firstWord = (s) => s.trim().split(/\s+/)[0] || '';

// Claude Code wraps its own text at the terminal width and indents each
// continuation to where the text starts. A line was wrapped when the next
// line's first word would not have fitted after it, and the next line starts
// at that text column. `rows` are { raw, text } where raw is the screen line
// and text is the part shown (its prefix removed).
function unwrap(rows, width) {
  const out = [];
  let cur = null;
  for (const r of rows) {
    if (!r.raw.trim()) { cur = null; out.push(''); continue; }
    if (cur && !BOX_LINE.test(r.raw) && width && cols(cur.last) + 1 + cols(firstWord(r.raw)) > width && indentOf(r.raw) === cur.cont) {
      cur.text += ' ' + r.text.trim();
      cur.last = r.raw;
      out[out.length - 1] = cur.text;
      continue;
    }
    // The column a wrapped continuation of this line would start at.
    const glyphCols = r.cont != null ? r.cont : cols(r.raw) - cols(r.text);
    const m = r.text.match(MARKER);
    cur = BOX_LINE.test(r.raw) ? null : { text: r.text, last: r.raw, cont: glyphCols + m[1].length + (m[2] ? m[2].length : 0) };
    out.push(r.text);
  }
  // No blank runs, none at either end.
  const tidy = [];
  for (const l of out) if (l || (tidy.length && tidy[tidy.length - 1])) tidy.push(l);
  while (tidy.length && !tidy[tidy.length - 1]) tidy.pop();
  return tidy;
}

// "Thinking… (12s · ↓ 1.2k tokens · esc to interrupt)" -> "Thinking… 12s"
function busyWords(line) {
  const t = line.trim().replace(/^[^\w\s]\s+/, '');
  const m = t.match(/^(.*?…)\s*(?:\(([^·)]*))?/);
  if (!m) return t;
  return m[2] && /\d/.test(m[2]) ? `${m[1]} ${m[2].trim()}` : m[1];
}

// "◯ general-purpose  Running the existing test suites   11m 19s · ↓ 164.2k tokens"
function agentRow(line) {
  const t = line.replace(/^\s*◯\s+/, '');
  const parts = t.split(/\s{2,}/);
  if (parts.length >= 3) return { type: parts[0], task: parts.slice(1, -1).join('  '), took: parts[parts.length - 1].split('·')[0].trim() };
  if (parts.length === 2) return { type: parts[0], task: parts[1], took: null };
  return { type: null, task: t.trim(), took: null };
}

// The screen as entries for the Live screen:
//   u  the user's prompt       { k, l: [lines] }
//   c  Claude's text           { k, l, orphan? }  (orphan: its ⏺ line scrolled off)
//   t  a tool call, one line   { k, n: name, a: first line of its input, m: output lines }
//      or a background notice  { k, b: text, x?: how many in a row (foldNotices) }
//   s  a done line             { k, g: glyph, t }
//   r  a recap                 { k, l }
//   o  an interruption note    { k, t }
//   todo  the live spinner's task list { k, l }
//   p  anything else, verbatim { k, l }  (a dialog, a banner, a shell)
// Removed: the prompt box and everything under it (mode line, footer, agent
// list), "Read 1 file (ctrl+o to expand)" and other folded tool groups,
// "› Message from ..." notices, spinner lines (the status row says what the
// live one says), and Claude Code's notes under a tool's output.
// `status` carries the live spinner, the agent list and the last done line.
export function trimScreen(text) {
  const lines = trimLines(text);
  const ps = parseScreen(text);
  const out = { live: ps.claudeLive, width: 0, entries: [], status: null };
  if (text == null) return out;
  const box = ps.claudeLive ? findBox(lines) : null;
  out.width = box ? cols(lines[box.top]) : Math.max(0, ...lines.map(cols));
  if (!ps.claudeLive) {
    const l = unwrap(lines.map((raw) => ({ raw, text: raw })), 0);
    if (l.length) out.entries.push({ k: 'p', l });
    return out;
  }
  const W = out.width;
  const end = box ? box.top : lines.length;
  const above = lines.slice(0, end);
  const footer = box ? lines.slice(box.bottom + 1) : [];
  const agents = footer.filter((l) => /^\s*◯\s+\S/.test(l)).map(agentRow);

  // The live spinner: the last spinner line just above the prompt, as
  // parseScreen finds it.
  let spinAt = -1;
  for (let i = above.length - 1; i >= Math.max(0, above.length - 8); i--) {
    if (DONE_LINE.test(above[i])) break;
    if (BUSY_LINE.test(above[i])) { spinAt = i; break; }
  }

  const entries = [];
  let cur = null;     // the entry lines are being added to
  let mode = null;    // 'text' | 'head' (tool input lines) | 'out' (tool output) | 'drop'
  const start = (e, m) => { entries.push(e); cur = e; mode = m; return e; };
  for (let i = 0; i < above.length; i++) {
    const l = above[i];
    if (!l.trim()) {
      if (cur && cur.rows && mode === 'text') cur.rows.push({ raw: '', text: '' });
      else if (mode !== 'text') { cur = null; mode = null; }
      continue;
    }
    let m;
    if (/^⏺ /.test(l)) {
      if ((m = l.match(TOOL_HEAD))) {
        const arg = m[2];
        const closed = arg.endsWith(')');
        start({ k: 't', n: m[1], a: (closed ? arg.slice(0, -1) : arg + ' …').replace(/^"(.*)"$/, '$1'), m: 0 }, 'head');
      } else if (TOOL_NOTICE.test(l)) start({ k: 't', b: l.slice(2).trim() }, 'drop');
      else start({ k: 'c', rows: [{ raw: l, text: l.slice(2) }] }, 'text');
      continue;
    }
    if (/^❯/.test(l)) { start({ k: 'u', rows: [{ raw: l, text: l.replace(/^❯ ?/, '') }] }, 'text'); continue; }
    if ((m = l.match(/^(\s*※ recap:\s?)/))) { start({ k: 'r', rows: [{ raw: l, text: l.slice(m[1].length), cont: 2 }] }, 'text'); continue; }
    if (/^› /.test(l)) { cur = null; mode = 'drop'; continue; }
    if ((m = l.match(/^(\s*⎿\s*)(.*)$/))) {
      const body = m[2];
      if (cur && cur.k === 't' && !cur.b) {
        const hidden = body.match(/^… \+(\d+) lines?\b/);
        if (hidden) cur.m += Number(hidden[1]);
        else if (!OUT_CHROME.some((re) => re.test(body))) cur.m++;
        mode = 'out';
      } else if (cur && cur.k === 'spin') {
        if (cur.live && !/^Tip:/.test(body)) cur.todo.push(body);
        mode = 'out';
      } else if (/^Interrupted/.test(body)) { start({ k: 'o', t: body }, 'drop'); }
      else { mode = 'drop'; }
      continue;
    }
    if (DONE_LINE.test(l)) {
      const t = l.trim();
      start({ k: 's', g: Array.from(t)[0], t: t.replace(/^[^\w\s]\s+/, '') }, 'drop');
      continue;
    }
    if (BUSY_LINE.test(l)) {
      start({ k: 'spin', live: i === spinAt, todo: [] }, 'drop');
      continue;
    }
    if (/^\s/.test(l)) {
      const ind = indentOf(l);
      if (mode === 'out' && ind >= 5) {
        // A wrapped or further output line of the tool (or the spinner's list).
        if (cur && cur.k === 't' && !cur.b && !(cols(above[i - 1] || '') + 1 + cols(firstWord(l)) > W)) {
          const hidden = l.trim().match(/^… \+(\d+) lines?\b/);
          if (hidden) cur.m += Number(hidden[1]);
          else if (!OUT_CHROME.some((re) => re.test(l.trim()))) cur.m++;
        } else if (cur && cur.k === 'spin' && cur.live) cur.todo.push(l.trim());
        continue;
      }
      if (mode === 'head' && ind >= 4) continue; // a multi-line tool input
      if (mode === 'drop' && ind >= 4) continue;
      // A folded tool group: "  Read 1 file (ctrl+o to expand)".
      if (/\(ctrl\+o to expand\)\s*$/.test(l) && (!above[i - 1] || !above[i - 1].trim() || mode !== 'text')) { cur = null; mode = 'drop'; continue; }
      if (cur && cur.rows && mode === 'text') { cur.rows.push({ raw: l, text: cur.k === 'p' ? l : l.replace(/^ {1,2}/, '') }); continue; }
      start({ k: 'c', orphan: true, rows: [{ raw: l, text: l.replace(/^ {1,2}/, '') }] }, 'text');
      continue;
    }
    // Anything else at column 0: a dialog, a banner, plain output.
    if (cur && cur.k === 'p' && mode === 'text') cur.rows.push({ raw: l, text: l });
    else start({ k: 'p', rows: [{ raw: l, text: l }] }, 'text');
  }

  for (const e of entries) {
    if (e.k === 'spin') {
      if (e.live && e.todo.length) out.entries.push({ k: 'todo', l: e.todo });
      continue;
    }
    if (e.rows) {
      const l = unwrap(e.rows, e.k === 'p' ? 0 : W);
      if (!l.length) continue;
      const x = { k: e.k, l };
      if (e.orphan) x.orphan = true;
      out.entries.push(x);
      continue;
    }
    out.entries.push(e);
  }
  out.entries = foldNotices(out.entries);
  out.status = {
    busy: spinAt >= 0 ? busyWords(above[spinAt]) : null,
    agents,
    done: ps.done,
  };
  return out;
}
