# How gaze compares

An honest answer to "is this actually different, or is it a wrapper?" and "why
would I not just use the big one?". Landscape data verified 2026-09-06
(stars, licenses, releases from GitHub/npm/vendor docs); full sourcing in
[`docs/browser-automation-landscape-2026.md`](browser-automation-landscape-2026.md).

## The short version

**Most of what gaze does is not novel.** Cloning a browser profile to drive it
is the community-standard answer to Chrome 136 refusing remote debugging on a
default profile. Driving a browser over CDP is Playwright. Exposing a browser
to an AI over MCP has official implementations from Microsoft and the Chrome
team, and attaching to your *real signed-in* browser is now a first-class mode
in Playwright MCP, Skyvern, browser-use and Claude in Chrome.

**What still appears not to exist elsewhere is the combination**: an *already
authenticated* browser, driven deterministically from any MCP client or shell,
with *enforceable, tool-level consent* and *provenance-tagged output* — and no
extension, no vendor client, and no agent inside the tool. Every comparable
tool either assumes unattended operation, or is an agent framework whose safety
lives in a prompt rather than in the tool, or is tied to one vendor's client.

---

## The landscape, at a glance (2026-09-06)

| Tool | What it is | Control mechanism | Acts on *your* signed-in profile? | Status / license |
|---|---|---|---|---|
| **Playwright MCP** | Official browser tools for AI clients | ARIA a11y snapshots + selectors ("snapshots, not screenshots") | Yes — `--cdp-endpoint`, its browser extension, or storage-state import | ~37k★, Apache-2.0, v0.0.80 |
| **browser-use / browser-harness** | Python agent framework (the most-starred) | Pure-CDP DOM serialization (Playwright removed in v0.6) | Yes — real-profile auth path documented | ~112k★ MIT, v0.13.10 |
| **Stagehand** | Agent framework + SDK | CDP-native; runtime injected as an extension to cut latency | Via Browserbase cloud or local attach | ~24k★ MIT, SDK 3.7.x |
| **Chrome DevTools MCP** | Chrome team's debugger tools | CDP | Debug port on your Chrome | Official, ~29 tools |
| **Puppeteer MCP** | First-gen MCP browser server | selectors + screenshots | No | **Archived/deprecated** |
| **Skyvern** | Vision+DOM agent platform | Its own SkyCDP layer; ARIA/shadow-DOM/iframe observation | Yes — attach to local Chrome `:9222` | ~23k★ **AGPL-3.0**, v1.0.52 |
| **Claude in Chrome** | Anthropic's signed-in-browser agent | Chrome extension + CDP | Yes (its whole point) | Vendor client + subscription |
| **Anthropic toolset** | `computer_use` / `browser_use` tool definitions | Desktop screenshots+coords, or a11y-tree/pixel hybrid | Your executor drives your browser | GA tool definitions |
| **OpenAI / Google** | Operator-style computer use / Gemini computer-use API | Vision → normalized coordinates | Through their clients | API-only |
| **Browserbase / Steel** | Hosted browser sessions | Cloud browsers, session APIs, HLS replay | Import sessions; not your local browser | SaaS / Steel Apache-2.0 |
| **Camoufox** | Firefox anti-detect fork, pivoting to "AI agent browser" | C++-level fingerprint spoofing | Own identities, not yours | ~12k★ MPL-2.0 |
| **midscene** | Vision-only localization | Screenshots → coordinates | Bring your own driver | ~15k★ MIT |
| **Firecrawl / hosted scrapers** | Public-page extraction | Their infra | No — cannot read your inbox by design | OSS core + SaaS |

## Not actually competitors

- **Playwright and Puppeteer** are the substrate, not rivals. Anyone can write
  `connectOverCDP` in twenty lines — but the twenty lines are not the product.
- **Firecrawl and hosted scraping APIs** fetch *public* pages from *their*
  infrastructure. Excellent at breadth, terrible at authentication, by design.
  If the page is public, use them: faster and cheaper. gaze is the opposite
  trade — for work that requires being signed in.
- **Camoufox, nodriver, antidetect vendors** optimise for *many anonymous
  identities*. gaze optimises for *one identity, which is genuinely yours*.
  Opposite goals; gaze uses Patchright as a component rather than competing
  with the stealth industry. (2026 research is blunt that JS-injection stealth
  is largely obsolete against managed challenges and that challenge verdicts
  key on the whole environment — see Research.)

## Actual competitors, honestly

### Playwright MCP (Microsoft) — the one to beat for AI callers
Launches its own browser (or attaches to yours via extension / `--cdp-endpoint`
/ storage-state). Its accessibility snapshot is text-only, fast, cross-browser,
deterministic, and more token-efficient than gaze's selector map — its own
words: "better than screenshot".

- **Better than gaze at:** agent-facing perception ergonomics, tool polish,
  Chrome-extension attach mode, storage-state session save/restore, its
  caps/vision/network tool set, maturity and a company behind it.
- **Gaze still wins when:** you do not want to install an extension or depend
  on Microsoft's tooling; you want a shell CLI too; you want Firefox with the
  same surface; you want the consent gate *in the tool*, enforced on every
  write, and provenance-tagged output the model cannot miss.

### browser-use / browser-harness — the agent-framework default
Pure-CDP DOM serialization, self-healing, MCP/CLI, real-profile reuse
documented. If you are building a Python agent, this is the pragmatic choice.

