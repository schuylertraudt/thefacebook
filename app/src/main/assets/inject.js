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
  // Debug review: content hides (sponsored, sections) are shown faded and outlined.
  // Structural hides (layout:, selector:) stay hidden: showing them reflows the page
  // (a hidden side column would squeeze the feed again).
  'html[data-fbk-debug] [' + HIDDEN_ATTR + ']:not([' + HIDDEN_ATTR + '^="layout:"]):not([' + HIDDEN_ATTR + '^="selector:"]){display:revert!important;opacity:.35!important;' +
  'outline:2px dashed #c00!important;outline-offset:-2px}' +
  'html[data-fbk-debug] [' + HIDDEN_ATTR + ']:not([' + HIDDEN_ATTR + '^="layout:"]):not([' + HIDDEN_ATTR + '^="selector:"])::before{content:"hidden: " attr(' + HIDDEN_ATTR + ');' +
  'display:block;background:#c00;color:#fff;font:bold 10px monospace;padding:1px 4px}';

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
  // Also drops invisible joiners Facebook mixes into labels (U+034F after every letter).
  return (s || '').replace(/[\s\u00a0\u00ad\u034f\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff\ufe00-\ufe0f]+/g, '').toLowerCase();
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
var labels_raw = labels;
var SPONSORED = list(labels.sponsored).map(norm).filter(Boolean);
var AD_CTA = list(CFG.adCtaLabels).map(norm).filter(Boolean);
var SECTIONS = list(labels.sections).map(norm).filter(Boolean);
var FEED_ONLY = list(labels.feedOnly).map(norm).filter(Boolean);
var AUTO_UNIT_ATTR = 'data-fbk-unit';
var UNIT_SEL = list(CFG.feedUnitSelectors).concat(CFG.autoFeedUnits === false ? [] : ['[' + AUTO_UNIT_ATTR + ']']).join(',');
var NAME_SEL = list(CFG.nameSelectors).join(',');
var FUZZY_RATIO = +CFG.sponsoredFuzzyRatio || 0;
var FUZZY_MIN_LEN = +CFG.sponsoredFuzzyMinLength || 5;
var HEADER_PX = +CFG.sponsoredHeaderPx || 0;
var CLIMB_MAX_TEXT = +CFG.sectionClimbMaxText || 2500;
var TIME_RE = null;
try { if (CFG.timestampPattern) TIME_RE = new RegExp(CFG.timestampPattern, 'i'); } catch (e) {}

// ---------------------------------------------------------------------------------------
// URL filtering (SPA side). Native code handles full navigations.
// ---------------------------------------------------------------------------------------

var DOC_URL = location.href; // address this document was loaded at
var lastUrl = location.href;
var redirecting = false;

