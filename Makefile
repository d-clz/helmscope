# helmscope: no Go module dependencies, so builds work with GOPROXY=off.
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)
PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64
export GOPROXY := off
export CGO_ENABLED := 0

.PHONY: build dist test test-ui run clean

build:
	go build -trimpath -ldflags "$(LDFLAGS)" -o bin/helmscope .

dist:
	@mkdir -p dist
	@for p in $(PLATFORMS); do \
		os=$${p%/*}; arch=$${p#*/}; ext=""; [ $$os = windows ] && ext=.exe; \
		echo "building $$os/$$arch"; \
		GOOS=$$os GOARCH=$$arch go build -trimpath -ldflags "$(LDFLAGS)" -o dist/helmscope-$$os-$$arch$$ext . || exit 1; \
	done
	@cd dist && sha256sum helmscope-* > SHA256SUMS && cat SHA256SUMS

test:
	go vet ./...
	go test ./...

test-ui:
	node web/core.test.js

run: build
	./bin/helmscope $(or $(ROOT),.)

clean:
	rm -rf bin dist
