package main

// Per-tab sessions that hold a SOPS age key in memory only.
//
// The browser makes a random token when the page loads and sends it as the
// X-Helmscope-Session header on every API call. A key set through the UI is
// stored against that token and passed to helm/helmfile (and so to
// helm-secrets and sops) as SOPS_AGE_KEY. Nothing is written to disk, no API
// returns the secret, and a page refresh starts a new token, so the key has
// to be given again. The page also asks the server to forget the old token
// when it unloads, and idle sessions expire.

import (
	"context"
	"crypto/ecdh"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	sessionHeader  = "X-Helmscope-Session"
	sessionIdleTTL = 8 * time.Hour
	maxSessions    = 64
	maxAgeKeys     = 32
)

var tokenRe = regexp.MustCompile(`^[A-Za-z0-9-]{16,128}$`)

type session struct {
	ageKeys    []string // AGE-SECRET-KEY-1... lines
	publicKeys []string // matching age1... recipients
	seen       time.Time
}

type sessionStore struct {
	mu sync.Mutex
	m  map[string]*session
}

func newSessionStore() *sessionStore { return &sessionStore{m: map[string]*session{}} }

// get returns the live session for a token and refreshes its idle timer.
func (st *sessionStore) get(tok string) *session {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.expireLocked()
	s := st.m[tok]
	if s != nil {
		s.seen = time.Now()
	}
	return s
}

func (st *sessionStore) set(tok string, keys, pubs []string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.expireLocked()
	if _, ok := st.m[tok]; !ok && len(st.m) >= maxSessions {
		// drop the least recently used session
		var oldest string
		for k, v := range st.m {
			if oldest == "" || v.seen.Before(st.m[oldest].seen) {
				oldest = k
			}
		}
		st.wipeLocked(oldest)
	}
	st.m[tok] = &session{ageKeys: keys, publicKeys: pubs, seen: time.Now()}
}

func (st *sessionStore) forget(tok string) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	_, ok := st.m[tok]
	st.wipeLocked(tok)
	return ok
}

func (st *sessionStore) expireLocked() {
	for k, v := range st.m {
		if time.Since(v.seen) > sessionIdleTTL {
			st.wipeLocked(k)
		}
	}
}

func (st *sessionStore) wipeLocked(tok string) {
	if s := st.m[tok]; s != nil {
		for i := range s.ageKeys {
			s.ageKeys[i] = ""
		}
		s.ageKeys = nil
	}
	delete(st.m, tok)
}

// ---- request plumbing -------------------------------------------------------

type ctxKey struct{}

// api wraps an API handler: it requires the session header (a custom header
// also means other web pages can't call the API without a CORS preflight,
// which this server never grants) and attaches the session to the context.
func (s *server) api(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := r.Header.Get(sessionHeader)
		if !tokenRe.MatchString(tok) {
			fail(w, http.StatusForbidden, "missing or invalid %s header", sessionHeader)
			return
		}
		r = r.WithContext(context.WithValue(r.Context(), ctxKey{}, tok))
		h(w, r)
	}
}

func tokenFrom(ctx context.Context) string {
	tok, _ := ctx.Value(ctxKey{}).(string)
	return tok
}

// childEnv is the environment for helm/helmfile: the server's own, plus the
// session's age keys added to any SOPS_AGE_KEY already set.
func (s *server) childEnv(ctx context.Context) []string {
	env := os.Environ()
	sess := s.sessions.get(tokenFrom(ctx))
	if sess == nil || len(sess.ageKeys) == 0 {
		return env
	}
	keys := strings.Join(sess.ageKeys, "\n")
	if existing := os.Getenv("SOPS_AGE_KEY"); existing != "" {
		keys = existing + "\n" + keys
	}
	// sops stops at an unreadable SOPS_AGE_KEY_FILE instead of trying the
	// next source, which would hide the session key. Drop a broken one.
	out := env[:0:0]
	for _, kv := range env {
		if v, ok := strings.CutPrefix(kv, "SOPS_AGE_KEY_FILE="); ok {
			if st, err := os.Stat(v); v == "" || err != nil || st.IsDir() {
				continue
			}
		}
		if strings.HasPrefix(kv, "SOPS_AGE_KEY=") {
			continue
		}
		out = append(out, kv)
	}
	return append(out, "SOPS_AGE_KEY="+keys)
}

