# Ravenry protocol

The spec of the protocol that `ravenryd`, the hub and every client speak
will live here. Nothing is written yet.

- **Versioned from v1.** Every message names the protocol version, and v1
  is frozen at the public launch: after that, changes are additions that
  old clients can ignore, or a new version.
- **Complete for any client.** A client (the desktop app, the phone, a
  future native one, or one someone else writes) needs nothing beyond this
  spec.
- **What it carries:** JSON messages for control, and binary frames for
  terminal bytes, over WebSocket, on the transports
  ../../docs/ARCHITECTURE.md describes.

Licence: Apache-2.0 (../LICENSE), so clients and plugins written against
it may use any licence.
