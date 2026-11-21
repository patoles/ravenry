// The adapter of an assistant the board follows by its hooks alone
// (docs/ASSISTANTS.md, "The registry"): it reports its state through
// `ravenryd hook --assistant <id> --state <state>`, and the board reads no
// screen, prompt or transcript of it. server/assistant.mjs gives one to
// every registered assistant that has no adapter of its own, which is the
// starting point for a new one: an assistant whose screen the board should
// read writes its own adapter, as server/codex.mjs did.
//
// Its screen never says the assistant is live, so a screen no session
// names is never claimed by it (server/assistant.mjs detect), and its
// sessions' states come from their events (server/state.mjs eventState).

import * as term from './terminal.mjs';
import * as registry from './assistants.mjs';
import { findBin } from './assistantfind.mjs';

export function make(id) {
  const a = registry.of(id);
  const parseScreen = (text) => ({
    readable: text != null,
    claudeLive: false, shell: false, exited: false,
    working: false, busyLine: null,
    done: null, recap: null,
    draft: '', dialog: null,
    agentsRunning: 0,
    resumeId: null,
    body: text == null ? [] : String(text).split('\n').filter((l) => l.trim()).slice(-12),
    footer: [],
  });
  const empty = { kind: 'empty', sure: true, by: 'screen' };
  return {
    KIND: a.id,
    NAME: a.name,
    SHORT: a.short,
    RULES_FILE: a.rules,
    SUPPORTS: { suggestion: false, pictures: false, backgroundTasks: false, processes: false, recap: false, handoff: !!a.caps.handoff, codeSpans: false },
    CMUX_AGENT: a.id,
    parseScreen,
    parseTitle: () => ({ claude: false, busy: false, topic: null }),
    trimScreen(text) {
      if (text == null) return { live: false, width: 0, entries: [], status: null };
      const l = String(text).split('\n');
      while (l.length && !l[l.length - 1].trim()) l.pop();
      return { live: false, width: Math.max(0, ...l.map((x) => Array.from(x).length)), entries: l.length ? [{ k: 'p', l }] : [], status: null };
    },
    judgeRead: async () => ({ text: '', ...empty }),
    judgedScreen: (x) => ({ ...parseScreen(x ? x.text : null), suggestion: null, prompt: empty }),
    forget() {},
    surePrompt: async () => empty,
    withPrompt: (screen) => screen,
    checkPrompt: async (tab, screen, { choice }) => (choice != null ? { ok: false, status: 409, error: 'No choice is open on screen any more, so nothing was pressed.' } : { ok: true, bashOn: false }),
    // A paste then Enter.
    async typeMessage(tab, msg, { where }) {
      const p = await term.pasteText(tab, msg);
      if (!p.ok) return { ok: false, status: 500, error: p.err || `${where} refused the text.` };
      await new Promise((r) => setTimeout(r, 150));
      const e = await term.pressKey(tab, 'enter');
      if (!e.ok) return { ok: false, status: 500, error: e.err || `${where} refused Enter.` };
      return { ok: true };
    },
    findTranscript: () => null,
    newestTranscriptFor: () => null,
    transcriptsFor: () => [],
    readTranscript: () => null,
    workFolder: () => null,
    firstPrompt: () => null,
    launchCommand: () => a.command.start,
    startCommand: () => a.command.start,
    installed: (settings, env = process.env) => !!findBin(a.id, env),
  };
}
