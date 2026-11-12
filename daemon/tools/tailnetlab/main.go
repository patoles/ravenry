// tailnetlab: a tailnet on this Mac for the hub's and the Mac app's
// checks, never a real one (internal/tailnet/tailnettest). It is a tool
// of the tests, not part of ravenryd:
//
//	go run ./tools/tailnetlab
//
// prints one JSON line, {"control": URL, "admin": URL}, both on
// 127.0.0.1, and runs until its standard input closes. The hub runs
// `ravenryd tailnet` against `control` (MC_TEST_TAILNET_CONTROL, a test's
// board only). Opening a sign-in URL completes that sign-in, as the
// person's browser would. The admin URL takes:
//
//	POST /phone {"name","kind","addr","method","path","body","token"}
//	     a phone stand-in called name joins (once), is made a device of that
//	     kind (owner, stranger, tagged, shared: tailnettest.Make) and sends
//	     one HTTPS request to addr over the tailnet (with the device token,
//	     when given); the answer, or the
//	     error when the connection was closed (tailnettest.Answer). An
//	     owner's request is tried again for up to 15 s while ravenry has
//	     not yet seen the device as its owner's.
//	GET  /nodes   the devices the control server knows
//	GET  /signins how many sign-in pages were opened
//	POST /down    the control server and the relay go, as no internet
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"ravenryd/internal/tailnet/tailnettest"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "tailnetlab:", err)
		os.Exit(1)
	}
}

func run() error {
	dir, err := os.MkdirTemp("", "tailnetlab.")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	lab, err := tailnettest.Start(nil)
	if err != nil {
		return err
	}
	defer lab.Close()
	var mu sync.Mutex
	peers := map[string]*tailnettest.Peer{}
	defer func() {
		for _, p := range peers {
			p.Close()
		}
	}()
	mux := http.NewServeMux()
	reply := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(v)
	}
	mux.HandleFunc("POST /phone", func(w http.ResponseWriter, r *http.Request) {
		var q struct{ Name, Kind, Addr, Method, Path, Body, Token string }
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&q); err != nil || q.Name == "" || q.Addr == "" {
			http.Error(w, "name, kind, addr, method, path, body", 400)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
		defer cancel()
		mu.Lock()
		p := peers[q.Name]
		mu.Unlock()
		if p == nil {
			p, err = lab.Peer(ctx, filepath.Join(dir, q.Name), q.Name)
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			mu.Lock()
			peers[q.Name] = p
			mu.Unlock()
		}
		if q.Kind != "" {
			if err := lab.Make(p, q.Kind); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
		}
		if q.Method == "" {
			q.Method = "GET"
		}
		end := time.Now().Add(15 * time.Second)
		for {
			one, c := context.WithTimeout(ctx, 6*time.Second)
			a := p.RequestAs(one, q.Addr, q.Method, q.Path, q.Body, q.Token)
			c()
			if a.Status != 0 || q.Kind != tailnettest.Owner || time.Now().After(end) {
				reply(w, a)
				return
			}
			time.Sleep(300 * time.Millisecond)
		}
	})
	mux.HandleFunc("GET /nodes", func(w http.ResponseWriter, r *http.Request) {
		type node struct {
			Name   string   `json:"name"`
			User   int64    `json:"user"`
			Tags   []string `json:"tags,omitempty"`
			Addr   string   `json:"addr,omitempty"`
			Expiry string   `json:"keyExpiry,omitempty"`
		}
		out := []node{}
		for _, n := range lab.Control.AllNodes() {
			x := node{User: int64(n.User), Tags: n.Tags}
			if n.Hostinfo.Valid() {
				x.Name = n.Hostinfo.Hostname()
			}
			if len(n.Addresses) > 0 {
				x.Addr = n.Addresses[0].Addr().String()
			}
			if !n.KeyExpiry.IsZero() {
				x.Expiry = n.KeyExpiry.UTC().Format(time.RFC3339)
			}
			out = append(out, x)
		}
		reply(w, out)
	})
	mux.HandleFunc("GET /signins", func(w http.ResponseWriter, r *http.Request) { reply(w, map[string]int{"count": lab.SignIns()}) })
	mux.HandleFunc("POST /down", func(w http.ResponseWriter, r *http.Request) { lab.Down(); reply(w, map[string]bool{"ok": true}) })
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	go http.Serve(ln, mux)
	json.NewEncoder(os.Stdout).Encode(map[string]string{"control": lab.URL, "admin": "http://" + ln.Addr().String()})
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	in := make(chan struct{})
	go func() { io.Copy(io.Discard, os.Stdin); close(in) }()
	select {
	case <-sig:
	case <-in:
	}
	return nil
}
