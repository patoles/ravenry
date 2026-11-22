// The fixed words every alert is made of (docs/PHONE.md section 5, "The
// line"). One place, so the channels (server/alerts.mjs: Telegram, a
// webhook, ntfy), the Mac's notifications and the phones (server/push.mjs)
// never say the same thing two ways.
//
// None of these is ever the session's text, the question, the command or
// the agent's words: they are what goes where the message travels in
// clear (a channel, an iPhone through ntfy).

// What a session in Needs you waits for.
export const KINDS = { question: 'Asked you a question', handback: 'Handed back', permission: 'Waiting for permission', gate: 'Plan gate' };

// What a plain program in a pane waits for (SESS-056), by the kind it said
// (OSC 7501 blocked's kind): never its own message.
export const PROGRAM_KINDS = { auth: 'Needs you to sign in', permission: 'Waiting for permission', question: 'Asked you a question', other: 'Waits for you' };

// What a checkpoint asks, for the channels and the Mac's notifications.
export const CHECKPOINT_KINDS = { ask: 'Asks you something', approve: 'Wants to run a command', secret: 'Needs you to type a secret', drive: 'Wants to type into another tab', pick: 'Wants you to pick a variant' };

// What a drive asks to do to a tab (its drive.action; absent: type).
export const DRIVE_ACTIONS = { input: 'Wants to type into another tab', close: 'Wants to close another tab', restart: 'Wants to restart another tab', override: 'Wants to change how another tab runs' };

// A checkpoint's line where it travels in clear (an iPhone through ntfy):
// what to do about it, since the answer is never in the alert.
export const CHECKPOINT_LINES = {
  answer: 'Answer on the board.',
  secret: 'Type it on the Mac.',
  approve: (mac) => `On ${mac}. Run or refuse on the board.`,
};
