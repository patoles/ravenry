package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// `ravenry page check FILE` and `ravenry page docs [TOPIC]`: what an agent
// runs while it writes a Ravenry page file (packages/page-format).
//
// They live here, in the binary agents run from a pane and that `ravenry
// skill` lists, so an agent finds them where it finds every other command.
// The page format has one checker, the hub's (packages/page-format, the
// same code that draws the page), so `check` sends the file's text to the
// hub running on this machine and prints its answer: an agent never sees a
// file pass here and fail in the sidebar. The docs are generated from the
// schema and built into this binary (pagedocs.md, kept equal to
// packages/page-format/docs/pages.md by a test), so `docs` works without a
// hub. npm's board has the same two commands in hub/bin/ravenry.mjs.

//go:embed pagedocs.md
var pageDocs string

func cmdPage(in []string) error {
	a, err := parse(in, specOf("page"))
	if err != nil {
		return err
	}
	if len(a.pos) == 0 {
		return errors.New("page check FILE, or page docs [TOPIC]")
	}
	switch a.pos[0] {
	case "check":
		if len(a.pos) != 2 {
			return errors.New("page check FILE: name one page file")
		}
		return pageCheck(a.pos[1], a.g.json)
	case "docs":
		if len(a.pos) > 2 {
			return errors.New("page docs [TOPIC]: one topic, such as board or ask")
		}
		topic := ""
		if len(a.pos) == 2 {
			topic = a.pos[1]
		}
		t, ok := docsTopic(pageDocs, topic)
		if !ok {
			return fmt.Errorf("no topic called %q in the page docs; run ravenry page docs for all of them", topic)
		}
		fmt.Print(t)
		return nil
	}
	return fmt.Errorf("page %s: page check FILE, or page docs [TOPIC]", a.pos[0])
}

// docsTopic is packages/page-format's docsTopic: the section whose ## or ###
// heading is the topic (the shortest such heading), else the first whose
// heading has it as a word.
func docsTopic(docs, topic string) (string, bool) {
	if topic == "" {
		return docs, true
	}
	t := strings.ToLower(strings.TrimSpace(topic))
	lines := strings.Split(docs, "\n")
	head := regexp.MustCompile(`^(#{2,3}) (.*)$`)
	type h struct {
		i     int
		level int
		text  string
	}
	var heads []h
	for i, l := range lines {
		if m := head.FindStringSubmatch(l); m != nil {
			heads = append(heads, h{i, len(m[1]), m[2]})
		}
	}
	hit := -1
	for k, x := range heads {
		if strings.ToLower(x.text) == t && (hit < 0 || x.level < heads[hit].level) {
			hit = k
		}
	}
	if hit < 0 {
		split := regexp.MustCompile(`[\s.]+`)
		for k, x := range heads {
			for _, w := range split.Split(strings.ToLower(x.text), -1) {
				if w == t {
					hit = k
					break
				}
			}
			if hit >= 0 {
				break
			}
		}
	}
	if hit < 0 {
		return "", false
	}
	end := len(lines)
	for _, x := range heads {
		if x.i > heads[hit].i && x.level <= heads[hit].level {
			end = x.i
			break
		}
	}
	body := strings.TrimRight(strings.Join(lines[heads[hit].i:end], "\n"), " \t\n")
	return "Page files, version 1.\n\n" + body + "\n", true
}

// hubURL is where the board runs: RAVENRY_HUB_URL, else the port the
// running board wrote to <RAVENRY_HOME, else ~/.ravenry>/board.json, else
// the board's default port.
func hubURL() string {
	if u := os.Getenv("RAVENRY_HUB_URL"); u != "" {
		return strings.TrimRight(u, "/")
	}
	dir := os.Getenv("RAVENRY_HOME")
	if dir == "" {
		dir = os.Getenv("MC_HOME")
	}
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".ravenry")
	}
	port := 4600
	if b, err := os.ReadFile(filepath.Join(dir, "board.json")); err == nil {
		var v struct {
			Port int `json:"port"`
		}
		if json.Unmarshal(b, &v) == nil && v.Port > 0 {
			port = v.Port
		}
	}
	return "http://127.0.0.1:" + strconv.Itoa(port)
}

type pageProblem struct {
	Severity string `json:"severity"`
	Line     int    `json:"line"`
	Column   int    `json:"column"`
	Message  string `json:"message"`
	Hint     string `json:"hint"`
	Text     string `json:"text"`
	Code     string `json:"code"`
}

func pageCheck(file string, asJSON bool) error {
	abs, err := filepath.Abs(file)
	if err != nil {
		return err
	}
	text, err := os.ReadFile(abs)
	if err != nil {
		return fmt.Errorf("cannot read %s: %v", file, err)
	}
	body, _ := json.Marshal(map[string]string{"path": abs, "text": string(text)})
	url := hubURL()
	req, _ := http.NewRequest("POST", url+"/api/pages/check", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Ravenry", "1")
	res, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return fmt.Errorf("Ravenry's board is not running at %s, and it checks page files: open the Ravenry app (or run ravenry from npm), then try again", url)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	var r struct {
		OK       bool          `json:"ok"`
		Error    string        `json:"error"`
		Problems []pageProblem `json:"problems"`
		Summary  string        `json:"summary"`
	}
	if json.Unmarshal(raw, &r) != nil || res.StatusCode != 200 {
		if r.Error != "" {
			return fmt.Errorf("the board did not check it: %s", r.Error)
		}
		return fmt.Errorf("the board did not check it (%s): it may be older than page files", res.Status)
	}
	if asJSON {
		if err := printJSON(r); err != nil {
			return err
		}
	} else {
		for _, p := range r.Problems {
			if p.Severity == "error" {
				fmt.Println(p.Text)
			}
		}
		if r.OK {
			fmt.Printf("OK  %s\n", r.Summary)
		}
		for _, p := range r.Problems {
			if p.Severity != "error" {
				fmt.Println("warning: " + p.Text)
			}
		}
	}
	if !r.OK {
		return exitCode(1)
	}
	return nil
}
