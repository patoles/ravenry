# Licensing

Ravenry is under two licences, chosen by folder.

| Folder | Licence | SPDX id | Text |
| --- | --- | --- | --- |
| Everything outside `packages/`: `daemon/`, `hub/`, `apps/`, `docs/`, `tools/` and the files at the root | GNU General Public License, version 3 only | `GPL-3.0-only` | [LICENSE](LICENSE) |
| `packages/`: the protocol spec, the plugin SDK, the specs and the adapter contracts | Apache License, Version 2.0 | `Apache-2.0` | [packages/LICENSE](packages/LICENSE) |

Why the split:

- **The app is GPL-3.0-only.** Anyone may use, study, change and share it.
  A changed version that is distributed must be published under the same
  licence. "Only" means later GPL versions do not apply unless the copyright
  holder chooses them.
- **`packages/` is Apache-2.0,** so a plugin, an assistant adapter or a
  client written against the protocol and the SDK is not bound by the GPL,
  and may be under any licence its author picks, closed ones included.

## Commercial licence

The copyright holder can license the code outside `packages/` under other
terms, for example to ship it in a product that cannot meet the GPL. For a
commercial licence, contact the copyright holder by opening an issue in
this repository.

## Contributions

Contributions are accepted under the contributor licence agreement in
[CLA.md](CLA.md), signed once by commenting on your first pull request. It
lets the project offer the commercial licence above while your contribution
stays available to everyone under the folder's licence.

## Earlier releases

Ravenry 0.4.x and earlier, as published, stay under the Apache License,
Version 2.0. The code in this repository starts from them and is offered
under the licences above.

## Trademarks

Neither licence grants rights to the name "Ravenry" or its logo. See
[TRADEMARK.md](TRADEMARK.md).

## Third-party code

Code from other projects keeps its own licence, named in [NOTICE](NOTICE)
and at the top of the file it is in.
