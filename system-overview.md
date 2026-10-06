# Reporting Presentation App — System Overview

> Handoff document for the next AI. Read this before changing the project.
> Last updated after the scoring, spin-the-wheel, red-alert, scoreboard and control-page work.

## Purpose

This is an offline, local-network event-registration and presentation app. It runs on one laptop, lets attendees join through a QR code, take a selfie, and displays each registrant on a live **scoreboard** with a Pokémon-style reveal animation. The host runs live games from a `/control` page (points, spin the wheel, red alert) to keep the students' attention on the reporters during the presentation. It is intended for a controlled school/reporting presentation; it is not a public production service.

## Current attendee flow

1. The host opens `/` on the projector. It displays a QR code for the registration page; optionally it also displays a Wi-Fi-join QR code.
2. An attendee scans the QR while connected to the same local network, then opens `/register`.
3. They submit full name, gender (`male`/`female`), and a password for reconnecting later.
4. `/camera` requests the front camera, captures a selfie, then POSTs it to `/capture`.
5. The server saves the original JPEG to `static/uploads/`, creates a SQLite `users` record, and awards the **registration bonus** (`scoring.REGISTER_BONUS`, currently 50 points).
6. Socket.IO broadcasts `new_registration` (including `score`) to all open pages.
7. `/leaderboard` queues the attendee for the full-screen Pokéball reveal, then slides their row into the scoreboard at their rank. `/thanks?uid=<id>` announces that attendee as online, shows the bouncing attendee gallery, and receives live host effects (red alert, spin the wheel).

Useful pages:

| Route | Role |
|---|---|
| `/` | Projector join QR screen |
| `/leaderboard` | Live scoreboard, Pokéball reveal, spin-the-wheel and red-alert overlays (projector) |
| `/control` | Host-only control page: player cards, points, alerts, wheel, game start/reset, delete |
| `/register`, `/login`, `/camera`, `/thanks` | Attendee phone flow |

## Technology and storage

- Python Flask 3 + Flask-SocketIO; `eventlet` is preferred, with a threading fallback.
- SQLite: `database/app.db`. Tables: `users` and `score_events` (see below).
- Uploads: `static/uploads/<uuid>.jpg`.
- Static Socket.IO client is bundled in `static/js/socket.io.min.js`; do not replace it with a CDN if offline use remains required.
- HTTPS uses an automatically generated self-signed certificate in `certs/`. HTTPS is necessary for phone camera access on a LAN IP.
- No build step. Plain HTML/CSS/JS, Jinja templates.

`users` schema: `id`, `full_name`, `gender`, `photo_filename`, `created_at`, `username`, `password_hash`.

`score_events` schema: `id`, `user_id`, `reason`, `points`, `created_at`. A player's score is always `SUM(points)` over their events (an event log, never a stored total, so mistakes can be undone with a negative award). Reasons used so far: `registered`, `manual`.

## Running the app

From the project folder, activate/install the Python dependencies and run:

```powershell
python app.py
```

(`python app.py runserver` also works only because extra arguments are ignored.)

The server prints local URLs and opens `https://127.0.0.1:5000/` after a short delay. To let phones connect, use the printed LAN-IP URL and allow Python through Windows Firewall on private networks.

At startup, `app.py` deliberately calls `reset_event_data()`. This deletes `database/app.db` (including all scores) and every file inside `static/uploads/`. Do **not** restart the server during an event if existing registrations or scores must be retained. After any change to a `.py` file the server must be fully restarted (Ctrl+C, then run again); refreshing the browser does not reload Python.

The optional Wi-Fi QR is configured by `WIFI_SSID` and `WIFI_PASSWORD`, either as environment variables or through the interactive startup prompt.

Phones will see a one-time self-signed certificate warning. They must proceed through it before the browser can use the camera.

## Required wiring in `app.py`

`app.py` was extended with these lines. If a feature returns 404 or "Could not send...", check them first:

```python
import scoring          # near the other imports
import games

scoring.register_scoring(app, socketio, get_db)   # module level, above the "Host / QR screen" section
games.register_games(app, socketio, get_db)       # right under the line above

# inside `if __name__ == "__main__":`
reset_event_data()
init_db()
scoring.init_scoring(get_db)
```

Other edits already made in `app.py`:

- `api_users()` returns a `score` for every user (`scoring.get_scores(conn)`).
- `delete_users()` calls `scoring.delete_for_users(conn, ids)` before committing.
- `capture()` awards `scoring.REGISTER_BONUS` and includes `score` in the `new_registration` payload.

