package main

import (
	"bytes"
	"debug/macho"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestCreate cross-compiles a tiny program for both macOS architectures,
// merges them, and checks every slice comes back byte-for-byte.
func TestCreate(t *testing.T) {
	if testing.Short() {
		t.Skip("cross-compiles two binaries")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "hello.go")
	if err := os.WriteFile(src, []byte("package main\nfunc main() { println(\"hi\") }\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	thin := map[string]macho.Cpu{"amd64": macho.CpuAmd64, "arm64": macho.CpuArm64}
	var inputs []string
	for arch := range thin {
		out := filepath.Join(dir, "hello-"+arch)
		cmd := exec.Command("go", "build", "-o", out, src)
		cmd.Env = append(os.Environ(), "GOOS=darwin", "GOARCH="+arch, "CGO_ENABLED=0", "GOFLAGS=")
		if b, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("build %s: %v\n%s", arch, err, b)
		}
		inputs = append(inputs, out)
	}

	out := filepath.Join(dir, "hello-universal")
	if err := create(out, inputs); err != nil {
		t.Fatal(err)
	}
	ff, err := macho.OpenFat(out)
	if err != nil {
		t.Fatalf("OpenFat: %v", err)
	}
	defer ff.Close()
	if len(ff.Arches) != 2 {
		t.Fatalf("want 2 slices, got %d", len(ff.Arches))
	}
	raw, _ := os.ReadFile(out)
	for _, a := range ff.Arches {
		if a.Offset%(1<<alignLog2) != 0 {
			t.Errorf("%s slice at %d is not 16 KiB aligned", a.Cpu, a.Offset)
		}
		var src string
		for arch, cpu := range thin {
			if cpu == a.Cpu {
				src = filepath.Join(dir, "hello-"+arch)
			}
		}
		want, _ := os.ReadFile(src)
		if !bytes.Equal(raw[a.Offset:a.Offset+a.Size], want) {
			t.Errorf("%s slice differs from its input", a.Cpu)
		}
	}
	if st, _ := os.Stat(out); st.Mode().Perm()&0o111 == 0 {
		t.Error("output is not executable")
	}

	if err := create(out, []string{inputs[0], inputs[0]}); err == nil {
		t.Error("duplicate architectures should fail")
	}
	if err := create(out, []string{src, inputs[0]}); err == nil {
		t.Error("non-Mach-O input should fail")
	}
}
