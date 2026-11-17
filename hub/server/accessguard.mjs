// Imported first by server/index.mjs, before any other module of the hub
// loads: from here on nothing of the hub reads, writes, watches or starts a
// child inside a protected folder macOS has not let it read
// (server/access.mjs guard).
import { guard } from './access.mjs';

guard();
