package pane

import "time"

// Linux has no fork watch a user's daemon can use (the proc connector
// needs CAP_NET_ADMIN): the sweep, the environment and the pane's mark
// (mark_linux.go) find what left its parents.
type forkWatch struct{}

func newForkWatch() *forkWatch    { return nil }
func (*forkWatch) add(int, *Pane) {}
func (*forkWatch) close()         {}

func (t *tracker) run() {
	defer close(t.done)
	tick := time.NewTicker(sweepEvery)
	defer tick.Stop()
	for {
		select {
		case <-t.stop:
			return
		case <-tick.C:
			t.sweep()
		}
	}
}
