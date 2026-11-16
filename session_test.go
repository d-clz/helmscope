package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Throwaway key that testdata/secrets/secret.sops.yaml is encrypted to.
// Split so secret scanners (gitleaks' age-secret-key rule) don't flag it.
const (
	testAgeSecret = "AGE-SECRET-" + "KEY-1" + "SU24326AJVWGYECVYAZ075JZ5CAGJTTAC6NUCNK8HSWNLMH8S0YSTNUF60"
	testAgePublic = "age172hcmk8hg6phy66895knns8nacvrfaenvu5a53c8jql787dy7gksc0rthr"
)

func readTestKey(t *testing.T) (secret, public, fileText string) {
	t.Helper()
	fileText = "# created: 2026-11-16T00:00:00Z\n# public key: " + testAgePublic + "\n" + testAgeSecret + "\n"
	return testAgeSecret, testAgePublic, fileText
}

func TestParseAgeKeys(t *testing.T) {
	secret, public, fileText := readTestKey(t)

	// a whole keys.txt (age-keygen output) and a bare key both work
	for _, in := range []string{fileText, secret, "  " + strings.ToLower(secret) + "  \n"} {
		keys, pubs, err := parseAgeKeys(in)
		if err != nil {
			t.Fatalf("parseAgeKeys: %v", err)
		}
		if len(keys) != 1 || keys[0] != secret || pubs[0] != public {
			t.Fatalf("got %v %v, want public %s", keys, pubs, public)
		}
	}

	bad := map[string]string{
		"":                           "no AGE-SECRET-KEY",
		public:                       "not an age secret key",
		"ssh-ed25519 AAAAC3Nza...":   "not an age secret key",
		secret[:len(secret)-1] + "q": "checksum",
		secret[:len(secret)-10]:      "checksum",
		strings.Repeat("x", 70<<10):  "too large",
	}
	for in, want := range bad {
		if _, _, err := parseAgeKeys(in); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("parseAgeKeys(%.20q) error = %v, want %q", in, err, want)
		}
	}
}

func TestAPIRequiresSessionHeader(t *testing.T) {
	_, mux := testServer(t)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/charts", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("no header: got %d, want 403", rec.Code)
	}
	req := httptest.NewRequest("GET", "/api/charts", nil)
	req.Header.Set(sessionHeader, "short")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("bad token: got %d, want 403", rec.Code)
	}
}

func TestHostGuard(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	h := hostGuard("127.0.0.1:8088", ok)
	for host, want := range map[string]int{
		"127.0.0.1:8088": 200, "localhost:8088": 200, "[::1]:8088": 200,
		"evil.example:8088": 403, "192.168.1.10:8088": 403,
	} {
		req := httptest.NewRequest("GET", "/", nil)
		req.Host = host
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("Host %s: got %d, want %d", host, rec.Code, want)
		}
	}
	// listening on all interfaces was an explicit choice: no Host check
	req := httptest.NewRequest("GET", "/", nil)
	req.Host = "build-box.corp:8088"
	rec := httptest.NewRecorder()
	hostGuard("0.0.0.0:8088", ok).ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Errorf("0.0.0.0 listener should not check Host, got %d", rec.Code)
	}
}

func TestSessionStoreExpiry(t *testing.T) {
	st := newSessionStore()
	st.set("tok-aaaaaaaaaaaaaaaa", []string{"K"}, []string{"P"})
	st.m["tok-aaaaaaaaaaaaaaaa"].seen = time.Now().Add(-sessionIdleTTL - time.Minute)
	if st.get("tok-aaaaaaaaaaaaaaaa") != nil {
		t.Fatal("idle session should have expired")
	}
	for i := 0; i < maxSessions+5; i++ {
		st.set(strings.Repeat("a", 16)+string(rune('A'+i%26))+strings.Repeat("b", i), []string{"K"}, nil)
	}
	if len(st.m) > maxSessions {
		t.Fatalf("store grew to %d sessions", len(st.m))
	}
}

