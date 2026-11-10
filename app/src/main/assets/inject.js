/*
 * Friendbook page script.
 *
 * Injector.kt wraps this file as
 *   (function (THEME_CSS, CFG) { 'use strict'; <this file> })("<theme.css>", <rules.json>);
 * so THEME_CSS is the contents of theme.css and CFG is the parsed rules.json.
 * Everything Facebook-specific comes from CFG or THEME_CSS; this file holds only logic.
 *
 * Runs at document start. Idempotent: a second evaluation in the same document is a no-op.
 */

if (window.top !== window) return;
var NATIVE = window.FriendbookNative;
if (!NATIVE) return;
if (!NATIVE.shouldRun(location.href)) return;
var GUARD = '__friendbookInstalled';
if (window[GUARD]) return;
Object.defineProperty(window, GUARD, { value: true, enumerable: false });

var FEED_URL = CFG.friendsFeedUrl;
var STYLE_ID = 'friendbook-style';
var HEADER_ID = 'friendbook-header';
var HIDDEN_ATTR = 'data-fbk-hidden';

// Functional CSS (not theming): how hidden elements behave, and their debug-mode review look.
var CORE_CSS =
  '[' + HIDDEN_ATTR + ']{display:none!important}' +
  'html[data-fbk-debug] [' + HIDDEN_ATTR + ']{display:block!important;opacity:.35!important;' +
  'outline:2px dashed #c00!important;outline-offset:-2px;position:relative!important;max-height:160px!important;overflow:hidden!important}' +
  'html[data-fbk-debug] [' + HIDDEN_ATTR + ']::before{content:"hidden: " attr(' + HIDDEN_ATTR + ');' +
  'position:absolute;z-index:2;top:0;left:0;background:#c00;color:#fff;font:bold 10px monospace;padding:1px 4px}';

// ---------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------

function safe(fn) {
  return function () {
    try { return fn.apply(this, arguments); } catch (e) { log('js:error', String(e && e.stack || e)); }
  };
}

var debugCache = false;
function isDebug() {
  try { debugCache = !!NATIVE.isDebug(); } catch (e) {}
  return debugCache;
}

function log(tag, msg) {
  try { NATIVE.log(tag, String(msg)); } catch (e) {}
}

function abs(url) {
  try { return new URL(url, location.href).href; } catch (e) { return null; }
}

/** Lowercase, strip all whitespace and zero-width characters. */
function norm(s) {
  return (s || '').replace(/[\s\u00a0\u200b-\u200f\u2028\u2029\u2060\ufeff]+/g, '').toLowerCase();
}

/** True if every character of `needle` appears in order in `hay`. */
function isSubsequence(needle, hay) {
  var i = 0;
  for (var j = 0; j < hay.length && i < needle.length; j++) {
    if (hay.charAt(j) === needle.charAt(i)) i++;
  }
  return i === needle.length;
}

function list(v) { return Array.isArray(v) ? v : []; }

var labels = CFG.hideLabels || {};
var SPONSORED = list(labels.sponsored).map(norm).filter(Boolean);
var SECTIONS = list(labels.sections).map(norm).filter(Boolean);
var FEED_ONLY = list(labels.feedOnly).map(norm).filter(Boolean);
var UNIT_SEL = list(CFG.feedUnitSelectors).join(',');
var NAME_SEL = list(CFG.nameSelectors).join(',');
var FUZZY_RATIO = +CFG.sponsoredFuzzyRatio || 0;
var CLIMB_MAX_TEXT = +CFG.sectionClimbMaxText || 2500;
var TIME_RE = null;
try { if (CFG.timestampPattern) TIME_RE = new RegExp(CFG.timestampPattern, 'i'); } catch (e) {}

// ---------------------------------------------------------------------------------------
// URL filtering (SPA side). Native code handles full navigations.
// ---------------------------------------------------------------------------------------

var lastUrl = location.href;
var redirecting = false;

