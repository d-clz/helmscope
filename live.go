package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Live snapshots for Compare. -live (or HELMSCOPE_LIVE) is a path template,
// set by whoever starts helmscope, like SOPS_AGE_KEY_FILE for sops:
//
//	~/exports/{env}/{ns}.yaml   one file per environment and namespace
//	~/exports/{env}/            every *.yaml|*.yml|*.json in that folder
//	~/exports/{env}/*-live.yaml glob
//
// {env} is the helmfile environment, {ns} each namespace the render touches.
// The browser only sends those two values; the template itself never comes
// from the client, so it may point outside the scan root (exports hold Secret
// data and don't belong in the chart repo).

const liveMaxBytes = 64 << 20

var liveName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*$`)

type liveFile struct {
	Path    string `json:"path"`
	Bytes   int64  `json:"bytes"`
	MtimeMs int64  `json:"mtimeMs"`
}

type liveResult struct {
	Ref     string     `json:"ref"`
	Files   []liveFile `json:"files"`
	Missing []string   `json:"missing"`
	Text    string     `json:"text"`
}

func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		if h, err := os.UserHomeDir(); err == nil {
			return filepath.Join(h, p[1:])
		}
	}
	return p
}

func isLiveExt(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".yaml", ".yml", ".json":
		return true
	}
	return false
}

// livePaths expands the template for one environment and a set of
// namespaces. Paths come back in template order, deduplicated.
func livePaths(tpl, env string, namespaces []string) ([]string, error) {
	if strings.Contains(tpl, "{env}") {
		if env == "" {
			return nil, fmt.Errorf("-live uses {env} but no environment was given")
		}
		if !liveName.MatchString(env) || strings.Contains(env, "..") {
			return nil, fmt.Errorf("bad environment name %q", env)
		}
		tpl = strings.ReplaceAll(tpl, "{env}", env)
	}
	tpl = expandHome(tpl)
	if !strings.Contains(tpl, "{ns}") {
		return []string{tpl}, nil
	}
	seen := map[string]bool{}
	var out []string
	for _, ns := range namespaces {
		if ns == "" || seen[ns] {
			continue
		}
		if !liveName.MatchString(ns) || strings.Contains(ns, "..") {
			return nil, fmt.Errorf("bad namespace name %q", ns)
		}
		seen[ns] = true
		out = append(out, strings.ReplaceAll(tpl, "{ns}", ns))
	}
	return out, nil
}

// loadLive resolves each path (file, folder or glob) and concatenates the
// files as one multi-document YAML stream.
func loadLive(tpl, env string, namespaces []string) (liveResult, error) {
	res := liveResult{Ref: tpl, Files: []liveFile{}, Missing: []string{}}
	paths, err := livePaths(tpl, env, namespaces)
	if err != nil {
		return res, err
	}
	var files []string
	seen := map[string]bool{}
	addFile := func(p string) {
		if !seen[p] {
			seen[p] = true
			files = append(files, p)
		}
	}
	addPath := func(p string) bool {
		st, err := os.Stat(p)
		if err != nil {
			return false
		}
		if !st.IsDir() {
			addFile(p)
			return true
		}
		ents, err := os.ReadDir(p)
		if err != nil {
			return false
		}
		n := 0
		for _, e := range ents {
			if !e.IsDir() && isLiveExt(e.Name()) {
				addFile(filepath.Join(p, e.Name()))
				n++
			}
		}
		return n > 0
	}
	for _, p := range paths {
		if strings.ContainsAny(p, "*?[") {
			m, _ := filepath.Glob(p)
			sort.Strings(m)
			found := false
			for _, x := range m {
				if addPath(x) {
					found = true
				}
			}
			if !found {
				res.Missing = append(res.Missing, p)
			}
			continue
		}
		if !addPath(p) {
			res.Missing = append(res.Missing, p)
		}
	}
	var b strings.Builder
	var total int64
	for _, f := range files {
		st, err := os.Stat(f)
		if err != nil {
			res.Missing = append(res.Missing, f)
			continue
		}
		total += st.Size()
		if total > liveMaxBytes {
			return res, fmt.Errorf("live exports exceed %d MiB; narrow the -live template", liveMaxBytes>>20)
		}
		data, err := os.ReadFile(f)
		if err != nil {
			return res, fmt.Errorf("read %s: %v", f, err)
		}
		if b.Len() > 0 {
			b.WriteString("\n---\n")
		}
		b.Write(data)
		res.Files = append(res.Files, liveFile{Path: f, Bytes: st.Size(), MtimeMs: st.ModTime().UnixMilli()})
	}
	res.Text = b.String()
	return res, nil
}

func (s *server) handleLive(w http.ResponseWriter, r *http.Request) {
	if s.cfg.Live == "" {
		fail(w, http.StatusNotFound, "no -live template configured")
		return
	}
	var req struct {
		Env        string   `json:"env"`
		Namespaces []string `json:"namespaces"`
	}
	if err := readBody(r, &req); err != nil {
		fail(w, http.StatusBadRequest, "bad request: %v", err)
		return
	}
	res, err := loadLive(s.cfg.Live, req.Env, req.Namespaces)
	if err != nil {
		fail(w, http.StatusBadRequest, "%v", err)
		return
	}
	writeJSON(w, 200, res)
}
