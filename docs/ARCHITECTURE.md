# gaze — architecture blueprint (reviewed 2026-09-06)

This is the working technical blueprint for gaze, distilled from a research
assessment (Sept 2026) and **corrected against the repo, the code, and the
2026 research annexes**
([`browser-automation-landscape-2026.md`](browser-automation-landscape-2026.md),
[`browser-market-and-adoption-2026.md`](browser-market-and-adoption-2026.md)).
It is design intent, not yet implementation. Every section maps to a ROADMAP
part (§9 here ↔ [ROADMAP.md](ROADMAP.md)).

**Flag legend:** ✅ verified in code/primary source · ⚠️ corrected (the
assessment was wrong or unsafe) · 🔶 unverified — confirm before building.

---

## 0. Non-negotiables (carried from ROADMAP §0)

Deterministic tool, not an agent · drives a real signed-in profile · consent
fail-closed · page content untrusted · no CAPTCHA solving by default · no
listening network port · no browser extension, ever.

---

## 1. Protocol engines

Decision: **three adapters + one stdio surface**, selected by a capability
probe at launch; degrade by capability, never by guess.

| Browser family | Protocol | Why | Status |
|---|---|---|---|
| Chromium (Chrome/Edge/Brave/Vivaldi/Opera/Chromium/CfT) | **CDP** (`connectOverCDP`) | Deepest, fastest attach to a running or launched browser; multi-client since Chrome 63 | ✅ today (`gaze.mjs`) |
| Firefox (Firefox/Dev Edition/BASILISK) | **WebDriver BiDi** (hand-rolled WS client) | Firefox 141+ removed CDP; BiDi is Firefox's only remote protocol; agent must be enabled at launch | ✅ today (`gaze-bidi.mjs`) |
| Safari/WebKit (macOS) | **Tier 1: `safaridriver --mcp`** (Safari 27 beta / STP 247+) — official stdio MCP over the real signed-in Safari · **Tier 2:** W3C WebDriver classic (fresh profile, no saved sign-in) | The only Safari surface honoring real login state; classic Safari cannot honor profile clones | 🔶 build later, macOS-only, labelled experimental ([WebKit](https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/)) |
| Anything with a WebDriver endpoint (WebKitGTK, driver-only cases) | **W3C WebDriver classic** (~30 endpoints, `element-6066-11e4-a52e-4f735466cecf`, ~400–800 LOC on global `fetch`) | Reach; **no console/network/push events** — gate those features on CDP/BiDi | 🔶 build last ([WebDriver 2](https://www.w3.org/TR/webdriver2/)) |

⚠️ **Spec status correction:** WebDriver BiDi is *not yet a W3C
Recommendation* — it is a Working Draft (latest 2026-09-03). It is nonetheless
the convergent standard (Chrome 106+/Firefox 102+; WebKit work in progress).

---

## 2. Session and profile strategy

**Goal:** act inside the operator's real, signed-in context without copying
raw cookies and without cloud state.

Two launch modes (no extension):

1. **Attach** — if the operator's own browser is running with a debug port,
   `connectOverCDP` (Chromium) attaches to the *live* browser: true shared
   session, operator can watch and take over. Playwright ≥1.60
   `connectOverCDP({noDefaults})` exists exactly for daily-driver attach.
2. **Clone** — otherwise `gaze sync` copies the everyday profile to a
   gaze-owned directory and launches that (**current model**). The clone is a
   point-in-time, per-machine copy.

⚠️ **Correction — no "shadow profile mirroring" via symlinks.** The assessment
suggests symlinking `Cookies`, `Login Data`, `Local Storage/leveldb` into an
ephemeral dir to dodge lock files. Rejected: (a) symlinking live SQLite/WAL
auth databases while the real browser is running invites corruption — the repo
learned this the hard way (`sync` insists the everyday browser is closed);
(b) Device-Bound Session Credentials bind sessions to hardware keys, so a
linked file copy cannot mint signatures on another profile anyway;
(c) DBSC keys are device+profile bound, so clones are per machine.

✅ **DBSC advantage is real and structural:** because gaze drives the real
local browser on the physical machine, automated requests carry native,
hardware-backed DBSC signatures — cloud grids, headless cookie injection, and
remote session import break on DBSC-bound sites (GA on Chrome/Windows 2026,
short-lived cookies, TPM/Secure-Enclave keys). See [Chrome blog](https://developer.chrome.com/blog/dbsc-windows-announcement).
This is a marketing-grade differentiator over every hosted browser, and it is
why session portability must stay *per machine*.

---

## 3. Cross-platform launcher and process lifecycle

Port `bin/gaze` (bash) to a thin Node launcher:

- **Discovery** — layered candidates (per-OS path table from Chromium's
  `user_data_dir.md`, snap/flatpak, Windows App Paths/Uninstall registry, macOS
  `mdfind`), verified by `--version` (or registry version on Windows), family
  from brand token then confirmed via protocol metadata. Candidate logic can
  borrow from `@agent-infra/browser-finder`/`roniemartinez/browsers`.
- **Protocol probe** — CDP `/json/version` → BiDi `POST /session`
  (`webSocketUrl` upgrade) → classic `/status`.
- **Lifecycle** — `child_process.spawn({detached:true, stdio:'ignore',
  windowsHide:true})` (setsid equivalent); per-profile state file (pid+port);
  stale-lock handling (`SingletonLock`/`.parentlock` — the documented
  "up on :9225 then dies" trap); graceful close first, `kill(-pgid)` /
  `taskkill /T` fallback, never kill by port alone; SIGINT/SIGTERM teardown.
- **Visible windows** — pass through `DISPLAY`/`WAYLAND_DISPLAY`; Windows must
  spawn into the interactive session; macOS needs the user's Aqua session.
- **Biometric approval** — fprintd today; Windows Hello / Touch ID require an
  OS-native helper or an in-window prompt; a CLI cannot trigger them from a
  daemon context.

---

## 4. Consent pipeline and security layers

Current implementation already satisfies the core of the blueprint ✅:

1. **A11y/DOM projection, not raw HTML, as the default read.** (Today: CSS
   `map` + envelope. Roadmap: ARIA snapshot as the agent default — the
   ecosystem converged here; Playwright `ariaSnapshot`, Skyvern ARIA observe.)
2. **Schema-bound tools over MCP** — zod-validated, values passed after `--`
   (structural, not luck).
3. **Hardware consent gate** — reads free, writes ask (`approve()`),
   `batch`/`grant` bounded, fingerprint mode, ticket-atomic budgets,
   no-terminal refusal, `revoke` authoritative. The gate is the anti-prompt-
   injection firewall; it never yields to page content.

⚠️ **Correction — automation-signal posture.** Do **not** adopt the
assessment's "override `navigator.webdriver` to `undefined` via init script"
and "patch `cdc_*` names at spawn". Rationale: (a) `cdc_*` leaks come from
ChromeDriver, which gaze does not run (pure `connectOverCDP`); (b) overriding
`navigator.webdriver` in a normally-launched real Chrome manufactures an
inconsistency — detectors catch *inconsistent* fingerprints
([arXiv 2406.07647](https://arxiv.org/pdf/2406.07647)); (c) gaze's stance is
one genuine consistency fix (Patchright avoids `Runtime.enable`), no disguise.
Keep headed default; keep `navigator.webdriver` whatever the real binary
reports. Firefox-specific caveat stands: `navigator.webdriver === true` under a
Marionette/BiDi session — verify on real targets and document, don't mask.

---

## 5. MCP surface and the 2026-07-28 spec

Today: stdio-only MCP server (`mcp.mjs`), 16 tools wrapping the same CLI.

Migration plan (ROADMAP part 3/7, 🔶 — spec published 2026-07-28):
- **Stateless core** — drop the `initialize` handshake / `Mcp-Session-Id`;
  every request self-describing (`_meta` carries protocol metadata, client
  capabilities, version) ([4sysops](https://4sysops.com/archives/mcp-2026-07-28-goes-stateless-removing-session-overhead-at-scale/),
  [spec](https://modelcontextprotocol.io/specification/2026-07-28)).
- **MRTR for consent** — server returns
  `resultType: "input_required"` + `inputRequests`; client collects the human's
  answer and retries with `inputResponses`. This is the *protocol-native shape*
  of gaze's approval gate — map `approve()` refusals onto it.
- **Extensions** — `io.modelcontextprotocol/tasks` (async task lifecycle) and
  MCP Apps `ui://` (host-rendered confirmation UIs) are the future for
  long-running research/recording tasks.
- Stdio stays the default transport (invariant 6); streamable-HTTP + OAuth
  2.1/CIMD apply only to server deployments, which gaze is not.

---

## 6. WebMCP bridge (optional, watch-first)

WebMCP lets pages expose structured, schema-backed tools that run in the page
context (`document.modelContext`), executing with the tab's cookies/SPA state
and returning typed JSON. Current reality (🔶/⚠️): Chrome Origin Trial
(Chrome 149+, 2026-06-09); **Puppeteer "native WebMCP" claim unverified**;
**WebKit officially opposes**; Firefox neutral ([compat](https://dev.to/ai-agent-economy/webmcp-in-2026-which-browsers-support-navigatormodelcontext-complete-compatibility-status-1oe4),
[opposition](https://dev.to/r0bertini/webkit-opposes-webmcp-heres-what-to-actually-build-today-18dn)).

Plan: **no dependency**, but design the MCP layer so that a future WebMCP
adapter can expose discovered in-page tools to the client when the site
declares them (`readOnlyHint`/`untrustedContentHint` honored — the security
model mirrors gaze's own envelope). Treat as integration surface and threat
signal (site-authored tools reduce DOM-driving needs on participating sites).
Track Chromium's implementation status; verify Puppeteer integration against
its changelog before any engineering.

---

## 7. Perception, speed and recording

- **Perception default = accessibility tree text** (token-cheap, diffable,
  deterministic); screenshots only for visual truth. `state` returns snapshot +
  `sha256` fingerprint so callers detect change without pixels.
- 🔶 **Optional local OCR** (assessment's PP-OCRv5/PaddleOCR idea): viable for a
  *local* "read pixels → text+coords" command for genuinely visual/rendered
  content, but heavy (model GBs, Apache-2.0), and DOM/AXTree covers the common
  case. Schedule as an optional late part, never the default path.
- **Speed:** condition-based settles replace fixed sleeps; persistent driver
  (stdio session, later Unix socket) removes per-call attach cost; batch stays.
  Sub-50 ms per step is a *target*, not a promise — measure with `gaze stats`
  p50/p95 (ROADMAP acceptance: ≥2× benchmark wall-time cut).
- **Recording:** per-step NDJSON ledger + screenshot-on-fingerprint-change;
  video opt-in via variable-rate screencast; frames remain source of truth.

---

## 8. Competitive position (one screen)

| Lever | Where it beats |
|---|---|
| No extension | chrome-faithful, browsermcp, real-browser-mcp, vibe-mcp, Kimi WebBridge, Claude in Chrome, Manus Operator |
| Real signed-in profile, local-only | hosted grids (Browserbase/Steel), cloud AI browsers (Comet/Dia), vision computer-use |
| Deterministic, non-LLM, consent-enforced | browser-use, Stagehand, Skyvern (prompt-level safety) |
| Firefox/BiDi real-profile | essentially uncontested (Kameleo = antidetect; Playwright/Chrome MCP = Chrome-first) |
| DBSC-native (real hardware) | every cloud/headless/cookie-import path |

The wider landscape and white-space analysis:
[`browser-market-and-adoption-2026.md`](browser-market-and-adoption-2026.md).

---

## 9. Mapping to the roadmap

| Blueprint topic | ROADMAP part |
|---|---|
| Protocol engines + Safari tiers | Part 5 (any-browser) & Part 8 (WebDriver classic, experimental) |
| Session/profile strategy + DBSC | Part 5 (sessions & identity) |
| Node launcher + discovery | Part 5 |
| Consent/security layers | Parts 2 & 7 (+ current code) |
| MCP 2026-07-28 stateless + MRTR | Part 3 (persistent driver) / Part 7 (MCP migration) |
| WebMCP bridge | Part 4/7 watch items |
| Perception (a11y) + OCR option | Part 2 (speed & perception) |
| Recording ledger | Part 6 (observability) |

## 10. Corrections summary (what the source assessment got wrong)

1. BiDi is a W3C **Working Draft**, not a finished standard.
2. "Shadow profile mirroring" by symlinking live auth DBs — **rejected** (corruption risk; DBSC keys don't travel).
3. `navigator.webdriver` override + `cdc_*` patching — **rejected** (ChromeDriver-only leak; inconsistency beats honesty).
4. "Puppeteer native WebMCP" — **unverified**; verify in the changelog first.
5. WebMCP status over-stated — Chrome OT, WebKit opposed; treat as watch.
6. Sub-50 ms step times are aspirational targets, not measured facts.
7. OCR is optional-and-heavy, not the perception default.
