# Google Play listing graphics

What the Play Console store listing takes, ready to upload. Every phone
screenshot is the real Android app (debug build of this repository) on an
emulator at 1080 x 1920 (9:16, density 420, dark theme), paired with a
made-up board on this Mac: the demo projects paper-boat, garden-planner,
notes-app, recipe-box and weather-widget on "MacBook Pro", the same story as
the download page. No frame, no added text; the status bar is in demo mode
(clock, full battery, Wi-Fi only).

| File | Size | What it shows |
| --- | --- | --- |
| `listing.md` | text | The listing's words (name, short and full description). |
| `icon-512.png` | 512 x 512 | The app icon, from `hub/brand/ravenry/icon-1024.png`. |
| `feature-1024x500.png` | 1024 x 500 | Feature graphic ("Image de présentation"): the Ravenry mark and name, the download page's line "Your agents, anywhere." on the page's black with its orange and blue glow, and screenshot 1 in a plain phone outline. Rendered from HTML in headless Chromium. |
| `screenshot-1.png` | 1080 x 1920 | The question an alert opens, full screen: paper-boat's Claude asks "Tilt the hull with the slope too, or keep it level?", with its three answers and a field for your own words. |
| `screenshot-2.png` | 1080 x 1920 | The board on paper-boat: "Needs you since" and the session's live screen, the terminal where it asked. |
| `screenshot-3.png` | 1080 x 1920 | A pick with pictures: three renders of the boat on a steep wave, B chosen, the spray circled and a note pinned to it ("This, but less spray at the bow. It hides the boat."). |
| `screenshot-4.png` | 1080 x 1920 | A command to approve: garden-planner's `npm test && git commit -am "Planting reminders"`, its folder, machine and pane, Claude's warning and reason, and Run on MacBook Pro behind a fingerprint. |
| `screenshot-5.png` | 1080 x 1920 | The notification shade with Ravenry's alerts: the pick with its three pictures, a secret for notes-app and the command for garden-planner. |

Play's limits these meet: feature graphic PNG, exactly 1024 x 500, under
15 MB; phone screenshots PNG, 9:16, each side between 320 and 3840 px, at
least 1080 px, under 8 MB each, 5 of them (2 to 8 allowed, 4 or more for
promotion). No alpha channel in any of them.
