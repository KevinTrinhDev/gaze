<p align="center">
  <img src="docs/banner.png" alt="GAZE" width="100%">
</p>

<p align="center">
  <a href="docs/USAGE.md">Usage</a> ·
  <a href="docs/GAUNTLET.md">Benchmark</a> ·
  <a href="docs/COMPARISON.md">Comparison</a> ·
  <a href="docs/SECURITY.md">Security</a> ·
  <a href="docs/RESEARCH.md">Research</a> ·
  <a href="docs/ROADMAP.md">Roadmap</a> ·
  <a href="docs/OPERATING.md">Operating</a>
</p>

---

Most browser automation drives a **fresh, anonymous** browser.
**`gaze` drives the one you are already signed in to.**

It is a CLI and a local stdio [MCP](https://modelcontextprotocol.io) server. It
is **not an AI agent**: it has no model, no planning and no autonomy. An agent
*you* run (Claude Code, Codex, any MCP client) drives gaze; gaze decides
nothing.

- Reads never prompt. Anything that **changes** something asks first.
- Page content comes back wrapped and injection-scanned, never as instruction.
- Nothing listens on a network port, and nothing phones home.

## Receipts

| Proof | Result |
|---|---|
| [Benchmark](docs/GAUNTLET.md) | **100/100, grade S** on a 12-level anti-scraping course — F1 1.0, perfect conduct, **17.2 s against a 180 s par** |
| [Tests](docs/OPERATING.md) | **195 automated checks**, green on every push/PR; every suite uses a throwaway browser and never touches a real profile |
| Prompt-injection defence | Scraped output is flagged, not followed (the course plants instructions aimed at the agent — see [Security](docs/SECURITY.md)) |
| [Comparison](docs/COMPARISON.md) | Says plainly where larger tools beat gaze — and where they cannot act as you |
| [Research](docs/RESEARCH.md) | Every design decision traced to published work |
| [Roadmap](docs/ROADMAP.md) | Where it is going: any browser, any OS, faster, sourced |

## Install

```bash
git clone https://github.com/KevinTrinhDev/gaze && cd gaze && npm install
ln -s "$PWD/bin/gaze" ~/.local/bin/gaze     # Linux / macOS (Windows: WSL)
```

## Quick start

```bash
gaze sync            # clone your logins (close that browser first)
gaze start           # open the automation browser (visible, on purpose)
gaze goto https://news.ycombinator.com
gaze map             # what is clickable, each with a reusable selector
```

Then read, click, fill, scrape, record, save sessions — see
[Usage](docs/USAGE.md). Anything that will not start: `gaze doctor`.

## Drive it from an AI client

```json
{ "mcpServers": { "gaze": {
    "command": "node", "args": ["/path/to/gaze/mcp.mjs"],
    "env": { "GAZE_APPROVAL": "fingerprint" } } } }
```

16 tools: read, map, click, fill, login (from a vault *you* unlocked), session,
screenshot, challenge detection, batch. Stdio only, deliberately.

## Guardrails

- Writes ask on the terminal, or for a fingerprint touch
  (`GAZE_APPROVAL=fingerprint`). No terminal, no opt-out → **refused**.
- `grant` approves once for a bounded window; there is no `--forever`.
- CAPTCHAs are **detected and handed to a human** — never solved.
- Passkeys and native sign-in stay human: gaze initiates, you complete.
- `revoke` stops everything. `stats` shows what ran. `log` shows what failed.
- It drives a browser holding **your real sessions** — treat it accordingly.

## Browsers

| Family | Browsers | Protocol |
|---|---|---|
| Chromium | Brave, Chrome, Chromium, Edge, Vivaldi, Opera | CDP |
| Firefox | Firefox, Dev Edition, BASILISK | WebDriver BiDi |

Safari is unsupported (WebKit protocol, macOS only). One browser per identity:
`sync` copies one profile. Roadmap: auto-discovery of whatever is installed —
see [Roadmap](docs/ROADMAP.md).

## Docs

| | |
|---|---|
| [USAGE.md](docs/USAGE.md) | every command and flag |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | the reviewed technical blueprint |
| [GAUNTLET.md](docs/GAUNTLET.md) | the benchmark, level by level |
| [COMPARISON.md](docs/COMPARISON.md) | vs Playwright MCP, browser-use, Skyvern, Claude in Chrome and more |
| [SECURITY.md](docs/SECURITY.md) | threat model, consent, CAPTCHA and vault rules |
| [RESEARCH.md](docs/RESEARCH.md) | the published work behind the design |
| [ROADMAP.md](docs/ROADMAP.md) | any-browser / any-OS plan, research-backed |
| [OPERATING.md](docs/OPERATING.md) | for people changing the driver |

---

Use it with discretion: this drives a browser holding your live sessions and can
act as you on any site you are signed in to. Many sites restrict automation;
being logged in does not change that. Not affiliated with any browser vendor.

MPL-2.0 · part of the [BASILISK](https://github.com/KevinTrinhDev/basilisk-browser) ecosystem