The `register_*` calls must run at module level, **not** after `socketio.run(...)` (that call blocks and nothing after it executes).

## Routes and APIs

| Route | Method | Purpose |
|---|---|---|
| `/api/users` | GET | All users: `id, full_name, gender, photo_url, created_at, online, score` |
| `/api/users/delete` | POST | Delete users (`{ids:[...]}`), removes photos and their score events |
| `/api/score/award` | POST | `{ids:[...], points:int, reason?}`. Negative subtracts. Cap ±10000. Broadcasts `score_update`. Returns `{ok, updates:[{id,score,delta}]}` |
| `/api/score/reset` | POST | Deletes all score events, broadcasts zeros |
| `/trigger-game`, `/reset-game` | POST | Start / reset the temporary "Game Starting!" visual (`game_start` / `game_reset`) |
| `/trigger-wheel` | POST | Spin the wheel (see below). `409 {"error":"busy"}` if one is already running, `400 no_attendees` if empty |
| `/close-wheel` | POST | Closes the wheel on every screen |
| `/trigger-red-light` | POST | Alert **everyone** |
| `/stop-red-light` | POST | Stop **all** alerts (everyone and individual) |
| `/api/red-user` | POST | `{id, on}`. Alert or stop alerting **one** attendee |
| `/api/red-state` | GET | Snapshot `{on, users, seq, boot}` (screens poll this as a safety net) |

## Live events and state

Server-to-browser events:

| Event | Meaning |
|---|---|
| `new_registration` | A selfie and user record were saved (payload includes `score`). |
| `attendee_status` | An attendee's `/thanks` socket connected or disconnected. |
| `users_removed` | Control panel deleted one or more attendees. |
| `score_update` | `{id, score, delta}` or an array of those. Drives the "+N" popup and rank changes. |
| `wheel_spin` | Full wheel definition (candidates, winner, timeline). See "Spin the wheel". |
| `wheel_close` | Close the wheel everywhere. |
| `red_state` | `{on, users, seq, boot}`. The **only** red-alert event (the old `red_light` / `red_light_stop` events no longer exist). |
| `game_start` / `game_reset` | Toggle the temporary game-start visual without reloading pages. |
| `network_changed` | LAN IP changed; the host QR page refreshes its registration QR. |

Browser-to-server socket events: `attendee_online` (from `/thanks`), `wheel_state_request`, `red_state_request` (a screen asks for the current state after it connects or wakes up).

Keep `game_start`, `game_reset` and every effect as DOM-only transitions. Reloading or navigating an attendee's `/thanks` page disconnects their Socket.IO presence and briefly marks them offline.

## Scoreboard (`/leaderboard`)

Files: `templates/leaderboard.html`, `static/js/leaderboard.js`, scoreboard CSS block in `static/css/style.css` (`.sb-*` classes).

- One centered panel: header with joined count, column header (Rank / Player / Points), then rows.
- Rows are **absolutely positioned** inside `#sb-track` and moved with `translateY(index * ROW_H)`. Ranking changes never re-insert or reorder DOM nodes (that used to make the pop-in animation replay). The outer `.sb-row` only moves; the inner `.sb-row-inner` plays the entrance animation, so the two transforms never conflict.
- `ROW_H = 72` in `leaderboard.js` **must match** the `.sb-row` height in CSS.
- Sorting: capturing (still revealing) players are pinned last, then score descending, then `id` ascending. Ranks use competition ranking; players with 0 points show `–`. Gold/silver/bronze accents apply only to players with points.
- Offline players get a greyed photo and an "offline" tag.
- `applyScore(id, newScore, delta)` is a global; useful for console testing.
- `refresh()` polls `/api/users` every 4 seconds as a safety net (scores, online state, missed registrations).
- Names are escaped (`escapeHtml`) before being inserted with `innerHTML`.
- **Known gap:** `leaderboard.js` handles `game_start` (hides the scoreboard and shows a banner) but does not handle `game_reset`, so the scoreboard stays hidden until a reload.

## Leaderboard Pokéball reveal (current, intentional behavior; unchanged)

Relevant files:

- `templates/leaderboard.html`: the full-screen reveal markup.
- `static/js/leaderboard.js`: queueing, audio timing, DOM resets, and cleanup.
- `static/css/style.css`: reveal styles and keyframes.
- `static/bg_music/whos-that-pokemon.mp4`: bundled audio; current duration is about **6.774 seconds**.

The capture sequence is deliberately split into nested elements because CSS animations that all write to the same `transform` property override each other:

