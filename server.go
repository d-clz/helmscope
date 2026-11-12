package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type server struct {
	cfg config
	mu  sync.Mutex // serialises chart fetches into the cache
}

func newServer(cfg config) *server { return &server{cfg: cfg} }

func (s *server) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/info", s.handleInfo)
	mux.HandleFunc("GET /api/charts", s.handleCharts)
	mux.HandleFunc("GET /api/chart/files", s.handleChartFiles)
	mux.HandleFunc("POST /api/render", s.handleRender)
	mux.HandleFunc("GET /api/helmfiles", s.handleHelmfiles)
	mux.HandleFunc("POST /api/helmfile/build", s.handleHelmfileBuild)
	mux.HandleFunc("POST /api/helmfile/template", s.handleHelmfileTemplate)
	mux.HandleFunc("POST /api/helmfile/chart", s.handleHelmfileChart)
}

// ---- helpers ---------------------------------------------------------------

type apiError struct {
	Error string `json:"error"`
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, format string, a ...any) {
	writeJSON(w, code, apiError{Error: fmt.Sprintf(format, a...)})
}

func readBody(r *http.Request, v any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 4<<20))
	return dec.Decode(v)
}

// resolve maps a root-relative path to an absolute one and refuses anything
// that escapes the root, including through symlinks.
func (s *server) resolve(rel string) (string, error) {
	if rel == "" {
		return "", errors.New("empty path")
	}
	if filepath.IsAbs(rel) {
		return "", errors.New("absolute paths are not allowed")
	}
	p := filepath.Join(s.cfg.Root, filepath.FromSlash(rel))
	if !within(s.cfg.Root, p) {
		return "", fmt.Errorf("path %q is outside the root", rel)
	}
	if real, err := filepath.EvalSymlinks(p); err == nil {
		realRoot, _ := filepath.EvalSymlinks(s.cfg.Root)
		if realRoot == "" {
			realRoot = s.cfg.Root
		}
		if !within(realRoot, real) {
			return "", fmt.Errorf("path %q resolves outside the root", rel)
		}
	}
	return p, nil
}

func within(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	if err != nil {
		return false
	}
	return rel == "." || (!strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != "..")
}

func (s *server) relPath(abs string) string {
	r, err := filepath.Rel(s.cfg.Root, abs)
	if err != nil {
		return abs
	}
	return filepath.ToSlash(r)
}

