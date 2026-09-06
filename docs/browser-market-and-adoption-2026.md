# Browser market & adoption signals — second research pass (2026-09-06)

Research annex #2 for gaze. Pass #1 (frameworks + anti-bot + sessions + recording)
lives in [`browser-automation-landscape-2026.md`](browser-automation-landscape-2026.md).
This pass covers: tools/standards to adopt or watch, the wider competitive
market (AI browsers, extension-MCP tools, antidetect, security vendors), and
any-browser/any-OS implementation strategy. Claims carry the date they were
verified; press items are marked "reported".

## 1. Watch / adopt (short list)

| Signal | What it is | Action for gaze |
|---|---|---|
| **WebMCP origin trial** (Chrome 149, 2026-06-09) | Sites declare structured "tools" for agents (`readOnlyHint`, `untrustedContentHint`); Google's agent-security guidance (spotlighting, confirm-with-user) matches gaze's envelope+gate | Read the spec + security doc; align `_untrusted`/`_suspicious` vocabulary so gaze is ready when sites annotate ([OT blog](https://developer.chrome.com/blog/ai-webmcp-origin-trial), [security](https://developer.chrome.com/docs/agents/security)) |
| **Mozilla AAF** (`data-agent-*` + `/.well-known/agent-manifest.json`) | Semantic page annotations with danger/confirm levels; fail-closed philosophy like gaze's gate | Study; borrow risk/confirm vocabulary if gaze ever scores page danger ([repo](https://github.com/mozilla-ai/aaf)) |
| **microsoft/Webwright** | "Code-as-action" harness; solved tasks → parameterized skills (Skill Factory); packaged as agent CLI/skills | Reference for wrapping gaze's CLI as Claude Code/Codex skills ([repo](https://github.com/microsoft/Webwright)) |
| **Firefox DevTools MCP** (`@mozilla/firefox-devtools-mcp`) | Mozilla-official Firefox MCP on BiDi: snapshot→UID click/fill, tool presets, screencast (FF 154+), `--connect-existing` | Parity checklist + reference for gaze's Firefox surface ([repo](https://github.com/mozilla/firefox-devtools-mcp)) |
| **Safari 27 beta / STP 247: `safaridriver --mcp`** | Apple's official MCP/stdio server driving the *real* signed-in Safari (tabs, DOM, network, console) — the first Safari path that honors real login state | Safari tier 1 when present; classic WebDriver only as clean-profile fallback ([WebKit blog](https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/)) |
| **Browser discovery libs** | `@agent-infra/browser-finder` (npm), `roniemartinez/browsers` (Python) | Candidate logic for `gaze browsers`/`doctor` discovery in the Node launcher |
| **Selenium Manager** (standalone binary) | Version-matches drivers (chromedriver/geckodriver/msedgedriver) for classic-WebDriver paths | Reuse as a binary on the classic fallback path ([docs](https://www.selenium.dev/documentation/selenium_manager/)) |
| **Playwright 1.61+** | Screencast cursor/timestamps, `connectOverCDP` `artifactsDir`, WebSockets in HAR/trace, passkeys via virtual authenticator | Upgrade target for the Chromium backend ([release](https://github.com/microsoft/playwright/releases/tag/v1.61.0)) |
| **Cloudflare Kitesurf / BrowserOS** | Agent-native DOM engines (CDP-compatible, no pixels) | Watch: signals where "agent-first browsers" go; not usable for real signed-in profiles |
| **MCP spec 2026-07-28** | Breaking: stateless requests, versioned extensions (Tasks, UI), server discovery | Plan migration of `mcp.mjs` to the new spec ([spec](https://modelcontextprotocol.io/specification/2026-07-28)) |

**Assessed, not adopting:** Crawl4AI, Firecrawl, Crawlee, Scrapling, curl_cffi —
all solve anonymous/bulk extraction or HTTP impersonation, which is the opposite
trade from a real-profile browser. Readability/trafilatura: only borrow
article-isolation if a `reader` command ever appears. rrweb-class replay remains
opt-in-only (storage grows with mutations).

## 2. News & signals that change the plan

- **DBSC is GA on Chrome/Windows** (rollout from 2026-05-25, default-on for
  Google accounts, not disableable via Admin console, per press). Cookies are
  cryptographically device-bound ⇒ **`gaze sync` across machines silently breaks
  Google sessions**. Re-test and document per-machine clones
  ([HealSecurity write-up](https://healsecurity.com/google-chromes-device-bound-session-credentials-now-ga-to-block-account-takeovers/)).
- **Chrome moved to a two-week release cadence (2026)** — doubles CDP/BiDi
  breakage exposure for drivers; keep Patchright/Playwright pins current and
  Chrome-for-Testing as the pinned row for CI.
- **Chrome built-in AI is a new fingerprint surface** (Prompt API stable;
  DataDome research on AI-web-API hardware fingerprinting). Keep
  `navigator.ai`/model availability stable across profile clones — do not
  randomize.
- **Firefox is BiDi-only and has an official MCP** (above). Firefox 141 removed
  CDP; Selenium dropped Firefox CDP; Playwright's Firefox protocol is private
  (Juggler), so gaze's hand-rolled BiDi client remains the correct Firefox path.
- **Anti-bot reality check (Browser Use, 2026-02-02):** stealth plugins and CDP
  patches are detectable in <50 ms at scale; Linux fingerprints are a red flag
  (<5% of traffic). Reinforces: real profile, headed, one consistency fix, no
  camouflage ([post](https://browser-use.com/posts/bot-detection)).
- **WebMCP/agent-security and MCP-as-control-plane:** ChatGPT added WebMCP;
  Comet ships MCP connectors; extension-MCP and agent-browser vendors are all
  MCP-first. gaze should treat MCP spec migration as scheduled work and WebMCP
  as a watch item.
- **AI-native browser economics collapsed** (OpenAI Atlas shut down 2026-08-09
  after <10 months; features re-homed to ChatGPT desktop + Side Chat), while
  Dia was acquired by Atlassian (~$610M) and fresh money still funds agentic
  browsers (Polar $5.7M seed). Industry analysis: the moat is the execution
  environment — identity, sessions, memory, permissions, provenance, audit —
  which is exactly gaze's layer, minus browser ownership.

## 3. The wider competitive market (pass #2)

| Category | Players | Meaning for gaze |
|---|---|---|
| **AI-native browsers** | Comet (Perplexity), Dia (→Atlassian), Polar, Tabbit, Phi, ~~ChatGPT Atlas~~ (dead) | All bet on owning a browser; Atlas's shutdown validates the no-browser wedge. Their signed-in state lives inside their browser |
| **Vendor-embedded agents** | Claude in Chrome, ChatGPT Side Chat, Gemini-in-Chrome (Mariner lineage), Edge Copilot mode | Drive your real browser, but tied to one lab's client/model + usually an extension |
| **Extension→MCP "drive my browser"** | browsermcp.io, chrome-faithful, real-browser-mcp, vibe-mcp, Kimi WebBridge, agent-browser-io, Manus Browser Operator | The hottest niche of 2026 and the closest to gaze; all require installing an extension and are Chrome-first. gaze's levers: **no extension, Firefox/BiDi, deterministic, enforceable consent, injection-safe output** |
| **Scraping/antidetect SaaS** | Bright Data Agent Browser, Apify stealth, Zyte, Kameleo, Nstbrowser, AdsPower/Multilogin/GoLogin | Solve *anonymous* sessions at scale; opposite philosophy (synthetic identities vs one real one) |
| **Agent-security vendors** | Menlo MARS, Lasso, Prompt Security→SentinelOne, Zscaler+SquareX, CrowdStrike+Seraphic, HumanLayer | Validates prompt-injection/consent as the #1 problem; their answers are enterprise network/API layers — gaze's deterministic local gate is the browser-layer half |
| **China web agents** | AutoGLM/AutoClaw, QwenWork/Qwen-UI-Agent, Kimi Agent/Claw, OpenCUA, Doubao | Mostly vision/VM-based and cloud/local agent stacks; not real-profile, no consent semantics |
| **Extraction/query tools** | AgentQL (can attach to an open tab), Diffbot-class | Ergonomics for structured extraction, not deterministic action + consent |

**White space gaze can claim:** the only architecture that combines real signed-in
sessions + determinism + local-only execution + an un-negotiable consent gate,
with none of the three structural costs (extension trust, browser-fork
maintenance, cloud data egress). Firefox/BiDi real-profile control is
essentially uncontested. Post-Atlas, users wanting logged-in deep-ops on their
existing browser have cloud/lab-bound options (Side Chat, Comet, WebBridge) —
gaze is the open, local, deterministic alternative.

## 4. Any-browser / any-OS implementation strategy (pass #2)

Findings (full detail + sources in this pass's report; key points):

1. **Protocol reality:** Chromium family = CDP attach (keep). Firefox = BiDi
   only since 141, agent enabled at launch. Safari = classic WebDriver or, from
   Safari 27 beta, `safaridriver --mcp` (the only Safari path honoring real
   signed-in state; classic Safari cannot honor profile clones). WebKitGTK on
   Linux exposes classic WebDriver via `WebKitWebDriver` (port 9515).
2. **One prober, three probes:** CDP `/json/version` → BiDi `POST /session`
   (upgrade via `webSocketUrl`) → classic `/status`. A ~30-endpoint W3C
   WebDriver-classic client is ~400-800 LOC on Node's global `fetch`
   (endpoints and element key `element-6066-11e4-a52e-4f735466cecf` per
   [WebDriver 2](https://www.w3.org/TR/webdriver2/)); classic has **no**
   console/network/push events — gate those features on CDP/BiDi and degrade.
   Reuse Selenium Manager as a binary for driver provisioning.
3. **Shared capability layer** over three adapters (CDP, BiDi, classic) + a
   thin Safari MCP/stdio adapter; model "managed profile clone" vs "attach to
   running browser" as first-class; degrade by capability, not browser name.
   BiDi is the convergent standard (Chromium + Firefox + partial WebKit);
   CDP stays the Chromium-native superset.
4. **Launcher:** port to Node with `spawn({detached:true})` (setsid
   equivalent), per-profile state file (pid+port), SingletonLock/.parentlock
   handling, graceful close before kill, `kill(-pid)`/`taskkill /T` fallback,
   never kill by port alone. Honor `XDG_*`/`CHROME_USER_DATA_DIR` and the
   per-OS dir conventions
   ([Chromium user_data_dir.md](https://chromium.googlesource.com/chromium/src/+/main/docs/user_data_dir.md)).
   Biometric approval must be an OS-native helper or browser-page prompt —
   a CLI cannot trigger fprintd/Hello/Touch ID from a daemon context.

Sources: Chrome WebMCP ([1](https://developer.chrome.com/blog/ai-webmcp-origin-trial),
[2](https://developer.chrome.com/docs/agents/security)) · [Mozilla AAF](https://github.com/mozilla-ai/aaf) ·
[Webwright](https://github.com/microsoft/Webwright) ·
[Firefox DevTools MCP](https://github.com/mozilla/firefox-devtools-mcp) ·
[WebKit Safari MCP](https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/) ·
[Selenium Manager](https://www.selenium.dev/documentation/selenium_manager/) ·
[Playwright 1.61](https://github.com/microsoft/playwright/releases/tag/v1.61.0) ·
[MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28) ·
[chrome-faithful](https://github.com/bpc-oss/chrome-faithful) ·
[browser-mcp](https://github.com/ikbenlit/browser-mcp) ·
[Comet reversing](https://labs.zenity.io/post/perplexity-comet-a-reversing-story) ·
[Menlo Security](https://www.menlosecurity.com/press-releases/menlo-security-extends-mars-to-secure-ai-assistants-and-coding-agents-like-microsoft-copilot-gemini-in-chrome-and-claude-code-against-prompt-injection-and-data-exfiltration) ·
[Browser Use bot-detection](https://browser-use.com/posts/bot-detection) ·
[WebDriver 2 spec](https://www.w3.org/TR/webdriver2/) ·
[Chromium user_data_dir](https://chromium.googlesource.com/chromium/src/+/main/docs/user_data_dir.md)