```text
.pokeball-entry  → falls in
  .pokeball-shake → shakes, then pops/fades on music end
    .pokeball-big → Pokéball drawing/catch filter
```

Current sequence:

1. Ball falls from the top.
2. It immediately shakes when it lands.
3. After landing, JavaScript applies `capture-holding`, which explicitly keeps the ball centered and opaque.
4. Audio `ended` adds `capture-finish`; a 7-second fallback handles blocked autoplay.
5. Only then does the ball pop/fade and the attendee photo reveal smoothly.
6. The reveal photo circle is the same diameter as the Pokéball (`min(60vh, 480px)`, border included).
7. While the reveal plays, the new player's scoreboard row is an invisible placeholder pinned at the bottom (so nothing moves). When the reveal ends the row becomes visible and slides to its rank.

Important maintenance rules:

- Do not merge fall, shake, and vanish back onto one element; use the nested wrappers.
- When cloning the Pokéball for a new attendee, clone/replace `.pokeball-entry`, not just `.pokeball-big`.
- `CAPTURE_DURATION_MS` (10100) must leave enough time for audio end, ball exit, reveal, and overlay fade.
- The animation diagnostic logger is attached to `.pokeball-big`; it logs the catch effect, not the wrapper fall/shake/exit animations.
- The old inline "capture inside a grid tile" code (`buildCaptureRow`, `addTile`) was removed. Only the full-screen overlay is used.

## Host effects: `static/js/effects.js`

Loaded on `/leaderboard` and `/thanks` (explicit `<script>` tags with a cache-busting random query). Optionally also add the same tag before `</body>` in `templates/base.html` so plain pages (`/register`, `/camera`, `/login`) also get the red alert (it works there without Socket.IO, by polling).

- Injects its own CSS (no stylesheet edit needed).
- Guarded by `window.__fxLoaded` so it wires only once.
- Reuses the page's own `socket` constant if it exists, otherwise opens `io()` if available.
- Never shows overlays on `/control`.
- On `/thanks`, the red alert is handled **inline in `thanks.html`** (which sets `window.__fxRedInline = true` so `effects.js` skips its own red overlay and polling). `effects.js` there only provides the wheel.
- Constant `RED_LIGHT_SOUND = "/static/bg_music/alarm.mp3"`.

### Spin the wheel

Server (`games.py`) is the single source of truth:

- Picks the winner **and** a landing offset (`jitter`) once, so every screen stops on the exact same spot.
- Constants in `games.py`: `SPIN_MS = 5000` (the one number to change for spin length), `LEAD_MS = 1200` (all screens show the wheel, then start together), `REVEAL_BUFFER_MS = 2500` (a new spin is refused until this long after landing), `REPLAY_WINDOW_MS = 60000` (late joiners still see it).
- `wheel_spin` payload: `spin_id, candidates[{id,full_name,photo_url}], winner_id, jitter, spin_ms, start_at (server ms), server_time`.
- Clients convert `start_at` to their own clock using the `server_time` in the same message, so phones with wrong clocks still start and stop together. Duplicate `spin_id` events are ignored. A screen that connects mid-spin emits `wheel_state_request` and gets the same wheel (or, if already landed, jumps straight to the winner).
- Runs on the projector and on every phone on `/thanks`. On a phone, the winner sees "You won! 🎉" (uses `ATTENDEE_ID`) and vibrates. Tapping the overlay after the winner appears closes it only on that device; **Close wheel** on `/control` closes everywhere.
- Known quirk: the **Reset** button (`game_reset`) closes the wheel locally, but the server still considers it open for the 60-second replay window.
- `control.js` reads `spin_ms` / `lead_ms` from the `/trigger-wheel` response, so the length is only defined in `games.py`.
- No wheel music is wired yet (a ~5 second track was planned; the wiring is not written).

### Red alert

