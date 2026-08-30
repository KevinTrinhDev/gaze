# Security model

## What this tool actually is

A browser holding your live, authenticated sessions, driven from a command line.
Anything you are signed in to, it can act as you on. Email included, if your mail
is in that profile.

That makes it the highest-privilege component in this repo, above the vault bridge
and the daemon, because it does not need a credential to act: it inherits one.

## Rules that follow from that

- Run it for a **specific, asked-for task**, in that session. Not as a convenient
  way to fetch something a plain HTTP request could get.
- **Never screenshot a page showing credentials, tokens, or one-time codes.**
  Screenshots outlive the session and often end up in logs or transcripts.
- **Stop it when the task ends.** A long-lived logged-in automation browser is a
  standing risk with no upside.
- **Reading is not permission to write.** Being able to open a mailbox is not
  permission to send, delete, or reply. Each of those needs to be asked for.
- Prefer the narrowest surface: a cookie-authenticated JSON read beats driving a
  UI, and driving a UI beats granting a long-lived API token.

## An honest note on what this technique is

The profile-clone approach is the same one Chrome 136 was hardening *against*.
Attackers had been driving the remote debugging port to lift cookies out of the
default profile, so Google stopped honouring the switch there.

Doing it locally, to your own profile, with your own consent, is legitimate. But
it is worth being clear-eyed: this tool is working against the grain of a security
control, which is why it has sharp edges and why it deserves the handling rules
above rather than being treated as ordinary tooling.

## Device Bound Session Credentials

[DBSC](https://w3c.github.io/webappsec-dbsc/) is a W3C Web Application Security WG
specification that binds a session to a private key held in the device TPM, so a
copied profile cannot replay it. Chrome shipped it to stable in 146.

Adoption is **server side**, so this degrades site by site rather than all at once.

Practical rule: if logins start failing on one specific site while every other site
in the same profile still works, suspect DBSC adoption on that site before
suspecting a bug here. There is no workaround on this side, and there should not
be one: the correct response is to use that site by hand.

## Credentials, and the invariant this must not break

The rule this inherits, and must not break: **every vault call is triggered by an
explicit human action.** There is no path for an automated planning loop to reach
the vault on its own, even when running unattended.

`gaze login` is a CLI that agents drive. Wiring it to `bw unlock` would hand any
agent the ability to unlock the vault by itself, which is exactly what that rule
forbids. So it deliberately **cannot unlock anything**:

- It reads `BW_SESSION` from the environment, a session the operator unlocked.
- It never accepts, prompts for, or stores a master password.
- Secrets are passed to `page.fill()` in memory. They never appear in argv, in
  stdout, in the log, or in an agent transcript.
- It refuses to type into a password manager's own web UI (`NEVER_AUTO` in
  `gaze.mjs`). The vault is reached through its CLI, never by driving its DOM.

If a future change makes gaze able to unlock the vault, that is a security
regression, not a feature.

## CAPTCHAs: detect, never solve

`challenge` reports a challenge and exits 2. `wait-human` blocks until a human
clears it. Neither solves anything, and no solver integration should be added.

Third-party solving services are bot-detection evasion. They breach most sites'
terms of service, and on a browser carrying the operator's real sessions the
downside is account loss, not a failed scrape. The browser is visible precisely so
a human can clear a challenge in seconds and let automation continue.

## Indirect prompt injection

This is the threat that actually matters here, and the reason page output is
wrapped rather than returned bare.

A web page can contain text addressed to the *AI* rather than to the human. An
agent that scrapes it may treat that text as instructions and act with a browser
holding real credentials. 2026 research puts attack success rates against agentic
systems at 84%, production exploits above CVSS 9.0, and OpenAI has publicly said
prompt injection in AI browsers "may never be fully patched". OWASP's Top 10 for
Agentic Applications 2026 covers it as LLM01 plus LLM06.

gaze is close to the worst case for this: a logged-in browser, driven by an AI,
reading arbitrary untrusted pages, with a `login` command nearby.

Mitigations here:

- `text`, `html`, `scrape`, `links` and `table` wrap output in an untrusted
  envelope naming its source. `--raw` opts out, deliberately explicitly.
- A pattern sniffer flags obvious attempts (role reassignment, "ignore previous
  instructions", concealment, credential exfiltration) as `_suspicious`.
- Write actions are gated (below), so a scraped page cannot silently cause a
  state change.

None of this is a proof. Treat scraped content as hostile input, always.

## The approval gate

Every capability stays enabled. The gate governs *consent*, not power.

- Read commands never prompt.
- Write commands (`click`, `fill`, `press`, `download`, `eval`, `login`) prompt,
  showing the actions and the page they will run on.
- `batch` prompts once for a whole script.
- `GAZE_APPROVAL=fingerprint` requires a biometric touch via `fprintd-verify`.
- With no terminal and no explicit `off` or `--yes`, writes are **refused**. Failing
  closed is the point: an unattended agent must be configured deliberately.

## Data handling

- The cloned profile contains real cookies and saved credentials. It lives outside
  this repo and is gitignored. **Never commit a profile directory.**
- `shots/` and `downloads/` can contain whatever was on screen or downloaded.
  Both are gitignored. Treat their contents as sensitive.
- `browser.log` is browser stderr and is gitignored; it can leak URLs.
- Saved sessions in `~/.local/share/gaze/sessions` contain **live cookies** and
  are written mode 600. They are credentials: treat a stolen session file exactly
  as you would treat a stolen password.

## Reporting

This component drives authenticated sessions. If you find a way to make it act on
a profile the operator did not intend, or to leak profile contents outside the
machine, treat it as a security issue rather than a bug.