/** Returns false if the URL is blocked (and a redirect to the feed has been started). */
function enforce(url, source) {
  if (redirecting) return false;
  var verdict = 'allow';
  try { verdict = NATIVE.checkUrl(url, source); } catch (e) {}
  if (verdict === 'block') {
    redirecting = true;
    location.replace(FEED_URL);
    return false;
  }
  if (verdict === 'stop') { redirecting = true; return false; }
  return true;
}

function onUrlMaybeChanged(source) {
  var href = location.href;
  if (href === lastUrl) return;
  lastUrl = href;
  if (!enforce(href, source)) return;
  onNavigated();
}

['pushState', 'replaceState'].forEach(function (name) {
  var orig = history[name];
  if (typeof orig !== 'function') return;
  var wrapped = function (state, title, url) {
    if (url !== undefined && url !== null) {
      var target = abs(url);
      if (target && target !== location.href) {
        lastUrl = target;
        if (!enforce(target, 'spa:' + name)) return;
      }
    }
    var r = orig.apply(this, arguments);
    if (location.href !== lastUrl) onUrlMaybeChanged('spa:' + name);
    else onNavigated();
    return r;
  };
  try { wrapped.toString = function () { return orig.toString(); }; } catch (e) {}
  history[name] = wrapped;
});

window.addEventListener('popstate', safe(function () { onUrlMaybeChanged('spa:popstate'); }), true);
window.addEventListener('hashchange', safe(function () { onUrlMaybeChanged('spa:hashchange'); }), true);

// ---------------------------------------------------------------------------------------
// Style + header
// ---------------------------------------------------------------------------------------

function ensureStyle() {
  var parent = document.head || document.documentElement;
  if (!parent) return;
  var s = document.getElementById(STYLE_ID);
  if (!s) {
    s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CORE_CSS + '\n' + THEME_CSS;
  }
  // Keep our sheet last so it wins ties in the cascade.
  if (document.head) {
    if (s.parentNode !== document.head || document.head.lastElementChild !== s) document.head.appendChild(s);
  } else if (!s.parentNode) {
    parent.appendChild(s);
  }
}

function forceLight() {
  var html = document.documentElement;
  if (!html) return;
  var f = CFG.forceLightMode || {};
  list(f.removeClasses).forEach(function (c) { if (html.classList.contains(c)) html.classList.remove(c); });
  list(f.addClasses).forEach(function (c) { if (!html.classList.contains(c)) html.classList.add(c); });
  if (!html.hasAttribute('data-friendbook')) html.setAttribute('data-friendbook', '');
  var dbg = isDebug();
  if (dbg !== html.hasAttribute('data-fbk-debug')) {
    if (dbg) html.setAttribute('data-fbk-debug', ''); else html.removeAttribute('data-fbk-debug');
  }
}

function headerHref(url) {
  return url === '@friendsFeedUrl' ? FEED_URL : url;
}

function buildHeader() {
  var h = document.createElement('div');
  h.id = HEADER_ID;
  var title = document.createElement('span');
  title.className = 'fbk-title';
  title.textContent = CFG.headerTitle || 'Friendbook';
  h.appendChild(title);

  var nav = document.createElement('span');
  nav.className = 'fbk-links';
  list(CFG.headerLinks).forEach(function (l) {
    var a = document.createElement('a');
    a.textContent = l.label;
    a.href = headerHref(l.url);
    a.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      location.assign(a.href);
    }, true);
    nav.appendChild(a);
  });
  h.appendChild(nav);

  // Long-press the title to toggle debug mode.
  var timer = null;
  function cancel() { if (timer) { clearTimeout(timer); timer = null; } }
  title.addEventListener('touchstart', function () {
    cancel();
    timer = setTimeout(function () {
      timer = null;
      try { NATIVE.toggleDebug(); } catch (e) {}
      setTimeout(schedule, 50);
    }, 600);
  }, { passive: true });
  title.addEventListener('touchend', cancel);
  title.addEventListener('touchmove', cancel, { passive: true });
  title.addEventListener('touchcancel', cancel);
  title.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  return h;
}

