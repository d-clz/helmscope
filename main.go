// helmscope: a local, read-only viewer for Helm template output.
//
// It shells out to the helm and helmfile binaries you already have, so it has
// no Go module dependencies and builds inside an air gap. Nothing here talks
// to a cluster.
package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed web
var webFS embed.FS

var version = "dev"

type config struct {
	Root        string
	Addr        string
	Helm        string
	Helmfile    string
	KubeVersion string
	Timeout     time.Duration
	CacheDir    string
}

func main() {
	cfg := config{}
	defCache := filepath.Join(os.TempDir(), "helmscope-cache")
	if d, err := os.UserCacheDir(); err == nil {
		defCache = filepath.Join(d, "helmscope")
	}

	flag.StringVar(&cfg.Root, "root", ".", "directory to scan for charts and helmfiles")
	flag.StringVar(&cfg.Addr, "addr", "127.0.0.1:8088", "listen address (no auth: keep it on loopback)")
	flag.StringVar(&cfg.Helm, "helm", envOr("HELMSCOPE_HELM", "helm"), "helm binary")
	flag.StringVar(&cfg.Helmfile, "helmfile", envOr("HELMSCOPE_HELMFILE", "helmfile"), "helmfile binary")
	flag.StringVar(&cfg.KubeVersion, "kube-version", envOr("HELMSCOPE_KUBE_VERSION", ""), "default --kube-version for .Capabilities (e.g. 1.30.0)")
	flag.DurationVar(&cfg.Timeout, "timeout", 90*time.Second, "timeout for each helm/helmfile call")
	flag.StringVar(&cfg.CacheDir, "cache", defCache, "cache dir for fetched remote charts")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}
	if flag.NArg() > 0 {
		cfg.Root = flag.Arg(0)
	}

	root, err := filepath.Abs(cfg.Root)
	if err != nil {
		log.Fatalf("root: %v", err)
	}
	if st, err := os.Stat(root); err != nil || !st.IsDir() {
		log.Fatalf("root %q is not a directory", root)
	}
	cfg.Root = root
	if err := os.MkdirAll(cfg.CacheDir, 0o755); err != nil {
		log.Fatalf("cache dir: %v", err)
	}

	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatal(err)
	}

	srv := newServer(cfg)
	mux := http.NewServeMux()
	srv.routes(mux)
	mux.Handle("/", noCache(http.FileServer(http.FS(sub))))

	if host, _, err := net.SplitHostPort(cfg.Addr); err == nil {
		if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			log.Printf("WARNING: listening on %s with no authentication; anyone who can reach it can read files under %s", cfg.Addr, cfg.Root)
		}
	}

	log.Printf("helmscope %s", version)
	log.Printf("root:  %s", cfg.Root)
	log.Printf("open:  http://%s", displayAddr(cfg.Addr))
	hs := &http.Server{
		Addr:              cfg.Addr,
		Handler:           logRequests(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Fatal(hs.ListenAndServe())
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func displayAddr(a string) string {
	if strings.HasPrefix(a, ":") {
		return "127.0.0.1" + a
	}
	return a
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		h.ServeHTTP(w, r)
	})
}

func logRequests(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		h.ServeHTTP(w, r)
		if strings.HasPrefix(r.URL.Path, "/api/") {
			log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
		}
	})
}
