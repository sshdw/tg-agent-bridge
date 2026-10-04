/**
 * W1 offline harness — no network, no Telegram token, no .env.
 * Imports the BUILT dist/miniapp/http.js with BOT_TOKEN='test', an ephemeral
 * port (port 0, real port read back from listen()) and temp dirs.
 * Usage: node work/verify-w1-http.mjs   (run from the repo root)
 *
 * Recovered 2026-10-03 after the W1 worktree deletion (work/ was gitignored
 * at the time); behaviour-identical to the 71-assertion version, plus a
 * raw-client traversal block (see the m2+m6 group).
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, request as httpRequest } from 'node:http';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { createMiniServer, verifyInitData, acquirePidLock, releasePidLock, startHeartbeat, wireMenuButton, isPortBusy } =
  await import('../dist/miniapp/http.js');

const TOKEN = 'test';
const ALLOWED = [111];
const WEB_DIR = join(ROOT, 'web');

let passed = 0;
const failures = [];
let group = '';
const g = (name) => {
  group = name;
  process.stdout.write(`\n${name}\n`);
};
function ok(label) {
  passed += 1;
  process.stdout.write(`  ok   ${label}\n`);
}
function assert(cond, label) {
  if (cond) ok(label);
  else {
    failures.push(`${group} :: ${label}`);
    process.stdout.write(`  FAIL ${label}\n`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- HMAC vectors (same construction the guard must verify) ---------------- */
function signEntries(entries) {
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dcs = sorted.map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  return createHmac('sha256', secret).update(dcs).digest('hex');
}
function sign(params) {
  return signEntries(Object.entries(params).filter(([k]) => k !== 'hash'));
}
function initData({ userId, authDate, hashOverride, firstName } = {}) {
  const at = authDate ?? Math.floor(Date.now() / 1000);
  const p = {
    auth_date: String(at),
    query_id: 'AAH-test-query',
    user: JSON.stringify({ id: userId ?? 111, first_name: firstName ?? 'T' }),
  };
  const h = hashOverride ?? sign(p);
  return new URLSearchParams({ ...p, hash: h }).toString();
}
const freshValid = () => initData({ userId: 111 });

const tmp = mkdtempSync(join(tmpdir(), 'w1-'));
const logs = [];
const say = (l) => logs.push(l);
const server = createMiniServer({ botToken: TOKEN, allowedChatIds: ALLOWED, webDir: WEB_DIR, log: say });
const { port } = await server.listen(0);
const base = `http://127.0.0.1:${port}`;
async function get(path, initDataHeader, method = 'GET') {
  const headers = initDataHeader !== undefined ? { 'X-Telegram-Init-Data': initDataHeader } : {};
  const res = await fetch(base + path, { method, headers });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body, ctype: res.headers.get('content-type') ?? '' };
}

g('setup: ephemeral listener');
assert(Number.isInteger(port) && port > 0, `listen(0) returned a real port (${port})`);

g('AC1: GET /health, no auth, < 50 ms');
{
  const t0 = Date.now();
  const r = await get('/health');
  const dt = Date.now() - t0;
  assert(r.status === 200, `GET /health -> 200 (got ${r.status})`);
  assert(r.body !== null && r.body.ok === true, 'GET /health JSON carries ok:true');
  assert(typeof r.body?.version === 'string' && typeof r.body?.sha === 'string', 'health carries version+sha strings');
  assert(r.ctype.includes('application/json'), `health content-type is JSON (${r.ctype})`);
  assert(dt < 50, `health answered in ${dt} ms (< 50 ms)`);
}

g('AC2: guard live before any API exists');
{
  const r = await get('/api/health');
  assert(r.status === 401, `GET /api/health without header -> 401 (got ${r.status})`);
  assert(r.body !== null && r.body.error === 'E_AUTH', 'missing initData -> {"error":"E_AUTH"}');
}