function ensureHeader() {
  if (!document.body) return;
  var h = document.getElementById(HEADER_ID);
  if (!h) h = buildHeader();
  if (h.parentNode !== document.body) document.body.insertBefore(h, document.body.firstChild);
  var title = h.querySelector('.fbk-title');
  var want = (CFG.headerTitle || 'Friendbook') + (debugCache ? ' \u00b7 debug' : '');
  if (title && title.textContent !== want) title.textContent = want;
}

// ---------------------------------------------------------------------------------------
// Content hiding
// ---------------------------------------------------------------------------------------

function isOurs(el) {
  var h = document.getElementById(HEADER_ID);
  return h && (el === h || h.contains(el) || el.contains(h));
}

function hide(el, reason) {
  if (!el || el === document.body || el === document.documentElement) return;
  if (isOurs(el)) return;
  if (!el.hasAttribute(HIDDEN_ATTR)) el.setAttribute(HIDDEN_ATTR, reason);
}

/** Outermost feed unit containing el (or el itself). */
function unitOf(el) {
  if (!UNIT_SEL) return null;
  var unit = el.closest(UNIT_SEL);
  while (unit && unit.parentElement) {
    var outer = unit.parentElement.closest(UNIT_SEL);
    if (!outer) break;
    unit = outer;
  }
  return unit;
}

/**
 * For a section heading outside any feed unit: climb to the largest ancestor that
 * contains no feed units and not too much text.
 */
function blockFor(el) {
  var unit = unitOf(el);
  if (unit) return unit;
  var cur = el;
  for (var depth = 0; depth < 12; depth++) {
    var p = cur.parentElement;
    if (!p || p === document.body || p === document.documentElement) break;
    if (p.matches('[role="feed"],[role="main"],main')) break;
    if (UNIT_SEL && p.querySelector(UNIT_SEL)) break;
    if ((p.textContent || '').length > CLIMB_MAX_TEXT) break;
    cur = p;
  }
  return cur;
}

var unitMemo = new WeakMap();

/**
 * Does element `el` (with raw textContent `t`) read as a sponsored label?
 * 1. exact match on normalised textContent;
 * 2. label letters appear in order and the text is at most FUZZY_RATIO x longer
 *    (decoy letters interleaved into the label);
 * 3. exact match on innerText, which respects CSS and so drops decoys hidden with display:none.
 */
function sponsoredMatch(el, t) {
  var n = norm(t);
  if (!n) return false;
  for (var i = 0; i < SPONSORED.length; i++) {
    var lab = SPONSORED[i];
    if (n === lab) return true;
    if (!isSubsequence(lab, n)) continue;
    if (FUZZY_RATIO > 0 && n.length <= lab.length * FUZZY_RATIO) return true;
    if (norm(el.innerText) === lab) return true;
  }
  return false;
}

var SPONSORED_MAXLEN = 0;
SPONSORED.forEach(function (l) { SPONSORED_MAXLEN = Math.max(SPONSORED_MAXLEN, l.length * 4 + 20); });

function unitIsSponsored(unit) {
  var withLabel = unit.querySelectorAll('[aria-label]');
  for (var i = 0; i < withLabel.length; i++) {
    if (SPONSORED.indexOf(norm(withLabel[i].getAttribute('aria-label'))) >= 0) return true;
  }
  var cands = unit.querySelectorAll('a,span,b,strong');
  for (var j = 0; j < cands.length; j++) {
    var t = cands[j].textContent;
    if (!t || t.length > SPONSORED_MAXLEN) continue;
    if (sponsoredMatch(cands[j], t)) return true;
  }
  return false;
}

function hideSponsored() {
  if (!UNIT_SEL || !SPONSORED.length) return;
  var units = document.querySelectorAll(UNIT_SEL);
  for (var i = 0; i < units.length; i++) {
    var u = units[i];
    if (u.hasAttribute(HIDDEN_ATTR)) continue;
    var sig = (u.textContent || '').length + ':' + u.childElementCount;
    if (unitMemo.get(u) === sig) continue;
    unitMemo.set(u, sig);
    if (unitIsSponsored(u)) hide(unitOf(u) || u, 'sponsored');
  }
}

