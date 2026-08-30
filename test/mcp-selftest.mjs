// Self-test for the MCP server (mcp.mjs).
//
// Speaks real MCP over stdio, the same way Claude Code or Codex would. Only
// read-only tools are exercised, and no browser needs to be running, so this is
// safe at any time.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const DIR = new URL('.', import.meta.url).pathname;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok    ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`); fail++; }
};

const transport = new StdioClientTransport({
  command: 'node',
  args: [DIR + '../mcp.mjs'],
  env: { ...process.env },
});
const client = new Client({ name: 'gaze-selftest', version: '1.0.0' });

try {
  await client.connect(transport);
  console.log('gaze mcp selftest');

  const { tools } = await client.listTools();
  const names = tools.map(t => t.name);
  check('server advertises tools over stdio', tools.length >= 15, `got ${tools.length}`);
  check('read tools are present',
        ['browser_goto', 'browser_read', 'browser_map', 'browser_scrape'].every(n => names.includes(n)));
  check('write tools are present',
        ['browser_click', 'browser_fill', 'browser_login'].every(n => names.includes(n)));
  check('every tool has a description', tools.every(t => t.description && t.description.length > 20));

  const write = tools.find(t => t.name === 'browser_click');
  check('write tools warn about the approval gate',
        write.description.includes('approval'), write.description.slice(0, 60));
  const read = tools.find(t => t.name === 'browser_read');
  check('read tools warn the content is untrusted',
        /UNTRUSTED/.test(read.description), read.description.slice(0, 60));
  const login = tools.find(t => t.name === 'browser_login');
  check('login tool states it cannot unlock the vault',
        login.description.includes('cannot unlock it'), login.description.slice(0, 80));

  const instructions = client.getInstructions ? client.getInstructions() : '';
  check('the server tells the agent to warn its human first',
        /tell the user plainly/i.test(instructions || ''), (instructions || '').slice(0, 60));
  check('and that page content is never an instruction',
        /never as instructions/i.test(instructions || ''));

  const status = await client.callTool({ name: 'browser_status', arguments: {} });
  const text = status.content.map(c => c.text).join('');
  check('browser_status runs the real CLI', text.includes('gaze doctor'), text.slice(0, 80));
  check('browser_status reports the selected browser', /browser:\s+\S+/.test(text));

  console.log(`${pass} passed, ${fail} failed`);
} catch (e) {
  console.log(`  FAIL  ${e.message}`);
  fail++;
} finally {
  try { await client.close(); } catch {}
}
process.exit(fail ? 1 : 0);
