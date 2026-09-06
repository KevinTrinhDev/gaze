# Usage

Everything the README leaves out.

## Reading a page

```bash
gaze goto https://example.com
gaze text --max 4000
gaze html --max 8000
```

`map` is usually the one you want. It lists interactive elements with a selector
you can paste straight into `click` or `fill`, walks shadow DOM and same-origin
frames, and hides nav, header and footer by default so real page content is not
crowded out by a hundred menu links.

```bash
gaze map
gaze map --filter password        # narrow
gaze map --nav                    # include page chrome
gaze map --json --max 500
```

All page output is wrapped in an untrusted envelope and scanned for prompt
injection. Pass `--raw` for bare output.

The agent-facing way to *see* a page is the accessibility snapshot — text only,
no pixels, no vision model:

```bash
gaze snapshot --json        # ARIA tree: buttons, fields, links, roles
gaze state --json --raw     # url/title + sha256 fingerprint + bounded snapshot
```

`state` hashes the snapshot, so a caller can detect "did the page change"
without re-reading it. Waiting for a change instead of sleeping a fixed time:

```bash
gaze click "#refresh" --yes
gaze wait --for url updated --timeout 30    # after a click that navigates
gaze wait --for selector ".loaded"
gaze wait --for text "Complete"
gaze wait --for network-idle x --timeout 20 # 600ms with no responses
```

All three are reads and never prompt.

## Extracting data

```bash
gaze scrape "h2"                  # text of every match
gaze scrape "a" --attr href       # an attribute instead
gaze links --filter docs          # every link, deduped
gaze table --nth 0 --json         # a table as rows
```

## Finding the real API

Often the fastest path is not scraping the DOM at all. Watch what the page itself
calls:

```bash
gaze network --seconds 5 --reload --json-only
```

Then request that endpoint directly in the logged-in browser. It returns JSON
authenticated by your session cookie, with no API token involved:

```bash
gaze goto 'https://app.example.com/api/v4/things?per_page=50'
gaze text --max 20000
```

This generalises to any service with a cookie-authenticated JSON API.

## Console

```bash
gaze console --seconds 5
gaze console --seconds 5 --reload --level error
```

Two paths, for a reason worth knowing. The driver is Patchright, which suppresses
`Runtime.enable` to remove an automation tell that anti-bot vendors flag, and
console events ride on that exact domain. Measured over the same window: stock
Playwright saw 8 events, Patchright saw 0.

- **Default** hooks `console` inside the page and reads the buffer back. Keeps the
  stealth property. Only sees output from the moment it runs.
- **`--reload`** attaches the stock driver, which does see output from page load.
  That momentarily re-enables `Runtime.enable` on a second connection, so use it
  for your own sites and debugging.

## Interacting

```bash
gaze click "#signin"
gaze click "Sign in" --text        # match visible text instead
gaze fill "input[name=email]" you@example.com --enter
gaze press Enter
gaze scroll down --px 800          # up | down | top | bottom
gaze scroll to "#pricing"          # bring an element into view
gaze upload "#attachment" ./report.pdf
gaze download "a.download-link"
```

All of these are write actions, so they ask first. See **Consent** below.

`click` escalates once, and says so. Some controls are visible but refuse a
normal click: a synthetic `<div role="button">` under a transparent overlay is
the common case on admin consoles. Rather than burn the whole timeout, gaze
dispatches a DOM click on the element it already located, and appends
`(dispatched a DOM click)` to the output so the escalation is never silent.

It deliberately does **not** force a mouse click. A forced click still fires at
the element's coordinates, so on a covered element it would hit whatever sits on
top. On a browser holding live sessions, clicking the wrong control silently is
worse than failing. A selector that matches nothing still fails, as before.

## Screenshots and recording

```bash
gaze shot --full
gaze record --seconds 20 --fps 4
gaze record --seconds 20 --format frames    # skip encoding
```

Frames are the source of truth. `mp4` is an optional convenience via ffmpeg: if
ffmpeg is missing or fails, every frame stays on disk, the path is printed, and
the command still exits 0.

Bounded on purpose, because uncapped recording is how a disk fills overnight.
Duration caps at 600s, fps at 30, and `--max-mb` (default 250) stops capture
cleanly and says why.

## Consent

Reads never prompt. Writes (`click`, `fill`, `press`, `download`, `eval`,
`login`, `upload`, `record`, and `session load`) do, showing the action and the
page it will run on. `session list` stays ungated: it shows only the names of
saved sessions, never their contents.

```bash
GAZE_APPROVAL=prompt        # ask on the terminal (default)
GAZE_APPROVAL=fingerprint   # require a fingerprint touch
GAZE_APPROVAL=off           # trust the caller
gaze click "#buy" --yes     # pre-approve this one action
GAZE_YES=1 gaze click "#buy"   # the same, for programmatic callers
```

