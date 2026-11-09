// What the Machines page shows of each machine (MACH-001 to MACH-004),
// worked out once for every client: its state word and colour, whether it
// needs the person, where it sorts, the line that says what to do, its
// buttons, its facts, the Uninstall question and each step of its last job
// with its words, bar, time, fix and button. Moved from the desktop's
// renderer/machines.ts (status(), card(), steps(), needsYou()) for the
// native Mac app; the desktop still works it out itself.
//
// Words are runs: { text, b } bold, { text, mono } a path or a command in
// the monospace face, { text, cmd } a command on its own chip. A button is
// { label, route, body, style } (style 'pri', 'ghost', 'danger' or ''),
// or { label, confirm: true } for Uninstall, which asks first on the page.
// Whatever the person folded away (Hide steps) is the client's: `folded`
// holds the same answers as if the job were gone.

const SYSTEM = { darwin: 'macOS', linux: 'Linux' };
const ARCH = { amd64: 'x86-64', x64: 'x86-64', arm64: 'arm64' };
const systemOf = (os, arch) => (os ? `${SYSTEM[os] || os}${arch ? `, ${ARCH[arch] || arch}` : ''}` : null);
const mb = (n) => `${(n / 1048576).toFixed(1)}`;

/** A machine needs the person: older or another protocol, not installed, or an install that stopped. */
export function needsYou(m) {
  if (m.job && (m.job.state === 'failed' || m.job.state === 'needs')) return true;
  return m.compare === 'older' || m.compare === 'protocol' || m.compare === 'missing';
}

/** Paths in a step's words, set in the monospace face. */
export function words(text) {
  if (!text) return [];
  const out = [];
  const re = /((?:~|\/)[\w.@+-]*(?:\/[\w.@+-]+)+|ssh-copy-id \S+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[1], mono: true });
    last = m.index + m[1].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** The state word beside a machine's name, and its colour. */
export function status(m) {
  const j = m.job;
  if (j && j.state === 'running') return [j.kind === 'install' ? (m.compare === 'older' || m.version ? 'Updating' : 'Installing') : 'Uninstalling', 'work'];
  if (j && j.state === 'needs') return ['Sessions still run there', 'bad'];
  if (j && j.state === 'failed') return [j.kind === 'install' ? 'Install stopped' : 'Uninstall stopped', 'bad'];
  if (m.compare === 'protocol') return ['Cannot talk to it', 'bad'];
  if (m.state === 'connected') {
    if (m.compare === 'older') return ['Older ravenryd', 'you'];
    if (m.compare === 'newer') return ['Newer ravenryd', 'you'];
    if (j && j.state === 'done' && j.steps.some((s) => s.state === 'warn')) return ['Installed, hooks left as they were', 'you'];
    return ['Connected', 'ok'];
  }
  if (m.missing) return ['Not installed', 'off'];
  if (m.state === 'held') return ['Paused', 'off'];
  if (m.state === 'connecting' || m.state === 'off') return ['Connecting', 'off'];
  return ['Cannot connect', 'bad'];
}

const T = (text, more = {}) => ({ text, ...more });
const btn = (label, route, body, style = '') => ({ label, route, body, style });

/** The line that says what to do, and the buttons (the main one last). */
function whatToDo(m) {
  const j = m.job;
  const ours = m.ours;
  const name = m.name;
  const install = (style, label, extra = {}) => btn(label, '/api/machines/install', { name, ...extra }, style);
  const remove = () => btn('Remove', '/api/machines/remove', { name }, 'ghost');
  if (j && j.state === 'running') return { msg: null, actions: [] };
  if (j && j.state === 'failed') return { msg: null, actions: [remove(), j.kind === 'install' ? install('', 'Try again') : btn('Try again', '/api/machines/uninstall', { name })] };
  if (j && j.state === 'needs') return { msg: null, actions: [] };
  if (m.compare === 'protocol') {
    const r = m.remote;
    const newerProto = !!(r && r.protocol != null && r.protocol > 1);
    const msg = [T(`${name} runs ravenryd `), T(r ? r.version : 'of another protocol', { b: true }), T(r && r.protocol != null ? `, which speaks protocol ${r.protocol}` : ''), T('; this app speaks protocol 1. '),
      T(newerProto ? `Update this app to use it${ours ? `, or install ${ours} there` : ''}.` : 'Update it there: its sessions keep running on the old daemon until they end.')];
    return { msg, actions: ours ? [install(newerProto ? '' : 'pri', newerProto ? `Install ${ours} there` : `Update ${name}`)] : [] };
  }
  if (m.state === 'connected' && m.compare === 'older') {
    return {
      msg: [T(`${name} runs ravenryd `), T(m.version || '?', { b: true }), T('; this app carries '), T(ours || '?', { b: true }), T(`. Its sessions keep running on ${m.version || 'it'} until they end; new sessions start on ${ours || 'the new one'}.`)],
      actions: [install('pri', `Update ${name}`)],
    };
  }
  if (m.state === 'connected' && m.compare === 'newer') {
    return {
      msg: [T(`${name} runs ravenryd `), T(m.version || '?', { b: true }), T(', newer than this app\'s '), T(ours || '?', { b: true }), T('. It works: the protocol is the same. Update this app to use what is new there.')],
      actions: [install('', `Install ${ours} there`)],
    };
  }
  if (m.state === 'connected') return { msg: null, actions: ours ? [{ label: 'Uninstall', confirm: true, style: 'ghost' }, install('', 'Run install again')] : [] };
  if (m.missing) {
    return {
      msg: [T(`ssh reaches ${name}, but ravenryd is not there yet. Install puts it in `), T('~/.ravenry/bin', { mono: true }), T(' and adds the hooks; no sudo.')],
      actions: [remove(), ...(ours ? [install('pri', 'Install')] : [])],
    };
  }
  if (m.state === 'down') {
    const x = m.explain;
    return {
      msg: [...words(x ? x.why : m.error || 'ssh closed the connection.'), ...(x && x.fix ? [T(' '), T(x.fixWhat || ''), T(' '), T(x.fix, { cmd: true })] : [])],
      actions: [remove(), btn('Try again', '/api/machines/retry', { name })],
    };
  }
  return { msg: null, actions: [] };
}

