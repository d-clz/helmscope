package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func testServer(t *testing.T) (*server, *http.ServeMux) {
	t.Helper()
	root, _ := filepath.Abs("testdata")
	cfg := config{
		Root:     root,
		Helm:     filepath.Join(root, "bin", "helm"),
		Helmfile: filepath.Join(root, "bin", "helmfile"),
		Timeout:  10 * time.Second,
		CacheDir: t.TempDir(),
	}
	s := newServer(cfg)
	mux := http.NewServeMux()
	s.routes(mux)
	return s, mux
}

func call(t *testing.T, mux *http.ServeMux, method, path string, body any, out any) int {
	t.Helper()
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rd)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if out != nil {
		if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
			t.Fatalf("%s %s: decode %q: %v", method, path, rec.Body.String(), err)
		}
	}
	return rec.Code
}

func needUnix(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake helm binaries are bash scripts")
	}
}

func TestResolveRejectsEscapes(t *testing.T) {
	s, _ := testServer(t)
	for _, p := range []string{"../etc/passwd", "/etc/passwd", "charts/../../x", ""} {
		if _, err := s.resolve(p); err == nil {
			t.Errorf("resolve(%q) should fail", p)
		}
	}
	if _, err := s.resolve("charts/web"); err != nil {
		t.Errorf("resolve(charts/web): %v", err)
	}
}

func TestDiscoverCharts(t *testing.T) {
	_, mux := testServer(t)
	var charts []chartRef
	call(t, mux, "GET", "/api/charts", nil, &charts)
	if len(charts) != 1 || charts[0].Name != "web" || charts[0].Version != "0.3.1" || charts[0].Path != "charts/web" {
		t.Fatalf("unexpected charts: %+v", charts)
	}
}

func TestLoadChartDir(t *testing.T) {
	cf, err := loadChart("testdata/charts/web")
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"web/templates/deployment.yaml", "web/templates/_helpers.tpl", "web/charts/redis/templates/statefulset.yaml", "web/values.yaml"} {
		if _, ok := cf.Files[k]; !ok {
			t.Errorf("missing %s", k)
		}
	}
	if !strings.Contains(cf.Values, "replicaCount") {
		t.Errorf("values not loaded")
	}
}

// TestLoadChartTgz packages the test chart (with the subchart as a nested
// .tgz, as "helm package" does after "helm dep build") and loads it.
func TestLoadChartTgz(t *testing.T) {
	sub := tgzOf(t, "testdata/charts/web/charts/redis", "redis", nil)
	top := tgzOf(t, "testdata/charts/web", "web", map[string][]byte{"web/charts/redis-7.2.4.tgz": sub})
	p := filepath.Join(t.TempDir(), "web-0.3.1.tgz")
	if err := os.WriteFile(p, top, 0o644); err != nil {
		t.Fatal(err)
	}
	if m, ok := tgzMeta(p); !ok || m.name != "web" {
		t.Fatalf("tgzMeta: %+v %v", m, ok)
	}
	cf, err := loadChart(p)
	if err != nil {
		t.Fatal(err)
	}
	if cf.Root != "web" || cf.Version != "0.3.1" {
		t.Errorf("meta: %+v", cf)
	}
	if _, ok := cf.Files["web/charts/redis/templates/statefulset.yaml"]; !ok {
		t.Errorf("nested tgz subchart not keyed under web/charts/redis: %v", keys(cf.Files))
	}
}