- `red_state` = `{on, users, seq, boot}`. `on` alerts everyone; `users` is a list of individually alerted attendee ids. A phone is red if `on` **or** its `ATTENDEE_ID` is in `users`. Pages with no attendee id (projector) react only to `on`.
- There is **no timer**. It stays on until the host turns it off. **Reset** (`game_reset`) does **not** clear it; only the OFF actions do. `/stop-red-light` clears everything, including individual alerts.
- Reliability design (added after phones intermittently missed the one-shot message): screens receive live `red_state` events **and** poll `GET /api/red-state` every ~1.5 s while visible, plus on `visibilitychange`, `online` and `pageshow`. `seq` prevents an old answer from overriding a newer one; `boot` (random per server start) resets `seq` tracking after a server restart. `stopRed()` returns early when nothing is showing (avoids vibrate/audio spam while polling).
- Phone overlay text: everyone → "Stop what you're doing and look up!"; individual → "The host is calling you out. Look up!". Plays `alarm.mp3` looping, vibrates on Android. Sound needs one tap on the page first (a "Tap anywhere to enable sound" pill on `/thanks` and a silent unlock on first tap). iPhones do not vibrate in the browser.
- Flash rate is about 1 Hz; solid red for users with `prefers-reduced-motion`.
- Server keeps individual alert ids in memory only; ids of deleted users are not cleaned up (harmless).

## Control page (`/control`)

Files: `templates/control.html`, `static/js/control.js`, CSS blocks `.ctl-*`, `.pc-*` in `style.css`. Body class `ctl-body` (normal block layout; the page scrolls).

- **Sticky top nav** with: player count, **online** and **disconnected** pills, a status toast (auto-hides after 6 s), **🚨 Alert everyone** (toggle; solid red and pulsing while on), **Stop all alerts** (appears when anything is alerting), **🎡 Spin the wheel**, **Close wheel**, **Start Game**, **Reset**, **Select all**, **+ Selected**, **− Selected**, **Delete selected** (with confirm), **Reset all scores** (with confirm).
- **Player cards, 5 per row** (4 / 3 / 2 on narrower screens), in fixed join order (`id` ascending) so a card never moves while being tapped. Each card: checkbox, online dot, photo, name, points, **−10 / +10** buttons, and a red **🚨 Alert / Stop alert** button for that single player.
- Disconnected players stay in the list with a greyed photo, a "Disconnected" overlay, dimmed text and a dashed border. Their buttons still work.
- Points per tap is fixed: `const POINTS_PER_TAP = 10;` at the top of `control.js`.
- `renderGrid()` compares the generated HTML with the previous render and skips the DOM update if identical. Background refreshes (`/api/users` every 8 s, `/api/red-state` every 4 s) would otherwise rebuild the cards mid-click and swallow taps. Do not remove this check.
- Listens to `new_registration`, `users_removed`, `score_update`, `attendee_status`, `red_state`.
- Scores can go negative (no floor).

## CSS notes

`static/css/style.css` has several appended blocks. Only these are used by current pages: the original theme/host/leaderboard/reveal styles, the **scoreboard** block (`.sb-*`), the **control design** block (`.ctl-*`, `.pc-*`), and the **control offline** block (`.pc-photo-wrap`, `.pc-off-overlay`, `.ctl-pill-*`). Older blocks (`.points-*`, `.pt-*`, `.cu-*`, and the legacy `.leaderboard-row` / `.lb-*` tile styles) may still be in the file; they are unused and harmless, and can be removed later.

## Files that matter

```text
app.py                         Flask routes, SQLite, certificates, Socket.IO, startup reset, wiring for scoring/games
scoring.py                     score_events table, award/reset routes, get_scores/award helpers, REGISTER_BONUS
games.py                       Spin-the-wheel + red-alert routes and state (server is source of truth)
requirements.txt               Python dependencies
system-overview.md             This handoff document
setup.ps1                      Old self-contained scaffold script; see warning below

templates/base.html            Shared HTML shell; cache-busts style.css on each page render
templates/host.html            Projector QR screen
templates/leaderboard.html     Scoreboard + full-screen reveal; loads leaderboard.js and effects.js
templates/control.html         Host control page (nav + 5-per-row player cards)
templates/register.html        Registration form
templates/login.html           Reconnect form
templates/camera.html          Camera capture page
templates/thanks.html          Attendee presence, bouncing gallery, INLINE red alert, loads effects.js for the wheel

static/css/style.css           All shared styles and animation keyframes
static/js/leaderboard.js       Scoreboard layout, reveal queue, Socket.IO handlers
static/js/effects.js           Spin-the-wheel overlay + red-alert overlay/polling (see above)
static/js/control.js           Player cards, points, alerts, wheel, start/reset, delete
static/js/qr.js                QR-page count and LAN-IP refresh handling
static/js/camera.js            getUserMedia, snapshot, upload
static/js/host.js              Legacy/unused by current host.html
static/bg_music/alarm.mp3      Red-alert sound (host-supplied)
static/bg_music/whos-that-pokemon.mp4   Reveal audio (~6.774 seconds)
```

## Current file structure