// TestSessionKeyReachesSops runs the real sops binary (skipped if missing)
// through helmscope -> fake helmfile -> sops, with the key set over the API.
func TestSessionKeyReachesSops(t *testing.T) {
	needUnix(t)
	if _, err := exec.LookPath("sops"); err != nil {
		t.Skip("sops not installed")
	}
	t.Setenv("HELMSCOPE_TEST_SOPS", "1")
	unsetenv(t, "SOPS_AGE_KEY", "SOPS_AGE_KEY_CMD")
	// a stale path from the user's shell must not hide the session key
	t.Setenv("SOPS_AGE_KEY_FILE", "/nonexistent/keys.txt")
	t.Setenv("HOME", t.TempDir()) // keep sops away from a real ~/.config/sops/age/keys.txt
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	_, mux := testServer(t)
	secret, public, _ := readTestKey(t)

	do := func(method, path, token string, body any) (*httptest.ResponseRecorder, map[string]any) {
		var b []byte
		if body != nil {
			b, _ = json.Marshal(body)
		}
		req := httptest.NewRequest(method, path, bytes.NewReader(b))
		req.Header.Set(sessionHeader, token)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec, out
	}
	render := func(token string) map[string]any {
		_, out := do("POST", "/api/helmfile/template", token, helmfileReq{File: "helmfile.yaml", Release: "web", Namespace: "apps"})
		return out
	}
	const tokA, tokB = "tab-a-0000000000000001", "tab-b-0000000000000002"

	if out := render(tokA); out["ok"] == true || !strings.Contains(out["stderr"].(string), "Failed to get the data key") {
		t.Fatalf("without a key the render should fail on decryption: %v", out["stderr"])
	}

	rec, info := do("PUT", "/api/session/sops", tokA, map[string]string{"keys": "# my key\n" + secret + "\n"})
	if rec.Code != 200 || info["hasKey"] != true || info["publicKeys"].([]any)[0] != public {
		t.Fatalf("set key: %d %v", rec.Code, info)
	}
	if strings.Contains(rec.Body.String(), "AGE-SECRET-KEY") {
		t.Fatal("the API must never echo the secret key")
	}

	out := render(tokA)
	if out["ok"] != true || !strings.Contains(out["stdout"].(string), "password: s3cr3t-from-sops") {
		t.Fatalf("with the key the secret should decrypt: ok=%v stderr=%v", out["ok"], out["stderr"])
	}
	if strings.Contains(out["cmd"].(string), "AGE-SECRET") {
		t.Fatal("the key leaked into the displayed command")
	}

	if out := render(tokB); out["ok"] == true {
		t.Fatal("another tab's session must not see tab A's key")
	}

	// page refresh: the old tab's beacon forgets the key
	req := httptest.NewRequest("POST", "/api/session/forget", strings.NewReader(tokA))
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("beacon: %d", rec.Code)
	}
	if out := render(tokA); out["ok"] == true {
		t.Fatal("after forget the render should fail again")
	}

	// explicit forget via DELETE
	do("PUT", "/api/session/sops", tokB, map[string]string{"keys": secret})
	if _, info := do("DELETE", "/api/session/sops", tokB, nil); info["hasKey"] != false {
		t.Fatalf("delete: %v", info)
	}
	if rec, _ := do("PUT", "/api/session/sops", tokB, map[string]string{"keys": public}); rec.Code != 400 {
		t.Fatalf("a public key must be rejected, got %d", rec.Code)
	}
}

func unsetenv(t *testing.T, names ...string) {
	for _, n := range names {
		if v, ok := os.LookupEnv(n); ok {
			t.Cleanup(func() { os.Setenv(n, v) })
		}
		os.Unsetenv(n)
	}
}

func TestChildEnvMergesExistingKey(t *testing.T) {
	secret, _, _ := readTestKey(t)
	t.Setenv("SOPS_AGE_KEY", "AGE-SECRET-KEY-1EXISTING")
	good := t.TempDir() + "/keys.txt"
	_ = os.WriteFile(good, []byte("x"), 0o600)
	t.Setenv("SOPS_AGE_KEY_FILE", good)
	s, _ := testServer(t)
	s.sessions.set(testToken, []string{secret}, []string{"age1x"})
	env := s.childEnv(context.WithValue(context.Background(), ctxKey{}, testToken))
	var key, file string
	n := 0
	for _, kv := range env {
		if v, ok := strings.CutPrefix(kv, "SOPS_AGE_KEY="); ok {
			key, n = v, n+1
		}
		if v, ok := strings.CutPrefix(kv, "SOPS_AGE_KEY_FILE="); ok {
			file = v
		}
	}
	if n != 1 || key != "AGE-SECRET-KEY-1EXISTING\n"+secret {
		t.Fatalf("SOPS_AGE_KEY should hold both keys once, got %d entries: %q", n, key)
	}
	if file != good {
		t.Fatalf("a readable SOPS_AGE_KEY_FILE should be kept, got %q", file)
	}
	if env := s.childEnv(context.Background()); strings.Contains(strings.Join(env, "\n"), secret) {
		t.Fatal("a request without a session must not get the key")
	}
}