g('AC3: three auth vectors');
{
  const forged = await get('/api/health', initData({ userId: 111, hashOverride: '0'.repeat(64) }));
  assert(forged.status === 401 && forged.body?.error === 'E_AUTH', 'forged hash -> 401 E_AUTH');
  const short = await get('/api/health', initData({ userId: 111, hashOverride: 'abc' }));
  assert(short.status === 401 && short.body?.error === 'E_AUTH', 'wrong-length hash -> 401 E_AUTH');
  const alien = await get('/api/health', initData({ userId: 999 }));
  assert(alien.status === 403 && alien.body?.error === 'E_FORBIDDEN', 'valid sig, alien user.id -> 403 E_FORBIDDEN');
  const stale = await get('/api/health', initData({ userId: 111, authDate: Math.floor(Date.now() / 1000) - 90000 }));
  assert(stale.status === 400 && stale.body?.error === 'E_STALE', 'stale auth_date -> 400 E_STALE');
  const future = await get('/api/health', initData({ userId: 111, authDate: Math.floor(Date.now() / 1000) + 172800 }));
  assert(future.status === 400 && future.body?.error === 'E_STALE', 'far-future auth_date -> 400 E_STALE (skew guard)');
  const cyr = await get('/api/health', initData({ userId: 111, firstName: 'Привет 🎉' }));
  assert(cyr.status === 404 && cyr.body?.error === 'E_NOT_FOUND', 'Cyrillic/emoji first_name passes the guard');
  assert(verifyInitData(initData({ userId: 111, firstName: 'Привет 🎉' }), TOKEN, ALLOWED).ok === true, 'verifyInitData accepts non-ASCII user JSON');
  {
    // Duplicated `user` key: server folds every pair into the check string;
    // get('user') reads the first for identity. Sign exactly that.
    const at = String(Math.floor(Date.now() / 1000));
    const u1 = JSON.stringify({ id: 111, first_name: 'T' });
    const u2 = JSON.stringify({ id: 999, first_name: 'X' });
    const entries = [['auth_date', at], ['query_id', 'AAH-test-query'], ['user', u1], ['user', u2]];
    const h = signEntries(entries);
    const rawDup = [...entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`), `hash=${h}`].join('&');
    const dup = await get('/api/health', rawDup);
    assert(dup.status === 404 && dup.body?.error === 'E_NOT_FOUND', 'duplicated user key: first (whitelisted) identity passes');
  }
  const good = await get('/api/health', freshValid());
  assert(good.status === 404 && good.body?.error === 'E_NOT_FOUND', 'valid initData passes the guard (404: route not yet in W1)');
  assert(verifyInitData(freshValid(), TOKEN, ALLOWED).ok === true, 'verifyInitData accepts a fresh whitelisted vector');
  assert(verifyInitData(null, TOKEN, ALLOWED).ok === false, 'verifyInitData rejects a missing header');
}

g('AC4: timingSafeEqual, no equality operator inside verifyInitData');
{
  const src = readFileSync(join(ROOT, 'src', 'miniapp', 'http.ts'), 'utf8');
  const start = src.indexOf('export function verifyInitData');
  assert(start !== -1, 'verifyInitData found in src/miniapp/http.ts');
  // Function body = up to the first closing brace at column 0 (inner blocks
  // are indented, so this needs no name-based guessing and survives renames).
  const tail = src.slice(start);
  const end = tail.indexOf('\n}');
  const body = tail.slice(0, end);
  const code = body.replace(/\/\/[^\n]*/g, '');
  assert(code.includes('timingSafeEqual'), 'verifyInitData uses timingSafeEqual');
  assert(!/===|!==|==|!=/.test(code), 'verifyInitData body contains no ===/!==/==/!= at all');
}

g('AC5: pid-lock');
{
  const lock = join(tmp, 'bridge.pid');
  const llog = [];
  assert(acquirePidLock(lock, (l) => llog.push(l)) === true, 'first acquire succeeds');
  assert(acquirePidLock(lock, (l) => llog.push(l)) === false, 'second acquire on the same path fails');
  assert(llog.some((l) => l.includes('E_ALREADY_RUNNING')), 'refusal logs E_ALREADY_RUNNING');
  releasePidLock(lock);
  assert(acquirePidLock(lock, (l) => llog.push(l)) === true, 're-acquire works after release');
  releasePidLock(lock);
}

g('AC6: menu-button wiring');
{
  const calls = [];
  const fakeApi = { setChatMenuButton: async (args) => { calls.push(args); return true; } };
  const mlog = [];
  await wireMenuButton(fakeApi, '', [111, 222], (l) => mlog.push(l));
  assert(calls.length === 0, 'empty MINIAPP_URL -> zero setChatMenuButton calls');
  assert(mlog.filter((l) => l === 'menu-button: skipped (no MINIAPP_URL)').length === 1, 'empty MINIAPP_URL -> exactly one skip line');
  await wireMenuButton(fakeApi, 'https://example.test/app', [111, 222], (l) => mlog.push(l));
  assert(calls.length === 2, 'miniUrl set -> one call per allowed chat id (2)');
  assert(calls.every((c) => c.menu_button?.type === 'web_app' && c.menu_button?.web_app?.url === 'https://example.test/app'), 'button is web_app with the env URL');
  assert(JSON.stringify(calls.map((c) => c.chat_id)) === '[111,222]', 'calls target each allowed chat id');
  {
    // M2: a network blackhole — setChatMenuButton NEVER settles and never
    // rejects. Boot must still proceed, bounded by the timeout.
    const blackhole = { setChatMenuButton: () => new Promise(() => undefined) };
    const blog = [];
    const t0 = Date.now();
    await wireMenuButton(blackhole, 'https://example.test/app', [111], (l) => blog.push(l), 200);
    const dt = Date.now() - t0;
    assert(dt < 5000, `never-settling Api resolves via timeout (${dt} ms, budget 200 ms)`);
    assert(blog.some((l) => l.includes('E_MENU_TIMEOUT')), 'blackhole chat logs E_MENU_TIMEOUT, boot proceeds');
    assert(blog.every((l) => l.startsWith('menu-button:')), 'blackhole produces only menu-button log lines');
  }
}

g('AC7: heartbeat written, refreshed, goes stale');
{
  const hb = join(tmp, 'heartbeat');
  const stop = startHeartbeat(hb, 60, say);
  await sleep(260);
  const c1 = readFileSync(hb, 'utf8');
  await sleep(170);
  const c2 = readFileSync(hb, 'utf8');
  assert(c1 !== '' && c2 !== '' && c1 !== c2, 'heartbeat file written and refreshed');
  stop();
  const m1 = statSync(hb).mtimeMs;
  await sleep(170);
  assert(statSync(hb).mtimeMs === m1, 'after stop() the heartbeat file goes stale (mtime frozen)');
  assert(logs.some((l) => l.startsWith('heartbeat: writing')), 'heartbeat start logged');
}

g('M1: busy port degrades, other errors still fail fast');
{
  // Occupy a port with a dummy listener, then prove our listener rejects
  // with a classifier-positive E_PORT_BUSY (boot would continue to polling).
  const dummy = createServer((_, res) => res.end('x'));
  await new Promise((res) => dummy.listen(0, '127.0.0.1', res));
  const busyPort = dummy.address().port;
  const mini2 = createMiniServer({ botToken: TOKEN, allowedChatIds: ALLOWED, webDir: WEB_DIR, log: say });
  let busyErr = null;
  try {
    await mini2.listen(busyPort);
  } catch (e) {
    busyErr = e;
  }
  assert(busyErr !== null, `listen on an occupied port rejects (port ${busyPort})`);
  assert(isPortBusy(busyErr) === true, 'occupied-port rejection is classified E_PORT_BUSY (degrade path)');
  assert(isPortBusy(new Error('boom')) === false, 'a genuine error is NOT E_PORT_BUSY (fail-fast path)');
  await mini2.close().catch(() => undefined);
  await new Promise((res) => dummy.close(res));
  // Structural: the E_PORT_BUSY branch in src/index.ts must reach polling —
  // no process.exit between the branch and the degrade log line.
  const idxSrc = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8').split('\n');
  const at = idxSrc.findIndex((l) => l.includes('if (isPortBusy(err))'));
  assert(at !== -1, 'src/index.ts branches on isPortBusy(err)');
  const window = idxSrc.slice(at, at + 7).join('\n');
  assert(!window.includes('process.exit'), 'E_PORT_BUSY branch contains no process.exit (polling is reached)');
  assert(window.includes('polling continues'), 'E_PORT_BUSY branch logs that polling continues');
}

g('m2+m6: traversal containment against a temp web root');
{
  const SECRET = 'TOP-SECRET-BYTES-7f3a';
  const DBBYTES = 'FAKEDB-BYTES-9c1e';
  const PLACEHOLDER = '<h1>trav</h1>\n';
  const troot = mkdtempSync(join(tmpdir(), 'w1trav-'));
  mkdirSync(join(troot, 'web', 'sub'), { recursive: true });
  writeFileSync(join(troot, 'web', 'index.html'), PLACEHOLDER);
  writeFileSync(join(troot, 'secret.txt'), SECRET);
  writeFileSync(join(troot, 'store.db'), DBBYTES);
  const trav = createMiniServer({ botToken: TOKEN, allowedChatIds: ALLOWED, webDir: join(troot, 'web'), log: say });
  const { port: tport } = await trav.listen(0);
  const tget = async (path) => {
    const res = await fetch(`http://127.0.0.1:${tport}${path}`, { headers: { 'X-Telegram-Init-Data': freshValid() } });
    return { status: res.status, text: await res.text() };
  };
  // Raw client: node:http sends `path` verbatim (no WHATWG normalisation),
  // so `..` genuinely reaches the socket. fetch() would normalise it away.
  const traw = (path) => new Promise((resolveP, rejectP) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: tport, path, method: 'GET', headers: { 'X-Telegram-Init-Data': freshValid() } },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolveP({ status: res.statusCode, text: data }));
      },
    );
    req.on('error', rejectP);
    req.end();
  });
  const absSecret = join(troot, 'secret.txt').replace(/\\/g, '/');
  const escapes = [
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/%2e%2e%2fsecret.txt',
    '/..%2fsecret.txt',
    '/%2f..%2fsecret.txt',
    '/..%5csecret.txt',
    '/%252e%252e%252fsecret.txt',
    `/${absSecret.slice(absSecret.indexOf('/') + 1)}`,
    '/secret.txt%00',
  ];
  for (const p of escapes) {
    const r = await tget(p);
    assert(r.status === 404, `escape ${p} -> 404 (got ${r.status})`);
    assert(!r.text.includes(SECRET) && !r.text.includes(DBBYTES), `escape ${p} leaks neither secret nor db bytes`);
  }
  const inside = await tget('/sub/../index.html');
  assert(inside.status === 200 && inside.text.includes('<h1>'), 'in-root sub/../ still serves (no over-blocking)');
  let linked = false;
  try {
    symlinkSync(join(troot, 'secret.txt'), join(troot, 'web', 'link.txt'));
    linked = true;
  } catch (e) {
    process.stdout.write(`  SKIP symlink vector (needs privilege: ${(e.message ?? e).split(':')[0]})\n`);
  }
  if (linked) {
    const r = await tget('/link.txt');
    assert(r.status === 404, 'symlink in web/ pointing outside -> 404');
    assert(!r.text.includes(SECRET), 'symlink response leaks no secret bytes');
  }
  // Raw-wire repeats: the same bytes fetch() would normalise first.
  for (const p of ['/../secret.txt', '/..%2fsecret.txt', '/..%5csecret.txt', '/%2e%2e%2fsecret.txt']) {
    const r = await traw(p);
    assert(r.status === 404, `raw ${p} -> 404 (got ${r.status})`);
    assert(!r.text.includes(SECRET) && !r.text.includes(DBBYTES), `raw ${p} leaks neither secret nor db bytes`);
  }
  // Windows-specific: ADS stream, device names, trailing dot/space, overlong UTF-8.
  {
    const r = await traw('/index.html::$DATA');
    assert(r.status === 200, `raw /index.html::$DATA -> 200 (got ${r.status})`);
    assert(r.text === PLACEHOLDER, '::$DATA serves exactly the public placeholder bytes');
    assert(!r.text.includes(SECRET) && !r.text.includes(DBBYTES), '::$DATA leaks neither secret nor db bytes');
  }
  for (const p of ['/NUL', '/CON']) {
    const r = await traw(p);
    assert(r.status === 404, `raw ${p} -> 404 (got ${r.status})`);
    assert(!r.text.includes(SECRET) && !r.text.includes(DBBYTES), `raw ${p} leaks neither secret nor db bytes`);
  }
  // Trailing dot/space: Windows may strip them and serve the public file, or
  // the fs may refuse — both are secure as long as only public bytes or a
  // 404 come back. (A literal space cannot go on the wire via node:http, so
  // the space variant travels as %20 and is decoded server-side.)
  for (const p of ['/index.html.', '/index.html%20']) {
    const r = await traw(p);
    assert(r.status === 200 || r.status === 404, `raw ${p} -> 200 or 404, nothing else (got ${r.status})`);
    assert(r.status !== 200 || r.text === PLACEHOLDER, `raw ${p} serves exactly the public placeholder bytes when 200`);
    assert(!r.text.includes(SECRET) && !r.text.includes(DBBYTES), `raw ${p} leaks neither secret nor db bytes`);
  }
  {
    const r = await traw('/%c0%ae/%c0%ae/secret.txt');
    assert(r.status === 404, `raw overlong-UTF8 dot segment -> 404 (got ${r.status})`);
    assert(!r.text.includes(SECRET) && !r.text.includes(DBBYTES), 'raw overlong-UTF8 leaks neither secret nor db bytes');
  }
  {
    const r = await traw('/../secret.txt.');
    assert(r.status === 404, `raw /../secret.txt. -> 404 (got ${r.status})`);
    assert(!r.text.includes(SECRET) && !r.text.includes(DBBYTES), 'raw /../secret.txt. leaks neither secret nor db bytes');
  }
  await trav.close();
  rmSync(troot, { recursive: true, force: true });
}

