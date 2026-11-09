// A stub hub's state as the real hub sends it: each session's group, the
// sidebar ready to draw, each checkpoint's words and each brief's Next step
// split, made by the hub's own modules (hub/server/sidebar.mjs,
// hub/server/cpwords.mjs, hub/server/briefnext.mjs) from the test's crafted
// projects and checkpoints. briefBody() is GET /api/brief's answer.
import { build, marksOf, paneNameIn, withGroups } from '../../../hub/server/sidebar.mjs';
import { withWords } from '../../../hub/server/cpwords.mjs';
import { nextParts } from '../../../hub/server/briefnext.mjs';

export function hubState(state) {
  if (!state || !Array.isArray(state.projects)) return state;
  const projects = withGroups(state.projects.map((p) => (p && p.brief ? { ...p, brief: { ...p.brief, nextParts: nextParts(p.brief.next) } } : p)));
  const checkpoints = (state.checkpoints || []).map((cp) => withWords(cp, { paneName: (pane) => paneNameIn(projects, pane) }));
  const marks = marksOf(projects, checkpoints);
  return { ...state, projects, checkpoints, sidebar: build(projects, { threshold: (state.settings && state.settings.handoffThreshold) ?? 50, marks }) };
}

/**
 * GET /api/brief's body as the hub sends it: the file's text with its Next
 * step (`next`, the section's text as the hub reads it) split.
 */
export function briefBody(body, next) {
  return { ...body, nextParts: nextParts(next) };
}
