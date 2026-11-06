// Command ravenryd is the Ravenry daemon: one per machine, it will own the
// terminals, their screen state, the hook command and the protocol server
// (see ../../README.md). For now it only prints its version.
package main

import (
	"fmt"
	"os"
)

// version is set at build time:
//
//	go build -ldflags "-X main.version=1.2.3" ./cmd/ravenryd
var version = "0.0.0-dev"

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version", "--version", "-v":
		default:
			fmt.Fprintf(os.Stderr, "ravenryd %s: unknown command %q (only \"version\" exists yet)\n", version, os.Args[1])
			os.Exit(2)
		}
	}
	fmt.Printf("ravenryd %s\n", version)
}
