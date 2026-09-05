# Operating gaze

Traps that have already cost real debugging time, and the reasoning behind the
design. Read this before changing the driver.

## How the profile clone works, and why

Three constraints stack up:

1. **Chrome 136+ refuses remote debugging on a default profile.** The switches
   `--remote-debugging-port` and `--remote-debugging-pipe` are ignored unless
   `--user-data-dir` points somewhere non-standard. This was a deliberate
   anti-cookie-theft measure; a non-standard directory also gets a different
   encryption key.
2. **You still want the logins.** A fresh profile is useless for driving a page
   you are authenticated to. So the automation profile is a *copy* of the everyday
   one, which carries the cookies across.
3. **Snap-confined browsers can only read profiles under their own snap home.**
   For snap Brave and snap Firefox the clone must live under `~/snap/<pkg>/`, not
   in `~/.local/share`. This is why the browser table stores a per-browser clone
   path instead of computing one.

`gaze sync` re-runs the copy. Close the everyday browser first, or the copy can
catch a half-written database.

## Two protocols

- **Chromium family** speaks CDP. Driven by `gaze.mjs` through Playwright's
  `connectOverCDP`.
- **Firefox family** speaks WebDriver BiDi. Firefox removed CDP in 141, so
  `gaze-bidi.mjs` implements a small BiDi client directly over the WebSocket that
  `--remote-debugging-port` serves. Node 22 ships a global `WebSocket`, so this
  needs no extra dependency.

The launcher picks the backend from the browser's family. Adding a browser is one
row in the table in `bin/gaze`.

## Traps

1. **It dies if started inside a short-lived process group.** The browser is
   reaped along with its parent. Start it as a backgrounded job so it survives
   across separate commands.
2. **`pkill -f <pattern>` matches its own shell** and kills the command that ran it
   (exit 143/144). Use `killauto.sh <port>`, which resolves the PID from the
   listening port. This one bites repeatedly; it even bit during the work that
   wrote this file.
3. **A BiDi session is bound to its WebSocket.** gaze runs one process per
   command, so each command must end its session on exit or the next command fails
   with "session does not exist". Firefox tears the socket down without replying to
   `session.end`, so it is sent fire-and-forget.
4. **Pending-request timers keep Node alive.** Every BiDi request sets a timeout;
   if it is not cleared on reply, commands appear to hang for the full timeout
   after doing their work correctly. They are cleared and `unref`-ed.
5. **`sync` copies one profile.** A Chromium profile is signed into one identity at
   a time, so an account not signed into the everyday profile is simply
   unreachable. That is an identity boundary, not a UI problem to click through.
6. **Do not drive the clone while logging into the same account in the everyday
   browser.** The provider may invalidate one of the two sessions.
7. **Never point another automation tool at the clone.** Launch a separate headless
   browser with its own `--user-data-dir` for QA work.
8. **Playwright's `download.saveAs()` fails under snap confinement**; artifacts
   land in the browser's private `/tmp`. `download` uses CDP
   `Browser.setDownloadBehavior` into a path inside the snap home instead.
9. **Do not pass `--password-store=basic`** to a cloned Chromium profile; it breaks
   cookie decryption.

## The highest-leverage trick

Navigating the logged-in browser to a dashboard's own JSON API returns data
authenticated by the **session cookie**, with no API token at all:

```bash
gaze goto 'https://dash.example.com/api/v4/things?per_page=50'
gaze text --max 20000
```

This generalises to any service with a cookie-authenticated JSON API, and is often
faster than finding, scoping and storing a token.

## CAPTCHAs

- For QA against your own site, use the official always-passing test keys.
- For real challenges, the browser is **visible**: solve it by hand and automation
  continues in the same session.
- **No third-party solver services.** That is bot-detection evasion, it violates
  most sites' terms, and it puts the signed-in accounts at risk.

## Running unattended (agents, CI, non-interactive shells)

The gate fails closed with no terminal, which is deliberate. A tool call from an
agent has no TTY, so a write returns `DENIED: no terminal to ask on`. Reads are
unaffected. Two supported ways through, both fully audited in `gaze stats`:

```bash
gaze eval "document.title" --yes          # approve one command
gaze grant --minutes 30 --yes             # approve a whole task, bounded
gaze revoke --yes                         # close the window early
```

A standing grant is checked *before* the gate reaches for a terminal, so it
works headlessly by design. Prefer it over `GAZE_APPROVAL=off`, which disables
the gate everywhere instead of for one task.

## Testing without touching a real profile

```bash
npm test              # Chromium backend
npm run test:firefox  # Firefox backend
```

Each launches a disposable browser with a temporary profile on its own port
(9226 and 9228), serves a fixture page from a separate process, and drives it
through the real CLI. The fixture deliberately includes 130 nav links, a shadow
DOM control and an iframe, because those are the cases that previously broke
`map`.

> The fixture server runs as its own process on purpose. The test driver blocks on
> `execFileSync` while the browser navigates, so a server sharing that event loop
> could never answer the request.
