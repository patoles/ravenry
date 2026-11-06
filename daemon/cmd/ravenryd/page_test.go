package main

import (
	"os"
	"strings"
	"testing"
)

// The page docs built into this binary are the ones packages/page-format
// generates from its schema (hub/tools/vendor-page-format.mjs copies them).
func TestPageDocsAreCurrent(t *testing.T) {
	want, err := os.ReadFile("../../../packages/page-format/docs/pages.md")
	if err != nil {
		t.Skip("not in the Ravenry repository")
	}
	if string(want) != pageDocs {
		t.Fatal("cmd/ravenryd/pagedocs.md differs from packages/page-format/docs/pages.md: run node hub/tools/vendor-page-format.mjs")
	}
}

func TestPageDocsTopic(t *testing.T) {
	got, ok := docsTopic(pageDocs, "board")
	if !ok || !strings.HasPrefix(got, "Page files, version 1.\n\n### board\n") || strings.Contains(got, "### table") {
		t.Fatalf("board: %q", got)
	}
	if _, ok := docsTopic(pageDocs, "nothing-like-this"); ok {
		t.Fatal("an unknown topic was found")
	}
	all, _ := docsTopic(pageDocs, "")
	if all != pageDocs {
		t.Fatal("no topic is not the whole docs")
	}
}
