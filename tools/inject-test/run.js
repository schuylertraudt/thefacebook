// Desktop test of assets/inject.js + theme.css against a fake feed page, with a mocked
// native bridge. Needs Node and Playwright (with Chromium). Run from the repo root:
//   node tools/inject-test/run.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const assets = path.join(root, 'app/src/main/assets');
const css = fs.readFileSync(path.join(assets, 'theme.css'), 'utf8');
const js = fs.readFileSync(path.join(assets, 'inject.js'), 'utf8');
const cfg = JSON.parse(fs.readFileSync(path.join(assets, 'rules.json'), 'utf8'));
// Same wrapping as Injector.kt.
const wrapped = "(function (THEME_CSS, CFG) {\n'use strict';\n" + js + '\n})(' +
  JSON.stringify(css) + ', ' + JSON.stringify(cfg) + ');';
const fixture = fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  -> ' + JSON.stringify(detail)));
  if (!ok) failures++;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const logs = [];
  await page.exposeFunction('__nlog', (t, m) => logs.push(`[${t}] ${m}`));
  await page.route('https://m.facebook.com/**', r => r.fulfill({ contentType: 'text/html', body: fixture }));
  await page.addInitScript(() => {
    let debug = false;
    const rewrites = new Set();
    window.FriendbookNative = {
      isDebug: () => debug,
      toggleDebug: () => { debug = !debug; },
      shouldRun: u => u.startsWith('https://m.facebook.com'),
      isFriendsFeed: u => (/[?&]sk=h_chr/.test(u) && /filter=friends/.test(u)) || rewrites.has(u),
      checkReplace: (u, doc) => {
        const isFeed = /[?&]sk=h_chr/.test(doc) && /filter=friends/.test(doc);
        if (isFeed && /^\/(\?.*)?$/.test(new URL(u).pathname + new URL(u).search)) { rewrites.add(u); return 'allow'; }
        return window.FriendbookNative.checkUrl(u, 'spa:replaceState');
      },
      checkUrl: (u, s) => {
        if (rewrites.has(u)) return 'allow';
        const p = new URL(u);
        const v = /^\/(watch|reel)/.test(p.pathname) || (p.pathname === '/' && !/sk=h_chr/.test(p.search)) ? 'block' : 'allow';
        window.__nlog(s, v + ' ' + u);
        return debug ? 'allow' : v;
      },
      log: (t, m) => window.__nlog(t, m),
      setAtTop: () => {},
      isDesktop: () => false,
      takeCommand: () => { const c = window.__cmd || ''; window.__cmd = ''; return c; },
    };
  });
  await page.addInitScript({ content: wrapped });
  await page.goto(cfg.friendsFeedUrl);
  await page.waitForTimeout(800);

  const st = await page.evaluate(() => {
    const h = id => { const e = document.getElementById(id); return e ? e.getAttribute('data-fbk-hidden') : 'missing'; };
    return {
      header: !!document.getElementById('friendbook-header'),
      htmlClass: document.documentElement.className,
      wash: getComputedStyle(document.documentElement).getPropertyValue('--web-wash').trim(),
      padTop: getComputedStyle(document.body).paddingTop,
      fbtop: h('fbtop'), stories: h('stories'), friend: h('friend'), comment: h('comment'),
      ad1: h('ad1'), ad2: h('ad2'), ad3: h('ad3'), page: h('page'), pymk: h('pymk'),
      nameColor: getComputedStyle(document.querySelector('#friend h3 a')).color,
      timeTagged: document.querySelector('#friend a[href*=story] span').hasAttribute('data-fbk-time'),
      m1: h('m1'), m2: h('m2'), m3: h('m3'), m1unit: document.getElementById('m1').hasAttribute('data-fbk-unit'),
      fontsVar: getComputedStyle(document.documentElement).getPropertyValue('--fbk-page-fonts'),
      iconFont: getComputedStyle(document.getElementById('icon')).fontFamily,
    };
  });
  check('header injected', st.header, st);
  check('forced light mode', st.htmlClass === '__fb-light-mode', st.htmlClass);
  check('css variable overridden', st.wash === '#edeff4', st.wash);
  check('body offset under header', st.padTop === '42px', st.padTop);
  check('native top bar hidden', st.fbtop === 'selector:fb-chrome', st.fbtop);
  check('stories tray hidden', st.stories === 'selector:stories', st.stories);
  check('friend post kept', st.friend === null, st.friend);
  check('comment kept', st.comment === null, st.comment);
  check('plain Sponsored hidden', st.ad1 === 'sponsored', st.ad1);
  check('Sponsored with display:none decoys hidden', st.ad2 === 'sponsored', st.ad2);
  check('Sponsored with positioned decoys hidden', st.ad3 === 'sponsored', st.ad3);
  check('Follow unit hidden on feed', st.page === 'section:follow', st.page);
  check('People you may know hidden', st.pymk === 'section:peopleyoumayknow', st.pymk);
  check('author name styled', st.nameColor === 'rgb(59, 89, 152)', st.nameColor);
  check('timestamp tagged', st.timeTagged, st.timeTagged);
  check('auto feed units detected without roles', st.m1unit, st);
  check('auto unit: Sponsored hidden', st.m2 === 'sponsored', st.m2);
  check('auto unit: friend posts kept', st.m1 === null && st.m3 === null, [st.m1, st.m3]);
  check('page web fonts exposed as fallback', /FBIcons/.test(st.fontsVar), st.fontsVar);
  check('icon element keeps icon font as fallback', /FBIcons/.test(st.iconFont), st.iconFont);

  // Device log: the feed document rewrites its own URL to "/" right after loading.
  await page.evaluate(() => history.replaceState({}, '', '/'));
  await page.waitForTimeout(800);
  check('feed document may replaceState itself to /', new URL(page.url()).pathname === '/' && !new URL(page.url()).search, page.url());
  check('header still present after rewrite', await page.evaluate(() => !!document.getElementById('friendbook-header')), null);
  await page.evaluate(() => history.pushState({}, '', '/jane.doe.123'));
  await page.waitForTimeout(200);
  await page.evaluate(() => history.back());
  await page.waitForTimeout(800);
  check('back to rewritten feed URL is kept', new URL(page.url()).pathname === '/', page.url());
  await page.evaluate(() => history.pushState({}, '', '/jane.doe.123'));
  await page.waitForTimeout(200);
  check('allowed pushState stays', page.url().endsWith('/jane.doe.123'), page.url());
  await page.evaluate(() => history.pushState({}, '', '/watch/?v=1'));
  await page.waitForTimeout(800);
  check('blocked pushState returns to feed', page.url() === cfg.friendsFeedUrl, page.url());

  await page.evaluate(() => window.FriendbookNative.toggleDebug());
  await page.waitForTimeout(1800);
  check('debug logs hidden count', logs.some(l => l.startsWith('[hidden]')), logs);
  check('debug logs css vars', logs.some(l => l.startsWith('[css-vars]')), logs);
  await page.evaluate(() => { window.__cmd = 'dump'; });
  await page.waitForTimeout(1200);
  check('dump page logs structure', logs.some(l => l.startsWith('[dump] auto feed container')) && logs.some(l => l.includes('label "Sponsored"')), logs.filter(l => l.startsWith('[dump]')).slice(0, 3));
  await page.evaluate(() => history.pushState({}, '', '/reel/1'));
  await page.waitForTimeout(800);
  check('debug mode does not filter', page.url().endsWith('/reel/1'), page.url());

  if (process.env.SHOW_LOG) console.log(logs.join('\n'));
  await browser.close();
  console.log(failures ? `${failures} failure(s)` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