function hideSections(onFeed) {
  var wanted = onFeed ? SECTIONS.concat(FEED_ONLY) : SECTIONS;
  if (!wanted.length) return;
  var maxLen = 0;
  wanted.forEach(function (l) { maxLen = Math.max(maxLen, l.length + 20); });
  var cands = document.querySelectorAll(
    'h1,h2,h3,h4,h5,h6,[role="heading"],[role="button"],button,a,span,strong,[aria-label]'
  );
  for (var i = 0; i < cands.length; i++) {
    var el = cands[i];
    var aria = el.getAttribute('aria-label');
    var hitAria = aria && aria.length <= maxLen && wanted.indexOf(norm(aria)) >= 0;
    var hitText = false;
    if (!hitAria) {
      if ((el.tagName === 'DIV' && !el.hasAttribute('role')) || el.childElementCount > 4) continue;
      var t = el.textContent;
      if (!t || t.length > maxLen) continue;
      hitText = wanted.indexOf(norm(t)) >= 0;
    }
    if (!hitAria && !hitText) continue;
    if (el.closest('[' + HIDDEN_ATTR + ']') || isOurs(el)) continue;
    var label = norm(hitAria ? aria : el.textContent);
    hide(blockFor(el), 'section:' + label);
  }
}

function hideBySelector() {
  var groups = CFG.hideSelectors || {};
  Object.keys(groups).forEach(function (name) {
    if (name.charAt(0) === '_') return;
    list(groups[name]).forEach(function (sel) {
      var found;
      try { found = document.querySelectorAll(sel); } catch (e) { return; }
      for (var i = 0; i < found.length; i++) hide(found[i], 'selector:' + name);
    });
  });
}

/** Tag author names and timestamps inside feed units so theme.css can style them. */
function tagNamesAndTimes() {
  if (!UNIT_SEL) return;
  var units = document.querySelectorAll(UNIT_SEL);
  for (var i = 0; i < units.length; i++) {
    var u = units[i];
    if (u.hasAttribute(HIDDEN_ATTR)) continue;
    if (NAME_SEL) {
      var names;
      try { names = u.querySelectorAll(NAME_SEL); } catch (e) { names = []; }
      for (var j = 0; j < names.length; j++) {
        if (!names[j].hasAttribute('data-fbk-name')) names[j].setAttribute('data-fbk-name', '');
      }
    }
    if (TIME_RE) {
      var c = u.querySelectorAll('a,span,abbr,time');
      for (var k = 0; k < c.length; k++) {
        var el = c[k];
        if (el.hasAttribute('data-fbk-time') || el.childElementCount > 2) continue;
        var t = el.textContent;
        if (t && t.length <= 40 && TIME_RE.test(t.trim())) el.setAttribute('data-fbk-time', '');
      }
    }
  }
}

// ---------------------------------------------------------------------------------------
// Debug reporting
// ---------------------------------------------------------------------------------------

var lastHiddenReport = '';
var hiddenReportTimer = null;
var cssVarsReported = false;

function reportHidden() {
  if (!debugCache) return;
  if (hiddenReportTimer) clearTimeout(hiddenReportTimer);
  hiddenReportTimer = setTimeout(function () {
    hiddenReportTimer = null;
    var els = document.querySelectorAll('[' + HIDDEN_ATTR + ']');
    var by = {};
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getAttribute(HIDDEN_ATTR);
      by[r] = (by[r] || 0) + 1;
    }
    var line = els.length + ' on ' + location.pathname + location.search + ' ' + JSON.stringify(by);
    if (line !== lastHiddenReport) {
      lastHiddenReport = line;
      log('hidden', line);
    }
  }, 1000);
}

