# AI Browser-Automation & Computer-Use Landscape — 2025→2026

*Research annex for **gaze**. Feeds the decisions in
[`RESEARCH.md`](RESEARCH.md), the strategy in [`ROADMAP.md`](ROADMAP.md), and
the product position in [`COMPARISON.md`](COMPARISON.md). All star counts /
release tags / licenses were read from primary sources (GitHub API, repos, npm,
vendor docs) on **2026-09-06**. Treat star counts as rough (GitHub rounds +
they move daily).*

---

## 0. TL;DR table

| Tool | What it is | Browser control | Stars · License · last release (Sep 2026) | Why it matters for gaze |
|---|---|---|---|---|
| **browser-use** (`browser-use/browser-use`) | Most popular OSS web-agent library (Python) | DOM/state serialization over **pure CDP** (Playwright removed in v0.6, 2025-08); own "Browser Harness" layer since 2026 | ~112k · MIT · **0.13.10** (2026-09-04) | The DOM→state→action pattern + real-Chrome profile reuse + now a separate self-healing harness repo |
| **browser-harness** (`browser-use/browser-harness`) | browser-use's new self-healing browser layer + CLI/box | CDP; persistent browsers; MCP | ~17k · MIT · active (created 2026-04) | Ecosystem is converging on a "harness + skills" CLI shape like gaze |
| **Stagehand** (`browserbase/stagehand`) | "SDK for browser agents" (TS/Python/Go) | **CDP directly, no Playwright/Puppeteer dep**; a11y-tree hybrid snapshots; act/observe/extract; runs as browser extension for low latency | ~24k · MIT · sdk v3.7.x / server-v3 v3.7.6 (2026-08-28) | Closest analog for deterministic+AI hybrid; shows CDP-native + a11y-trim pattern at scale |
| **Playwright MCP** (`microsoft/playwright-mcp`) | Official MCP server over Playwright | Playwright a11y ("ARIA") snapshots with refs — explicitly *not* pixel input; Playwright core drives CDP/BiDi | ~37k · Apache-2.0 · v0.0.80 (2026-09-01); Playwright 1.63 | Canonical *snapshot-ref action model*; profiles, storage-state, CDP attach, extension mode, recording → all converged primitives |
| **Playwright CLI** (`microsoft/playwright-cli`) | Newer sibling: record/inspect/screenshot CLI exposed as agent SKILLs | Same Playwright engine | ~13k · Apache-2.0 | The industry's own pivot: **CLI+SKILL beats MCP for token cost** — validates gaze's CLI/MCP shape |
| **Puppeteer MCP** (`modelcontextprotocol/servers` → `servers-archived`) | Reference MCP server (selector/screenshot based) | Puppeteer + CDP; selectors + screenshots + evaluate | repo ~90k; puppeteer server **archived**; npm pkg deprecated; last rel 2025.5.12 · MIT | Mostly **historical now**: archived by MCP org, no a11y snapshot model — superseded by Playwright MCP & friends |
| **Skyvern** (`Skyvern-AI/skyvern`) | LLM+vision RPA/workflow engine (cloud + self-host); Playwright-compatible SDK | CDP via Playwright historically, now own **SkyCDP** facade (+ "Rustwright" image lane); DOM/ARIA + shadow-DOM + cross-origin iframe "observe"; optional vision | ~23k · **AGPL-3.0** · v1.0.52 (2026-08-31) | Deepest *production hardening*: per-credential profiles, TOTP, verify-after-act, recordings, workflows; can attach to your own Chrome at `127.0.0.1:9222` |
| **Browserbase** (cloud) | Managed headless browsers/sessions + observability; maker of Stagehand | Cloud Chromium over CDP; connect from Playwright/Puppeteer/any CDP client | SaaS; OSS repos: `stagehand` 24k, `skills` 3.7k, `mcp-server-browserbase` 3.4k (**archived** → Stagehand), `sdk-node` | Defines cloud "session/persona" model; session live-view/recording; now also Fetch/Search runtime + Model Gateway |
| **Steel** (`steel-dev/steel-browser`) | Open-source browser API (sessions + quick actions), self-host or cloud | Chrome via Puppeteer/CDP (connect w/ Puppeteer/Playwright/Selenium); stateful sessions persist cookies/localStorage | ~7.6k · Apache-2.0 · v0.5.4-beta (2026-08-25) | "Profiles" = persistent logged-in identity concept; markdown/readability converters; stealth plugins; beta software |
| **midscene** (`web-infra-dev/midscene`) | GUI agent for E2E testing (ByteDance web-infra) | **Pure vision (screenshot-only)** element localization; DOM only optional for extraction; runs on Qwen/GLM/Gemini/UI-TARS | ~15k · MIT · v1.12.3 (2026-09-02) | Best counter-example: no a11y tree needed; canvas/native reach; self-hostable VLM option |
| **browserless** | Headless-browser farm service (self-host/cloud) | CDP/WebDriver; Puppeteer/Playwright protocol proxies | ~14k · source-available "fair-code" (free non-commercial) | Infra/detection perspective, not a new agent model |
| **Camoufox** (`daijro/camoufox`) | Firefox-based anti-detect browser, now pivoting to "AI agent browser" | Firefox (own fork) via Playwright/Juggler (CDP-equivalent protocol); humanized input | ~12k · MPL-2.0 · v152.0.4-beta.30 (2026-09-01) | Only mainstream **Firefox** automation base w/ stealth; roadmap = token-efficient DOM object for LLMs |
| **Anthropic computer/browser use** | API client toolsets for Claude | Computer tool: screenshots+coords desktop. **Browser use tool** (`browser_toolset_20260801`): a11y tree+elements+forms+tabs **and** pixels, 27 member tools; *your* executor runs the browser | API product (demo: `claude-quickstarts` ~18k, MIT) | Anthropic now ships a "browser use" tool whose executor contract mirrors gaze (real browser, client-side) |
| **OpenAI Operator / CUA** | ChatGPT operator + API "computer" tool / code-execution | Screenshots → structured actions (click x,y / type / scroll…) executed by **your** harness, or model-written Playwright/PyAutoGUI code | API product (CUA sample app OSS) | Convergence: batched actions per turn + confirmations + treat screen as untrusted |
| **Gemini computer use** | API tool for browser/mobile/desktop agents | Screenshots → normalized coordinates; you execute (Playwright); Gemini 3.x adds intents + safety decisions | API product (Mariner extension **shut down** 2026-05) | Same screenshot-loop pattern; browser computer use is API-level, extension experiments sunset |

