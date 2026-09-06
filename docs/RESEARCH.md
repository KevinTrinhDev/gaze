# Research

Every design decision in `gaze` traces to published work. This is that work, and
what it changed here.

---

## Why the profile is cloned

Chrome 136 stopped honouring `--remote-debugging-port` and `--remote-debugging-pipe`
on a browser's default data directory. Attackers had been driving the debug port to
lift cookies out of the default profile, a technique discussed publicly since 2018
that spiked once App-Bound Encryption closed easier routes. A non-standard
`--user-data-dir` also gets a different encryption key.

- [Changes to remote debugging switches to improve security](https://developer.chrome.com/blog/remote-debugging-port) - Chrome for Developers
- [Return of the Cookie Monster](https://specterops.io/blog/2026/08/13/chrome-devtools-protocol-cookie-theft/) - SpecterOps, Aug 2026
- [Chrome DevTools Technique Enables Authenticated Session Hijacking](https://thehackernews.com/2026/08/chrome-devtools-technique-enables.html) - The Hacker News
- [Session Hijacking and MFA Bypass](https://www.recordedfuture.com/blog/session-hijacking-mfa-bypass) - Recorded Future, Insikt Group
- [A Study on Malicious Browser Extensions in 2025](https://arxiv.org/pdf/2503.04292) - arXiv

**What it changed:** `gaze sync` clones the everyday profile to a non-default
directory and drives the clone. It is the community-standard response, not an
invention here.

- [Chrome ≥136 no longer supports being driven over CDP with the default `--user-data-dir`](https://github.com/browser-use/browser-use/issues/1520) - browser-use #1520

**Worth being clear-eyed about:** this is the same technique the mitigation exists
to stop, done locally, to your own profile, with your consent. That is why `gaze`
is treated as the highest-privilege component in the repo.

---

## Why there are two protocols

Firefox removed CDP entirely. `--remote-debugging-port` on Firefox now serves
WebDriver BiDi. Selenium dropped Firefox CDP in 4.29; Puppeteer and Cypress both
migrated.

- [CDP Retirement in Firefox](https://fxdx.dev/cdp-retirement-in-firefox/) - Mozilla
- [Bug 1882096: Remove CDP support from Remote Agent](https://bugzilla.mozilla.org/show_bug.cgi?id=1882096)
- [Removing Chrome DevTools Support For Firefox](https://www.selenium.dev/blog/2025/remove-cdp-firefox/) - Selenium

**What it changed:** `gaze.mjs` speaks CDP for the Chromium family;
`gaze-bidi.mjs` is a hand-rolled BiDi client for the Firefox family, which is what
lets `gaze` drive BASILISK Browser itself.

---

## Why the driver is Patchright

Anti-bot systems specifically flag `Runtime.enable`, the CDP call stock automation
libraries make during page setup. Detection is layered: TLS handshake fingerprints
(JA3/JA4), canvas/WebGL/audio fingerprints, and behavioural signals.

- [When Handshakes Tell the Truth: Detecting Web Bad Bots via TLS Fingerprints](https://arxiv.org/html/2602.09606v1) - arXiv, Feb 2026. A CatBoost classifier on JA4 features reaches **AUC 0.998, 98.6% accuracy**. Your handshake alone identifies you.
- [FP-Inconsistent: Fingerprint Inconsistencies in Evasive Bot Traffic](https://arxiv.org/pdf/2406.07647) - arXiv. Evasive bots are caught by *inconsistencies* between claimed fingerprints, not by any single value.
- [Detecting Bot Detection: Prevalence, Techniques, and Implications](https://arxiv.org/pdf/2606.14525) - arXiv
- [How New Headless Chrome & the CDP Signal Are Impacting Bot Detection](https://datadome.co/threat-research/how-new-headless-chrome-the-cdp-signal-are-impacting-bot-detection/) - DataDome
- [Detecting Puppeteer Extra Stealth with JS Fingerprinting](https://datadome.co/bot-management-protection/detecting-headless-chrome-puppeteer-extra-plugin-stealth/) - DataDome

**What it changed:** the driver is [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright),
which removes the `Runtime.enable` tell, with a fallback to stock Playwright.

**What it deliberately did NOT change:** `gaze` does not chase evasion. It drives
your own profile, on your own accounts, from your own IP, in a visible window. You
are not impersonating a human user; you *are* one. FP-Inconsistent is the reason
half-hearted stealth is worse than none: added fakery creates exactly the
inconsistencies detectors look for. Removing a genuine discrepancy is worth it;
manufacturing a disguise is not.

---

## Why scraped output is wrapped and scanned

Indirect prompt injection is the live threat against an agent-driven, logged-in
browser. A page can carry text addressed to the *AI* rather than the human, and the
agent then acts with real credentials.

- [Indirect Prompt Injection Goes Operational](https://labs.cloudsecurityalliance.org/research/csa-research-note-indirect-prompt-injection-in-the-wild-2026/) - Cloud Security Alliance, 2026
- [Indirect Prompt Injection in the Wild: An Empirical Study](https://arxiv.org/pdf/2604.27202) - arXiv
- [IPI-proxy: Red-Teaming Web-Browsing AI Agents Against Indirect Prompt Injection](https://arxiv.org/pdf/2605.11868) - arXiv
- [EIA: Environmental Injection Attack on Generalist Web Agents](https://arxiv.org/pdf/2409.11295) - arXiv
- [From Secure Agentic AI to Secure Agentic Web](https://arxiv.org/pdf/2603.01564) - arXiv
- [Indirect Prompt Injection Targets AI Agents](https://www.zscaler.com/blogs/security-research/indirect-prompt-injection-web-content-targets-ai-agents) - Zscaler ThreatLabz

Attack success rates reach **84%** against agentic systems, production exploits
carry **CVSS above 9.0**, and OpenAI has publicly stated that prompt injection in AI
browsers *"may never be fully patched"*. OWASP's Top 10 for Agentic Applications
2026 covers it as LLM01 plus LLM06 (Excessive Agency).

**What it changed:** `text`, `html`, `scrape`, `links` and `table` wrap output in an
untrusted envelope naming its source, and flag known injection patterns as
`_suspicious`. Write actions are gated so a scraped page cannot silently cause a
state change. None of this is a proof: treat scraped content as hostile input,
always.

---

## Why cloning will erode

Device Bound Session Credentials bind a session to a private key held in the device
TPM, so a copied profile cannot replay it. Chrome shipped DBSC to stable in 146.

- [Device Bound Session Credentials](https://w3c.github.io/webappsec-dbsc/) - W3C Web Application Security WG
- [w3c/webappsec-dbsc](https://github.com/w3c/webappsec-dbsc)

Adoption is server-side, so this degrades **site by site**, not all at once.

**What it changed:** nothing in the code, and nothing should. If logins start
failing on one site while every other site in the same profile still works, suspect
DBSC adoption there. The correct response is to use that site by hand.

---

## Why CAPTCHAs are detected and never solved

Third-party solving services are bot-detection evasion. They breach most sites'
terms, and on a browser carrying live sessions the downside is losing the account,
not failing a scrape.

**What it changed:** `challenge` detects and exits 2; `wait-human` blocks until a
person clears it in the visible window. No solver integration exists, and none
should be added.

---

## The landscape, for context

If you are evaluating alternatives, these are the serious ones and how they differ.

| Tool | Approach | Trade-off |
|---|---|---|
| [Camoufox](https://github.com/daijro/camoufox) | Firefox fork, patched at C++ level | Strongest on hard targets, among the slowest |
| [nodriver](https://github.com/ultrafunkamsterdam/nodriver) | Drives Chrome over CDP with no Playwright bridge | Avoids `Runtime.enable` entirely |
| [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) | Drop-in Playwright fork | What `gaze` uses |

Every source repeats the same caveat: **each of these leaks eventually and needs
re-patching after browser updates.** A design that depends on winning that race is
a design with a maintenance treadmill attached. `gaze` deliberately does not enter
it.

---

# 2026 landscape update

Fresh research pass, 2026-09-06. Sources per claim; the full annex is
[`browser-automation-landscape-2026.md`](browser-automation-landscape-2026.md),
and the strategy it feeds is in [`ROADMAP.md`](ROADMAP.md).

## Perception: accessibility snapshots are the agent default

Playwright MCP's design is explicit: its accessibility snapshot is "better than
screenshot" — text-only, deterministic, no vision model
([README](https://github.com/microsoft/playwright-mcp)). Playwright removed the
long-deprecated `page.accessibility` (CDP-only) in v1.57 and standardised on
`locator.ariaSnapshot()` (YAML) with `ariaSnapshotJSON()` and `mode:'ai'` refs
([ARIA snapshots](https://playwright.dev/docs/aria-snapshots)). Skyvern
observes ARIA/shadow-DOM/cross-origin iframes; browser-use serialises the DOM.

**What it changes:** `map` (CSS selectors, good for humans) should gain an a11y
snapshot mode (`map --aria`/`snapshot`) as the default agent-facing read, and a
`state` command that returns snapshot + fingerprint so callers detect change
without re-reading pixels. Chromium: `locator.ariaSnapshot()` is already in the
installed Playwright. Firefox: small in-page ARIA builder via BiDi
`script.evaluate` (no DOMSnapshot/a11y tree exists on the BiDi side yet).

## Attach vs snapshot vs launch — the three session models

Playwright's docs distinguish them cleanly
([connectOverCDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp),
[auth guide](https://playwright.dev/docs/auth)): `storageState` is a
point-in-time snapshot (cookies + localStorage only); `launchPersistentContext`
is a browser *you* launch — no two instances may share one userDataDir;
`connectOverCDP` is the only true *attach to the operator's already-running
browser*. Chrome 136 (Mar 2025) made a non-default `--user-data-dir` mandatory
for remote debugging
([Chrome blog](https://developer.chrome.com/blog/remote-debugging-port)), which
is exactly the clone model. Playwright 1.60 added `noDefaults` to
`connectOverCDP` for daily-driver attach; multiple CDP clients per browser have
been supported since Chrome 63.

**What it changes:** keep clone-for-identity and reserve `connectOverCDP` for
live-shared Chromium (operator watching/taking over the same window); document
that storageState misses IndexedDB/sessionStorage and that DBSC-bound sites will
not replay on another machine.

## WebDriver BiDi: the cross-browser future is not a standard yet

BiDi is still a W3C **Working Draft** as of 2026-09-03 (FPWD 2024-11-21)
([spec](https://www.w3.org/TR/webdriver-bidi/),
[history](https://www.w3.org/standards/history/webdriver-bidi/)), shipped in
Chrome 106 and Firefox 102. Firefox's Remote Agent is BiDi-only now (CDP removed
~FF 141), starts only with `--remote-debugging-port` at launch (no attach to a
running agent-less Firefox), and Firefox reports `navigator.webdriver === true`
while a Marionette/BiDi session is active
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/webdriver);
verify against real targets).

**What it changes:** the Firefox model stays clone + own instance. Add a
self-test/verification for the `navigator.webdriver` signal. Track BiDi module
growth (`storage.getCookies`, `log.entryAdded`, `network.*`,
`input.performActions`, user contexts) as the path to Firefox parity without
CDP.

## Real headed profile beats stealth — with one caveat

The 2025-2026 verdict across sources: JS-injection stealth is largely obsolete
against managed challenges (puppeteer-extra #920; Camoufox's C++-level
argument; DataDome's CDP-session detection; Castle.io). A measured reCAPTCHA v3
study found near-identical synthetic traces scored 0.1–0.3 clean but passed in a
real profile — environment authenticity dominates trace perfection
([arXiv 2607.18659](https://arxiv.org/abs/2607.18659)). But the *control
channel* itself leaks: DataDome detects CDP-driven sessions, Patchright exists
because `Runtime.enable`/`Console.enable` are detectable, and behavioural +
network-reputation signals dominate once browser artifacts are clean
(Cloudflare [engines](https://developers.cloudflare.com/bots/concepts/bot-detection-engines/),
[clearance](https://developers.cloudflare.com/cloudflare-challenges/concepts/clearance/)).

**What it changes:** nothing in the code — it *confirms* the existing stance
(one consistency fix via Patchright, no camouflage). Keep the headed default.
Add the caveats to the challenge docs: a hard 403 usually means network/ASN;
an interactive challenge usually means behaviour/driver suspicion.

## CAPTCHA solving: a throughput business gaze does not need to join

Solver measurements (Jul-2026): Turnstile and reCAPTCHA v2 solve ~100%,
reCAPTCHA v3 solver tokens clear ≥0.5 only 0–63%, and hCaptcha is being dropped
(only 2 of 7 providers still sell it; CapSolver removed it)
([arXiv 2607.18659](https://arxiv.org/abs/2607.18659), [CapSolver pricing](https://docs.capsolver.com/vi/pricing/)).
Tokens are minted in the solver's environment and injected into yours — a
behaviour mismatch risk on a high-trust profile. Challenge verdicts key on the
whole environment (Camoufox users got "invalid-response" on Discord hCaptcha
despite correct solves: [camoufox #429](https://github.com/daijro/camoufox/issues/429)).

**What it changes:** default stays detect → pause → notify → human clears →
resume (token minted in-session, no injection race). ROADMAP §7 documents the
one narrow opt-in a domain owner could switch on (reCAPTCHA v2/Turnstile only,
success-tracked), and why v3/hCaptcha-Enterprise/in-browser auto-clicking on an
authenticated profile stay off.

## Recording that scales: change-driven ledger, not constant video

CDP `Page.startScreencast` is variable-rate — frames only when the page
repaints — which is a feature for audit time-lapse, not a bug
([Page domain](https://chromedevtools.github.io/devtools-protocol/tot/Page/)).
Playwright's own bundled video is hardcoded vp8/1 Mbps with no libx264
([deep dive](https://dev.to/mutsuntsai/replacing-playwrights-hardcoded-vp8-encoder-a-deep-dive-into-pagescreencast-43ee)).
The ecosystem's replayable artifact is an action + before/after snapshot +
console/network trail (Playwright trace; Stagehand's per-act logs; Browserbase's
per-session video/HLS).

**What it changes:** roadmap adopts a per-step NDJSON ledger with a `sha256`
state fingerprint and screenshot-on-change; video stays opt-in and bounded.
One injected snapshotter shared by both backends keeps parity
(CDP `Page.addScriptToEvaluateOnNewDocument`, BiDi `script.addPreloadScript`).

## DBSC and the clone's half-life

DBSC (device-bound session credentials) is GA on Chrome/Windows, TPM-bound with
silent refresh
([Chrome blog](https://developer.chrome.com/blog/dbsc-windows-announcement));
Firefox has none and is evaluating. Adoption is server-side, so clone erosion is
site-by-site.

**What it changes:** nothing in code — but `doctor` should surface clone age vs
cookie age so a stale clone is diagnosed as "re-run `gaze sync`", not a bug.

## Sources added in this pass

[Playwright MCP](https://github.com/microsoft/playwright-mcp) ·
[ARIA snapshots](https://playwright.dev/docs/aria-snapshots) ·
[BiDi spec](https://www.w3.org/TR/webdriver-bidi/) ·
[Chrome 136 change](https://developer.chrome.com/blog/remote-debugging-port) ·
[arXiv 2607.18659](https://arxiv.org/abs/2607.18659) ·
[Cloudflare engines](https://developers.cloudflare.com/bots/concepts/bot-detection-engines/) ·
[Cloudflare clearance](https://developers.cloudflare.com/cloudflare-challenges/concepts/clearance/) ·
[CapSolver](https://docs.capsolver.com/vi/pricing/) ·
[CDP Page domain](https://chromedevtools.github.io/devtools-protocol/tot/Page/) ·
[Chrome DBSC](https://developer.chrome.com/blog/dbsc-windows-announcement)
