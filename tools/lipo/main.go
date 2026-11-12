// Command lipo merges thin Mach-O executables into one universal ("fat")
// binary, like Apple's `lipo -create`, so the macOS release can be built on
// Linux without Xcode. Standard library only.
//
//	go run ./tools/lipo -o helmscope helmscope-amd64 helmscope-arm64
package main

import (
	"bytes"
	"debug/macho"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

// Slices start on 16 KiB boundaries, which is what Apple's lipo uses for
// arm64 and is valid for x86_64.
const alignLog2 = 14

type slice struct {
	cpu  macho.Cpu
	sub  uint32
	data []byte
}

func main() {
	out := flag.String("o", "", "output path for the universal binary")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: lipo -o <out> <thin-macho> <thin-macho> [...]")
		flag.PrintDefaults()
	}
	flag.Parse()
	if *out == "" || flag.NArg() < 2 {
		flag.Usage()
		os.Exit(2)
	}
	if err := create(*out, flag.Args()); err != nil {
		fmt.Fprintln(os.Stderr, "lipo:", err)
		os.Exit(1)
	}
}

func create(out string, inputs []string) error {
	var slices []slice
	for _, p := range inputs {
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		f, err := macho.NewFile(bytes.NewReader(b))
		if err != nil {
			return fmt.Errorf("%s: not a thin Mach-O file: %w", p, err)
		}
		for _, s := range slices {
			if s.cpu == f.Cpu {
				return fmt.Errorf("%s: duplicate architecture %s", p, f.Cpu)
			}
		}
		slices = append(slices, slice{cpu: f.Cpu, sub: f.SubCpu, data: b})
	}
	sort.Slice(slices, func(i, j int) bool { return slices[i].cpu < slices[j].cpu })

	var buf bytes.Buffer
	put := func(v uint32) { _ = binary.Write(&buf, binary.BigEndian, v) }
	put(macho.MagicFat)
	put(uint32(len(slices)))

	const align = 1 << alignLog2
	offsets := make([]uint32, len(slices))
	off := roundUp(8+20*len(slices), align)
	for i, s := range slices {
		if off+len(s.data) > 1<<32-1 {
			return errors.New("universal binary would exceed 4 GiB")
		}
		offsets[i] = uint32(off)
		put(uint32(s.cpu))
		put(s.sub)
		put(uint32(off))
		put(uint32(len(s.data)))
		put(alignLog2)
		off = roundUp(off+len(s.data), align)
	}
	for i, s := range slices {
		buf.Write(make([]byte, int(offsets[i])-buf.Len()))
		buf.Write(s.data)
	}

	tmp := out + ".tmp"
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(tmp, buf.Bytes(), 0o755); err != nil {
		return err
	}
	return os.Rename(tmp, out)
}

func roundUp(n, align int) int { return (n + align - 1) / align * align }
