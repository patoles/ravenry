// The Ravenry relay's entry: the Worker's handler only (workerd takes no
// other export from the entry module). The relay itself is src/relay.js.
import { handler } from './relay.js';

export default handler;
