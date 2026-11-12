package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type helmfileRef struct {
	Path string   `json:"path"`
	Envs []string `json:"envs"`
}

func isHelmfileName(n string) bool {
	switch n {
	case "helmfile.yaml", "helmfile.yml", "helmfile.yaml.gotmpl", "helmfile.yml.gotmpl":
		return true
	}
	return false
}

func discoverHelmfiles(root string) []helmfileRef {
	var out []helmfileRef
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		if d.IsDir() {
			if p != root && (skipDirs[d.Name()] || strings.HasPrefix(d.Name(), ".")) {
				return fs.SkipDir
			}
			if strings.Count(filepath.ToSlash(rel), "/") > maxScanDepth {
				return fs.SkipDir
			}
			if d.Name() == "helmfile.d" {
				out = append(out, helmfileRef{Path: p, Envs: envsInDir(p)})
				return fs.SkipDir
			}
			return nil
		}
		if isHelmfileName(d.Name()) {
			out = append(out, helmfileRef{Path: p, Envs: envsInFile(p)})
		}
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

var reEnvKey = regexp.MustCompile(`^  ([A-Za-z0-9_.-]+):`)

// envsInFile is a best-effort scan of the top-level "environments:" block.
// Templated helmfiles may hide some names; the UI also accepts free text.
func envsInFile(p string) []string {
	f, err := os.Open(p)
	if err != nil {
		return nil
	}
	defer f.Close()
	seen := map[string]bool{}
	in := false
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "environments:"):
			in = true
		case line == "---" || (len(line) > 0 && line[0] != ' ' && line[0] != '#' && line[0] != '\t'):
			in = false
		case in:
			if m := reEnvKey.FindStringSubmatch(line); m != nil {
				seen[m[1]] = true
			}
		}
	}
	return sortedKeys(seen)
}

func envsInDir(dir string) []string {
	seen := map[string]bool{}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		n := e.Name()
		if e.IsDir() || !(strings.HasSuffix(n, ".yaml") || strings.HasSuffix(n, ".yml") || strings.HasSuffix(n, ".gotmpl")) {
			continue
		}
		for _, env := range envsInFile(filepath.Join(dir, n)) {
			seen[env] = true
		}
	}
	return sortedKeys(seen)
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func (s *server) handleHelmfiles(w http.ResponseWriter, r *http.Request) {
	hfs := discoverHelmfiles(s.cfg.Root)
	for i := range hfs {
		hfs[i].Path = s.relPath(hfs[i].Path)
	}
	writeJSON(w, 200, hfs)
}

type helmfileReq struct {
	File        string `json:"file"`
	Env         string `json:"env"`
	Selector    string `json:"selector"`
	Release     string `json:"release"`
	Namespace   string `json:"namespace"`
	Chart       string `json:"chart"`
	KubeVersion string `json:"kubeVersion"`
	SkipDeps    *bool  `json:"skipDeps"`
	Refresh     bool   `json:"refresh"`
}

// base resolves the helmfile and returns its absolute path, the directory to
// run in, and the leading "-f <file> -e <env>" arguments.
func (s *server) base(req helmfileReq) (abs, dir string, args []string, err error) {
	abs, err = s.resolve(req.File)
	if err != nil {
		return
	}
	dir = filepath.Dir(abs)
	env := req.Env
	if env == "" {
		env = "default"
	}
	args = []string{"--file", abs, "--environment", env}
	return
}

func releaseSelector(req helmfileReq) string {
	sel := "name=" + req.Release
	if req.Namespace != "" {
		sel += ",namespace=" + req.Namespace
	}
	return sel
}

func (s *server) handleHelmfileBuild(w http.ResponseWriter, r *http.Request) {
	var req helmfileReq
	if err := readBody(r, &req); err != nil {
		fail(w, 400, "bad request: %v", err)
		return
	}
	_, dir, args, err := s.base(req)
	if err != nil {
		fail(w, 400, "%v", err)
		return
	}
	if sel := strings.TrimSpace(req.Selector); sel != "" {
		args = append(args, "--selector", sel)
	}
	args = append(args, "build", "--embed-values")
	writeJSON(w, 200, s.run(r.Context(), dir, s.cfg.Helmfile, args...))
}