function collectCssVars() {
  var vars = {};
  var root = document.documentElement;
  if (!root) return vars;
  try {
    var cs = getComputedStyle(root);
    for (var i = 0; i < cs.length; i++) {
      var p = cs[i];
      if (p.indexOf('--') === 0) vars[p] = cs.getPropertyValue(p).trim();
    }
  } catch (e) {}
  // Also walk same-origin stylesheets for :root / theme-class rules.
  for (var s = 0; s < document.styleSheets.length; s++) {
    var sheet = document.styleSheets[s];
    if (sheet.disabled || (sheet.ownerNode && sheet.ownerNode.id === STYLE_ID)) continue;
    var rules;
    try { rules = sheet.cssRules; } catch (e) { continue; }
    if (!rules) continue;
    for (var r = 0; r < rules.length; r++) {
      var rule = rules[r];
      if (!rule.style || !rule.selectorText) continue;
      if (!/:root|__fb-|html/.test(rule.selectorText)) continue;
      for (var k = 0; k < rule.style.length; k++) {
        var name = rule.style[k];
        if (name.indexOf('--') === 0 && !(name in vars)) vars[name] = rule.style.getPropertyValue(name).trim();
      }
    }
  }
  return vars;
}

function reportCssVars() {
  if (!debugCache) return;
  cssVarsReported = true;
  // Sample with our sheet disabled so the log shows Facebook's own values.
  var ours = document.getElementById(STYLE_ID);
  var themed = {};
  var orig;
  if (ours) {
    var all = collectCssVars();
    ours.disabled = true;
    orig = collectCssVars();
    ours.disabled = false;
    Object.keys(all).forEach(function (n) { if (!(n in orig) || orig[n] !== all[n]) themed[n] = true; });
  } else {
    orig = collectCssVars();
  }
  var names = Object.keys(orig).sort();
  var colorish = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i;
  log('css-vars', names.length + ' custom properties defined by the page (* = overridden by theme.css, c = color)\n' +
    names.map(function (n) {
      return '  ' + (themed[n] ? '*' : ' ') + (colorish.test(orig[n]) ? 'c ' : '  ') + n + ': ' + orig[n];
    }).join('\n'));
}

// ---------------------------------------------------------------------------------------
// Main pass, observer, polling
// ---------------------------------------------------------------------------------------

var onFeedCache = null;
function onFeed() {
  if (onFeedCache === null || onFeedCache.url !== location.href) {
    var v = false;
    try { v = !!NATIVE.isFriendsFeed(location.href); } catch (e) {}
    onFeedCache = { url: location.href, value: v };
  }
  return onFeedCache.value;
}

var pass = safe(function () {
  ensureStyle();
  forceLight();
  ensureHeader();
  if (!document.body) return;
  hideBySelector();
  hideSponsored();
  hideSections(onFeed());
  tagNamesAndTimes();
  reportHidden();
});

var timer = null;
function schedule() {
  if (timer) return;
  timer = setTimeout(function () { timer = null; pass(); }, 150);
}

function onNavigated() {
  lastHiddenReport = '';
  schedule();
}

var observer = new MutationObserver(schedule);
function observe() {
  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
}
observe();

var lastDebug = debugCache;
setInterval(safe(function () {
  onUrlMaybeChanged('spa:poll');
  var d = isDebug();
  if (d !== lastDebug) {
    lastDebug = d;
    if (d) { lastHiddenReport = ''; reportCssVars(); }
    schedule();
  }
}), 500);

// Report scroll position so native pull-to-refresh only triggers at the top of the page.
var atTop = true;
window.addEventListener('scroll', function (e) {
  var t = e.target;
  var top;
  if (!t || t === document || t === document.documentElement || t === document.body) {
    top = (document.scrollingElement || document.documentElement).scrollTop;
  } else {
    top = t.scrollTop || 0;
  }
  var now = top <= 0;
  if (now !== atTop) {
    atTop = now;
    try { NATIVE.setAtTop(now); } catch (err) {}
  }
}, { capture: true, passive: true });

document.addEventListener('DOMContentLoaded', safe(function () { pass(); }));
window.addEventListener('load', safe(function () {
  pass();
  setTimeout(function () {
    if (!cssVarsReported && isDebug()) reportCssVars();
  }, 2000);
}));

// Document-start: check the initial URL and get the style in before first paint.
if (enforce(location.href, 'js:docstart')) {
  ensureStyle();
  forceLight();
  if (document.body) pass();
}
