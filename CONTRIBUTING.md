# Contributing to Ravenry

Thanks for your interest in Ravenry. Issues and pull requests are welcome.
Before your first pull request is merged, you sign the contributor licence
agreement ([CLA.md](CLA.md)) once, by posting the comment the CLA assistant
asks for on that pull request.

## Reporting bugs

- Open an issue with the steps to reproduce it and what you expected.
- Include your macOS version, Node version (`node -v`), Claude Code version
  (`claude --version`), your terminal (cmux, iTerm2, Rex or another) and the
  output of `ravenry doctor`.
- Leave out anything private: session text, project names and paths you
  would rather not share, alert tokens or phone access keys.

## Suggesting features

- Open an issue that describes the feature and the problem it solves for
  you.

## Submitting code

1. Fork the repository and create a branch from `main`.
2. Make your change. The hub has no runtime dependencies; please keep it
   that way.
3. Run the tests that cover what you touched. For the hub, each is a plain
   `node tools/<name>-test.mjs` run from `hub/` (hub/docs/DEVELOPING.md
   lists them). Every test keeps its data in `hub/.tmp/` and runs its own
   board on a test port, never your real one on :4600. For the daemon,
   `go vet ./...` and `go build ./...` from `daemon/`.
4. Run `node tools/audit.mjs` from the repository root: it must say CLEAN.
5. Commit with messages that say what changed and why.
6. Push to your fork and open a pull request against `main`.

### Pull request guidelines

- One feature or fix per pull request.
- Say what it does and why, and link any related issue.
- For a change to what the board looks like, add a screenshot (desktop and
  phone width, light and dark if it matters).
- Make sure the existing tests still pass.

## Code of conduct

Be respectful and constructive. Everyone should feel welcome here.

## License

Your contributions are licensed under the licence of the folder they are in
([LICENSING.md](LICENSING.md)): the GNU General Public License version 3
only outside `packages/`, the Apache License 2.0 inside it, and to the
project owner under the contributor licence agreement ([CLA.md](CLA.md)).
