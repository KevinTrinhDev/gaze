// Self-test for the experimental W3C WebDriver-classic client (webdriver.mjs).
// Runs entirely against a FAKE WebDriver HTTP server — no browser, no profile,
// no real driver binary — so it is safe anywhere and needs no network.
import { createServer } from 'node:http';
import { WebDriver, WebDriverError } from '../webdriver.mjs';

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok    ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`); fail++; }
};

// Fake driver: minimal W3C semantics for the verbs the client uses.
const calls = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let body = null;
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null; } catch {}
    calls.push(`${req.method} ${req.url}`);
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ value }));
    };
    const m = (re, s) => { const x = re.exec(req.url); return x ? x[s] : null; };
    if (req.method === 'POST' && req.url === '/session') return send(200, { sessionId: 's1', capabilities: { browserName: 'fake' } });
    if (req.method === 'DELETE' && req.url === '/session/s1') return send(200, null);
    if (req.method === 'POST' && /^\/session\/s1\/url$/.test(req.url)) return send(200, null);
    if (req.method === 'GET' && req.url === '/session/s1/url') return send(200, 'https://example.test/');
    if (req.method === 'GET' && req.url === '/session/s1/title') return send(200, 'Fake title');
    if (req.method === 'GET' && req.url === '/session/s1/source') return send(200, '<html></html>');
    if (req.method === 'POST' && /^\/session\/s1\/element$/.test(req.url)) {
      check('find sends the W3C using/value body', body && body.using === 'css selector' && body.value === '#x');
      return send(200, { [ELEMENT_KEY]: 'e0' });
    }
    if (req.method === 'POST' && /^\/session\/s1\/element\/e0\/(click|value)$/.test(req.url)) return send(200, null);
    if (req.method === 'GET' && req.url === '/session/s1/element/e0/text') return send(200, 'hello');
    if (req.method === 'POST' && /^\/session\/s1\/execute\/sync$/.test(req.url)) return send(200, body?.script === 'return 1+1' ? 2 : null);
    if (req.method === 'GET' && req.url === '/session/s1/screenshot') return send(200, Buffer.from('hi').toString('base64'));
    send(404, { error: 'unknown command', message: req.url });
  });
});

server.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log('webdriver client selftest');
  const wd = new WebDriver(base);
  try {
    const s = await wd.newSession();
    check('newSession returns an id', s.id === 's1', s.id);
    check('newSession returns capabilities', s.capabilities.browserName === 'fake');
    await wd.navigate(s, 'https://example.test/');
    check('currentUrl round-trips', (await wd.currentUrl(s)) === 'https://example.test/');
    check('title round-trips', (await wd.title(s)) === 'Fake title');
    check('source round-trips', (await wd.source(s)).includes('<html>'));
    const el = await wd.find(s, '#x');
    check('find returns the W3C element reference', el === 'e0', String(el));
    await wd.click(s, el);
    await wd.sendKeys(s, el, 'text');
    check('element text round-trips', (await wd.elementText(s, el)) === 'hello');
    check('execute/sync returns the value', (await wd.execute(s, 'return 1+1')) === 2);
    const shot = await wd.screenshot(s);
    check('screenshot returns base64', typeof shot === 'string' && Buffer.from(shot, 'base64').toString() === 'hi');
    await wd.deleteSession(s);
    check('deleteSession was called', calls.includes('DELETE /session/s1'));
    check('session lifecycle order is sane',
      calls.indexOf('POST /session') < calls.indexOf('DELETE /session/s1'));

    // Error surfaces as WebDriverError with the driver's message.
    let err = null;
    try { await wd.navigate({ id: 'missing' }, 'x'); }
    catch (e) { err = e; }
    check('driver errors surface as WebDriverError',
      err instanceof WebDriverError && err.wdError === 'unknown command' && /missing/.test(err.message),
      err ? err.message : '(no error)');
  } catch (e) {
    console.log(`  FAIL  ${e.stack || e.message}`);
    fail++;
  } finally {
    server.close();
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
});
