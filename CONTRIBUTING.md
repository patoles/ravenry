# Contributing to Ravenry

Thanks for your interest in Ravenry. Issues and pull requests are welcome.
There is no contributor licence agreement to sign.

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
2. Make your change. The board has no runtime dependencies; please keep it
   that way.
3. Run the tests that cover what you touched (each is a plain
   `node tools/<name>-test.mjs`; docs/DEVELOPING.md lists them). Every test
   keeps its data in the repo's `.tmp/` and runs its own board on a test
   port, never your real one on :4600.
4. Commit with messages that say what changed and why.
5. Push to your fork and open a pull request against `main`.

### Pull request guidelines

- One feature or fix per pull request.
- Say what it does and why, and link any related issue.
- For a change to what the board looks like, add a screenshot (desktop and
  phone width, light and dark if it matters).
- Make sure the existing tests still pass.

## Code of conduct

Be respectful and constructive. Everyone should feel welcome here.

## License

By contributing to Ravenry, you agree that your contributions are licensed
under the [Apache License 2.0](LICENSE), the licence of the project, as
section 5 of that licence describes.
