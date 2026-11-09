package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"golang.org/x/term"

	"ravenryd/internal/attach"
	"ravenryd/internal/client"
	"ravenryd/internal/proto"
)

// `ravenry attach` puts a pane in the terminal it runs in: the pane's
// screen, then its live output, written to standard output as it is; what
// the terminal sends (keys, pastes, mouse) goes to the pane as a person's
// keystrokes; and the terminal's size becomes the pane's whenever it
// changes. It is how a native window draws a pane with a full terminal
// emulator of its own (the Mac app runs it as the command of a Ghostty
// surface): the window owns drawing and resize, the daemon owns the pane.
//
// The terminal answers the program's queries too; the daemon already did,
// so those answers are dropped (internal/attach).
func cmdAttach(in []string) error {
	a, err := parse(in, specOf("attach"))
	if err != nil {
		return err
	}
	isNew := a.bools["new"]
	if !isNew && (len(a.pos) != 1 || a.dash >= 0) {
		return errors.New("usage: ravenry attach PANE, or ravenry attach --new [-- COMMAND ARGS...]")
	}
	if a.bools["close"] && !isNew {
		return errors.New("--close goes with --new: attach closes only a pane it started")
	}
	fd := int(os.Stdin.Fd())
	if !term.IsTerminal(fd) {
		return errors.New("standard input is not a terminal")
	}
	cols, rows, err := term.GetSize(fd)
	if err != nil {
		return fmt.Errorf("the terminal's size: %w", err)
	}
	cols, rows = clampSize(cols), clampSize(rows)

	ctx := context.Background()
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var c *client.Client
	var pane string
	if isNew {
		if c, err = connectNewest(cctx, a.g); err != nil {
			return err
		}
		params := map[string]any{"cols": cols, "rows": rows}
		if len(a.pos) > 0 {
			params["command"] = a.pos
		}
		if v := a.values["cwd"]; v != "" {
			params["cwd"] = v
		}
		if v := a.values["name"]; v != "" {
			params["name"] = v
		}
		if l, err := labelArgs(a.lists["label"]); err != nil {
			return err
		} else if l != nil {
			params["labels"] = l
		}
		var r proto.PaneResult
		if err := c.Call(cctx, "pane.new", params, &r); err != nil {
			return err
		}
		pane = r.Pane.ID
	} else {
		pane = a.pos[0]
		if c, err = connectFor(cctx, a.g, pane); err != nil {
			return err
		}
		// A display resizes the panes it shows.
		if err := c.Call(cctx, "pane.resize", map[string]any{"pane": pane, "cols": cols, "rows": rows}, nil); err != nil {
			return err
		}
	}
	defer c.Close()

	st, err := c.Subscribe(cctx, pane, client.SubscribeOptions{KittyKeyboard: true})
	if err != nil {
		return err
	}
	old, err := term.MakeRaw(fd)
	if err != nil {
		return err
	}
	defer term.Restore(fd, old)

	queries := &attach.Queries{}
	ended := make(chan struct{})
	go func() {
		defer close(ended)
		for f := range st.Frames {
			queries.Output(f.Data)
			if _, err := os.Stdout.Write(f.Data); err != nil {
				return
			}
		}
	}()

	go func() {
		f := attach.Filter{Queries: queries}
		buf := make([]byte, 32<<10)
		for {
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				if b := f.Write(buf[:n]); len(b) > 0 {
					if st.Input(ctx, b) != nil {
						return
					}
				}
			}
			if err != nil {
				return
			}
		}
	}()

	// Resizes: the newest size wins. While one pane.resize is on its way,
	// the window's further changes gather into the next one.
	winch := make(chan os.Signal, 1)
	signal.Notify(winch, syscall.SIGWINCH)
	wake := make(chan struct{}, 1)
	go func() {
		for range winch {
			select {
			case wake <- struct{}{}:
			default:
			}
		}
	}()
	go func() {
		sent := [2]int{cols, rows}
		for range wake {
			w, h, err := term.GetSize(fd)
			if err != nil {
				continue
			}
			size := [2]int{clampSize(w), clampSize(h)}
			if size == sent {
				continue
			}
			rctx, rcancel := context.WithTimeout(ctx, 5*time.Second)
			if c.Call(rctx, "pane.resize", map[string]any{"pane": pane, "cols": size[0], "rows": size[1]}, nil) == nil {
				sent = size
			}
			rcancel()
		}
	}()

	// The window going away (its pty hung up) ends the attach; the pane
	// lives on unless this attach started it with --close.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGHUP, syscall.SIGTERM, syscall.SIGINT)
	select {
	case <-ended:
		return nil
	case <-c.Done():
		return nil
	case <-stop:
	}
	if a.bools["close"] {
		xctx, xcancel := context.WithTimeout(ctx, 5*time.Second)
		defer xcancel()
		c.Call(xctx, "pane.close", map[string]any{"pane": pane}, nil)
	}
	return nil
}

func clampSize(n int) int {
	if n < 1 {
		return 1
	}
	if n > 4096 {
		return 4096
	}
	return n
}