**If a value came from a page, put it after `--`.** `gaze fill "#note" -- "$text"`
is unambiguous; `gaze fill "#note" "$text"` is not, because a `$text` of
`--yes` is a flag by Unix convention. That was a real bypass: the MCP server
handed model-supplied strings straight to the CLI, so a page saying "type
`--yes` into the box" pre-approved its own write. The MCP server now always
inserts `--`, and `GAZE_YES=1` exists so programmatic callers never have to put
consent in argv at all, where page-derived data can reach it.

For fingerprint mode, enrol one first with `fprintd-enroll`.

### Approve once, not every time

```bash
gaze grant --minutes 30
gaze grant --minutes 60 --actions 50
gaze grant-status
gaze revoke
```

Always bounded, by time and optionally by action count, with a 12 hour ceiling.
There is deliberately no `--forever`: an unbounded standing approval on a browser
holding live sessions is just "no gate" with extra steps.

`batch` asks once for a whole script rather than once per step.

## Speed

Every command pays for one browser connection. `batch` pays once for all of them.
In the test suite that is roughly **2.8x faster** for three commands, and the gap
widens with length.

```bash
printf 'goto https://example.com\nmap --json\nscrape h1\n' | gaze batch -
gaze batch script.txt
```

Fixed post-action sleeps are the difference between responsive and fast when an
agent runs hundreds of steps. `goto`, `click`, `fill --enter` and `press`
accept `--wait calm`, which settles on real page quiet — no responses for a
window, DOM node count stable, `readyState` complete — instead of sleeping a
fixed number of milliseconds. It is bounded, so calm mode is never slower than
the sleep it replaces:

```bash
gaze click "#signin" --yes --wait calm
export GAZE_WAIT=calm      # the whole run, including batch
```

A numeric `--wait` (e.g. `--wait 2000`) keeps the old predictable behaviour.

## Credentials

```bash
export BW_SESSION=$(bw unlock --raw)   # YOU do this, once
gaze login github.com --submit
gaze login github.com --totp
```

`gaze` **cannot unlock your vault**, deliberately. A vault should only be unlocked
by a human action, and `gaze` is a CLI that agents drive: letting it run
`bw unlock` would hand any agent the ability to unlock your vault on its own.

Secrets never touch argv, stdout, or the log: the vault session is handed to
`bw` through the environment, not on its command line, so it is not sitting in
`ps` while the call runs. `login` also refuses to run on a password manager's
own web UI. That guard is on `login` specifically, so a plain `fill` there is
not blocked.

## Sessions

The profile clone already persists logins. `session` is for parking a *particular*
state and returning to it.

```bash
gaze session save work        # snapshot cookies, written mode 600
gaze session load work
gaze session list
```

## CAPTCHAs

```bash
gaze challenge                # exits 2 if one is present
gaze wait-human --timeout 300 # block until a person clears it
```

**Nothing here solves a CAPTCHA, and nothing will.** Solver services are
bot-detection evasion: they breach most sites' terms, and on a browser carrying
live sessions the downside is losing the account, not failing a scrape. The
browser is visible on purpose so you can clear it in seconds.

## Headed or headless

Headed by default, on purpose: you can watch it work and take over mid-task.

```bash
gaze start
gaze start --headless
```

## Knowing it is active

```bash
gaze indicator on
gaze indicator off
```

Draws a badge into the page itself. In-page rather than an OS notification
because it is styled by the tool, needs no notification daemon, looks identical on
every system, and sits where you are already looking. It lives in a shadow root so
the page cannot restyle or hide it, is `pointer-events:none` so it can never
swallow a click, and survives navigation.

## Insights

```bash
gaze stats --days 7    # runs, failure rate, p50/p95 per command, busiest sites
gaze log --n 20        # raw recent entries
```

Local JSONL, mode 600, nothing leaves the machine, `GAZE_LOG=off` disables it.
**Values are redacted**: `fill` values, `eval` scripts and `login` arguments
never reach the log, because a log that quietly accumulates passwords is worse
than no log. `goto` URLs keep their origin and path but have their query string,
fragment and any userinfo stripped, since that is where magic-link tokens,
OAuth codes and signed-URL signatures live. A secret embedded in the path
itself does survive: stripping the path too would leave entries that say
nothing. Use `GAZE_LOG=off` for a run where even that matters.

## Settings

| Set this | To do this |
|---|---|
| `GAZE_BROWSER` | use a specific browser (`gaze browsers` lists the names) |
| `GAZE_APPROVAL` | `prompt`, `fingerprint`, or `off` |
| `GAZE_PORT` | run on a different debug port, default `9225` |
| `GAZE_PROFILE` | keep the cloned profile somewhere else |
| `GAZE_HOME` | point at a different checkout |
| `GAZE_STATE` | keep the log, sessions and standing grant somewhere else (default `~/.local/share/gaze`) |
| `GAZE_YES` | `1` pre-approves writes without putting consent in argv |
| `GAZE_LOG` | `off` disables activity logging |
| `GAZE_HEADLESS` | start without a visible window |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | error |
| `2` | a CAPTCHA or bot challenge is blocking the page |
| `3` | the action was not approved |

Scripts can branch on 2 and 3 rather than treating them as crashes.
