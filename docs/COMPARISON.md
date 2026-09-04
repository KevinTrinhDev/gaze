# How gaze compares

An honest answer to "is this actually different, or is it a wrapper?"

## The short version

**Most of what gaze does is not novel.** Cloning a browser profile to drive it is
the community-standard workaround for the Chrome 136 change. Driving a browser over
CDP is Playwright. Exposing a browser to an AI over MCP has official
implementations from both Microsoft and the Chrome team.

**What appears not to exist elsewhere is the combination**: an *already
authenticated* browser, driven by an agent, with *enforceable, tool-level consent*
and *provenance-tagged output*. Every comparable tool either assumes unattended
operation and skips consent entirely, or is an agent framework where the safety
lives in a prompt rather than in the tool.

That is the claim. Everything below is the evidence for and against it.

---

## Not actually competitors

**Playwright and Puppeteer** are the substrate, not rivals. `gaze` is built on
Playwright (via Patchright). They give you an API for driving browsers you launch;
`gaze` gives you a logged-in browser, a CLI, an MCP surface, and a consent model.
Anyone can write `connectOverCDP` in twenty lines, and that is fine: the twenty
lines are not the product.

**Firecrawl** and hosted scraping APIs fetch *public* pages from *their*
infrastructure. They are excellent at breadth and terrible at authentication, by
design: Firecrawl cannot read your inbox, because it is not you. `gaze` is the
opposite trade. If the page is public, use Firecrawl; it will be faster and cheaper.

**Camoufox, nodriver, patchright** optimise for *anonymity at scale*: many
identities, none of them yours. `gaze` optimises for *one identity, which is
genuinely yours*. Opposite goals, which is why gaze uses one of them as a
component rather than competing with it.

---

## Actual competitors

### Playwright MCP (Microsoft)

Launches its own browser. Uses an accessibility-tree snapshot, which is text-only,
fast, cross-browser, and **more token-efficient than our selector map** (roughly
13.7k vs Chrome DevTools MCP's 18k in published benchmarks).

- **Better than gaze at:** test automation, CI, token efficiency, cross-platform
  maturity, WebKit support.
- **Cannot do:** act as you. A fresh browser has none of your sessions.

### Chrome DevTools MCP (Chrome team)

About 29 tools over CDP: navigation, input, network inspection, performance
tracing, Lighthouse.

- **Better than gaze at:** debugging depth. Performance traces and Lighthouse
  audits have no equivalent here.
- **Cannot do:** Firefox, at all. And it has no consent layer: tools execute when
  the model calls them.

### Claude in Chrome (Anthropic)

The closest thing to gaze's actual niche: a real browser with authenticated
sessions, driven by an AI.

- **Better than gaze at:** polish, packaging, being maintained by a company.
- **Differs:** it is a paid extension tied to one vendor's client. `gaze` is
  vendor-neutral (Codex, Claude Code, any MCP client), needs no extension, runs on
  your machine, works on Firefox as well as Chromium, and you can read every line
  of it.

### browser-use, Stagehand, and agent frameworks

These put an LLM in the driving loop. `gaze` deliberately does not: it is a
deterministic tool, and the intelligence lives in whatever calls it.

- **Better than gaze at:** autonomy out of the box.
- **Differs:** their safety is prompt-level. A model that has been talked into
  something acts immediately. gaze's approval gate is enforced by the tool, not
  requested of the model, so a successful prompt injection still hits a wall.

---

## What is genuinely ours

| | Why it matters |
|---|---|
| **Authenticated, vendor-neutral, no extension** | Claude in Chrome needs a subscription and its own client. gaze answers to any MCP client, or to a shell. |
| **Two browser families** | Chromium over CDP and Firefox over WebDriver BiDi. Chrome DevTools MCP is Chrome-only; almost nothing drives an *authenticated* Firefox profile. |
| **Enforceable consent** | Reads are free, writes prompt, `batch` prompts once, `grant` gives a bounded standing approval, and fingerprint mode ties it to hardware. Refuses rather than proceeds when there is no terminal. |
| **Provenance-tagged output** | Page content comes back wrapped and injection-scanned. Every other tool hands the model raw page text, which is the exact attack surface 2026 research measures at 84% success. |
| **A vault bridge that refuses to unlock** | `login` fills credentials but structurally cannot unlock the vault. The human does that, or nobody does. |
| **Redacted local telemetry** | `stats` shows what is slow and what fails, with credential values never written. |

---

## Where gaze is genuinely behind

Said plainly, because a comparison that only flatters is not useful.

- **Token efficiency.** Playwright MCP's accessibility snapshot is a better default
  representation for a model than our CSS-selector map. Worth adopting.
- **Debugging depth.** No performance tracing, no Lighthouse. Chrome DevTools MCP
  wins outright there.
- **Portability.** Linux-centric: snap-aware profile paths, `fprintd` for
  biometrics. macOS and Windows are unimplemented, not merely untested.
- **Stealth is one fix deep.** The Patchright swap removes the `Runtime.enable`
  tell. That is all. This is not a stealth product and does not pretend to be one.
- **Maturity.** Days old, one author, 139 tests. The alternatives have years and
  companies behind them.

---

## When you should not use gaze

- The page is public. Use Firecrawl or a plain HTTP request.
- You are running tests in CI. Use Playwright.
- You need performance profiling. Use Chrome DevTools MCP.
- You want thousands of anonymous sessions. Use Camoufox or a hosted browser grid,
  and understand you are entering the detection arms race.
- You want the agent to decide and act without you. Use an agent framework, and
  accept the risk that comes with it.

**Use gaze when the work requires being signed in as yourself, and you want a
record and a say in what happens.**
