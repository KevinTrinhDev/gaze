# gaze roadmap — anywhere, any browser, any OS

Working plan, last updated 2026-09-06. It is a plan, not a commitment: nothing
here is implemented yet, and every item names the code it touches. The landscape
claims come from a fresh research pass over the 2025–2026 browser-automation
ecosystem; the full tool-by-tool annex is
[`docs/browser-automation-landscape-2026.md`](browser-automation-landscape-2026.md),
and the decisions that change how gaze is built live in
[`docs/RESEARCH.md`](RESEARCH.md). The honest competitor comparison is
[`docs/COMPARISON.md`](COMPARISON.md).

## The goal, in plain words

gaze should be the layer that **finds a way in on whatever browser and OS it is
running**, with no extension, no vendor lock-in, and no agent inside it:

- It is **not tied to a browser extension** (unlike Claude in Chrome or
  Playwright MCP's extension mode) and **not tied to one protocol**.
- On a given machine it **discovers what is installed and capable**, picks the
  deepest driver it can actually speak to, and tells you what it found.
- It **learns quietly**: remembers, locally and with consent, what worked on a
  site (which selector route matched, what wait settled, which JSON API the
  page itself calls), so the next run is faster. Never by rotating fingerprints
  or evading controls — see Non-goals.
- Everything it gains must keep the invariants in §0. Stronger and faster only
  matter if the consent gate, the untrusted envelope and the "one real
  identity" stance survive.

---

## 0. What must not change

1. **Deterministic tool, not an agent.** No model, planner, goal loop or durable
   autonomous memory inside gaze.
2. **Drives a real, already-signed-in profile.** Sessions are inherited from the
   operator, never provisioned.
3. **Enforceable consent, fail closed.** Reads free, writes gated, grants always
   bounded, no terminal = refusal.
4. **Page content is untrusted.** Every read is enveloped and injection-scanned,
   on every backend, with no second un-wrapped code path.
5. **No CAPTCHA solving by default, no evasion arms race.** Detect → pause →
   notify → human clears → resume. (§7 explores the one narrow per-domain
   opt-in that is defensible, and why the default stays refuse-and-pause.)
6. **Nothing listens on a network port.** stdio / local Unix socket only.
7. **No extension required.** Anything that needs an extension installed in the
   operator's browser is a different product.

---

## 1. Where gaze is today (architecture map)

| Layer | File | What it is |
|---|---|---|
| Launcher | `bin/gaze` (bash) | Hand-maintained browser table (Linux/macOS rows), profile-clone `sync`, `start/stop`, `doctor`, resolved-path `rm -rf` guard |
| Chromium backend | `gaze.mjs` | Playwright/Patchright `connectOverCDP`; one process per invocation (or one per `batch`); ~26 commands |
| Firefox backend | `gaze-bidi.mjs` | Hand-rolled WebDriver BiDi client; command subset; synthetic-JS click/fill |
| Consent | `consent.mjs` | Approval gate + ticket-atomic grant budgets |
| Untrusted output | `untrusted.mjs` | Injection envelope shared by both backends |
| MCP server | `mcp.mjs` | Stdio-only; 16 tools; each tool shells out to the CLI |
| Telemetry | `gaze.mjs` main | Redacted JSONL; `stats` p50/p95 per command |

**Measured cost facts (from the code):** the driver import (~270 ms) is deferred
until the first browser command; every CLI/MCP call pays node boot + driver
import + `connectOverCDP` attach + run + exit (`batch` exists because one
connection per process is the dominant cost — ~2.8× on three commands per the
README); fixed sleeps dominate wall time — `goto` 1500 ms, `click` 1200 ms,
`fill --enter` 2000 ms, `scroll` 400 ms — all page-agnostic heuristics, none
condition-based.

---

## 2. What the 2025–2026 ecosystem converged on (verified, sourced in annex)

- **Real, persistent profiles are now the ecosystem's auth primitive.**
  Attaching to the operator's own signed-in browser is first-class in Playwright
  MCP (`--cdp-endpoint`, its browser extension), Skyvern (attach to
  `127.0.0.1:9222`), browser-use (real-Chrome-profile auth path) and Claude in
  Chrome. Chrome 136 (2025) *requires* a non-default `--user-data-dir` for
  remote debugging — gaze's clone model is the community answer, now mandatory.
  Playwright 1.60 added `connectOverCDP({ noDefaults })` specifically for
  attaching to a daily-driver browser without overriding its context.
- **Accessibility snapshots, not screenshots, are the agent-perception
  default.** Playwright MCP is explicit that its a11y snapshot is "better than
  screenshot": text-only, token-cheap, deterministic, no vision model needed.
  Playwright removed the old `page.accessibility` (v1.57) in favour of
  `locator.ariaSnapshot()`; browser-use / Stagehand / Skyvern all serialize a
  compact interactive-elements tree with stable refs. Vision stays a fallback
  for visual truth.
- **WebDriver BiDi is the cross-browser future but not a standard yet.** Still a
  W3C Working Draft (2026-09-03). Shipped in Chrome 106 and Firefox 102;
  Firefox's Remote Agent is BiDi-only (CDP removed ~FF 141), starts only with
  `--remote-debugging-port` **at launch** (no attach to an already-running,
  agent-less Firefox), and Firefox reports `navigator.webdriver === true` while
  a Marionette/BiDi session is active.
- **A real headed human profile beats headless + stealth** — with one caveat:
  the *control channel itself* can be detected (DataDome detects CDP-driven
  sessions; patchright exists because `Runtime.enable`/`Console.enable` leak;
  Camoufox isolates its protocol at C++ level). Behavioural/velocity signals and
  network reputation dominate once browser artifacts are clean. In a measured
  reCAPTCHA v3 study, near-identical synthetic traces scored 0.1–0.3 in clean
  environments but passed inside a real user profile — environment
  authenticity beats trace perfection.
- **Recording that scales is change-driven, not constant.** A per-step NDJSON
  ledger with a state fingerprint, screenshots only when the fingerprint
  changes; video opt-in via variable-rate screencast (frames only on repaint).
  rrweb-class full DOM replay only when JS-state debugging genuinely needs it.
- **CAPTCHA solving is a throughput business and hCaptcha is falling out of
  it** (only 2 of 7 measured providers still sell it; CapSolver dropped it).
  Turnstile and reCAPTCHA v2 are reliably solved (~100% measured), reCAPTCHA v3
  is not (solver tokens clear the ≥0.5 bar only 0–63%). Challenge verdicts key
  on the whole environment, not click accuracy — which is exactly why solving
  inside an authenticated profile is the riskiest option there is.

---

## 3. Pillar A — any browser, any OS (the "finds a way" layer)

### 3.1 A capability model instead of a fixed table
`bin/gaze` holds a hand-maintained browser table. That cannot scale to "any
browser on any OS". Replace the *concept*, not just the file:

- A **discovery probe** that walks each OS's known install locations *and*
  `PATH`, probes the browser's family and remote protocol, and reports what is
  actually usable. `gaze browsers` grows columns for `DISCOVERED`,
  `CAPABLE (cdp|bidi|webdriver)`, `READY`, `profile age`.
- A **capability → driver resolver**: pick the deepest protocol a browser
  speaks — CDP (Chromium family), BiDi (Firefox family), then
  WebDriver-classic (everything else, §3.3). Persist the resolved pair
  (`browser`, `protocol`, `launch flags`) so `doctor`, `sync` and `start`
  agree with each other.
- The bash table stays as the *seed list*; discovery becomes the source of
  truth. Porting the launcher to Node (§3.4) makes the table and the discovery
  one codebase instead of a shell heredoc plus a node backend.

### 3.2 Protocol reality per family (research-backed)
- **Chromium family** (Chrome/Chromium/Brave/Edge/Vivaldi/Opera + forks): CDP.
  Chrome 136+: the debug port is honoured only on a non-default
  `--user-data-dir`, which is exactly the clone model. Add **Chrome for
  Testing** and **headless-shell** as first-class rows (pinned versions, no
  auto-update drift) for CI and unattended work.
- **Firefox family**: BiDi only; the agent must be enabled at launch. So
  Firefox keeps the clone + own-instance model — unchanged. Verify
  `navigator.webdriver` under BiDi (documented true in Firefox) and how much it
  actually costs a signed-in, headed Firefox on real targets; add a self-test
  that asserts the visible window still reads as a browser, not a bot.
- **Safari/WebKit**: two tiers (research pass #2). **Tier 1 — preferred:**
  Safari 27 beta / STP 247 ships `safaridriver --mcp`, Apple's official
  MCP/stdio server that drives the *real* signed-in Safari with tabs, DOM,
  network and console — the first Safari surface that honors genuine login
  state ([WebKit blog](https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/)).
  **Tier 2 — fallback:** W3C WebDriver-classic via `safaridriver` for
  clean-profile work, clearly labelled "no saved sign-in" (classic Safari
  cannot honor profile clones — it runs a fresh profile each session). Neither
  can be tested on Linux: scope with a macOS CI job, label experimental.

### 3.3 A thin WebDriver-classic adapter (reach, built last)
One adapter speaking the W3C WebDriver REST protocol (`session/new`, find
element, click, send keys, screenshot, script execute — the surface is small
and stable: ~30 endpoints, element refs under the fixed key
`element-6066-11e4-a52e-4f735466cecf`) gives gaze any browser with a WebDriver
endpoint: **~400–800 LOC over Node's global `fetch`**, fitting the zero-magic
ethos; classic is the *fallback* path, not the core
([WebDriver 2](https://www.w3.org/TR/webdriver2/)). Costs: per-command HTTP
round-trips and **no console/network/push events** — gate those features on
CDP/BiDi and degrade gracefully (execute-script shims). Reuse **Selenium
Manager as a standalone binary** for driver provisioning (chromedriver /
msedgedriver / geckodriver / WebKitWebDriver) rather than pulling in a Selenium
stack.

### 3.4 OS universality
- **Port `bin/gaze` to Node** (`bin/gaze.mjs`, thin and auditable): removes the
  `uname`/`ss`/`setsid`/`pgrep`/`fprintd` assumptions, gives one place for
  discovery + paths + lock handling, and makes Windows-native possible instead
  of WSL-only. `assert_clone`-grade guards (the resolved-path `rm -rf`
  protection) and the launcher self-test must survive the port — the two worst
  bugs this project ever had lived in that shell file.
- **Biometrics**: today `fprintd` (Linux PAM). Make the approver pluggable so
  Windows Hello and macOS Touch ID can back `GAZE_APPROVAL=fingerprint`.
- **Paths**: profile/clone/state locations per OS resolved from one module.

### 3.5 What stays deliberately closed
- **No extension, ever** (§0.7) — the differentiator against Claude in Chrome
  and Playwright MCP's extension mode.
- **Safari signs in as a human the same way**: clone the profile, drive the
  clone, one identity per clone. Same boundary as today.

---

## 4. Pillar B — perception and speed for AI callers

1. **a11y snapshot command** (`map --aria` / `snapshot`, plus an MCP tool):
   text ARIA tree with stable refs — the ecosystem default. Nearly free on
   Chromium (`locator.ariaSnapshot()` ships in the installed Playwright); a
   small in-page builder on Firefox/BiDi. Keep `map` (CSS selectors) for
   humans.
2. **`state` primitive**: url + title + bounded a11y snapshot + scroll
   position + **fingerprint** (`sha256` of the normalized snapshot), so a
   caller detects change without re-reading pixels. Envelope it like any page
   read.
3. **Condition-based settles replace fixed sleeps** (§1 costs): after `goto`,
   wait `readyState === 'complete'` plus a short network-quiet / render-idle
   window, with `--until <selector|url>`; after writes, settle on URL/DOM
   change instead of 1200–2000 ms blind waits; add an explicit `wait` command
   (`--for selector|url|text|network-idle`). Firefox `goto` should mirror
   Chromium (`domcontentloaded` + settle) instead of `complete`.
4. **Persistent driver**: a stdio session mode behind the MCP server (one
   long-lived backend child speaking newline-JSON), later an optional
   Unix-socket `gaze serve` (mode 600 under `$GAZE_STATE`) — never TCP. Cuts
   the ~300–400 ms per-call boot+attach. The daemon re-runs the same consent
   and redaction code in-process; `revoke` kills in-flight approvals; a daemon
   crash costs nothing (tabs/sessions live in the browser, not the daemon).
5. **Fast reads**: an authenticated in-page `fetch` helper ("drive the JSON API
   the page already calls", per OPERATING.md) as a gated write; optional
   `--skip-images` blocking of image/font/media for scrape-only runs
   (CDP `Network.setBlockedURLs`, BiDi `network.addIntercept`).
6. **Parallelism ceiling**: contexts are per-identity and cheap; BiDi has
   first-class user contexts (`browser.createUserContext`) — map gaze
   identities (§5) onto contexts rather than spawning browsers. Keep "a few
   long-lived session pools", never thousands of ephemeral browsers.

---

## 5. Pillar C — session and identity depth

- **Named identities** (`gaze sync --as work`, `gaze use work`): per-identity
  clones, each separately revocable, mapped onto BiDi user contexts / Chromium
  browser contexts for parallel work with isolated cookie jars.
- **Session fidelity**: today `session save/load` captures cookies +
  localStorage only. Gaps to close or document: IndexedDB/WebSQL/
  sessionStorage auth tokens; cookie field preservation (SameSite, partition
  keys); DBSC-bound sites will not replay on another machine — say so per site
  (DBSC is GA on Chrome/Windows; Firefox has none, evaluating).
- **Freshness signals**: `doctor` should warn when the clone is older than the
  cookies it carries and offer `sync` — the clone is a point-in-time copy of
  the human's identity and erodes site by site (DBSC adoption, session
  rotation), never all at once. **DBSC is GA on Chrome/Windows (2026):**
  cookies are device-bound, so clones are *per machine* — `gaze sync` across
  machines silently breaks Google sessions; document that a clone travels with
  the machine, not the account.
- **Keep the model**: profile clone for identity, plus `connectOverCDP` attach
  for live-shared Chromium where the operator wants to watch and take over the
  exact same window. Research is unambiguous that storageState is a snapshot
  (cookies + localStorage only) and that no two instances may share one
  userDataDir, so clones stay the parallel/multi-identity answer.

---

## 6. Pillar D — recording and observability

Adopt the change-driven ledger the research validates:
- One **injected snapshotter JS shared by both backends**
  (CDP `Page.addScriptToEvaluateOnNewDocument`; BiDi
  `script.addPreloadScript`) producing a normalized a11y/text state — the
  cross-browser core. Chromium-only protocol features (DOMSnapshot,
  screencast) are accelerators, never the cross-browser core.
- Per-step **NDJSON ledger**: step id, command summary, URL/title, before/after
  `sha256` fingerprints, console/network as capped ring buffers, screenshot only
  on fingerprint change — ~KB/step. Extends the existing redacted JSONL and
  obeys the same redaction rules (secrets never logged).
- **Video stays opt-in and bounded**: CDP screencast frames (variable-rate —
  exploit no-frame-on-idle for time-lapse) → optional ffmpeg; frames remain the
  source of truth; keep the time/fps/disk caps.
- rrweb-class DOM replay only if JS-state debugging demands it — not the
  default; it grows with mutations and is heavy.
- Replay without video: fingerprint + action log + a11y snapshot is the
  Playwright-trace-style artifact that survives site changes, and the viewer is
  self-hostable (trace.playwright.dev loads entirely client-side).

---

## 7. Pillar E — challenge and bot posture

Default stance (unchanged): **detect → pause → notify → human clears → resume**,
reusing the consent/notify plumbing (`challenge`, `wait-human`, the
challenge-notify pattern). ~100% accurate by construction, and the token is
minted in-session — no injection race, no account risk.

Research-refined decisions:
- **Extend detection markers**: Arkose/FunCaptcha, Kasada, Akamai and AWS WAF
  are unrepresented today. Add `challenge --explain` (marker vs phrase vs
  block) for the log and for callers; a block and a challenge need opposite
  answers and gaze should say which one it found.
- **Test and document Firefox**: `navigator.webdriver` is true under a BiDi
  session; verify against real targets what that costs a signed-in Firefox and
  keep the honest statement in COMPARISON.md.
- **Headless**: docs already say headed is *less* detectable; the research adds
  that the control channel itself leaks (CDP-session detection,
  `Runtime.enable`/`Console.enable`, DataDome). Keep Patchright as the one
  consistency fix; do not stack camouflage.
- **Narrow opt-in auto-solve (default off, per-domain)**: for unattended work on
  low-account-risk targets where reCAPTCHA v2/invisible or Turnstile blocks an
  otherwise-legitimate fetch, the *operator* may opt a domain into a token-API
  solve with a success tracker that stops after 2–3 consecutive failures and
  pauses for a human. Explicitly never: v3-gated flows, hCaptcha-Enterprise,
  in-browser auto-clicking on an authenticated profile, sharing tokens across
  machines. Default remains refuse-and-pause. This is a product decision for
  the owner to switch on per domain — never something gaze does silently.
- **Watch items (research pass #2)**: Mozilla's official Firefox DevTools MCP
  (`@mozilla/firefox-devtools-mcp`, BiDi-based) as the parity reference for
  gaze's Firefox surface; Chrome's two-week release cadence (keeps
  Patchright/Playwright pins and Chrome-for-Testing current); Chrome built-in
  AI APIs as a new fingerprint surface (keep `navigator.ai` stable across
  clones); WebMCP / Mozilla AAF site annotations and agent-browser runtimes
  (Cloudflare Kitesurf, BrowserOS) as threats and integration surfaces;
  MCP spec 2026-07-28 (stateless, versioned extensions) as a scheduled
  `mcp.mjs` migration.

---

## 8. Pillar F — "learns", locally and honestly

- **Site memory (opt-in, local, mode 600)**: remember per site what worked —
  the selector route that matched last time, the wait that settled, the JSON
  endpoint the page itself calls (the fastest scrape). Next run tries memory
  first, then heals. Same adaptive-not-agentic contract as `locate()`: fixed
  order, reports which route worked.
- **Rot visibility**: selector-route success rates per site in `gaze stats`, so
  rot shows before it breaks a run.
- Memory never stores page *content* — only structure, timing and endpoints —
  and obeys the same redaction rules as the log. A site can be excluded via
  robots/terms.

---

## 9. Sequencing — landed in parts, each part green

1. **Docs & research (this branch)**: ROADMAP, expanded COMPARISON, RESEARCH
   updates, landscape annex. No behaviour change.
2. **Speed & perception**: condition-based settles + `wait`; a11y snapshot +
   `state`; Firefox trusted input (BiDi `input.performActions`, not synthetic
   JS). Acceptance: agent-loop wall time on the benchmark harness down ≥2×;
   `npm run test:all` green.
3. **Persistent driver**: stdio session mode behind the MCP server, then
   `gaze serve` on a Unix socket. Same gates in-process.
4. **Capability**: `extract --schema`; bounded `crawl` honouring conduct;
   missing primitives (`select`, `hover`, `drag`, key chords, tab
   close/activate); cross-origin frame story; Firefox parity list
   (press/download/upload/record/table/console/network/session/login/batch/
   indicator).
5. **Any-browser**: discovery probe + capability resolver; Chrome for Testing +
   headless-shell rows; Node launcher port; named identities.
6. **Observability**: shared injected snapshotter, per-step ledger,
   screenshot-on-change; video stays opt-in.
7. **Challenge depth**: extended markers + `--explain`; Firefox
   `navigator.webdriver` verification; owner decision on per-domain auto-solve
   opt-in with success tracking.
8. **Reach (experimental)**: WebDriver-classic adapter; macOS CI; Safari
   labelled experimental.

Each part keeps its own self-test, never touches a real profile, and preserves
the exit-code contracts (0/1/2/3).

---

## 10. Non-goals (stated so nobody proposes them later)

- Solving CAPTCHAs by default, stealth fingerprinting, IP/proxy rotation,
  anti-detect identities — §7 and docs/RESEARCH.md.
- Becoming an agent (a model in the loop).
- Cloud/hosted sessions (Browserbase/Steel/browserless are a different product;
  COMPARISON.md covers them).
- Full pixel/DOM-fidelity replay of every session by default.
- An extension, ever.
- Trying to defeat DBSC or challenge systems on accounts that are not ours.

---

## 11. Key sources

- `docs/browser-automation-landscape-2026.md` — tool-by-tool annex
  (browser-use, Stagehand, Playwright MCP, Chrome DevTools MCP, Puppeteer MCP,
  Skyvern, Browserbase, Steel, midscene, Camoufox, Anthropic/OpenAI/Google
  computer-use), with numbered sources.
- `docs/browser-market-and-adoption-2026.md` — second-pass annex: adoption
  short-list (WebMCP, Mozilla AAF, Webwright, Firefox DevTools MCP,
  `safaridriver --mcp`, Selenium Manager), market signals, wider competitive
  set, and any-browser implementation strategy.
- `docs/ARCHITECTURE.md` — the reviewed technical blueprint (protocol engines,
  session/profile strategy, launcher, consent/MCP pipeline, corrections list).
- Chrome 136 remote-debugging change:
  https://developer.chrome.com/blog/remote-debugging-port · Chrome for Testing:
  https://developer.chrome.com/docs/automation-and-testing/chrome-for-testing
- BiDi status: https://www.w3.org/TR/webdriver-bidi/ and
  https://www.w3.org/standards/history/webdriver-bidi/
- Playwright attach (`connectOverCDP`, `noDefaults`):
  https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp
- ARIA snapshots: https://playwright.dev/docs/aria-snapshots · Playwright MCP
  snapshot rationale: https://github.com/microsoft/playwright-mcp
- reCAPTCHA v3 / solver measurements:
  https://arxiv.org/abs/2607.18659 · Turnstile token lifetime:
  https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/
- CAPTCHA coverage/pricing: https://docs.capsolver.com/vi/pricing/ ·
  https://anti-captcha.com/pricing · https://nopecha.com/pricing ·
  https://deathbycaptcha.com/pricing · https://capmonster.cloud/en/prices
- Bot defenses: https://developers.cloudflare.com/bots/ ·
  https://developers.cloudflare.com/bots/concepts/bot-detection-engines/ ·
  https://developers.cloudflare.com/cloudflare-challenges/concepts/clearance/
- DBSC: https://developer.chrome.com/blog/dbsc-windows-announcement
- Firefox remote/BiDi: https://firefox-source-docs.mozilla.org/remote/index.html