g('AC8: no new runtime dependency');
{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert(JSON.stringify(Object.keys(pkg.dependencies).sort()) === '["better-sqlite3","grammy"]', 'dependencies are exactly better-sqlite3 + grammy');
}

g('routing: 404 / 405 / static / bind / close');
{
  const nope = await get('/nope-xyz', freshValid());
  assert(nope.status === 404 && nope.body?.error === 'E_NOT_FOUND', 'unknown path -> 404 JSON');
  const postHealth = await get('/health', undefined, 'POST');
  assert(postHealth.status === 405 && postHealth.body?.error === 'E_METHOD_NOT_ALLOWED', 'POST /health -> 405 JSON');
  const idx = await get('/', freshValid());
  assert(idx.status === 200, `GET / -> 200 (got ${idx.status})`);
  assert(idx.ctype.includes('text/html'), `placeholder served as text/html (${idx.ctype})`);
  const html = await (await fetch(base + '/', { headers: { 'X-Telegram-Init-Data': freshValid() } })).text();
  assert(html.includes('<h1'), 'shell carries an <h1 (real Mini App shell, W5+)');
  const src = readFileSync(join(ROOT, 'src', 'miniapp', 'http.ts'), 'utf8');
  assert(src.includes('127.0.0.1'), 'listener binds 127.0.0.1 explicitly');
  assert(!src.includes('0.0.0.0'), 'listener never binds 0.0.0.0');
  await server.close();
  let threw = false;
  try {
    await fetch(`${base}/health`);
  } catch {
    threw = true;
  }
  assert(threw, 'close() releases the port (fetch refuses)');
}

rmSync(tmp, { recursive: true, force: true });
process.stdout.write(`\n${'-'.repeat(60)}\n`);
if (failures.length === 0) {
  process.stdout.write(`ALL GREEN — ${passed} assertions passed\n`);
} else {
  process.stdout.write(`${failures.length} FAILED of ${passed + failures.length} assertions:\n`);
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exitCode = 1;
}
