# Contributing to Ravenry

Thanks for your interest in Ravenry. Issues and pull requests are welcome.
Before your first pull request is merged, you sign the contributor licence
agreement ([CLA.md](CLA.md)) once, by posting the comment the CLA assistant
asks for on that pull request.

## Reporting bugs

- Open an issue with the steps to reproduce it, what you expected and what
  happened instead.
- Say which app and version (the Mac app's About window, the Android app's
  version in Android's app info, the iPhone or iPad app's in Settings,
  General, iPhone Storage, Ravenry), your macOS, Android or iOS version,
  and which agent and its version (`claude --version`, `codex --version`,
  `opencode --version` or `agy --version`). For a session on
  another machine, its system too.
- Leave out anything private: session text, project names and paths you
  would rather not share, tokens, pairing codes or keys.
- A security problem is not an issue: see [SECURITY.md](SECURITY.md).

## Suggesting features

Open an issue that describes the feature and the problem it solves for you.

## Submitting code

1. Fork the repository and create a branch from `main`.
2. Make your change. Each folder's README says how to build and run it, and
   [docs/FEATURES.md](docs/FEATURES.md) lists every feature with the check
   that covers it.
3. Run the checks that cover what you touched:
   - the daemon: `make test` from `daemon/` (gofmt, `go vet` and the Go
     tests);
   - the hub: each test is a plain `node tools/<name>-test.mjs` run from
     `hub/` ([hub/docs/DEVELOPING.md](hub/docs/DEVELOPING.md) lists them);
   - the apps: the checks in each app's README.
   Every test runs on throwaway folders and its own ports, never on your
   own board, daemon or settings.
4. Run `node tools/audit.mjs` from the repository root: it must say CLEAN.
   It fails on personal data (emails, home paths, keys and tokens, and
   more), so nothing personal lands in the history.
5. Commit with messages that say what changed and why.
6. Push to your fork and open a pull request against `main`.

### Pull request guidelines

- One feature or fix per pull request.
- Say what it does and why, and link any related issue.
- For a change to what an app looks like, add a screenshot (light and dark
  if it matters, and the phone's width for the board).
- Make sure the existing checks still pass. CI runs the audit, the daemon's
  and the hub's checks, the desktop app's smoke test and the Android build
  on every pull request.
- Code from another project keeps its licence: name it, with its licence,
  at the top of the file and in [NOTICE](NOTICE), and only bring code whose
  licence is compatible with the GPL version 3.

## Code of conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Licence

Your contributions are licensed under the licence of the folder they are in
([LICENSING.md](LICENSING.md)): the GNU General Public License version 3
only outside `packages/`, the Apache License 2.0 inside it, and to the
project owner under the contributor licence agreement ([CLA.md](CLA.md)).
