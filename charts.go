package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const (
	maxFileBytes  = 512 << 10
	maxChartFiles = 4000
	maxScanDepth  = 8
)

type chartRef struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Description string `json:"description"`
	Path        string `json:"path"`
	Kind        string `json:"kind"` // dir | tgz
}

type chartFiles struct {
	Name    string            `json:"name"`
	Version string            `json:"version"`
	Root    string            `json:"root"` // prefix used in "# Source:" lines
	Files   map[string]string `json:"files"`
	Values  string            `json:"values"`
}

var skipDirs = map[string]bool{".git": true, "node_modules": true, "vendor": true, ".terraform": true}

// discoverCharts lists chart directories and packaged .tgz charts. Subcharts
// are not listed: they render as part of their parent.
func discoverCharts(root string) ([]chartRef, error) {
	var out []chartRef
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entries are skipped, not fatal
		}
		rel, _ := filepath.Rel(root, p)
		depth := strings.Count(filepath.ToSlash(rel), "/")
		if d.IsDir() {
			if p != root && (skipDirs[d.Name()] || strings.HasPrefix(d.Name(), ".")) {
				return fs.SkipDir
			}
			if depth > maxScanDepth {
				return fs.SkipDir
			}
			meta := filepath.Join(p, "Chart.yaml")
			if b, err := os.ReadFile(meta); err == nil {
				m := chartMeta(b)
				out = append(out, chartRef{Name: m.name, Version: m.version, Description: m.description, Path: p, Kind: "dir"})
				return fs.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(d.Name(), ".tgz") {
			if m, ok := tgzMeta(p); ok {
				out = append(out, chartRef{Name: m.name, Version: m.version, Description: m.description, Path: p, Kind: "tgz"})
			}
		}
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, err
}

type meta struct{ name, version, description string }

var (
	reName    = regexp.MustCompile(`(?m)^name:\s*["']?([^"'\s#]+)`)
	reVersion = regexp.MustCompile(`(?m)^version:\s*["']?([^"'\s#]+)`)
	reDesc    = regexp.MustCompile(`(?m)^description:\s*["']?([^"'\n#]*)`)
)

func chartMeta(b []byte) meta {
	m := meta{}
	if x := reName.FindSubmatch(b); x != nil {
		m.name = string(x[1])
	}
	if x := reVersion.FindSubmatch(b); x != nil {
		m.version = string(x[1])
	}
	if x := reDesc.FindSubmatch(b); x != nil {
		m.description = strings.TrimSpace(string(x[1]))
	}
	return m
}

func tgzMeta(p string) (meta, bool) {
	f, err := os.Open(p)
	if err != nil {
		return meta{}, false
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return meta{}, false
	}
	tr := tar.NewReader(gz)
	for i := 0; i < 50; i++ {
		h, err := tr.Next()
		if err != nil {
			return meta{}, false
		}
		parts := strings.Split(strings.TrimPrefix(h.Name, "./"), "/")
		if len(parts) == 2 && parts[1] == "Chart.yaml" {
			b, _ := io.ReadAll(io.LimitReader(tr, maxFileBytes))
			return chartMeta(b), true
		}
	}
	return meta{}, false
}

// loadChart returns the chart's text files keyed the way "helm template"
// names them in "# Source:" comments: <chart>/templates/x.yaml and
// <chart>/charts/<sub>/templates/y.yaml.
func loadChart(p string) (*chartFiles, error) {
	st, err := os.Stat(p)
	if err != nil {
		return nil, err
	}
	cf := &chartFiles{Files: map[string]string{}}
	if st.IsDir() {
		b, err := os.ReadFile(filepath.Join(p, "Chart.yaml"))
		if err != nil {
			return nil, errors.New("no Chart.yaml in directory")
		}
		m := chartMeta(b)
		if m.name == "" {
			m.name = filepath.Base(p)
		}
		cf.Name, cf.Version, cf.Root = m.name, m.version, m.name
		if err := addDir(cf.Files, p, m.name); err != nil {
			return nil, err
		}
	} else {
		f, err := os.Open(p)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		if err := addTgz(cf.Files, f, ""); err != nil {
			return nil, err
		}
		for k, v := range cf.Files {
			if parts := strings.Split(k, "/"); len(parts) == 2 && parts[1] == "Chart.yaml" {
				m := chartMeta([]byte(v))
				cf.Name, cf.Version, cf.Root = firstNonEmpty(m.name, parts[0]), m.version, parts[0]
				break
			}
		}
		if cf.Root == "" {
			return nil, errors.New("no Chart.yaml in archive")
		}
	}
	cf.Values = cf.Files[cf.Root+"/values.yaml"]
	return cf, nil
}

func isText(name string, b []byte) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".yaml", ".yml", ".tpl", ".txt", ".json", ".gotmpl", ".lock":
	default:
		return false
	}
	return !bytes.ContainsRune(b, 0)
}

func addDir(files map[string]string, dir, prefix string) error {
	return filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if len(files) >= maxChartFiles {
			return fs.SkipAll
		}
		rel, _ := filepath.Rel(dir, p)
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if p == dir {
				return nil
			}
			if strings.HasPrefix(d.Name(), ".") {
				return fs.SkipDir
			}
			// charts/<sub>/ is a subchart: re-key it under its own chart name
			if parts := strings.Split(rel, "/"); len(parts) == 2 && parts[0] == "charts" {
				if b, err := os.ReadFile(filepath.Join(p, "Chart.yaml")); err == nil {
					name := firstNonEmpty(chartMeta(b).name, d.Name())
					_ = addDir(files, p, prefix+"/charts/"+name)
					return fs.SkipDir
				}
			}
			return nil
		}
		if parts := strings.Split(rel, "/"); len(parts) == 2 && parts[0] == "charts" && strings.HasSuffix(rel, ".tgz") {
			if f, err := os.Open(p); err == nil {
				_ = addTgz(files, f, prefix+"/charts/")
				f.Close()
			}
			return nil
		}
		info, err := d.Info()
		if err != nil || info.Size() > maxFileBytes {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil || !isText(rel, b) {
			return nil
		}
		files[prefix+"/"+rel] = string(b)
		return nil
	})
}

// addTgz reads a packaged chart in memory. Entries are already rooted at the
// chart name, so prefix is "" at the top and "<parent>/charts/" for subcharts.
func addTgz(files map[string]string, r io.Reader, prefix string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return fmt.Errorf("gzip: %w", err)
	}
	tr := tar.NewReader(gz)
	for len(files) < maxChartFiles {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("tar: %w", err)
		}
		if h.Typeflag != tar.TypeReg {
			continue
		}
		name := strings.TrimPrefix(path.Clean(h.Name), "./")
		if strings.HasPrefix(name, "..") || path.IsAbs(name) {
			continue
		}
		parts := strings.Split(name, "/")
		// <chart>/charts/<sub>.tgz nested inside the archive
		if len(parts) == 3 && parts[1] == "charts" && strings.HasSuffix(parts[2], ".tgz") {
			b, _ := io.ReadAll(io.LimitReader(tr, 64<<20))
			_ = addTgz(files, bytes.NewReader(b), prefix+parts[0]+"/charts/")
			continue
		}
		if h.Size > maxFileBytes {
			continue
		}
		b, err := io.ReadAll(tr)
		if err != nil || !isText(name, b) {
			continue
		}
		files[prefix+name] = string(b)
	}
	return nil
}
