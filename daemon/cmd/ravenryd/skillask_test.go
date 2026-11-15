package main

import (
	"strings"
	"testing"
)

// The guide's "Before you ask the person anything" opens with asking
// through Ravenry instead of the chat, as the skill's description does
// (hub/server/skills.mjs DESCRIPTION): agents with the person in their
// chat otherwise typed their choices there.
func TestSkillAskThroughRavenryFirst(t *testing.T) {
	g := skillText()
	at := strings.Index(g, "## Before you ask the person anything\n\n")
	if at < 0 {
		t.Fatal("the guide has no Before you ask the person anything section")
	}
	first := g[at+len("## Before you ask the person anything\n\n"):]
	if !strings.HasPrefix(first, "- **Ask through Ravenry, not in your reply.**") {
		t.Fatalf("the section does not open with asking through Ravenry: %.120q", first)
	}
	end := strings.Index(first, "\n- **")
	for _, c := range []string{"ravenry ask", "ravenry pick", "ravenry approve", "ravenry secret", "do not write the\n  question in your chat"} {
		if !strings.Contains(first[:end], c) {
			t.Errorf("its first point does not say %q", c)
		}
	}
}

// After --no-wait, the guide says the answer comes back as a message in
// the session when the agent is not waiting on it (hub/server/cardanswer.mjs),
// in the words the hub types.
func TestSkillNoWaitAnswerComesBack(t *testing.T) {
	g := strings.Join(strings.Fields(skillText()), " ")
	for _, c := range []string{"If you are not waiting on it when the person answers, the answer comes back as a message in your session", "`Answer to your card \"TITLE\": THEIR ANSWER`", "for a secret, only that it is ready"} {
		if !strings.Contains(g, c) {
			t.Errorf("the guide does not say %q", c)
		}
	}
}
