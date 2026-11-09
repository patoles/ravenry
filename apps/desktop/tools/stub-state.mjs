// A stub hub's state as the real hub sends it: each session's group and the
// sidebar ready to draw, made by the hub's own module (hub/server/sidebar.mjs)
// from the test's crafted projects and checkpoints.
import { build, marksOf, withGroups } from '../../../hub/server/sidebar.mjs';

export function hubState(state) {
  if (!state || !Array.isArray(state.projects)) return state;
  const projects = withGroups(state.projects);
  const marks = marksOf(projects, state.checkpoints || []);
  return { ...state, projects, sidebar: build(projects, { threshold: (state.settings && state.settings.handoffThreshold) ?? 50, marks }) };
}
