// Loads REAL logged-out mobile Facebook in headless Chromium with the app's policy simulated:
// rules.json classification on every committed main-frame URL (like doUpdateVisitedHistory),
// blocked -> load start URL, and inject.js + theme.css injected with a bridge mock.
// Run from the repo root: node tools/live-test/run.js [startUrl]   (screenshot: live.png)
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const assets = path.join(root, 'app/src/main/assets');
const cfg = JSON.parse(fs.readFileSync(path.join(assets, 'rules.json'), 'utf8'));
const wrapped = "(function (THEME_CSS, CFG) {\n'use strict';\n" +
  fs.readFileSync(path.join(assets, 'inject.js'), 'utf8') + '\n})(' +
  JSON.stringify(fs.readFileSync(path.join(assets, 'theme.css'), 'utf8')) + ', ' + JSON.stringify(cfg) + ');';

// JS port of UrlRules.classify (test-only).
const re = a => (a || []).map(s => new RegExp(s));
const R = { internal: re(cfg.internalHosts), allow: re(cfg.allow), block: re(cfg.block), shim: re(cfg.linkShim && cfg.linkShim.hosts) };
const feed = new URL(cfg.friendsFeedUrl);
function classify(u) {
  let url; try { url = new URL(u); } catch (e) { return ['BLOCK', 'unparseable']; }
  if (!/^https?:$/.test(url.protocol)) return (cfg.internalSchemes || []).includes(url.protocol.slice(0, -1)) ? ['ALLOW', 'scheme'] : ['BLOCK', 'scheme'];
  if (!R.internal.some(r => r.test(url.hostname))) return ['EXTERNAL', 'external-host'];
  const np = p => p.length > 1 ? p.replace(/\/+$/, '') || '/' : p || '/';
  if (np(url.pathname) === np(feed.pathname) && [...feed.searchParams].every(([k, v]) => url.searchParams.get(k) === v)) return ['ALLOW', 'friends-feed'];
  const pq = url.pathname + url.search;
  const b = R.block.find(r => r.test(pq)); if (b) return ['BLOCK', 'block:' + b.source];
  const a = R.allow.find(r => r.test(pq)); if (a) return ['ALLOW', 'allow:' + a.source];
  return ['BLOCK', 'default'];
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'],
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8 Build/AP3A.241005.015) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.135 Mobile Safari/537.36' });
  const page = await ctx.newPage();
  const loggedIn = async () => (await ctx.cookies(cfg.sessionCookie.url)).some(c => c.name === cfg.sessionCookie.name && c.value);
  const startUrl = async () => (await loggedIn()) ? cfg.friendsFeedUrl : cfg.loginUrl;
  let redirects = 0;
  await page.exposeFunction('__fb_log', (t, m) => console.log(`  [${t}] ${m.split('\n')[0]}`));
  await page.exposeFunction('__fb_check', (u, s) => { const [d, r] = classify(u); console.log(`  [${s}] ${d} [${r}] ${u.slice(0, 120)}`); return d === 'BLOCK' ? 'block' : d.toLowerCase(); });
  await page.exposeFunction('__fb_target', () => startUrl());
  await page.addInitScript(() => {
    // exposeFunction is async; the real bridge is sync. Use sync stand-ins and fire-and-forget logging.
    window.FriendbookNative = {
      isDebug: () => true, toggleDebug: () => {}, shouldRun: () => true,
      isFriendsFeed: () => false, log: (t, m) => { window.__fb_log(t, m); },
      checkUrl: (u, s) => { window.__fb_check(u, s); return 'allow'; }, // native side enforces below
      redirectTarget: () => location.href, setAtTop: () => {},
    };
  });
  await page.addInitScript({ content: wrapped });
  page.on('framenavigated', async f => {
    if (f !== page.mainFrame()) return;
    const u = f.url(); const [d, r] = classify(u);
    console.log(`native:commit ${d} [${r}] ${u.slice(0, 140)}`);
    if (d === 'BLOCK' && !(await loggedIn())) { console.log('  (logged out: not enforced)'); return; }
    if (d === 'BLOCK') {
      if (++redirects > 6) { console.log('LOOP GUARD TRIPPED'); return; }
      const t = await startUrl(); console.log('  -> redirect to', t);
      page.goto(t).catch(() => {});
    }
  });
  const first = process.argv[2] || await startUrl();
  console.log('start:', first);
  await page.goto(first, { waitUntil: 'load' }).catch(e => console.log('goto error', e.message));
  await page.waitForTimeout(7000);
  const st = await page.evaluate(() => ({
    url: location.href,
    header: !!document.getElementById('friendbook-header'),
    text: document.body ? document.body.innerText.replace(/\n/g, ' / ').slice(0, 200) : '',
    hidden: [...document.querySelectorAll('[data-fbk-hidden]')].map(e => e.getAttribute('data-fbk-hidden')),
    inputs: document.querySelectorAll('input').length,
  }));
  console.log('RESULT', JSON.stringify(st, null, 1));
  await page.screenshot({ path: path.join(process.cwd(), 'live.png') });
  await browser.close();
})();