- **Better at:** autonomy out of the box, ecosystem size, Python.
- **Gaze differs:** deterministic and safe-by-construction — no model inside,
  approval enforced by the tool rather than requested of a model; a successful
  prompt injection still hits the gate. browser-use's own maintainers moved to
  Patchright to shrink the automation signature (issue #356), which is the same
  one-fix-deep stance gaze takes.

### Skyvern — the automation platform
AGPL-3.0, per-credential browser profiles with cookie banking, TOTP, can attach
to your own Chrome, records 720p. Serious engineering (SkyCDP).

- **Better at:** end-to-end "do the workflow" automation, verification loops,
  its own observability.
- **Gaze differs:** deterministic primitives vs an autonomous planner; local
  and extension-free; MPL-2.0 (no AGPL obligations); no cloud dependency for
  anti-bot (Skyvern's anti-bot is cloud-only).

### Claude in Chrome / Anthropic / OpenAI / Google — the vendor agents
Claude in Chrome is the closest thing to gaze's niche: a real browser with your
sessions, driven by an AI. OpenAI and Google sell computer-use APIs where the
model emits structured actions and a sandbox executes them.

- **Better at:** polish, packaging, integrated model reasoning.
- **Gaze differs:** vendor-neutral (any MCP client, or a shell), no extension,
  no subscription, no cloud round-trip of your pages, deterministic and
  auditable line-by-line, and it works on Firefox as well as Chromium.

### Browserbase / Steel — hosted sessions
Excellent observability (per-session video, HLS replay) and scale, but they are
*their* browsers in *their* datacenters. Sessions can be imported, but you are
not driving the browser that is already signed in on your desk.

---

## What is genuinely ours

| | Why it matters |
|---|---|
| **Authenticated, vendor-neutral, no extension** | Claude in Chrome needs its client; Playwright MCP's attach mode needs its extension. gaze answers to any MCP client or a shell, with no extension installed anywhere. |
| **Two browser families, one surface** | Chromium over CDP *and* Firefox over WebDriver BiDi — almost nothing drives an authenticated Firefox profile; nothing else does it extension-free. |
| **Enforceable consent, fail closed** | Reads free, writes prompt, `batch` prompts once, `grant` is bounded, fingerprint mode ties it to hardware, no terminal = refusal. Safety lives in the tool, not a prompt. |
| **Provenance-tagged output** | Page content returns enveloped and injection-scanned on every backend. Every other tool hands the model raw page text — the exact attack surface 2026 research measures at 84% success against agentic systems. |
| **A vault bridge that cannot unlock** | `login` fills from Bitwarden but structurally cannot unlock the vault. The human does, or nobody does. |
| **Redacted local telemetry** | `stats`/`log` show what is slow and what fails; credentials never reach the log; nothing leaves the machine. |

## Where gaze is genuinely behind

- **Token efficiency / agent perception.** Playwright MCP's a11y snapshot is a
  better default representation than the CSS-selector map. Roadmap item #1.
- **Per-call latency.** Every command pays a process boot + CDP attach
  (~300–400 ms) plus fixed sleeps; `batch` is the only reuse. Competitors run
  long-lived drivers. Roadmap: persistent stdio/socket driver.
- **Debugging depth.** No performance tracing or Lighthouse. Chrome DevTools
  MCP wins outright.
- **Firefox parity.** The BiDi backend lags the Chromium one by a dozen
  commands and uses synthetic-JS clicks rather than trusted input. Roadmap.
- **Portability.** Bash launcher, Linux-centric (snap paths, `fprintd`).
  Windows is WSL-only; macOS untested. Roadmap: Node launcher + discovery.
- **Browser reach.** Chromium + Firefox only. No WebKit/Safari path, no generic
  WebDriver fallback. Roadmap: capability resolver + WebDriver-classic adapter.
- **Scale/observability.** No hosted sessions, video, or team dashboard —
  and that is a feature, not a bug, for a local signed-in browser.
- **Maturity.** Small, young, one author. The alternatives have years and
  companies behind them. The receipts table in the README is the honest
  counter-evidence, not a substitute.

## When you should not use gaze

- The page is public — use Firecrawl or a plain HTTP request.
- You need thousands of anonymous sessions — use a hosted grid or antidetect
  product, and understand you are in the detection arms race.
- You want the agent to decide and act without you — use an agent framework,
  and accept the risk that comes with it.
- You are testing in CI — use Playwright directly.
- You need performance profiling — use Chrome DevTools MCP.

**Use gaze when the work requires being signed in as yourself, and you want a
record and a say in what happens.** For where this is going — auto-discovering
any installed browser, a11y-first perception, a persistent driver, named
identities — see [Roadmap](ROADMAP.md).

## Sources

- [Playwright MCP](https://github.com/microsoft/playwright-mcp) ·
  [browser-use](https://github.com/browser-use/browser-use) ·
  [browser-harness](https://github.com/browser-use/browser-harness) ·
  [Stagehand](https://github.com/browserbase/stagehand) ·
  [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) ·
  [Puppeteer MCP archived](https://github.com/modelcontextprotocol/servers-archived) ·
  [Skyvern](https://github.com/Skyvern-AI/skyvern) ·
  [Steel](https://github.com/steel-dev/steel-browser) ·
  [Camoufox](https://github.com/daijro/camoufox) ·
  [midscene](https://github.com/web-infra-dev/midscene) ·
  [Firecrawl](https://github.com/firecrawl/firecrawl)
- Chrome 136 remote-debugging change: https://developer.chrome.com/blog/remote-debugging-port
- Prompt-injection measurement: https://arxiv.org/abs/2604.27202
- Full annex with per-tool sourcing:
  [browser-automation-landscape-2026.md](browser-automation-landscape-2026.md)