func tgzOf(t *testing.T, dir, prefix string, extra map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	add := func(name string, b []byte) {
		_ = tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(b)), Typeflag: tar.TypeReg})
		_, _ = tw.Write(b)
	}
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if d.IsDir() {
			if p != dir && d.Name() == "charts" {
				return fs.SkipDir
			}
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		b, _ := os.ReadFile(p)
		add(prefix+"/"+filepath.ToSlash(rel), b)
		return nil
	})
	for k, v := range extra {
		add(k, v)
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func keys(m map[string]string) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestRender(t *testing.T) {
	needUnix(t)
	_, mux := testServer(t)
	var res runResult
	call(t, mux, "POST", "/api/render", renderReq{Chart: "charts/web", Release: "demo", Values: "replicaCount: 2\n", Set: []string{"image.tag=x"}, KubeVersion: "1.30.0"}, &res)
	if !res.OK || !strings.Contains(res.Stdout, "kind: Deployment") {
		t.Fatalf("render: %+v", res)
	}
	for _, want := range []string{"--namespace default", "-f ", "--set image.tag=x", "--kube-version 1.30.0", "--include-crds"} {
		if !strings.Contains(res.Stderr, want) {
			t.Errorf("args missing %q: %s", want, res.Stderr)
		}
	}
	if strings.Contains(res.Cmd, "testdata") {
		t.Errorf("cmd should show the root-relative chart path: %s", res.Cmd)
	}

	call(t, mux, "POST", "/api/render", renderReq{Chart: "charts/web", Set: []string{"fail=true"}}, &res)
	if res.OK || !strings.Contains(res.Stderr, "deployment.yaml:8:20") {
		t.Fatalf("expected failure with template position: %+v", res)
	}

	var e apiError
	if code := call(t, mux, "POST", "/api/render", renderReq{Chart: "../x"}, &e); code != 400 {
		t.Errorf("escape should be 400, got %d", code)
	}
}

func TestHelmfiles(t *testing.T) {
	needUnix(t)
	_, mux := testServer(t)
	var hfs []helmfileRef
	call(t, mux, "GET", "/api/helmfiles", nil, &hfs)
	if len(hfs) != 1 || hfs[0].Path != "helmfile.yaml" || strings.Join(hfs[0].Envs, ",") != "default,prod,uat" {
		t.Fatalf("helmfiles: %+v", hfs)
	}

	var res runResult
	call(t, mux, "POST", "/api/helmfile/build", helmfileReq{File: "helmfile.yaml", Env: "uat"}, &res)
	if !res.OK || !strings.Contains(res.Stdout, "redis-shared") || !strings.Contains(res.Stderr, "--environment uat build --embed-values") {
		t.Fatalf("build: %+v", res)
	}

	call(t, mux, "POST", "/api/helmfile/template", helmfileReq{File: "helmfile.yaml", Env: "uat", Release: "web", Namespace: "apps", KubeVersion: "1.30.0"}, &res)
	if !res.OK || !strings.Contains(res.Stderr, "--selector name=web,namespace=apps template --skip-deps --args --kube-version=1.30.0") {
		t.Fatalf("template: %+v", res)
	}

	var local struct {
		Chart  *chartFiles `json:"chart"`
		Source string      `json:"source"`
	}
	call(t, mux, "POST", "/api/helmfile/chart", helmfileReq{File: "helmfile.yaml", Release: "web", Namespace: "apps", Chart: "./charts/web"}, &local)
	if local.Source != "local" || local.Chart == nil || local.Chart.Root != "web" {
		t.Fatalf("local chart: %+v", local)
	}

	var fetched struct {
		Chart  *chartFiles `json:"chart"`
		Source string      `json:"source"`
		Fetch  *runResult  `json:"fetch"`
	}
	req := helmfileReq{File: "helmfile.yaml", Release: "redis-shared", Namespace: "platform", Chart: "nexus/redis"}
	call(t, mux, "POST", "/api/helmfile/chart", req, &fetched)
	if fetched.Source != "fetch" || fetched.Chart == nil || fetched.Chart.Root != "redis" || fetched.Fetch == nil {
		t.Fatalf("fetched chart: %+v fetch=%+v", fetched.Chart, fetched.Fetch)
	}
	fetched.Fetch = nil
	call(t, mux, "POST", "/api/helmfile/chart", req, &fetched)
	if fetched.Chart == nil || fetched.Fetch != nil {
		t.Fatalf("second call should hit the cache: fetch=%+v", fetched.Fetch)
	}

	// ../web exists (the UI folder) but sits outside the root: refuse it
	var e apiError
	if code := call(t, mux, "POST", "/api/helmfile/chart", helmfileReq{File: "helmfile.yaml", Release: "x", Chart: "../web"}, &e); code != 400 {
		t.Errorf("chart outside root should be 400, got %d %+v", code, e)
	}
}

func TestEnvScanIgnoresLaterBlocks(t *testing.T) {
	p := filepath.Join(t.TempDir(), "helmfile.yaml")
	_ = os.WriteFile(p, []byte("environments:\n  dev:\n    values: []\n  # comment\n  qa: {}\nreleases:\n  notanenv:\n"), 0o644)
	if got := strings.Join(envsInFile(p), ","); got != "dev,qa" {
		t.Errorf("envs = %q", got)
	}
}
