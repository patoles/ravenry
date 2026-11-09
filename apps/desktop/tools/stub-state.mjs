// A stub hub's state as the real hub sends it: each session's group, the
// sidebar ready to draw, and each checkpoint's words, made by the hub's own
// modules (hub/server/sidebar.mjs, hub/server/cpwords.mjs) from the test's
// crafted projects and checkpoints.
import { build, marksOf, paneNameIn, withGroups } from '../../../hub/server/sidebar.mjs';
import { withWords } from '../../../hub/server/cpwords.mjs';

export function hubState(state) {
  if (!state || !Array.isArray(state.projects)) return state;
  const projects = withGroups(state.projects);
  const checkpoints = (state.checkpoints || []).map((cp) => withWords(cp, { paneName: (pane) => paneNameIn(projects, pane) }));
  const marks = marksOf(projects, checkpoints);
  return { ...state, projects, checkpoints, sidebar: build(projects, { threshold: (state.settings && state.settings.handoffThreshold) ?? 50, marks }) };
}
