// Paths and commands the phase D views use. Every one can be overridden in
// the registry's "settings" (or by env), so tests point them at temp copies
// and never at the real ~/.claude/CLAUDE.md, project CLAUDE.md files or a
// real `claude` run.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HOME_OVERRIDE, SCRATCH_DATA, inRepoTmp } from './home.mjs';
import { codexHome } from './codexrollout.mjs';

const H = os.homedir();
const env = process.env;

// Claude Code names a project's folder under ~/.claude/projects by its path
// with every character that is not a letter, digit or dash turned into "-".
export function claudeProjectDir(folder) {
  return path.join(H, '.claude', 'projects', folder.replace(/[^A-Za-z0-9-]/g, '-'));
}

// The scope for rule suggestions (the Rules view): every project on the
// board with a folder, plus the projects root (sessions started there).
// Each source's transcripts are read from claudeProjectDir(folder), or from
// `transcripts` when a source names it (tests); Codex's sessions in it come
// from Codex's rollouts by their folder (server/repeats.mjs). Its rules files
// are CLAUDE.md (Claude Code) and AGENTS.md (Codex) at the folder's root. A
// registry can list its own in settings.ruleSources.
export function defaultRuleSources(projects = [], root = null) {
  const seen = new Set();
  const out = [];
  const add = (label, folder) => {
    if (!folder || seen.has(folder)) return;
    seen.add(folder);
    out.push({ label, folder, memory: path.join(claudeProjectDir(folder), 'memory'), claudeMd: path.join(folder, 'CLAUDE.md'), agentsMd: path.join(folder, 'AGENTS.md') });
  };
  for (const p of projects || []) if (p && !p.hidden && p.folder && !inRepoTmp(p.folder)) add(p.name || path.basename(p.folder), p.folder);
  if (root) add('Projects folder', root);
  return out;
}

function claudeBin() {
  if (env.MC_CLAUDE_BIN) return env.MC_CLAUDE_BIN;
  const local = path.join(H, '.local', 'bin', 'claude');
  return fs.existsSync(local) ? local : 'claude';
}

// `projects` (the registry's) is the default scope of the Rules view.
export function config(settings = {}, projects = []) {
  const c = configRaw(settings, projects);
  // A mockup round needs only its prompt and Read, so it skips the user's
  // settings (CLAUDE.md, hooks) and MCP servers like the repeats detector:
  // with them one turn read 63,909 input tokens before the prompt, without
  // them 3,959 (measured 2026-11-03, `claude -p` asked for one word).
  if (!c.mockupCommand) c.mockupCommand = [...c.printCommand, '--strict-mcp-config', '--setting-sources', 'project,local', '--model', 'sonnet', '--output-format', 'json'];
  return c;
}

function configRaw(settings, projects) {
  const bin = settings.claudeBin || claudeBin();
  return {
    // The server resolves the full order (MC_PROJECTS_ROOT, the setting, the
    // folder most projects share, the first-run suggestion) in
    // server/projectsroot.mjs and puts the answer here.
    // A test's scratch folder is never a real board's root (home.mjs).
    projectsRoot: [env.MC_PROJECTS_ROOT, settings.projectsRoot].find((r) => r && (SCRATCH_DATA || !inRepoTmp(r))) || null,
    globalClaudeMd: env.MC_GLOBAL_CLAUDE_MD || settings.globalClaudeMd || path.join(H, '.claude', 'CLAUDE.md'),
    // Codex's global rules file (<CODEX_HOME>/AGENTS.md), where a rule
    // suggestion from Codex sessions is written, and the folder of Codex's
    // rollouts the repeats detector reads. A test reaches neither in the
    // real ~/.codex: without MC_CODEX_HOME (a scratch one) or a setting they
    // are null there.
    globalAgentsMd: env.MC_GLOBAL_AGENTS_MD || settings.globalAgentsMd || (env.TEST_RAVENRY === '1' && !env.MC_CODEX_HOME ? null : path.join(codexHome(), 'AGENTS.md')),
    codexSessions: settings.codexSessions || (env.TEST_RAVENRY === '1' && !env.MC_CODEX_HOME ? null : path.join(codexHome(), 'sessions')),
    backupDir: env.MC_BACKUP_DIR || settings.backupDir || path.join(H, '.claude', 'backups'),
    ruleSources: Array.isArray(settings.ruleSources) ? settings.ruleSources : defaultRuleSources(projects, [env.MC_PROJECTS_ROOT, settings.projectsRoot].find((r) => r && (SCRATCH_DATA || !inRepoTmp(r))) || null),
    // What a new or revived cmux or iTerm2 tab runs; the prompt is appended quoted.
    launchCommand: settings.launchCommand || 'claude',
    // The Ideas thread: non-interactive print mode, prompt on stdin. Read is
    // the only tool, so Claude can look at an idea's pictures and nothing else.
    printCommand: env.MC_PRINT_COMMAND ? JSON.parse(env.MC_PRINT_COMMAND) : Array.isArray(settings.printCommand) ? settings.printCommand : [bin, '-p', '--no-session-persistence', '--tools', 'Read'],
    claudeTimeoutMs: Number(settings.claudeTimeoutMs) || 3 * 60 * 1000,
    // Quick mockups on idea cards: the same print command without user
    // settings or MCP servers, on Sonnet, with the JSON envelope so each
    // round can log its tokens.
    mockupCommand: env.MC_MOCKUP_COMMAND ? JSON.parse(env.MC_MOCKUP_COMMAND) : Array.isArray(settings.mockupCommand) ? settings.mockupCommand : null,
    // The repeats detector (server/repeats.mjs): the same claude -p print
    // mode as the Ideas thread, on the user's own Claude login (no API key),
    // with no tools, no MCP servers, no user settings (so no hooks), no
    // saved session, a short system prompt and JSON out. The call adds its
    // own --system-prompt and --json-schema.
    repeatsCommand: env.MC_REPEATS_COMMAND ? JSON.parse(env.MC_REPEATS_COMMAND) : Array.isArray(settings.repeatsCommand) ? settings.repeatsCommand : [bin, '-p', '--no-session-persistence', '--model', 'sonnet', '--tools', '', '--strict-mcp-config', '--setting-sources', 'project,local', '--output-format', 'json'],
    repeatsTimeoutMs: Number(settings.repeatsTimeoutMs) || 5 * 60 * 1000,
    // Plans (server/planner.mjs): the same print mode as the repeats
    // detector (no saved session, no user settings or MCP servers, no tools,
    // Sonnet, the JSON envelope for the tokens); each call adds its own
    // --system-prompt and --json-schema. MC_PLAN_COMMAND replaces it in tests.
    planCommand: env.MC_PLAN_COMMAND ? JSON.parse(env.MC_PLAN_COMMAND) : Array.isArray(settings.planCommand) ? settings.planCommand : [bin, '-p', '--no-session-persistence', '--model', 'sonnet', '--tools', '', '--strict-mcp-config', '--setting-sources', 'project,local', '--output-format', 'json'],
    planTimeoutMs: Number(settings.planTimeoutMs) || 3 * 60 * 1000,
    // Daily runs: on by default only for the real board (no RAVENRY_HOME or
    // MC_HOME override),
    // so a test board never spends tokens unless it asks.
    repeatsAuto: env.MC_REPEATS_AUTO != null ? env.MC_REPEATS_AUTO === '1' : settings.repeatsAuto != null ? !!settings.repeatsAuto : !HOME_OVERRIDE,
    // How the Suggested subtitle names the scope.
    rulesScopeName: settings.rulesScopeName || 'your projects',
  };
}
