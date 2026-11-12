# helmscope: no Go module dependencies, so builds work with GOPROXY=off.
#
#   make build                 local binary in ./bin
#   make release VERSION=v1.2.3   three portable archives in ./dist:
#       helmscope_<v>_linux_amd64.tar.gz
#       helmscope_<v>_darwin_universal.tar.gz   (amd64 + arm64 in one binary)
#       helmscope_<v>_windows_amd64.zip         (version info, manifest, icon; signed if a cert is set)
#   CI runs the same steps separately: binaries -> sign -> package.
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
export GOPROXY ?= off
export CGO_ENABLED := 0
export GOFLAGS := -trimpath

BIN := dist/bin
# -buildid= keeps builds reproducible; same source + toolchain = same bytes.
LDFLAGS := -X main.version=$(VERSION) -buildid=
# Windows keeps its symbol table: stripped Go binaries are a common
# false-positive trigger for AV heuristics, and the size cost is small.
LDFLAGS_STRIP := $(LDFLAGS) -s -w

.PHONY: build binaries linux darwin windows sign package release dist test test-ui run clean

build:
	go build -ldflags "$(LDFLAGS_STRIP)" -o bin/helmscope .

binaries: linux darwin windows

linux:
	GOOS=linux GOARCH=amd64 go build -ldflags "$(LDFLAGS_STRIP)" -o $(BIN)/linux_amd64/helmscope .

darwin:
	GOOS=darwin GOARCH=amd64 go build -ldflags "$(LDFLAGS_STRIP)" -o $(BIN)/darwin_amd64/helmscope .
	GOOS=darwin GOARCH=arm64 go build -ldflags "$(LDFLAGS_STRIP)" -o $(BIN)/darwin_arm64/helmscope .
	GOOS= GOARCH= go run ./tools/lipo -o $(BIN)/darwin_universal/helmscope \
		$(BIN)/darwin_amd64/helmscope $(BIN)/darwin_arm64/helmscope
	rm -rf $(BIN)/darwin_amd64 $(BIN)/darwin_arm64

windows:
	scripts/winres.sh "$(VERSION)" amd64
	GOOS=windows GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $(BIN)/windows_amd64/helmscope.exe . ; \
		status=$$?; rm -f rsrc_windows_amd64.syso; exit $$status

sign:
	scripts/sign-windows.sh $(BIN)/windows_amd64/helmscope.exe

package:
	scripts/package.sh "$(VERSION)"

release: binaries sign package

dist: release

test:
	go vet ./...
	go test ./...

test-ui:
	node web/core.test.js

run: build
	./bin/helmscope $(or $(ROOT),.)

clean:
	rm -rf bin dist rsrc_windows_*.syso
