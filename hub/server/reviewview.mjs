// What a worktree session's review and its project's files show, worked out
// once here for every client (docs/FEATURES.md section 3): a diff split
// into each file's lines with their numbers (moved from the desktop's
// review.ts parseDiff), how Merge goes (a fast-forward, or a merge commit
// once the base branch moved), and in a project's files which file another
// session changed too, and the grid of who changed what. Pure functions,
// tested by tools/reviewview-test.mjs.

/**
 * A unified diff split into its files' lines: { <path>: [{ kind: hunk |
 * add | del | ctx, text, oldNo, newNo }] }, as the review draws them.
 */
export function parseDiff(text) {
  const out = {};
  let cur = null;
  let o = 0, n = 0;
  for (const raw of String(text || '').split('\n')) {
    if (raw.startsWith('diff --git ')) { cur = null; continue; }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).replace(/^b\//, '');
      cur = [];
      out[p === '/dev/null' ? '' : p] = cur;
      continue;
    }
    if (raw.startsWith('--- ') || !cur) continue;
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(raw);
    if (m) { o = Number(m[1]); n = Number(m[2]); cur.push({ kind: 'hunk', text: m[3] ? `@@ ${m[3].trim()} @@` : '@@', oldNo: null, newNo: null }); continue; }
    if (raw.startsWith('+')) cur.push({ kind: 'add', text: raw.slice(1), oldNo: null, newNo: n++ });
    else if (raw.startsWith('-')) cur.push({ kind: 'del', text: raw.slice(1), oldNo: o++, newNo: null });
    else if (raw.startsWith(' ') || raw === '') { if (raw === '' && !cur.length) continue; cur.push({ kind: 'ctx', text: raw.slice(1), oldNo: o++, newNo: n++ }); }
  }
  for (const v of Object.values(out)) while (v.length && v[v.length - 1].kind === 'ctx' && !v[v.length - 1].text) v.pop();
  return out;
}

/** How Merge goes: a merge commit once the base branch moved since the session started, else a fast-forward. */
export const mergeMode = (check) => (check && check.moved > 0 ? 'merge' : 'ff');

/**
 * A project's files (filesview.mjs projectFiles) with what the clients
 * show: on each session's file another session changed too (not only
 * read), `clash`: that session { surfaceId, topic, assistant, at, worktree,
 * same (both in one folder: whoever saves last wins) }; and `grid`: the
 * sessions that changed files as columns, then you, and a row a file (the
 * files two sessions changed first) with each column's counts or null.
 */
export function withClashes(answer) {
  if (!answer || !Array.isArray(answer.sessions)) return answer;
  const sessions = answer.sessions.map((s) => ({
    ...s,
    files: (s.files || []).map((f) => {
      if (f.read) return f;
      for (const o of answer.sessions) {
        if (o.surfaceId === s.surfaceId) continue;
        const of = (o.files || []).find((x) => x.path === f.path && !x.read);
        if (of) return { ...f, clash: { surfaceId: o.surfaceId, topic: o.topic || null, assistant: o.assistant || null, at: of.at || null, worktree: !!o.worktree, same: !s.worktree && !o.worktree } };
      }
      return f;
    }),
  }));
  const cols = sessions.filter((s) => s.files.length);
  const rows = new Map();
  const cell = (f) => (f ? { added: f.added || 0, removed: f.removed || 0, read: !!f.read } : null);
  cols.forEach((s, i) => { for (const f of s.files) { const r = rows.get(f.path) || Array(cols.length + 1).fill(null); r[i] = cell(f); rows.set(f.path, r); } });
  for (const f of answer.you || []) { const r = rows.get(f.path) || Array(cols.length + 1).fill(null); r[cols.length] = cell(f); rows.set(f.path, r); }
  const changed = (r) => r.filter((c) => c && !c.read).length;
  const grid = {
    cols: cols.map((s) => ({ surfaceId: s.surfaceId, topic: s.topic || null, assistant: s.assistant || null })),
    you: (answer.you || []).length > 0,
    rows: [...rows].sort((a, b) => changed(b[1]) - changed(a[1]) || a[0].localeCompare(b[0])).map(([path, cells]) => ({ path, cells, clash: changed(cells) > 1 })),
  };
  return { ...answer, sessions, grid };
}
