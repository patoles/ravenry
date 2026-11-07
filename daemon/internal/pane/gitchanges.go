package pane

import (
	"context"
	"path/filepath"
	"strings"
)

// GitChange is a file git status shows changed in a work tree.
type GitChange struct {
	// Path is absolute.
	Path string
	// Status is git's two letters (" M", "A ", "??", "R ", ...).
	Status string
}

// maxGitChanges caps what GitChanges returns.
const maxGitChanges = 2000

// GitChanges lists the files git status shows changed in the work tree
// that holds dir: the fallback for the files an agent touched when its
// hooks do not say (pane.files). Bounded by git's timeout; partial when
// it was cut.
func GitChanges(ctx context.Context, dir string) (root string, out []GitChange, partial bool, err error) {
	top, err := gitRun(ctx, dir, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", nil, false, err
	}
	root = strings.TrimSpace(top)
	if root == "" {
		return "", nil, false, nil
	}
	st, err := gitRun(ctx, root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
	if err != nil {
		return root, nil, true, err
	}
	fields := strings.Split(st, "\x00")
	for i := 0; i < len(fields); i++ {
		f := fields[i]
		if len(f) < 4 {
			continue
		}
		code, path := f[:2], f[3:]
		if code[0] == 'R' || code[0] == 'C' {
			i++ // the old name follows
		}
		if len(out) == maxGitChanges {
			partial = true
			break
		}
		out = append(out, GitChange{Path: filepath.Join(root, filepath.FromSlash(path)), Status: code})
	}
	return root, out, partial, nil
}
