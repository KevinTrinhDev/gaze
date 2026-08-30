# AGENTS.md - gaze

Read [`docs/SECURITY.md`](docs/SECURITY.md) **before running this**, and
[`docs/OPERATING.md`](docs/OPERATING.md) before changing it.

## The short version

`gaze` drives a browser that holds the operator's **live, authenticated
sessions**. It can act as them on any site they are signed in to, email included.
It does not need a credential to act: it inherits one. Treat it accordingly.

Therefore:

- Run it only for a **specific task the operator asked for, in that session**.
  Never as a shortcut for something a plain HTTP request could fetch.
- Never screenshot credentials, tokens or one-time codes.
- Stop it when the task ends.
- **Reading is not permission to write.** Opening a mailbox is not permission to
  send, delete or reply. Ask for each.

## Before you debug something

Run `gaze doctor` first. It checks the binary, the profile, the cookies and the
debug port, and reports the actual cause instead of leaving you to guess.

`gaze browsers` shows what is installed and which one is selected.

## Traps that repeat

These are covered fully in [`docs/OPERATING.md`](docs/OPERATING.md), but the three
that keep costing time:

1. **`pkill -f <pattern>` kills the shell that ran it.** Use `killauto.sh <port>`.
2. **The browser dies if launched in a short-lived process group.** Start it
   backgrounded so it survives across commands.
3. **`sync` copies one profile**, signed into one identity. An account not signed
   into the everyday profile is unreachable, and that is an identity boundary, not
   a UI problem to click through.

## Changing the driver

- Chromium goes through `gaze.mjs` (Playwright over CDP).
- Firefox goes through `gaze-bidi.mjs` (WebDriver BiDi, hand-rolled client).
- Adding a browser is one row in the table at the top of `bin/gaze`.

Both backends have a headless self-test that never touches a real profile. Run
both before committing:

```bash
npm test && npm run test:firefox
```
