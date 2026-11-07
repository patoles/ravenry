package main

// ravenry review reply: an agent answers the person's review comment on
// its work (hub/docs/SESSIONS.md, Review comments). The comment reached the
// session as "Review comment <id> on <file> line <n>: ..."; the reply
// joins its thread on the hub, which takes it only from the pane of the
// session the comment is on.

import (
	"errors"
	"fmt"
	"strings"
)

func cmdReview(in []string) error {
	a, err := parse(in, specOf("review"))
	if err != nil {
		return err
	}
	if len(a.pos) != 3 || a.pos[0] != "reply" || strings.TrimSpace(a.pos[1]) == "" || strings.TrimSpace(a.pos[2]) == "" {
		return errors.New("usage: ravenry review reply ID \"WHAT YOU DID OR WHY NOT\"")
	}
	var r struct {
		Reply struct {
			ID string `json:"id"`
		} `json:"reply"`
	}
	if err := hubCall("POST", "/api/review/reply", map[string]any{"id": a.pos[1], "text": a.pos[2]}, &r); err != nil {
		return err
	}
	if a.g.json {
		return printJSON(r)
	}
	fmt.Println(r.Reply.ID)
	return nil
}