// ---- handlers --------------------------------------------------------------

type sessionInfo struct {
	HasKey     bool     `json:"hasKey"`
	PublicKeys []string `json:"publicKeys"`
	EnvKeys    bool     `json:"envKeys"` // SOPS_AGE_KEY(_FILE) set where helmscope started
	IdleTTL    string   `json:"idleTTL"`
}

func (s *server) info(tok string) sessionInfo {
	in := sessionInfo{PublicKeys: []string{}, IdleTTL: sessionIdleTTL.String(),
		EnvKeys: os.Getenv("SOPS_AGE_KEY") != "" || os.Getenv("SOPS_AGE_KEY_FILE") != "" || os.Getenv("SOPS_AGE_KEY_CMD") != ""}
	if sess := s.sessions.get(tok); sess != nil {
		in.HasKey = len(sess.ageKeys) > 0
		in.PublicKeys = append(in.PublicKeys, sess.publicKeys...)
	}
	return in
}

func (s *server) handleSessionGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.info(tokenFrom(r.Context())))
}

func (s *server) handleSessionSetKey(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Keys string `json:"keys"`
	}
	if err := readBody(r, &req); err != nil {
		fail(w, 400, "bad request: %v", err)
		return
	}
	keys, pubs, err := parseAgeKeys(req.Keys)
	req.Keys = ""
	if err != nil {
		fail(w, 400, "%v", err)
		return
	}
	tok := tokenFrom(r.Context())
	s.sessions.set(tok, keys, pubs)
	writeJSON(w, 200, s.info(tok))
}

func (s *server) handleSessionForgetKey(w http.ResponseWriter, r *http.Request) {
	tok := tokenFrom(r.Context())
	s.sessions.forget(tok)
	writeJSON(w, 200, s.info(tok))
}

// handleSessionBeacon is the page-unload path: navigator.sendBeacon can't set
// headers, so the token comes in the body. It can only forget a key whose
// token the caller already knows.
func (s *server) handleSessionBeacon(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(io.LimitReader(r.Body, 256))
	if tok := strings.TrimSpace(string(b)); tokenRe.MatchString(tok) {
		s.sessions.forget(tok)
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- host guard ------------------------------------------------------------

// hostGuard rejects requests whose Host isn't a loopback name while the server
// listens on loopback. It stops DNS-rebinding pages from reaching the API
// under their own origin.
func hostGuard(addr string, h http.Handler) http.Handler {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return h
	}
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return h // listening beyond loopback was an explicit choice
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hh := r.Host
		if h2, _, err := net.SplitHostPort(hh); err == nil {
			hh = h2
		}
		hh = strings.Trim(hh, "[]")
		if ip := net.ParseIP(hh); hh != "localhost" && (ip == nil || !ip.IsLoopback()) {
			http.Error(w, "unexpected Host header", http.StatusForbidden)
			return
		}
		h.ServeHTTP(w, r)
	})
}

// ---- age keys ----------------------------------------------------------------

// parseAgeKeys accepts one key or a whole keys.txt (comments and blank lines
// allowed) and returns the secret keys with their public recipients.
func parseAgeKeys(text string) (keys, pubs []string, err error) {
	if len(text) > 64<<10 {
		return nil, nil, errors.New("key text is too large")
	}
	for i, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if !strings.HasPrefix(strings.ToUpper(line), "AGE-SECRET-KEY-1") {
			return nil, nil, fmt.Errorf("line %d is not an age secret key (expected AGE-SECRET-KEY-1...); SSH keys and age public keys (age1...) aren't accepted", i+1)
		}
		pub, err := agePublicKey(line)
		if err != nil {
			return nil, nil, fmt.Errorf("line %d: %v", i+1, err)
		}
		keys = append(keys, strings.ToUpper(line))
		pubs = append(pubs, pub)
		if len(keys) > maxAgeKeys {
			return nil, nil, fmt.Errorf("more than %d keys", maxAgeKeys)
		}
	}
	if len(keys) == 0 {
		return nil, nil, errors.New("no AGE-SECRET-KEY-1... line found")
	}
	return keys, pubs, nil
}

