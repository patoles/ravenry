// The Ship view's facts, all read from git (and the brief's "## Ship"
// section). The board never runs a deploy or a push: a project's
// `shipCommand` in the registry is only shown, as a line for the user to run.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

const HOME = os.homedir();
const short = (p) => (p && p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);

function git(dir, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { timeout: 6000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, out) => resolve(err ? null : out.trim()));
  });
}

const cache = new Map(); // repo top -> { at, value, running }

async function repoFacts(top) {
  const [branch, upstream, dirty, last] = await Promise.all([
    git(top, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(top, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    git(top, ['status', '--porcelain', '--untracked-files=no']),
    git(top, ['log', '-1', '--format=%h%x09%cI%x09%s']),
  ]);
  let ahead = null;
  let behind = null;
  if (upstream) {
    const lr = await git(top, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
    if (lr) { const [b, a] = lr.split(/\s+/).map(Number); ahead = a; behind = b; }
  }
  let lastCommit = null;
  if (last) { const [hash, at, ...subject] = last.split('\t'); lastCommit = { hash, at, subject: subject.join('\t') }; }
  return {
    top, topShort: short(top), branch: branch && branch !== 'HEAD' ? branch : null,
    upstream: upstream || null, ahead, behind,
    changed: dirty == null ? null : dirty ? dirty.split('\n').filter(Boolean).length : 0,
    lastCommit,
  };
}

const tops = new Map(); // folder -> { top, at }
async function topOf(folder) {
  const c = tops.get(folder);
  if (c && Date.now() - c.at < 5 * 60 * 1000) return c.top;
  const top = fs.existsSync(folder) ? await git(folder, ['rev-parse', '--show-toplevel']) : null;
  tops.set(folder, { top, at: Date.now() });
  return top;
}

// One entry per git repo the registry's projects live in.
export async function shipView(projects, briefOf) {
  const byTop = new Map();
  for (const p of projects) {
    if (!p.folder) continue;
    const top = await topOf(p.folder);
    if (!top) continue;
    if (!byTop.has(top)) byTop.set(top, []);
    byTop.get(top).push(p);
  }
  const repos = await Promise.all([...byTop.entries()].map(async ([top, ps]) => {
    let c = cache.get(top);
    if (!c || Date.now() - c.at > 15000) {
      c = { at: Date.now(), value: await repoFacts(top) };
      cache.set(top, c);
    }
    const members = ps.map((p) => {
      const b = briefOf(p);
      return {
        id: p.id, name: p.name, state: p.state || null,
        ship: b && b.ship && b.ship.length ? b.ship : null,
        shipCommand: p.shipCommand ? String(p.shipCommand) : null,
        picture: b && b.pictures && b.pictures[0] ? b.pictures[0] : null,
        folder: short(p.folder), subdir: path.relative(top, p.folder) || null,
      };
    });
    return { ...c.value, projects: members };
  }));
  repos.sort((a, b) => (b.ahead || 0) - (a.ahead || 0) || (b.changed || 0) - (a.changed || 0) || Date.parse(b.lastCommit?.at || 0) - Date.parse(a.lastCommit?.at || 0));
  const withUp = repos.filter((r) => r.upstream);
  const shipItems = repos.flatMap((r) => r.projects.flatMap((p) => p.ship || []));
  return {
    repos,
    totals: {
      unpushed: withUp.reduce((n, r) => n + (r.ahead || 0), 0),
      reposAhead: withUp.filter((r) => r.ahead > 0).length,
      reposWithUpstream: withUp.length,
      reposChanged: repos.filter((r) => r.changed > 0).length,
      repos: repos.length,
      // Only when some brief has a Ship section; otherwise there is no source.
      waitingYou: shipItems.length ? shipItems.filter((t) => t.state === 'you').length : null,
    },
  };
}
