# App Review notes (App Store Connect)

What goes in App Store Connect, App Review Information, for the iPhone and
iPad app (`apps/ios`). The app has no account, so Sign-in required stays
off and there is no demo account to give: the app's own demo takes its
place (guideline 2.1, App Completeness: a reviewer sees the app's full
features without the Mac it pairs with). The demo is built into the app
(`apps/phone/src/demo.ts`, docs/PHONE.md, The demo) and reached only before
a Mac is paired.

## Sign-in

- Sign-in required: no (the app has no account, no server and no sign-in).

## Notes

Paste as it is:

> Ravenry has no account, so there is no demo account to give: the app
> has a demo instead, built in.
>
> 1. Tap "Try the demo" at the bottom of the first screen ("No Mac yet?
> Try the demo"). The app opens on sample projects, with a bar on top
> that says it is a demo. Browse Projects, Ideas, Rules, Ship and Pages,
> tap a live screen to see it full, answer the question that arrives a
> few seconds in (if notifications are allowed, it also comes as an alert
> titled "Demo: notes-app needs you", whose buttons answer it), run or
> refuse the command, and pick one of three pictures (Compare, then
> Circle a part). Nothing leaves the phone. "Pair your Mac" in the bar
> leaves the demo.
>
> 2. To pair a real Mac: on a Mac with Apple silicon (macOS 13 or later),
> install Ravenry for Mac, free, from https://patoles.github.io/ravenry/
> and open it; click the phone button in Ravenry; scan the QR code it
> shows with the iPhone (or tap "Type the code instead" and type the
> address and code under the QR code); check that the number on both
> screens matches and tap "They match, pair". The phone then shows the
> Mac's projects and sessions. The iPhone and the Mac must be on the same
> Wi-Fi network (iOS asks for Local Network access: allow it). Alerts
> appear when a coding agent (Claude Code or Codex) running on the Mac
> asks a question.
>
> Alerts need a paired Mac with Ravenry for Mac 0.1.71 or later. The
> demo's alert is posted by the device itself: nothing leaves it.
>
> 3. A video of the app paired with a Mac, as a backup:
> https://www.youtube.com/watch?v=RfqYjxmg4CQ

## Contact

The developer account's own contact details, filled in App Store Connect
(not kept in this public repository).
