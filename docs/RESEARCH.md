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