type runResult struct {
	OK         bool   `json:"ok"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	Cmd        string `json:"cmd"`
	DurationMs int64  `json:"durationMs"`
}

// run executes a binary without a shell. A non-zero exit is reported in the
// result, not as a Go error, because helm's stderr is what the user needs.
func (s *server) run(ctx context.Context, dir, bin string, args ...string) runResult {
	ctx, cancel := context.WithTimeout(ctx, s.cfg.Timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	cmd.Env = os.Environ()
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	start := time.Now()
	err := cmd.Run()
	res := runResult{
		OK:         err == nil,
		Stdout:     out.String(),
		Stderr:     errb.String(),
		Cmd:        strings.ReplaceAll(displayCmd(bin, args), s.cfg.Root+string(filepath.Separator), ""),
		DurationMs: time.Since(start).Milliseconds(),
	}
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			res.Stderr += fmt.Sprintf("\nhelmscope: timed out after %s", s.cfg.Timeout)
		} else if _, ok := err.(*exec.ExitError); !ok {
			res.Stderr += "\nhelmscope: " + err.Error()
		}
	}
	return res
}

func displayCmd(bin string, args []string) string {
	parts := []string{filepath.Base(bin)}
	for _, a := range args {
		if strings.ContainsAny(a, " \t\"'") {
			a = fmt.Sprintf("%q", a)
		}
		parts = append(parts, a)
	}
	return strings.Join(parts, " ")
}

// ---- /api/info ---------------------------------------------------------------

func (s *server) handleInfo(w http.ResponseWriter, r *http.Request) {
	hv := s.run(r.Context(), s.cfg.Root, s.cfg.Helm, "version", "--short")
	hfv := s.run(r.Context(), s.cfg.Root, s.cfg.Helmfile, "--version")
	writeJSON(w, 200, map[string]any{
		"version":     version,
		"root":        s.cfg.Root,
		"kubeVersion": s.cfg.KubeVersion,
		"helm":        strings.TrimSpace(firstNonEmpty(hv.Stdout, hv.Stderr)),
		"helmOK":      hv.OK,
		"helmfile":    strings.TrimSpace(firstNonEmpty(hfv.Stdout, hfv.Stderr)),
		"helmfileOK":  hfv.OK,
	})
}

func firstNonEmpty(a ...string) string {
	for _, s := range a {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

// ---- charts ------------------------------------------------------------------

func (s *server) handleCharts(w http.ResponseWriter, r *http.Request) {
	charts, err := discoverCharts(s.cfg.Root)
	if err != nil {
		fail(w, 500, "scan: %v", err)
		return
	}
	for i := range charts {
		charts[i].Path = s.relPath(charts[i].Path)
	}
	writeJSON(w, 200, charts)
}

func (s *server) handleChartFiles(w http.ResponseWriter, r *http.Request) {
	p, err := s.resolve(r.URL.Query().Get("path"))
	if err != nil {
		fail(w, 400, "%v", err)
		return
	}
	cf, err := loadChart(p)
	if err != nil {
		fail(w, 400, "load chart: %v", err)
		return
	}
	writeJSON(w, 200, cf)
}

type renderReq struct {
	Chart       string   `json:"chart"`
	Release     string   `json:"release"`
	Namespace   string   `json:"namespace"`
	Values      string   `json:"values"`
	Set         []string `json:"set"`
	KubeVersion string   `json:"kubeVersion"`
	APIVersions []string `json:"apiVersions"`
	DepUpdate   bool     `json:"depUpdate"`
}

func (s *server) handleRender(w http.ResponseWriter, r *http.Request) {
	var req renderReq
	if err := readBody(r, &req); err != nil {
		fail(w, 400, "bad request: %v", err)
		return
	}
	chart, err := s.resolve(req.Chart)
	if err != nil {
		fail(w, 400, "%v", err)
		return
	}
	if req.Release == "" {
		req.Release = "release-name"
	}
	if req.Namespace == "" {
		req.Namespace = "default"
	}
	args := []string{"template", req.Release, chart, "--namespace", req.Namespace, "--include-crds", "--debug"}

	if strings.TrimSpace(req.Values) != "" {
		f, err := os.CreateTemp("", "helmscope-values-*.yaml")
		if err != nil {
			fail(w, 500, "temp file: %v", err)
			return
		}
		defer os.Remove(f.Name())
		_, werr := f.WriteString(req.Values)
		cerr := f.Close()
		if werr != nil || cerr != nil {
			fail(w, 500, "write values: %v %v", werr, cerr)
			return
		}
		args = append(args, "-f", f.Name())
	}
	for _, kv := range req.Set {
		if kv = strings.TrimSpace(kv); kv != "" {
			args = append(args, "--set", kv)
		}
	}
	kv := firstNonEmpty(req.KubeVersion, s.cfg.KubeVersion)
	if kv = strings.TrimSpace(kv); kv != "" {
		args = append(args, "--kube-version", kv)
	}
	for _, av := range req.APIVersions {
		if av = strings.TrimSpace(av); av != "" {
			args = append(args, "--api-versions", av)
		}
	}
	if req.DepUpdate {
		args = append(args, "--dependency-update")
	}
	res := s.run(r.Context(), s.cfg.Root, s.cfg.Helm, args...)
	res.Cmd = strings.Replace(res.Cmd, chart, req.Chart, 1)
	writeJSON(w, 200, res)
}