---

## 1. browser-use (`browser-use/browser-use`)

1. **What:** The dominant open-source Python "web agent" library — you give an LLM a task, it drives a browser via a growing action vocabulary (click, input, scroll, tab ops, downloads, structured extraction…).
2. **Control mechanism:** Historically Playwright-over-CDP; **v0.6.0 "Goodbye Playwright" (2025-08-19) ripped out Playwright for a pure CDP stack (`cdp-use`, `bubus`, "pure cdp extraction layer", cross-origin iframe support)**. The 2026 rewrite layers a separate **`browser-use/browser-harness`** ("self-healing harness", own repo, ~17k stars) under the library; per-step the agent is fed a **serialized page "state" (DOM tree serializer with stacking-context/occlusion filtering and element indexes)** plus optional screenshots for VLM models. Release notes show ongoing DOM-quality work (filter paint-order-occluded text, expose image context on clickables) and an MCP server (Python SDK 2.x) + "CLI 3.0".
3. **Session/auth:** Runs Chromium with a profile dir; README documents **reusing a real Chrome profile** (`examples/browser/real_browser.py`) and syncing logins to remote browsers via a `profile-use` installer ("profile sync") — i.e., the same "drive the signed-in profile" idea as gaze. Cloud product persists sessions/filesystem.
4. **Worth copying:** enumerated-action + state-ref prompt format; history-tree with per-step screenshots & GIFs for replay; model-agnostic ("bring any LLM"), now with their own `bu-2-0`/mini models and an open `browser-use/bu-30b-a3b-preview`; benchmark + leaderboard marketing (BU-Bench, #1 on Odysseys 87.4%).
5. **License/gaps:** MIT. Gaps: Python-centric; LLM API key required for real autonomy; DOM quality and CDP-detection risk on anti-bot sites (cloud "stealth browsers" sold separately); agentic, not deterministic — you cannot guarantee a fixed action sequence.

## 2. Stagehand (`browserbase/stagehand`)

1. **What:** "The SDK for browser agents" (Browserbase) — three primitives (`act`, `extract`, `observe`) mixed with deterministic Playwright-style `page.*` calls; now a TS/Python/Go monorepo, v3/v4.
2. **Control:** **CDP-native** — v4 docs: "Stagehand drives the browser over the Chrome DevTools Protocol, so there is no Playwright or Puppeteer dependency." The runtime is injected **as an extension next to the browser** to cut round-trip latency (README: "runs as an extension next to the browser, closing the distance"). Page understanding = **hybrid, trimmed accessibility tree** ("agents use fewer tokens… nothing more"), deep locators into OOPIF iframes and closed shadow DOM; screenshot/vision used only when a11y cannot express the target.
3. **Session/auth:** Runs on local Chromium or on **Browserbase cloud sessions** (personas/profiles, live view, proxies); `browserbase.launch(...)` in v4. Works with Chrome/Edge/Arc/Brave.
4. **Worth copying:** token-efficiency trimming of a11y snapshots; **self-healing actions** (re-locate when site changes) with `act` success/failure returned to the model; `observe()` returns candidate actions with selectors; typed `extract` (zod/pydantic); per-method token + inference-time **metrics()**; built-in observability (OTel); CUA-coordinate normalization fixes; WebMCP/clipboard support.
5. **License/gaps:** MIT core; Browserbase cloud + LLM keys needed for the managed path. MCP surface lives in Stagehand's `server-v3` binaries / docs (`@browserbasehq/mcp` predecessor archived). Older repo `browserbase/mcp-server-browserbase` (3.4k★) is archived.

## 3. Playwright MCP (`microsoft/playwright-mcp`) — and the agentic Playwright pivot

1. **What:** Official MCP server exposing the browser as tools for LLM clients; plus a sibling **CLI+SKILLS** product (`microsoft/playwright-cli`, "record and generate Playwright code, inspect selectors, take screenshots").
2. **Control:** Playwright accessibility snapshots ("ARIA snapshot", role/name text-tree with per-node refs), **explicitly not pixel-based** ("Uses Playwright's accessibility tree… Deterministic tool application"); actions target **exact refs from the snapshot or a selector** (`browser_snapshot`, `browser_click/type/select_option/press_key`, `browser_tabs`, `browser_wait_for`, network tools). A11y snapshot is the *sole* action space; `browser_take_screenshot` says "You can't perform actions based on the screenshot, use browser_snapshot" unless you opt into `--caps=vision` coordinate mouse tools. Recent releases add **distilled/less-verbose snapshots**, `browser_find` (regex the snapshot cheaply), `--snapshot-boxes` ([box=x,y,w,h] viewport CSS px), configurable **settle delay (default 500 ms)** after actions, WebP screenshots, mobile/device emulation, video/tracing/recording caps.
3. **Session/auth:** Persistent profile by default (`mcp-{channel}-{workspace-hash}` under the ms-playwright cache), `--user-data-dir`, `--isolated`, `--storage-state` export/import, cookie/localStorage CRUD tools, **connect to your own running Chrome via `--cdp-endpoint` or the Playwright Chrome Extension** (leverage your logged-in sessions), `--init-page/--init-script`.
4. **Worth copying:** the ref-based snapshot contract; read-only vs read-write tool gating; caps model (vision/network/storage/pdf/testing/devtools opt-in); `browser_start_recording` returns the human's manual actions as Playwright code; the README's own argument that **CLI+SKILL is more token-efficient than MCP for coding agents** while MCP suits long-running agentic loops — a live debate gaze should cite.
5. **License/gaps:** Apache-2.0, free, actively shipped (v0.0.80, 2026-09-01; Playwright core at 1.63). Gaps: headed default but still a "clean" automation browser — no stealth; snapshot can still be large on heavy pages; Firefox/WebKit supported by Playwright but a11y-snapshot parity is best on Chromium.

## 4. Puppeteer MCP (`modelcontextprotocol/servers` → archived)

1. **What:** Anthropic/MCP-org reference MCP server giving an LLM Puppeteer control of a browser.
2. **Control:** Old-school: CSS selector + screenshot + `evaluate` (tools: navigate, screenshot, click, hover, fill, select, evaluate; resources: console logs, screenshots). No accessibility snapshot, no element refs.
3. **Session/auth:** Launch options only (headful/headless, `--user-data-dir` passthrough, `ALLOW_DANGEROUS`), Docker for headless.
4. **Worth copying:** little today — historically useful as the "what agents looked like before a11y snapshots" baseline.
5. **License/gaps:** MIT; **not maintained**: MCP org moved it to `modelcontextprotocol/servers-archived` ("Archived" section of the servers README) and the npm package `@modelcontextprotocol/server-puppeteer` is deprecated (last publish 2025.5.12). Ecosystem replacements: Playwright MCP and the many maintained puppeteer MCP forks.

## 5. Skyvern (`Skyvern-AI/skyvern`)

1. **What:** LLM + vision browser-workflow engine (RPA-for-AI) with cloud and self-host; a Playwright-compatible SDK with AI commands, plus YAML workflows, UI, MCP.
2. **Control:** Perception is **DOM/ARIA-based with vision assist**: internal "observe" builds an element tree covering shadow DOM and cross-origin iframes; Task V3 does "decisive-accept ARIA/value probes", hidden-native-control handling, per-site form heuristics. Driver is CDP: Playwright-compatible facade historically, now hardened into **SkyCDP** (its own CDP layer matching Playwright selector-engine semantics, CDP proxy, network/domain interception) with a **Rustwright** engine on the image lanes. Actions are high-level typed operations (click/type/select/hover/upload/download/…) and are **verified after execution** (self-verifying agentic actions; stall detectors, autocomplete commits).
3. **Session/auth:** Deep auth story: per-credential managed **browser profiles** with cookie-jar banking on save, rotating-credential profile segmentation, 2FA/TOTP (QR/email/SMS), password managers (Bitwarden…), and **"control your own browser"**: connect Skyvern to your Chrome at `127.0.0.1:9222` (remote debugging) or tunnel your browser to Skyvern Cloud. Multi-account via the credential vault.
4. **Worth copying:** verify-after-act; form "commit evidence"; download mediation; per-run **720p video recordings + step screenshots**; live view streaming (CDP screencast); prompt-injection defenses and page-content-is-untrusted posture; workflow block language (task/extract/validate/loop/code), MCP YAML workflows.
5. **License/gaps:** **AGPL-3.0**; anti-bot (proxies, captcha solving) is cloud-only; requires LLM keys self-hosted; AGPL copyleft is a real adoption barrier.

## 6. Browserbase (cloud infra) + agent SDK

1. **What:** Cloud-managed Chromium "sessions" (API + SDKs) with live view, recording, proxying, and persistent identity; the commercial arm behind Stagehand.
2. **Control:** Remote browser reachable over **CDP/WebDriver** from local Playwright/Puppeteer/Stagehand/Selenium; "connect" model (session URL + WS).
3. **Session/auth:** Session = isolated browser instance; **personas/profiles** for persistent cookies/logins (docs under Identity + Authentication); per-session proxy; enterprise SSO; **Fetch, Search and Model Gateway** are now separate runtime products in their platform docs.
4. **Worth copying:** the **observability package** — session live view (docs: `platform/browser/observability/session-live-view`), recordings, console/network logs as debugging primitives for browser agents; Stagehand's metrics; "skills" repo (SKILL.md playbook) — agents installed as skills rather than MCP.
5. **License/gaps:** SaaS (usage-billed, LLM/API keys required); OSS only around the edges (SDKs, Stagehand, skills). Cloud sessions are new-ish browser fingerprints — fine for many sites, not a logged-in human profile.

## 7. Steel (`steel-dev/steel-browser`) + "steelsearch"

1. **What:** "Open-source browser API for AI agents & apps": an HTTP service managing Chrome sessions, pages, lifecycle; self-host (Docker) or Steel Cloud.
2. **Control:** Chrome via **Puppeteer + CDP**; you attach with Puppeteer, Playwright or Selenium; plus "quick actions" (`/scrape`, `/screenshot`, `/pdf`, markdown/readability) and a `search` action added in the API. Stateful **sessions keep cookies & localStorage across requests**; auto cleanup.
3. **Session/auth:** **Profiles** = persistent logged-in identity per agent ("Profiles: Your Agent's Persistent Identity", cookbook "persist authenticated sessions with Profiles", "reuse authenticated sessions across browsers") — effectively multi-account by profile; proxy chains; custom CA certs.
4. **Worth copying:** session-as-REST-object + attach via standard drivers; cookie/localStorage persistence across session reuse; markdown conversion for cheap reading; fingerprint/stealth plugins config.
5. **License/gaps:** Apache-2.0, public beta (v0.5.4-beta, 2026-08-25; earlier 0.5.x gaps months apart). **"steelsearch": no maintained open-source product/repo with that name is verifiable** (GitHub search returns nothing relevant; the steel-browser API has a `search` action). If you meant Browserbase's hosted "Search" runtime, that's separate and closed.
   - Note: repo volume of `camoufox` releases indicates big OSS overlap audiences — both target undetectable agent browsing.

## 8. midscene, browserless, Camoufox (the "newer" set)

- **midscene (`web-infra-dev/midscene`)** — GUI-agent/E2E-testing SDK: **pure-vision element localization from screenshots only** (no selectors, no a11y tree needed for acting; DOM used only optionally for extraction). Runs on any multimodal model (Qwen, GLM-4.6V, Gemini, **UI-TARS self-hosted**). One API across web/Android/iOS/HarmonyOS/desktop (scrcpy/ADB/WDA bridges), YAML scripts, reports with screenshots, Chrome extension + "midscene studio" desktop, `midscene-skills` for OpenClaw. MIT. **Gap:** screenshot-loop cost and reliability on text-heavy pages; vision-model quality ceiling. The direct counterweight to DOM/a11y approaches and useful for *assert-what-user-sees* QA.
- **browserless** — self-hostable headless-browser farm/API since 2017 (~14k★, source-available license, free non-commercial): fleet management, proxies, session reuse, Puppeteer/Playwright protocol compat, PDF/screenshot endpoints; has moved toward agent-friendly JSON endpoints. Infrastructure, not a perception model.
- **Camoufox (`daijro/camoufox`)** — anti-detect **Firefox** fork controllable via Playwright's Juggler protocol, with humanized mouse paths, canvas fuzzing, fingerprint surface control. Maintainers (now a "Clover" team after Daijro) announced (discussion #571, 2026-04) a **rebrand from "anti-detect browser" to "AI agent browser"** and a roadmap item squarely in gaze's wheelhouse: **turn the DOM into a token-efficient, LLM-traversable object** (community experiment "VulpineOS"). It remains the serious **Firefox** base for stealth+agent use (many "camoufox for AI" wrappers exist). MPL-2.0, beta, active (v152.0.4-beta.30, 2026-09-01).

## 9. The "computer-use model" layer (API products)

- **Anthropic** — two client toolsets now. (a) **Computer use tool** (`computer_toolset_20260801`, GA 2026): 17 member tools (`screenshot`, `left_click`, `type`, `zoom`…), desktop screenshots+coords, batch actions per turn, runs in *your* environment; prompt-injection classifiers auto-route suspicious screenshots to user confirmation. (b) **Browser use tool** (`browser_toolset_20260801`): "works with the page both through its structure (accessibility tree, elements, forms, tabs) and through pixels"; 27 member tools by default (+ optional `javascript_exec`, `file_upload`, `read_console`, `read_network`); **your application/executor runs the browser** (nothing on Anthropic's side). The open-source reference demos live in `anthropics/claude-quickstarts/computer-use-demo` (MIT). Claude Code also ships **"Claude in Chrome"** (extension attaching the agent to a real signed-in Chrome via CDP/native messaging). All GA'd on the Claude Platform ("Computer use, the Skills API, Files API GA").
- **OpenAI (Operator/CUA)** — Operator remains ChatGPT's agentic browser feature; for developers the guidance now recommends **code execution** (model writes Playwright/PyAutoGUI scripts executed in a persistent sandbox/session you provide) or the **`computer` tool** returning structured actions (`click x/y`, `type`, `double_click`, `drag`, `scroll`, `keypress`, `wait`, `screenshot`) that your handler executes, screenshot loop back with `previous_response_id`; coordinates must be mapped if you downscale. Official **CUA sample app** (`openai/openai-cua-sample-app`) is the reference. Strong "run safely" guidance = restricted environment, **screen content is untrusted**, confirm consequential actions — identical posture to gaze's gate.
- **Google (Gemini)** — Gemini API "computer use" tool for **browser / mobile / desktop** environments: screenshot → model returns **normalized-coordinate** `function_call` actions (with per-action `intent` rationale on Gemini 3.x), you execute via **automation tools such as Playwright**; safety engine returns `require_confirmation`/blocked decisions; screenshot prompt-injection scan optional. The Chrome-extension research agent **Project Mariner was shut down (May 2026)**; Google's trajectory is API computer-use + "Gemini in Chrome" (Gemini 2.5 Computer Use model preview 2025-10 → later Flash-tier computer use in Chrome). Browser-specific snippet: browser environment agents are the recommended path for web tasks.

## 10. Synthesis — what actually makes interaction fast/reliable

**Perception spectrum (pick per task):**
- **a11y/ARIA tree + refs = the 2025–26 default** (Playwright MCP, Stagehand, Anthropic browser tool, Skyvern probes). Text cheap, deterministic, element-addressed; brittle to non-semantic UI (icon-only/canvas/custom controls, shadow DOM, OOPIFs) — patched with shadow-DOM/OOPIF traversal (browser-use, Skyvern, Stagehand) — and blind to *visual* truth.
- **Vision/screenshots = fallback and QA layer** (midscene is pure-vision; everyone else keeps it optional): coordinate actions need **normalized or viewport-coordinate mapping** (OpenAI/Gemini normalized; Playwright boxes in viewport CSS px; Stagehand "normalize CUA coordinates to actual viewport"); low-res screenshots cost less but hurt; post-action screenshots are the verification loop.
- **DOM serialization = the token-cost battleground**: browser-use's DOM-state + browser-harness, Skyvern's element tree, Camoufox's planned "DOM as LLM object", Playwright "distilled snapshots" + `browser_find`, Stagehand "a11y trimming", midscene "brief" DOM for extraction. Convergence: a **compact, deduped, occluded-content-filtered text tree with stable refs**, chunked/streamed, with an on-demand "search the snapshot" tool instead of always sending everything.
- **Incremental/streaming network state**: actions wait for a **configurable settle delay** (Playwright MCP default 500 ms) rather than blind sleep; network-tool introspection (Playwright MCP network caps, Skyvern stall detectors, browser-use tab-reuse) replaces vague waits.

**Action model convergence:** high-level *typed actions* with an explicit target = element ref from the latest snapshot OR selector (never free-form JS unless flagged) — Playwright MCP tools, Stagehand act/observe, Anthropic 27 browser tools, Skyvern actions. LLM frameworks batch several actions per turn (Anthropic batch actions, OpenAI `computer_call.actions[]`, Skyvern Task V3 "batched turn"). Deterministic codegen (Playwright recording, skycdp recording, playwright-cli codegen) coexists with agentic loops rather than replacing them.

**State/recording primitives the ecosystem converged on:**
1. **Persistent profile / user-data-dir** as the auth primitive (Playwright MCP default profile + `--storage-state`, browser-use real profile + profile-sync, Skyvern cookie-jar banking + per-credential profiles, Steel/Stagehand personas, extension attach for already-signed-in Chrome).
2. **Storage-state export/import** as the portable session format (Playwright storage state; browserbase persona archives; Skyvern profile archives).
3. **CDP attach to the operator's real browser** is now a first-class feature across stacks: Playwright MCP `--cdp-endpoint`/extension, Skyvern `127.0.0.1:9222` connect + tunnels, browser-use profile-use, Claude-in-Chrome, Skyvern docs even tell you to enable `chrome://inspect` remote debugging — i.e., the market has validated gaze's exact "drive the signed-in profile" model.
4. **Replay/observability**: session videos + step screenshots + trace/log (Playwright video/tracing caps, Skyvern 720p recordings, Browserbase live view/recording, browser-use GIFs/history) and **manual-action recording → code** (Playwright `browser_start_recording`, Playwright codegen, Skyvern Record Browser).
5. **Human-in-the-loop gates built into the API layer** (OpenAI confirmations, Anthropic confirmation steering, Gemini `require_confirmation`, plus every agent framework's permission prompts) — supports gaze's approval-gate philosophy.
6. **Verification**: act-then-verify with page-state checks (Skyvern), self-healing re-location (Stagehand), element actionability checks (Playwright), proof/evidence screenshots per step.
7. **Firefox story is thin but stabilizing**: gaze's WebDriver BiDi backend is ahead of most of these tools; Camoufox (Juggler) and Playwright's Firefox support are the only serious automation bases. Expect BiDi to become the recommended cross-browser path as "computer use for the open web" matures.

**Anti-bot reality** (relevant to a real human profile): headless ≠ stealthy; the arms race (PerimeterX/DataDome/Cloudflare BM) pushes everyone to headed browsers, real fingerprints, proxy rotation, captcha solvers — most sold as cloud add-ons (browser-use cloud, Skyvern cloud, Browserbase/Steel stealth). A genuinely signed-in human profile (gaze) is the strongest "credential" none of these can sell.

## 11. Suggested next steps for the gaze roadmap (evidence-based)

- Adopt the **ref-based text snapshot + search-the-snapshot** contract (Playwright MCP / Anthropic browser tool) and a distilled "role/name + index + box" text format like ARIA snapshots; make box/coords opt-in.
- Model the MCP surface on the **caps** pattern and on read-only vs write gating; expose `recording`, `storage-state`, `video/trace` as primitives, not afterthoughts.
- Treat **persistent profile = identity**, and add storage-state export/import + per-identity profile naming (playwright hash-per-workspace, Skyvern per-credential profiles).
- Keep the **deterministic CLI/SKILL path** (like `microsoft/playwright-cli`) beside the MCP server — the 2026 Playwright README argues CLI+skills is the token-efficient winner for agents.
- Watch Anthropic's `browser_toolset_20260801` vocabulary and Skyvern/Stagehand verify-after-act; they are de-facto specs for the action set agents expect.
- Keep Firefox on BiDi and track Camoufox's DOM-for-LLM work + Playwright Firefox a11y parity for when multi-browser computer-use demand arrives.

---

## Sources

**browser-use / browser-harness**
- Repo/API: https://github.com/browser-use/browser-use (stars, MIT, releases 0.13.8–0.13.10: https://github.com/browser-use/browser-use/releases/tag/0.13.9 , https://github.com/browser-use/browser-use/releases/tag/0.13.10)
- v0.6 "Goodbye Playwright" (pure-CDP pivot): https://github.com/browser-use/browser-use/releases/tag/0.6.0
- README (real-profile reuse, ChatBrowserUse, CLI/skill, cloud): https://github.com/browser-use/browser-use/blob/main/README.md
- Harness repo: https://github.com/browser-use/browser-harness (README/install: https://github.com/browser-use/browser-harness/blob/main/install.md)
- Docs: https://docs.browser-use.com

**Stagehand / Browserbase**
- Repo: https://github.com/browserbase/stagehand ; README (CDP-native, extension runtime, metrics, browserbase facade + search/fetch): https://github.com/browserbase/stagehand/blob/main/README.md
- v4 intro (no Playwright/Puppeteer dependency; CDP; hybrid a11y): https://github.com/browserbase/stagehand/blob/main/packages/docs/v4/first-steps/introduction.mdx
- Releases (server-v3 v3.7.6, sdk 3.7.3, CUA-coordinate normalization): https://github.com/browserbase/stagehand/releases
- Browserbase docs: session creation https://docs.browserbase.com/platform/browser/getting-started/create-browser-session ; live view https://docs.browserbase.com/platform/browser/observability/session-live-view ; proxies/authentication https://docs.browserbase.com/platform/identity/proxies
- Browserbase org repos (skills, mcp-server-browserbase archived): https://github.com/browserbase/skills , https://github.com/browserbase/mcp-server-browserbase
- npm readme for the MCP successor: https://www.npmjs.com/package/@browserbasehq/mcp

**Playwright**
- Playwright MCP README (a11y-snapshot philosophy, CLI-vs-MCP discussion, all tools/caps, profiles, storage state, CDP/extension): https://github.com/microsoft/playwright-mcp/blob/main/README.md
- Playwright MCP releases v0.0.78–0.0.80 (browser_find, distilled snapshots, settle delay, webp, recording tools): https://github.com/microsoft/playwright-mcp/releases
- Playwright CLI (SKILLS): https://github.com/microsoft/playwright-cli
- Playwright version current: https://registry.npmjs.org/playwright/latest (1.63.0)

**Puppeteer MCP**
- Archived listing in servers README: https://github.com/modelcontextprotocol/servers#archived ; archived puppeteer source/README: https://github.com/modelcontextprotocol/servers-archived/tree/main/src/puppeteer
- npm deprecated status: https://www.npmjs.com/package/@modelcontextprotocol/server-puppeteer

**Skyvern**
- Repo + README (SDK, AI page commands, control your own Chrome 127.0.0.1:9222, cloud tunneling, 2FA/TOTP, MCP, AGPL + cloud anti-bot): https://github.com/Skyvern-AI/skyvern
- Releases v1.0.50–v1.0.52 (SkyCDP, Task V3 ARIA/shadow/cross-origin observe, Rustwright, cookie-jar banking, recordings): https://github.com/Skyvern-AI/skyvern/releases
- Docs: https://www.skyvern.com/docs ; browser tunneling: https://www.skyvern.com/docs/optimization/browser-tunneling

**Steel**
- Repo/README (Puppeteer+CDP, sessions, quick actions, Selenium): https://github.com/steel-dev/steel-browser
- Releases: https://github.com/steel-dev/steel-browser/releases ; docs: https://docs.steel.dev
- Profiles blog: https://steel.dev/blog/profiles ; cookbook persist/reuse auth: https://docs.steel.dev/cookbook/profiles , https://docs.steel.dev/cookbook/auth-context

**midscene / browserless / Camoufox**
- midscene README (pure vision, model list, platforms, MIT): https://github.com/web-infra-dev/midscene/blob/main/README.md ; releases: https://github.com/web-infra-dev/midscene/releases ; site: https://midscenejs.com ; skills: https://github.com/web-infra-dev/midscene-skills
- browserless: https://github.com/browserless/browserless
- Camoufox repo/releases: https://github.com/daijro/camoufox ; long-term plan/rebrand discussion: https://github.com/daijro/camoufox/discussions/571 ; site: https://camoufox.com

**Anthropic**
- Computer use tool (GA toolset, security/confirmation): https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- Browser use tool (a11y+structure+pixels, 27 tools, client-side executor): https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool
- GA announcement (computer use + Skills + Files GA): https://claude.com/fr/blog/computer-use-skills-api-files-api
- computer-use-demo: https://github.com/anthropics/claude-quickstarts/tree/main/computer-use-demo ; Claude-in-Chrome docs/issues: https://code.claude.com/docs/ja/chrome , https://github.com/anthropics/claude-code/issues/84055

**OpenAI**
- Computer use API guide (code-execution vs computer tool; action list; coordinates; safety): https://developers.openai.com/api/docs/guides/tools-computer-use
- CUA sample app: https://github.com/openai/openai-cua-sample-app

**Google**
- Gemini computer-use API doc (loop, environments, intents, safety decisions, execute via Playwright): https://ai.google.dev/gemini-api/docs/computer-use
- Project Mariner shutdown coverage: https://www.techspot.com/news/112334-project-mariner-dead-but-google-browser-controlling-ai.html ; Gemini 2.5 computer-use preview: https://9to5google.com/2025/10/07/gemini-2-5-computer-use-model/

**Secondary/context (used for framing, treated as untrusted data)**
- WebBench/Skyvern perf claim: https://www.skyvern.com/blog/web-bench-a-new-way-to-compare-ai-browser-agents/
- Odyssey leaderboard claim in browser-use README: https://odysseysbench.com/leaderboard (linked from repo README)
- Browserbase docs nav (Fetch/Search/Model Gateway product surfaces): https://docs.browserbase.com/platform/fetch/overview