```text
reporting/
├── app.py
├── scoring.py
├── games.py
├── requirements.txt
├── setup.ps1                           # OUTDATED scaffold generator; do not run casually
├── system-overview.md
│
├── certs/                              # Generated/self-signed HTTPS certificate files
│   ├── cert.pem
│   └── key.pem
├── database/
│   └── app.db                          # Runtime SQLite (users, score_events); deleted on server startup
│
├── static/
│   ├── bg_music/
│   │   ├── alarm.mp3                   # Red-alert sound
│   │   └── whos-that-pokemon.mp4       # Reveal audio (~6.774 seconds)
│   ├── css/
│   │   └── style.css
│   ├── js/
│   │   ├── socket.io.min.js
│   │   ├── leaderboard.js
│   │   ├── effects.js
│   │   ├── control.js
│   │   ├── qr.js
│   │   ├── camera.js
│   │   └── host.js                     # Legacy; unused
│   └── uploads/                        # Runtime attendee JPEGs; deleted on server startup
│
└── templates/
    ├── base.html
    ├── host.html
    ├── leaderboard.html
    ├── control.html
    ├── register.html
    ├── login.html
    ├── camera.html
    └── thanks.html
```

`certs/`, `database/app.db`, and `static/uploads/` are runtime state. Treat attendee photos, scores and the database as disposable because startup resets them.

## Editing and deployment warnings

- `setup.ps1` is an older full-project generator and does **not** match the current manually edited project. Running it overwrites current files with its embedded baseline and will remove the leaderboard, reveal, scoring and games work. Do not run it unless it is intentionally updated first.
- There is no `run.ps1`; use `python app.py` after installing requirements.
- `base.html` cache-busts `style.css`, and the main JavaScript files use cache-busting query strings. Preserve this so browser tests do not use stale CSS/JS. After replacing a template, phones that already have the page open must reload.
- Always escape attendee-supplied names before putting them in `innerHTML` (use `escapeHtml`; already done in `leaderboard.js`, `control.js`, `thanks.html`).
- Do not make `game_start`, `game_reset`, or any effect navigate or reload a page.
- The Flask secret key is a placeholder and there is no authorization for host-only endpoints (`/control`, `/api/score/*`, `/trigger-*`, `/api/red-user`, `/api/users/delete`). Any device on the LAN that knows the URL can call them. Acceptable only for the controlled local event.
- The app is LAN-only by design. A public deployment would need real authentication, a proper secret, durable database/object storage, and CA-issued HTTPS.

## Testing status (be honest about this)

The scoreboard, scoring, wheel and red-alert logic was tested only in simulation: Flask-SocketIO's test client for the server and jsdom for the browser code (including phones with deliberately wrong clocks, missed socket messages, stale answers, and late joiners). Layouts were **not** viewed in a real browser, and nothing was verified on real phones or the projector. First things to check on real hardware:

1. Register a test attendee: reveal plays, row slides into the scoreboard with 50 points.
2. `+10` / `−10` on a card: "+10" popup and rank slide on the leaderboard.
3. **Alert everyone**: every phone on `/thanks` and the projector turns red; the OFF tap ends it. Repeat with a phone locked/unlocked.
4. Per-card **Alert**: only that phone turns red.
5. **Spin the wheel**: projector and phones spin together and land on the same person; winner phone shows "You won!".
6. A phone that disconnects shows "Disconnected" on `/control` and the scoreboard.

Quick console test on `/leaderboard`: `applyScore(1, 150)` (use a real user id).

## Likely next features

- **Quick Quiz** round engine (was proposed first): host types or selects a question, phones answer, server scores by correctness and speed (all timing on the server, one answer per round), projector shows live answer counts. A `game_rounds` table (`id, type, payload, started_at, ends_at`) and events like `round_start`, `player_answer`, `round_result` were sketched but **nothing is implemented**. Points should go through `scoring.award(...)` and broadcast `score_update`.
- Other game ideas: Who's That Student (silhouette of a selfie), Pokéball Pick (random student answers aloud, host awards points), Tap Race, Live Poll.
- Wheel sound (about 5 seconds, ending on a hit as the winner appears), started on the shared `start_at` time.
- A Reset handler on the leaderboard (`game_reset` currently does nothing there).
- Optional: add `effects.js` to `base.html`; a control-page filter (All / Online / Disconnected); a score floor at 0.

Any new game screen must follow the same rules: server-authoritative state, DOM-only show/hide, no reloads, a polling or state-request fallback so a missed socket message cannot strand a phone, and `attendee_online` presence left untouched.