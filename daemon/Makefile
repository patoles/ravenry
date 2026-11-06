# Builds ravenryd. libghostty-vt is built once into .deps/ by
# scripts/libghostty.sh (Zig 0.17 or newer), and found through pkg-config.

VERSION ?= 0.0.0-dev
PKG_CONFIG_PATH := $(shell scripts/libghostty.sh)
export PKG_CONFIG_PATH

.PHONY: build test vet fmt

build:
	go build -ldflags "-X main.version=$(VERSION)" -o ravenryd ./cmd/ravenryd

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -l -w $$(git ls-files '*.go')