/** Returns false if the URL is blocked (and a redirect to the feed has been started). */
function enforce(url, source) {
  if (redirecting) return false;
  var verdict = 'allow';
  try {
    verdict = source === 'spa:replaceState' && typeof NATIVE.checkReplace === 'function'
      ? NATIVE.checkReplace(url, DOC_URL)
      : NATIVE.checkUrl(url, source);
  } catch (e) {}
  if (verdict === 'block') {
    redirecting = true;
    var target = FEED_URL;
    try { target = NATIVE.redirectTarget() || FEED_URL; } catch (e) {}
    location.replace(target);
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
  if (url === '@friendsFeedUrl') return FEED_URL;
  // Relative links resolve against the current host, so they work on m. and www.
  try { return new URL(url, location.href).href; } catch (e) { return url; }
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

/**
 * Never hide the page itself: refuse elements that contain the main region / feed, or most
 * of the page's text. A broad label or selector match then degrades to "not hidden"
 * instead of a blank screen.
 */
function tooBigToHide(el) {
  if (el.querySelector('[role="main"],[role="feed"],main')) return true;
  if (el.matches('[role="main"],[role="feed"],main')) return true;
  var header = document.getElementById(HEADER_ID);
  var total = (document.body.textContent || '').length - (header ? (header.textContent || '').length : 0);
  return total > 0 && (el.textContent || '').length > total * 0.6;
}

var refusedLogged = typeof WeakSet === 'function' ? new WeakSet() : null;

function hide(el, reason) {
  if (!el || el === document.body || el === document.documentElement) return;
  if (isOurs(el)) return;
  if (el.hasAttribute(HIDDEN_ATTR)) return;
  if (tooBigToHide(el)) {
    if (refusedLogged && !refusedLogged.has(el)) {
      refusedLogged.add(el);
      log('hide-refused', reason + ' matched <' + el.tagName.toLowerCase() +
        (el.id ? '#' + el.id : '') + '> containing the main page; not hidden');
    }
    return;
  }
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
  var FORM = 'input,textarea,select,[contenteditable="true"]';
  var curHasForm = !!cur.querySelector(FORM);
  var maxHeight = (window.innerHeight || 800) * 0.6;
  for (var depth = 0; depth < 12; depth++) {
    var p = cur.parentElement;
    if (!p || p === document.body || p === document.documentElement) break;
    if (p.matches('[role="feed"],[role="main"],main')) break;
    if (UNIT_SEL && p.querySelector(UNIT_SEL)) break;
    if ((p.textContent || '').length > CLIMB_MAX_TEXT) break;
    // Don't swallow forms (login, composer) or anything most of a screen tall.
    if (!curHasForm && p.querySelector(FORM)) break;
    if (p.getBoundingClientRect().height > maxHeight) break;
    cur = p;
  }
  return cur;
}

var unitMemo = new WeakMap();

/**
 * Text of el as a person sees it: characters in elements that are displayed, not
 * transparent / zero-size / clipped away, and sitting on el's own line. Facebook hides
 * decoy letters inside labels ("A<hidden x>d") with all of these tricks.
 */
function visibleText(el) {
  var box = el.getBoundingClientRect();
  if (!box.width || !box.height) return '';
  var out = '';
  var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  for (var n = walker.nextNode(); n; n = walker.nextNode()) {
    var p = n.parentElement;
    if (!p || !n.nodeValue.trim()) continue;
    var cs = getComputedStyle(p);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') continue;
    if (parseFloat(cs.opacity) === 0 || parseFloat(cs.fontSize) === 0) continue;
    if (cs.color === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(cs.color)) continue;
    var hidden = false;
    for (var q = p; q && q !== el.parentElement; q = q.parentElement) {
      var qs = q === p ? cs : getComputedStyle(q);
      if (qs.display === 'none' || parseFloat(qs.opacity) === 0 || qs.visibility === 'hidden') { hidden = true; break; }
    }
    if (hidden) continue;
    var range = document.createRange();
    range.selectNodeContents(n);
    var r = range.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    // Off the label's line (absolutely positioned decoys) or outside its box.
    if (r.bottom <= box.top + 1 || r.top >= box.bottom - 1 || r.right <= box.left || r.left >= box.right) continue;
    out += n.nodeValue;
  }
  return out;
}

/**
 * Does element `el` (with raw textContent `t`) read as a sponsored label?
 * 1. exact match on normalised textContent;
 * 2. exact match on the visible text (decoy letters removed);
 * 3. labels of sponsoredFuzzyMinLength+ letters: label letters appear in order and the
 *    text is at most FUZZY_RATIO x longer.
 */
function sponsoredMatch(el, t) {
  var n = norm(t);
  if (!n) return false;
  var vis = null;
  for (var i = 0; i < SPONSORED.length; i++) {
    var lab = SPONSORED[i];
    if (n === lab) return true;
    if (!isSubsequence(lab, n)) continue;
    if (vis === null) vis = norm(visibleText(el));
    if (vis === lab) return true;
    if (lab.length >= FUZZY_MIN_LEN && FUZZY_RATIO > 0 && n.length <= lab.length * FUZZY_RATIO) return true;
  }
  return false;
}

var SPONSORED_MAXLEN = 0;
SPONSORED.forEach(function (l) { SPONSORED_MAXLEN = Math.max(SPONSORED_MAXLEN, l.length * 4 + 20); });

/** Is el within the header strip (top sponsoredHeaderPx px) of the unit? */
function inHeader(el, unitTop) {
  if (!(HEADER_PX > 0)) return true;
  var r = el.getBoundingClientRect();
  if (!r.width && !r.height) return true; // not laid out (hidden decoy / lazy): don't exclude
  return r.top - unitTop <= HEADER_PX;
}

function unitIsSponsored(unit) {
  var unitTop = unit.getBoundingClientRect().top;
  var withLabel = unit.querySelectorAll('[aria-label]');
  for (var i = 0; i < withLabel.length; i++) {
    if (SPONSORED.indexOf(norm(withLabel[i].getAttribute('aria-label'))) >= 0 &&
        inHeader(withLabel[i], unitTop)) return true;
  }
  // Labels attached by reference: <a aria-labelledby="id">, text lives in #id (maybe elsewhere).
  var byRef = unit.querySelectorAll('[aria-labelledby]');
  for (var r = 0; r < byRef.length; r++) {
    var ids = (byRef[r].getAttribute('aria-labelledby') || '').split(/\s+/);
    for (var q = 0; q < ids.length; q++) {
      var ref = ids[q] && document.getElementById(ids[q]);
      if (ref && SPONSORED.indexOf(norm(ref.textContent)) >= 0 && inHeader(byRef[r], unitTop)) return true;
    }
  }
  // Labels drawn as SVG: <use href="#SvgX"> renders an element (usually <text>) stored
  // elsewhere in the page; compare that element's text.
  var uses = unit.querySelectorAll('use');
  for (var u = 0; u < uses.length; u++) {
    var refText = useText(uses[u]);
    if (refText !== null && inHeader(uses[u], unitTop) && labelEquals(refText)) return true;
  }
  var cands = unit.querySelectorAll('a,span,b,strong');
  for (var j = 0; j < cands.length; j++) {
    var t = cands[j].textContent;
    if (!t || t.length > SPONSORED_MAXLEN) continue;
    if (sponsoredMatch(cands[j], t) && inHeader(cands[j], unitTop)) return true;
  }
  return false;
}

/** Text of the element an SVG <use> points at, or null. */
function useText(use) {
  var href = use.getAttribute('href') || use.getAttribute('xlink:href') ||
    use.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
  if (href.charAt(0) !== '#') return null;
  var ref = document.getElementById(href.slice(1));
  return ref ? (ref.textContent || '') : null;
}

/** Exact label match; labels of sponsoredFuzzyMinLength+ letters may also match with decoys. */
function labelEquals(text) {
  var n = norm(text);
  if (!n) return false;
  for (var i = 0; i < SPONSORED.length; i++) {
    var lab = SPONSORED[i];
    if (n === lab) return true;
    if (lab.length >= FUZZY_MIN_LEN && FUZZY_RATIO > 0 && n.length <= lab.length * FUZZY_RATIO &&
        isSubsequence(lab, n)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------
// Side columns: any element beside the feed (no horizontal overlap with the feed's
// ancestor at that level) is hidden, so the feed gets the full width.
// ---------------------------------------------------------------------------------------

/** Parent of the configured feed-unit selectors' units if any are visible, else the auto container. */
function feedAnchor() {
  var sels = list(CFG.feedUnitSelectors);
  for (var i = 0; i < sels.length; i++) {
    var found;
    try { found = document.querySelectorAll(sels[i]); } catch (e) { continue; }
    for (var j = 0; j < found.length; j++) {
      var u = unitOf(found[j]) || found[j];
      var r = u.getBoundingClientRect();
      if (r.width > 50 && r.height > 50 && u.parentElement) return u.parentElement;
    }
  }
  if (autoContainer && autoContainer.isConnected) return autoContainer;
  return null;
}

var lastAnchor = null;

function hideSideColumns() {
  if (!CFG.hideSideColumns) return;
  var anchor = feedAnchor();
  if (!anchor) return;
  // Let the feed and every wrapper above it take the full width (see theme.css).
  if (anchor !== lastAnchor) {
    var stale = document.querySelectorAll('[data-fbk-feedpath]');
    for (var x = 0; x < stale.length; x++) stale[x].removeAttribute('data-fbk-feedpath');
    lastAnchor = anchor;
  }
  for (var w = anchor; w && w !== document.body; w = w.parentElement) {
    if (!w.hasAttribute('data-fbk-feedpath')) w.setAttribute('data-fbk-feedpath', '');
  }
  for (var a = anchor; a && a.parentElement && a !== document.body; a = a.parentElement) {
    var ar = a.getBoundingClientRect();
    if (!ar.width) continue;
    for (var s = a.parentElement.firstElementChild; s; s = s.nextElementSibling) {
      if (s === a || s.id === HEADER_ID || s.id === STYLE_ID || s.hasAttribute(HIDDEN_ATTR)) continue;
      if (/^(SCRIPT|STYLE|LINK|META)$/.test(s.tagName)) continue;
      var sr = s.getBoundingClientRect();
      if (!sr.width || !sr.height) continue;
      var beside = sr.right <= ar.left + 4 || sr.left >= ar.right - 4;
      var overlapsVertically = sr.bottom > ar.top && sr.top < ar.bottom;
      if (beside && overlapsVertically) hide(s, 'layout:side-column');
    }
  }
}

// ---------------------------------------------------------------------------------------
// Automatic feed-unit detection: the element with the most "post-like" children (text +
// media) is the feed list; its children are marked as units. Works without knowing
// Facebook's markup, so label-based hiding applies to every post.
// ---------------------------------------------------------------------------------------

var autoContainer = null;
var autoCheckedAt = 0;

function postLike(child) {
  if (child.id === HEADER_ID) return false;
  var r = child.getBoundingClientRect();
  if (r.width < 100 || r.height < 20) return false; // invisible lists (e.g. hidden chat list)
  var t = child.textContent;
  if (!t || t.length < 60) return false;
  return !!child.querySelector('img,video,svg image,[style*="background-image"]');
}

function findFeedContainer() {
  var best = null, bestScore = 2;
  var cands = document.body.querySelectorAll('div,section,main,ul,article');
  for (var i = 0; i < cands.length; i++) {
    var c = cands[i];
    if (c.childElementCount < 4) continue;
    if (c.closest('[role="grid"],[role="navigation"],[role="complementary"],[role="dialog"]')) continue;
    var score = 0;
    for (var k = c.firstElementChild; k; k = k.nextElementSibling) if (postLike(k)) score++;
    // ">=": on ties prefer the later (deeper) element, i.e. the actual list, not a wrapper.
    if (score >= bestScore) { best = c; bestScore = score; }
  }
  return best;
}

function autoMarkUnits() {
  if (CFG.autoFeedUnits === false || !document.body) return;
  var now = Date.now();
  if (!autoContainer || !autoContainer.isConnected || now - autoCheckedAt > 5000) {
    autoCheckedAt = now;
    var c = findFeedContainer();
    if (c !== autoContainer) {
      autoContainer = c;
      if (c) log('feed-units', 'auto container: ' + describe(c));
    }
  }
  if (!autoContainer) return;
  for (var k = autoContainer.firstElementChild; k; k = k.nextElementSibling) {
    if (!k.hasAttribute(AUTO_UNIT_ATTR) && postLike(k)) k.setAttribute(AUTO_UNIT_ATTR, '');
  }
}

// ---------------------------------------------------------------------------------------
// Fonts: our font stack replaces Facebook's on every element. Facebook draws icons as
// private-use characters of its own web font, so the page's web fonts are appended as
// per-glyph fallbacks (--fbk-page-fonts, used in theme.css).
// ---------------------------------------------------------------------------------------

var pageFonts = '';
function updatePageFonts() {
  if (!document.fonts || !document.documentElement) return;
  var fams = {};
  try {
    document.fonts.forEach(function (f) {
      var n = (f.family || '').replace(/^["']|["']$/g, '').trim();
      if (n) fams[n] = 1;
    });
  } catch (e) { return; }
  var names = Object.keys(fams).sort();
  var css = names.map(function (n) { return '"' + n.replace(/["\\]/g, '') + '"'; }).join(', ');
  if (css && css !== pageFonts) {
    pageFonts = css;
    document.documentElement.style.setProperty('--fbk-page-fonts', css);
    log('fonts', 'page web fonts used as glyph fallbacks: ' + names.join(', '));
  }
}
if (document.fonts && document.fonts.addEventListener) {
  document.fonts.addEventListener('loadingdone', safe(updatePageFonts));
}

// ---------------------------------------------------------------------------------------
// Desktop site: render the desktop layout at a fixed CSS width, scaled to the screen.
// ---------------------------------------------------------------------------------------

function ensureViewport() {
  var desktop = false;
  try { desktop = !!NATIVE.isDesktop(); } catch (e) {}
  if (!desktop || !document.head) return;
  var w = +CFG.desktopViewportWidth || 600;
  var want = 'width=' + w;
  var metas = document.head.querySelectorAll('meta[name="viewport"]');
  var ours = document.getElementById('friendbook-viewport');
  for (var i = 0; i < metas.length; i++) if (metas[i] !== ours) metas[i].remove();
  if (!ours) {
    ours = document.createElement('meta');
    ours.id = 'friendbook-viewport';
    ours.name = 'viewport';
    document.head.appendChild(ours);
  }
  if (ours.content !== want) ours.content = want;
}

/**
 * Ad call-to-action buttons ("Learn more", "Shop now"...) anywhere in a unit. Facebook draws
 * the "Ad" label itself as SVG shapes with no text, but these buttons are plain text and
 * appear only on ads.
 */
function unitAdCta(unit) {
  if (!AD_CTA.length) return null;
  var els = unit.querySelectorAll('[role="button"],[role="link"],a,button');
  for (var i = 0; i < els.length; i++) {
    var t = els[i].textContent;
    if (!t || t.length > 40) continue;
    var n = norm(t);
    if (AD_CTA.indexOf(n) >= 0) return n;
    var al = els[i].getAttribute('aria-label');
    if (al && al.length <= 40 && AD_CTA.indexOf(norm(al)) >= 0) return norm(al);
  }
  return null;
}

function hideSponsored() {
  if (!UNIT_SEL || (!SPONSORED.length && !AD_CTA.length)) return;
  var units = document.querySelectorAll(UNIT_SEL);
  for (var i = 0; i < units.length; i++) {
    var u = units[i];
    if (u.hasAttribute(HIDDEN_ATTR)) continue;
    var sig = (u.textContent || '').length + ':' + u.childElementCount;
    if (unitMemo.get(u) === sig) continue;
    unitMemo.set(u, sig);
    if (SPONSORED.length && unitIsSponsored(u)) { hide(unitOf(u) || u, 'sponsored'); continue; }
    var cta = unitAdCta(u);
    if (cta) hide(unitOf(u) || u, 'ad-cta:' + cta);
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
  var todo = names.filter(function (n) { return !themed[n] && colorish.test(orig[n]); });
  log('css-vars', names.length + ' custom properties on the page, ' + Object.keys(themed).length +
    ' overridden by theme.css, ' + todo.length + ' color variables not themed' +
    (todo.length ? ' (first 40):\n' + todo.slice(0, 40).map(function (n) { return '  ' + n + ': ' + orig[n]; }).join('\n') : ''));
}

// ---------------------------------------------------------------------------------------
// Page structure dump (debug panel "Dump page"): enough of the DOM around feed units,
// labels and fixed bars to write selectors for rules.json.
// ---------------------------------------------------------------------------------------

var DESCRIBE_ATTRS = ['role', 'aria-label', 'data-pagelet', 'data-mcomponent', 'data-type',
  'data-tracking-duration-id', 'data-sigil', 'data-store', 'data-focusable', AUTO_UNIT_ATTR, HIDDEN_ATTR];

function describe(el) {
  if (!el || !el.tagName) return String(el);
  var s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  var others = [];
  for (var i = 0; i < el.attributes.length; i++) {
    var a = el.attributes[i];
    if (DESCRIBE_ATTRS.indexOf(a.name) >= 0) {
      s += '[' + a.name + (a.value ? '=' + JSON.stringify(a.value.slice(0, 40)) : '') + ']';
    } else if (a.name.indexOf('data-') === 0 || a.name.indexOf('aria-') === 0) {
      others.push(a.name);
    }
  }
  if (others.length) s += ' {' + others.join(' ') + '}';
  var cls = (el.getAttribute('class') || '').trim();
  if (cls) s += ' .' + cls.split(/\s+/).length + 'cls';
  try {
    var cs = getComputedStyle(el);
    if (cs.position === 'fixed' || cs.position === 'sticky') s += ' pos=' + cs.position;
    if (cs.fontFamily && el.childElementCount === 0) s += ' font=' + cs.fontFamily.slice(0, 40);
  } catch (e) {}
  var r = el.getBoundingClientRect();
  s += ' kids=' + el.childElementCount + ' ' + Math.round(r.width) + 'x' + Math.round(r.height);
  var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (t) s += ' "' + t.slice(0, 50) + (t.length > 50 ? '\u2026' : '') + '"(' + t.length + ')';
  return s;
}

function ancestry(el, max) {
  var lines = [];
  for (var cur = el, d = 0; cur && cur !== document.documentElement && d < (max || 30); cur = cur.parentElement, d++) {
    lines.push('    ' + d + ' ' + describe(cur));
  }
  return lines.join('\n');
}

function tree(el, depth, indent) {
  var out = indent + describe(el);
  if (depth <= 0) return out;
  var n = 0;
  for (var k = el.firstElementChild; k && n < 12; k = k.nextElementSibling, n++) {
    out += '\n' + tree(k, depth - 1, indent + '  ');
  }
  if (el.childElementCount > 12) out += '\n' + indent + '  \u2026 ' + (el.childElementCount - 12) + ' more';
  return out;
}

function findLabel(label) {
  var want = norm(label);
  var found = [];
  var els = document.body.querySelectorAll('span,div,a,h1,h2,h3,h4,strong,b,button,[aria-label]');
  for (var i = 0; i < els.length && found.length < 2; i++) {
    var el = els[i];
    var aria = el.getAttribute('aria-label');
    if (aria && norm(aria) === want) { found.push(el); continue; }
    if (el.childElementCount > 3) continue;
    var t = el.textContent;
    if (t && t.length <= label.length + 12 && norm(t) === want) found.push(el);
  }
  return found;
}

function dumpPage() {
  if (!document.body) return;
  var out = [];
  out.push('==== page dump ' + location.href);
  out.push('viewport ' + innerWidth + 'x' + innerHeight + ' debug=' + debugCache);
  list(CFG.feedUnitSelectors).concat(['[' + AUTO_UNIT_ATTR + ']']).forEach(function (sel) {
    var c = 0; try { c = document.querySelectorAll(sel).length; } catch (e) {}
    out.push('selector ' + sel + ' -> ' + c);
  });
  autoCheckedAt = 0;
  autoMarkUnits();
  out.push('auto container: ' + (autoContainer ? describe(autoContainer) : 'none'));
  var anchor = feedAnchor();
  if (anchor) out.push('feed anchor ancestry:\n' + ancestry(anchor, 14));
  // Outermost units, first 4: every element in the header strip with its visible text.
  var units = [].slice.call(UNIT_SEL ? document.querySelectorAll(UNIT_SEL) : []).filter(function (u) {
    return unitOf(u) === u;
  });
  out.push('outer units: ' + units.length);
  units.slice(0, 4).forEach(function (u, i) {
    out.push('-- unit ' + i + ': ' + describe(u).slice(0, 200));
    var top = u.getBoundingClientRect().top;
    // Visible text pieces in the header strip, in reading order, with their element.
    var pieces = [];
    var seen = {};
    var walker = document.createTreeWalker(u, NodeFilter.SHOW_TEXT, null);
    for (var n = walker.nextNode(); n && pieces.length < 30; n = walker.nextNode()) {
      var t = n.nodeValue.trim();
      if (!t) continue;
      var range = document.createRange();
      range.selectNodeContents(n);
      var r = range.getBoundingClientRect();
      if (!r.width || !r.height || r.top - top > 170) continue;
      var pe = n.parentElement;
      var cs = getComputedStyle(pe);
      var flags = (cs.display === 'none' ? ' display:none' : '') + (parseFloat(cs.opacity) === 0 ? ' opacity:0' : '') +
        (cs.position === 'absolute' ? ' abs' : '') + (cs.overflow !== 'visible' ? ' ovf:' + cs.overflow : '') +
        (cs.clipPath && cs.clipPath !== 'none' ? ' clip' : '');
      var key = t + '|' + Math.round(r.top - top);
      if (seen[key] || t === 'Facebook') { seen[key] = (seen[key] || 0) + 1; continue; }
      seen[key] = 1;
      pieces.push('   ' + JSON.stringify(t.slice(0, 40)) + ' @' + Math.round(r.left) + ',' + Math.round(r.top - top) +
        ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + flags + ' in ' + describe(pe).slice(0, 120));
    }
    var fb = 0;
    Object.keys(seen).forEach(function (k) { if (k.indexOf('Facebook|') === 0) fb += seen[k]; });
    out.push('  header text pieces (' + fb + ' "Facebook" decoys skipped):\n' + pieces.join('\n'));
    // Non-text labels: aria-label(ledby), svg text/use, ::before/::after content.
    var extra = [];
    var els = u.querySelectorAll('[aria-label],[aria-labelledby],svg text,use,a,span');
    for (var k = 0; k < els.length && extra.length < 12; k++) {
      var el = els[k];
      var er = el.getBoundingClientRect();
      if (er.top - top > 170 || (!er.width && !er.height)) continue;
      var bits = [];
      var al = el.getAttribute('aria-label');
      if (al) bits.push('aria-label=' + JSON.stringify(al.slice(0, 40)));
      var lb = el.getAttribute('aria-labelledby');
      if (lb) bits.push('labelledby=' + lb.split(/\s+/).map(function (id) {
        var e = document.getElementById(id); return e ? JSON.stringify((e.textContent || '').slice(0, 30)) : '?';
      }).join(','));
      if (el.tagName === 'text') bits.push('svg-text=' + JSON.stringify(el.textContent.slice(0, 30)));
      if (el.tagName === 'use') {
        var href = el.getAttribute('href') || el.getAttribute('xlink:href') || '';
        var ref = href.charAt(0) === '#' ? document.getElementById(href.slice(1)) : null;
        var bb = '';
        try { var b = el.getBBox(); bb = ' bbox=' + Math.round(b.width) + 'x' + Math.round(b.height); } catch (e) {}
        bits.push('use=' + href + bb + ' -> ' + (ref
          ? '<' + ref.tagName + ' kids=' + ref.childElementCount + '> text=' + JSON.stringify((ref.textContent || '').slice(0, 30)) +
            ' html=' + JSON.stringify(ref.outerHTML.replace(/\s+/g, ' ').slice(0, 260))
          : '(not found)'));
      }
      ['::before', '::after'].forEach(function (pse) {
        var c = getComputedStyle(el, pse).content;
        if (c && c !== 'none' && c !== 'normal' && c !== '""') bits.push(pse + '=' + c.slice(0, 30));
      });
      if (bits.length) extra.push('   ' + bits.join(' ') + ' on ' + describe(el).slice(0, 100));
    }
    if (extra.length) out.push('  non-text labels:\n' + extra.join('\n'));
    var btns = [];
    var bs = u.querySelectorAll('[role="button"],button,[role="link"]');
    for (var bi = 0; bi < bs.length && btns.length < 25; bi++) {
      var bt = (bs[bi].textContent || '').trim() || bs[bi].getAttribute('aria-label') || '';
      if (bt && bt.length <= 40 && btns.indexOf(bt) < 0) btns.push(bt);
    }
    out.push('  buttons/links: ' + JSON.stringify(btns));
  });
  // What forces the page wide?
  var wide = [];
  var everything = document.body.getElementsByTagName('*');
  for (var w = 0; w < everything.length && wide.length < 6; w++) {
    var mw = parseFloat(getComputedStyle(everything[w]).minWidth);
    if (mw >= 500) wide.push('  min-width ' + mw + 'px on ' + describe(everything[w]).slice(0, 120));
  }
  out.push('layout: innerWidth=' + innerWidth + ' scrollWidth=' + document.documentElement.scrollWidth +
    '\n' + (wide.join('\n') || '  no min-width >= 500px'));
  var fixed = [];
  var all = document.body.getElementsByTagName('*');
  for (var j = 0; j < all.length && fixed.length < 8; j++) {
    var p = getComputedStyle(all[j]).position;
    if (p === 'fixed' || p === 'sticky') fixed.push('  ' + describe(all[j]).slice(0, 160));
  }
  out.push('fixed/sticky:\n' + (fixed.join('\n') || '  none'));
  out.push('==== end of dump');
  var text = out.join('\n');
  try { NATIVE.setDump(text); } catch (e) {}
  log('dump', text);
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
  updatePageFonts();
  ensureViewport();
  if (!document.body) return;
  autoMarkUnits();
  hideSideColumns();
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
  var cmd = '';
  try { cmd = NATIVE.takeCommand ? NATIVE.takeCommand() : ''; } catch (e) {}
  if (cmd === 'dump') dumpPage();
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