/** One step of a job, as its row draws it. */
function stepView(m, j, s) {
  const going = s.state === 'running' && s.progress && s.progress.total;
  let action = null;
  if (s.action === 'replaceHooks' && j.state === 'done') action = { buttons: [btn('Use Ravenry\'s instead', '/api/machines/install', { name: m.name, replaceHooks: true })], hint: 'Uninstall puts yours back.' };
  if (s.action === 'endSessions' && j.state === 'needs') action = { buttons: [btn(`End ${j.needs && j.needs.count === 1 ? 'it' : 'them'} and uninstall`, '/api/machines/uninstall', { name: m.name, endSessions: true }, 'danger'), { label: 'Cancel', fold: true, style: 'ghost' }], hint: null };
  return {
    id: s.id, state: s.state, icon: s.state === 'skipped' ? 'pending' : s.state, title: s.title,
    detail: s.detail ? words(s.detail) : null,
    bar: going ? Math.round((100 * s.progress.done) / s.progress.total) : null,
    time: going ? `${mb(s.progress.done)} of ${mb(s.progress.total)} MB` : s.ms != null && s.state === 'done' && s.ms >= 1000 ? `${(s.ms / 1000).toFixed(1)} s` : null,
    fix: s.fix ? { what: s.fixWhat || null, cmd: s.fix } : null,
    action,
  };
}

/** Everything the card shows, for the machine with its job and with the job folded away. */
export function machineCard(m) {
  const [word, tone] = status(m);
  const j = m.job;
  const running = !!(j && j.state === 'running');
  const { msg, actions } = whatToDo(m);
  const facts = [];
  if (m.state === 'connected') {
    const sys = systemOf(m.os, m.arch);
    if (sys) facts.push([T(sys)]);
    if (m.version && m.compare !== 'older' && m.compare !== 'newer') facts.push([T('ravenryd '), T(m.version, { b: true })]);
    for (const v of m.older || []) facts.push([T(`Sessions on ${v} until they end`)]);
    facts.push([T(m.answers ? 'Answers from here' : 'Another board takes its answers')]);
  }
  const needs = !running && needsYou(m);
  const folded = !running && needsYou({ ...m, job: null });
  const order = (n) => (running ? 0 : n ? 1 : m.state === 'connected' ? 3 : 2);
  const tag = (n) => (n || (m.state === 'connected' && m.compare === 'newer') ? (tone === 'bad' ? 'bad' : 'att') : '');
  return {
    word, tone, running, needs, needsFolded: folded, order: order(needs), orderFolded: order(folded), tag: tag(needs), tagFolded: tag(folded),
    msg, actions, facts,
    // Steps shown while running; once done or stopped, until the person hides them.
    job: j ? { key: `${m.name}|${j.startedAt}`, state: j.state, canHide: j.state === 'done' || j.state === 'failed', factsWithSteps: j.state === 'done', steps: j.steps.map((s) => stepView(m, j, s)) } : null,
    confirm: m.state === 'connected' && m.ours ? {
      words: [T(`Uninstall from ${m.name}?`, { b: true }), T(' Ravenry removes what it installed there: '), T('~/.ravenry/bin/ravenryd', { mono: true }), T(', the '), T('ravenry', { mono: true }), T(' link beside it, and its hook lines in Claude Code\'s and Codex\'s settings (each backed up first). '), T(`${m.name} then leaves this list. Its pane logs stay.`)],
      yes: btn('Uninstall', '/api/machines/uninstall', { name: m.name }, 'danger'),
    } : null,
  };
}
