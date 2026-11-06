# Ravenry protocol

The protocol that `ravenryd`, the hub and every client speak.

- **[PROTOCOL.md](PROTOCOL.md):** the spec of version 1. It is a draft
  until the public launch, then frozen.
- **[schema/v1.json](schema/v1.json):** a JSON Schema (draft 2020-12) for
  every JSON message. A client message validates against
  `#/$defs/ClientMessage`, a daemon message against `#/$defs/DaemonMessage`,
  and each message type has its own definition (`request.pane.new`,
  `result.pane.new`, `event.pane.exited`, ...).

In short:

- **Versioned from v1.** Every JSON message carries `"v": 1` and every
  binary frame starts with the version. After the launch v1 only grows by
  additions that old clients can ignore; anything else is a new version.
- **Complete for any client.** A client (the desktop app, the phone, a
  future native one, or one someone else writes) needs nothing beyond the
  spec and the schema.
- **What it carries:** JSON messages for control, and binary frames for
  terminal bytes, over WebSocket, on a unix socket or through
  `ravenryd proxy` over SSH ([ARCHITECTURE.md](../../docs/ARCHITECTURE.md)).

ravenryd's tests (`daemon/internal/server`) check every message they send
and receive against the schema, and fail when a message type of the schema
never went over the wire.

Licence: Apache-2.0 (../LICENSE), so clients and plugins written against
it may use any licence.