// agePublicKey derives the age1... recipient from an AGE-SECRET-KEY-1...
// identity: bech32-decode, X25519 base-point multiply, bech32-encode.
func agePublicKey(secret string) (string, error) {
	hrp, data, err := bech32Decode(strings.ToLower(secret))
	if err != nil {
		return "", err
	}
	if hrp != "age-secret-key-" || len(data) != 32 {
		return "", errors.New("not an X25519 age identity")
	}
	priv, err := ecdh.X25519().NewPrivateKey(data)
	if err != nil {
		return "", err
	}
	return bech32Encode("age", priv.PublicKey().Bytes())
}

// ---- bech32 (BIP 173), no length limit as age uses it ---------------------------

const bech32Charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

func bech32Polymod(values []byte) uint32 {
	gen := [5]uint32{0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3}
	chk := uint32(1)
	for _, v := range values {
		top := chk >> 25
		chk = (chk&0x1ffffff)<<5 ^ uint32(v)
		for i := 0; i < 5; i++ {
			if (top>>i)&1 == 1 {
				chk ^= gen[i]
			}
		}
	}
	return chk
}

func bech32HRPExpand(hrp string) []byte {
	out := make([]byte, 0, len(hrp)*2+1)
	for i := 0; i < len(hrp); i++ {
		out = append(out, hrp[i]>>5)
	}
	out = append(out, 0)
	for i := 0; i < len(hrp); i++ {
		out = append(out, hrp[i]&31)
	}
	return out
}

func convertBits(data []byte, from, to uint, pad bool) ([]byte, error) {
	var acc uint32
	var bits uint
	var out []byte
	maxv := uint32(1)<<to - 1
	for _, v := range data {
		if uint32(v)>>from != 0 {
			return nil, errors.New("invalid data range")
		}
		acc = acc<<from | uint32(v)
		bits += from
		for bits >= to {
			bits -= to
			out = append(out, byte(acc>>bits&maxv))
		}
	}
	if pad {
		if bits > 0 {
			out = append(out, byte(acc<<(to-bits)&maxv))
		}
	} else if bits >= from || acc<<(to-bits)&maxv != 0 {
		return nil, errors.New("invalid padding")
	}
	return out, nil
}

func bech32Decode(s string) (string, []byte, error) {
	pos := strings.LastIndexByte(s, '1')
	if pos < 1 || pos+7 > len(s) {
		return "", nil, errors.New("malformed bech32 string")
	}
	hrp := s[:pos]
	var vals []byte
	for i := pos + 1; i < len(s); i++ {
		d := strings.IndexByte(bech32Charset, s[i])
		if d < 0 {
			return "", nil, fmt.Errorf("invalid character %q", s[i])
		}
		vals = append(vals, byte(d))
	}
	if bech32Polymod(append(bech32HRPExpand(hrp), vals...)) != 1 {
		return "", nil, errors.New("checksum mismatch (key mistyped or truncated?)")
	}
	data, err := convertBits(vals[:len(vals)-6], 5, 8, false)
	return hrp, data, err
}

func bech32Encode(hrp string, data []byte) (string, error) {
	vals, err := convertBits(data, 8, 5, true)
	if err != nil {
		return "", err
	}
	poly := bech32Polymod(append(append(bech32HRPExpand(hrp), vals...), 0, 0, 0, 0, 0, 0)) ^ 1
	var b strings.Builder
	b.WriteString(hrp)
	b.WriteByte('1')
	for _, v := range vals {
		b.WriteByte(bech32Charset[v])
	}
	for i := 0; i < 6; i++ {
		b.WriteByte(bech32Charset[poly>>(5*(5-i))&31])
	}
	return b.String(), nil
}