func (s *server) handleHelmfileTemplate(w http.ResponseWriter, r *http.Request) {
	var req helmfileReq
	if err := readBody(r, &req); err != nil {
		fail(w, 400, "bad request: %v", err)
		return
	}
	if req.Release == "" {
		fail(w, 400, "release is required")
		return
	}
	_, dir, args, err := s.base(req)
	if err != nil {
		fail(w, 400, "%v", err)
		return
	}
	args = append(args, "--selector", releaseSelector(req), "template")
	if req.SkipDeps == nil || *req.SkipDeps {
		args = append(args, "--skip-deps")
	}
	if kv := strings.TrimSpace(firstNonEmpty(req.KubeVersion, s.cfg.KubeVersion)); kv != "" {
		args = append(args, "--args", "--kube-version="+kv)
	}
	writeJSON(w, 200, s.run(r.Context(), dir, s.cfg.Helmfile, args...))
}

// handleHelmfileChart returns a release's chart files for the source pane.
// Local chart paths are read in place; anything else goes through
// "helmfile fetch" into the cache.
func (s *server) handleHelmfileChart(w http.ResponseWriter, r *http.Request) {
	var req helmfileReq
	if err := readBody(r, &req); err != nil {
		fail(w, 400, "bad request: %v", err)
		return
	}
	if req.Release == "" || req.Chart == "" {
		fail(w, 400, "release and chart are required")
		return
	}
	abs, dir, args, err := s.base(req)
	if err != nil {
		fail(w, 400, "%v", err)
		return
	}

	if !strings.Contains(req.Chart, "://") {
		local := filepath.Join(dir, filepath.FromSlash(req.Chart))
		if st, err := os.Stat(local); err == nil && (st.IsDir() || strings.HasSuffix(local, ".tgz")) {
			if !within(s.cfg.Root, local) {
				fail(w, 400, "chart %q is outside the root", req.Chart)
				return
			}
			cf, err := loadChart(local)
			if err != nil {
				fail(w, 400, "load chart: %v", err)
				return
			}
			writeJSON(w, 200, map[string]any{"chart": cf, "source": "local", "path": s.relPath(local)})
			return
		}
	}

	h := sha256.Sum256([]byte(strings.Join([]string{abs, req.Env, req.Release, req.Namespace, req.Chart}, "\x00")))
	out := filepath.Join(s.cfg.CacheDir, "fetch", hex.EncodeToString(h[:8]))

	s.mu.Lock()
	defer s.mu.Unlock()
	if req.Refresh {
		_ = os.RemoveAll(out)
	}
	var res *runResult
	chartPath := findChart(out)
	if chartPath == "" {
		_ = os.RemoveAll(out)
		if err := os.MkdirAll(out, 0o755); err != nil {
			fail(w, 500, "cache: %v", err)
			return
		}
		a := append(args, "--selector", releaseSelector(req), "fetch", "--output-dir", out)
		rr := s.run(r.Context(), dir, s.cfg.Helmfile, a...)
		res = &rr
		chartPath = findChart(out)
	}
	if chartPath == "" {
		writeJSON(w, 200, map[string]any{"chart": nil, "source": "fetch", "fetch": res})
		return
	}
	cf, err := loadChart(chartPath)
	if err != nil {
		fail(w, 500, "load fetched chart: %v", err)
		return
	}
	writeJSON(w, 200, map[string]any{"chart": cf, "source": "fetch", "fetch": res})
}

// findChart returns the shallowest chart directory or .tgz under dir.
func findChart(dir string) string {
	best, bestDepth := "", 1<<30
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		depth := strings.Count(p, string(filepath.Separator))
		if depth >= bestDepth {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if _, err := os.Stat(filepath.Join(p, "Chart.yaml")); err == nil {
				best, bestDepth = p, depth
				return fs.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(p, ".tgz") {
			best, bestDepth = p, depth
		}
		return nil
	})
	return best
}
