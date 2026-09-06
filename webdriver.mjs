#!/usr/bin/env node
// Minimal W3C WebDriver (classic) client — ROADMAP part 8, experimental
// scaffold. This is the *reach* adapter: any browser with a WebDriver HTTP
// endpoint (Safari via safaridriver, WebKitGTK's WebKitWebDriver, driver-only
// cases) becomes drivable without CDP or BiDi.
//
// Deliberately tiny (~30 endpoints under a small set of verbs), dependency-free
// (global fetch + AbortController), and honest about what classic WebDriver
// cannot do: no console/network push events, no preload scripts — every method
// is request/response. gaze's CDP and BiDi paths stay the fast lanes; this is
// the fallback for reach, not a replacement.
//
// Element references use the fixed W3C key
// element-6066-11e4-a52e-4f735466cecf. Errors come back as HTTP status +
// {"value":{"error","message","stacktrace"}} and surface as WebDriverError.
//
// Not yet wired into bin/gaze: that integration (a `webdriver` browser row,
// per-OS driver provisioning via Selenium Manager) is a later slice.

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

export class WebDriverError extends Error {
  constructor(status, error, message) {
    super(`${error}${message ? ': ' + message : ''} (HTTP ${status})`);
    this.status = status;
    this.wdError = error;
  }
}

export class WebDriver {
  constructor(base, { timeoutMs = 60000 } = {}) {
    this.base = String(base).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  async #req(method, path, body) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
    } catch (e) {
      throw new Error(`webdriver request to ${path} failed: ${e.message}`);
    } finally {
      clearTimeout(t);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    const value = json?.value;
    if (res.status >= 400 && (value?.error || json?.value?.error)) {
      const v = value || json.value;
      throw new WebDriverError(res.status, v.error, v.message);
    }
    if (res.status >= 400) throw new WebDriverError(res.status, 'unknown', text.slice(0, 200));
    return value;
  }

  // POST /session -> {sessionId, capabilities}
  async newSession(capabilities = {}) {
    const v = await this.#req('POST', '/session', { capabilities: { alwaysMatch: capabilities } });
    return { id: v.sessionId, capabilities: v.capabilities || {} };
  }

  async deleteSession(s) { await this.#req('DELETE', `/session/${s.id}`); }
  async navigate(s, url) { await this.#req('POST', `/session/${s.id}/url`, { url }); }
  async currentUrl(s) { return this.#req('GET', `/session/${s.id}/url`); }
  async title(s) { return this.#req('GET', `/session/${s.id}/title`); }
  async source(s) { return this.#req('GET', `/session/${s.id}/source`); }

  async find(s, value, using = 'css selector') {
    const v = await this.#req('POST', `/session/${s.id}/element`, { using, value });
    return v[ELEMENT_KEY] || v;
  }
  async click(s, el) { await this.#req('POST', `/session/${s.id}/element/${el}/click`, {}); }
  async sendKeys(s, el, text) {
    await this.#req('POST', `/session/${s.id}/element/${el}/value`, { text });
  }
  async elementText(s, el) { return this.#req('GET', `/session/${s.id}/element/${el}/text`); }

  async execute(s, script, args = []) {
    return this.#req('POST', `/session/${s.id}/execute/sync`, { script, args });
  }
  async screenshot(s) { return this.#req('GET', `/session/${s.id}/screenshot`); }

  // Convenience: drive a flow against a real endpoint without managing the
  // session lifecycle by hand.
  async withSession(caps, fn) {
    const s = await this.newSession(caps);
    try { return await fn(s); }
    finally { try { await this.deleteSession(s); } catch {} }
  }
}

// Standalone smoke check when run directly:  node webdriver.mjs <base>
if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.argv[2];
  if (!base) { console.error('usage: node webdriver.mjs <webdriver-base-url>'); process.exit(2); }
  const wd = new WebDriver(base);
  wd.withSession({}, async s => {
    const url = process.argv[3] || 'about:blank';
    if (url) await wd.navigate(s, url);
    console.log('url:', await wd.currentUrl(s));
    console.log('title:', await wd.title(s));
  }).catch(e => { console.error('ERR:', e.message); process.exit(1); });
}
