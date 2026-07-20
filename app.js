/**
 * Family Dashboard — client
 *
 * Offline-first by design: the page renders from cache before it talks to the
 * network, and every write is applied locally first and queued for later. The
 * grocery store has no signal; the list still has to work there.
 */

// config.js is gitignored, so it can legitimately be missing on a fresh clone
// or a partial deploy. Without this fallback CONFIG is undefined, the first
// call that touches it throws, init() aborts before registering the service
// worker, and offline dies silently while the page still renders fine.
window.CONFIG = window.CONFIG || { endpoint: '', token: '' };

var CACHE_KEY = 'fd.cache';
var QUEUE_KEY = 'fd.queue';
var WHO_KEY = 'fd.who';
var TOKEN_KEY = 'fd.token';

var state = { shopping: [], todo: [], note: '', events: [], fetched: null };
var queue = [];
var who = localStorage.getItem(WHO_KEY) || '';

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; }
  catch (e) { return fallback; }
}
function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'x-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

/**
 * Everything is a POST with the token in the body. A token in the query string
 * ends up in server logs and Referer headers, which matters now that this
 * endpoint returns calendar contents. text/plain keeps it a "simple request"
 * so the browser skips the CORS preflight, which Apps Script cannot answer.
 */
function post(payload) {
  payload = payload || {};
  payload.token = CONFIG.token;
  return fetch(CONFIG.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  }).then(function (r) { return r.json(); });
}

/** Nothing can talk to the backend without both halves. */
function configured() {
  return !!(CONFIG.endpoint && CONFIG.token);
}

/**
 * A setup link carries the token (and optionally a name) exactly once. We stash
 * them on the device and strip them from the URL so the secret does not linger
 * in history, bookmarks, or a screenshot. The hosted page ships with no token,
 * so the public URL on its own reveals nothing and reaches nothing.
 */
function adoptSetupLink() {
  var params = new URLSearchParams(location.search);
  var dirty = false;

  var t = (params.get('token') || '').trim();
  if (t) { localStorage.setItem(TOKEN_KEY, t); dirty = true; }

  var w = (params.get('who') || '').trim();
  if (w) { who = w; localStorage.setItem(WHO_KEY, w); dirty = true; }

  var stored = localStorage.getItem(TOKEN_KEY);
  if (stored) CONFIG.token = stored;

  var shared = params.get('share');
  if (shared) dirty = true;

  if (dirty) history.replaceState({}, '', location.pathname);
  return shared;
}

/* ---------- writes ---------- */

function enqueue(op) {
  noteActivity();
  queue.push(op);
  save(QUEUE_KEY, queue);
  render();
  flush();
}

function addItem(list, text) {
  text = text.trim();
  if (!text) return;
  var id = uuid();
  state[list].push({ id: id, text: text, by: who, at: new Date().toISOString() });
  save(CACHE_KEY, state);
  announce(text + ' added');
  enqueue({ op: 'add', id: id, list: list, text: text, by: who });
}

/**
 * Crossing off is a single tap on a whole row, easy to hit by accident
 * one-handed in a shop. So a tap does not commit anything: the row greys out
 * and offers an inline Undo for a few seconds, and only then is it removed and
 * queued. Nothing reaches the server until the window closes, which means an
 * accidental tap costs no round trip and cannot race a sync.
 */
var UNDO_MS = 3000;
var pendingDone = {};                      // id -> { list, timer }

function startDone(list, item) {
  if (pendingDone[item.id]) return;
  pendingDone[item.id] = {
    list: list,
    timer: setTimeout(function () { commitDone(list, item.id); }, UNDO_MS)
  };
  announce(item.text + ' crossed off');
  render();
}

function cancelDone(id, text) {
  var p = pendingDone[id];
  if (!p) return;
  clearTimeout(p.timer);
  delete pendingDone[id];
  announce((text || 'Item') + ' restored');
  render();
}

function commitDone(list, id) {
  var p = pendingDone[id];
  if (p) { clearTimeout(p.timer); delete pendingDone[id]; }
  state[list] = state[list].filter(function (i) { return i.id !== id; });
  save(CACHE_KEY, state);
  enqueue({ op: 'done', id: id, done: true });
}

/** Backgrounding the app should not quietly drop a cross-off in its window. */
function commitAllPending() {
  Object.keys(pendingDone).forEach(function (id) {
    commitDone(pendingDone[id].list, id);
  });
}

function announce(msg) {
  var el = document.getElementById('live');
  if (el) el.textContent = msg;
}

/**
 * Sends the whole queue in one request. Ops carry client-generated IDs and the
 * server dedupes on them, so a flush that succeeds but whose response is lost
 * can be safely retried without double-adding.
 */
var flushing = false;
function flush() {
  if (flushing || !queue.length || !navigator.onLine || !configured()) return;
  flushing = true;
  var sending = queue.slice();

  post({ ops: sending })
    .then(function (res) {
      if (!res.ok) throw new Error(res.error);
      queue = queue.slice(sending.length);
      save(QUEUE_KEY, queue);
      // Only trust the server's snapshot once nothing local is still pending.
      // Ops queued while this request was in flight are not reflected in it,
      // so adopting unconditionally would visibly undo them.
      if (!queue.length) adopt(res.data);
    })
    .catch(function () { /* stays queued; retried on next trigger */ })
    .then(function () { flushing = false; render(); if (queue.length) setTimeout(flush, 5000); });
}

/* ---------- reads ---------- */

function adopt(data) {
  var before = signature();
  state.shopping = data.shopping || [];
  state.todo = data.todo || [];
  state.note = data.note || '';
  state.events = data.events || [];
  state.fetched = new Date().toISOString();
  // A change from the other device counts as activity: whoever is watching is
  // probably mid-conversation about it, so stay on the fast poll for a bit.
  if (signature() !== before) lastChange = Date.now();
  save(CACHE_KEY, state);
  render();
}

function signature() {
  return [state.shopping.map(function (i) { return i.id; }).join(','),
          state.todo.map(function (i) { return i.id; }).join(','),
          state.note].join('|');
}

var refreshing = false;

function refresh() {
  if (refreshing || !navigator.onLine || !configured()) return;
  refreshing = true;
  post({ action: 'data' })
    // Skip while writes are queued: the server has not seen them yet, so
    // adopting its state here would visibly undo what was just typed.
    .then(function (res) { if (res.ok && !queue.length) adopt(res.data); })
    .catch(function () {})
    .then(function () { refreshing = false; });
}

/* ---------- polling ---------- */

/**
 * There is no push channel — Apps Script cannot hold a socket — so seeing the
 * other person's changes means polling. Polling hard forever would be wasteful
 * on battery and on a shared Apps Script account, so the rate follows use:
 * quick while someone is actually looking at it, backing off as it sits idle,
 * and stopped entirely while the page is hidden.
 */
var POLL_ACTIVE = 8000;      // just interacted, or another device just changed something
var POLL_STEADY = 20000;     // open and being watched, but quiet
var POLL_IDLE = 60000;       // wall screen nobody has touched in a while

var lastActivity = Date.now();
var lastChange = Date.now();
var pollTimer = null;

function noteActivity() { lastActivity = Date.now(); }

function pollDelay() {
  var since = Date.now() - Math.max(lastActivity, lastChange);
  if (since < 2 * 60 * 1000) return POLL_ACTIVE;
  if (since < 15 * 60 * 1000) return POLL_STEADY;
  return POLL_IDLE;
}

function pollLoop() {
  clearTimeout(pollTimer);
  if (!document.hidden) {
    refresh();
    FEEDS.refreshIfStale(render);            // feeds own their own, much slower cadence
  }
  render();                                  // keeps the "2m ago" stamp honest
  pollTimer = setTimeout(pollLoop, document.hidden ? POLL_IDLE : pollDelay());
}

/* ---------- rendering ---------- */

function renderList(el, list, items) {
  el.innerHTML = '';
  if (!items.length) {
    var li = document.createElement('li');
    li.className = 'empty';
    li.textContent = list === 'shopping' ? 'Nothing needed' : 'Nothing pending';
    el.appendChild(li);
    return;
  }
  items.forEach(function (item) {
    var waiting = !!pendingDone[item.id];

    var li = document.createElement('li');
    if (waiting) li.className = 'going';

    var span = document.createElement('span');
    span.textContent = item.text;
    li.appendChild(span);

    if (waiting) {
      // Inline, in the row it belongs to — no separate strip to hunt for.
      var undo = document.createElement('button');
      undo.type = 'button';
      undo.className = 'undoInline';
      undo.textContent = 'Undo';
      undo.setAttribute('aria-label', 'Undo crossing off ' + item.text);
      undo.onclick = function (e) { e.stopPropagation(); cancelDone(item.id, item.text); };
      li.appendChild(undo);
    } else if (item.by && item.by !== who) {
      var meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = item.by;
      li.appendChild(meta);
    }

    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-label', waiting
      ? item.text + ' crossed off, undo available'
      : 'Cross off ' + item.text);

    function activate() {
      if (pendingDone[item.id]) cancelDone(item.id, item.text);
      else startDone(list, item);
    }
    li.onclick = activate;
    li.onkeydown = function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    };
    el.appendChild(li);
  });
}

/**
 * One agenda row. Whose it is shows in the shape of the rule, never colour —
 * e-ink hues are too muddy to carry meaning. Titles come from Google Calendar,
 * so they go in via textContent.
 */
function eventNode(ev) {
  var d = document.createElement('div');
  d.className = 'ev ' + (ev.who || 'him');

  var what = document.createElement('div');
  what.className = 'what';
  what.textContent = ev.what;
  d.appendChild(what);

  var when = document.createElement('div');
  when.className = 'when';
  when.textContent = ev.when;
  d.appendChild(when);
  return d;
}

function ago(iso) {
  if (!iso) return 'never';
  var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  var hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.round(hrs / 24) + 'd ago';
}

/**
 * The bottom bar is a single priority slot, not a stack of widgets. On a screen
 * you glance at, one loud thing beats four quiet ones.
 */
function barMessage(view) {
  if (state.note) return state.note;
  if (view.alert) return view.alert;
  if (view.countdown) return view.countdown.label + ' in ' + view.countdown.days + ' days';
  return view.hebrew || '';
}

function render() {
  var view = FEEDS.view();

  document.getElementById('day').textContent = view.day;
  document.getElementById('sub').textContent = view.sub;
  document.getElementById('temp').textContent = view.temp;
  document.getElementById('cond').textContent = view.cond;

  // Events come from the authenticated backend, not from FEEDS, so they live
  // in state alongside the lists and survive offline the same way.
  var events = state.events || [];
  var todayEvents = events.filter(function (e) { return e.day !== 'tomorrow'; });
  var tomorrowEvents = events.filter(function (e) { return e.day === 'tomorrow'; });

  var today = document.getElementById('today');
  today.innerHTML = '';
  if (!todayEvents.length) {
    var empty = document.createElement('div');
    empty.className = 'ahead';
    empty.textContent = state.fetched ? 'Nothing scheduled' : (view.eventsNote || '');
    today.appendChild(empty);
  }
  todayEvents.forEach(function (ev) { today.appendChild(eventNode(ev)); });

  // On Thursday the feed label already says "Tomorrow · Friday", which covers
  // both the events and the candle times. Any other day it says "This Shabbat",
  // which would be wrong above a list of tomorrow's appointments.
  document.getElementById('aheadLabel').textContent =
    (tomorrowEvents.length && view.dow !== 4) ? 'Tomorrow' : view.aheadLabel;

  var ahead = document.getElementById('ahead');
  ahead.innerHTML = '';
  tomorrowEvents.forEach(function (ev) { ahead.appendChild(eventNode(ev)); });

  // Built as nodes, not markup: everything below originates from a remote feed,
  // and textContent means it can never become HTML.
  var lines = view.aheadLines || [];
  if (lines.length) {
    var box = document.createElement('div');
    if (tomorrowEvents.length) box.style.marginTop = '10px';
    lines.forEach(function (line, i) {
      if (i) box.appendChild(document.createElement('br'));
      box.appendChild(document.createTextNode(line.label + ' '));
      var b = document.createElement('b');
      b.textContent = line.value;
      box.appendChild(b);
    });
    ahead.appendChild(box);
  }

  renderList(document.getElementById('shopping'), 'shopping', state.shopping);
  renderList(document.getElementById('todo'), 'todo', state.todo);

  var cd = document.getElementById('countdown');
  cd.innerHTML = '';
  if (view.countdown) {
    var d = view.countdown.days;
    var lead = document.createElement('b');
    lead.textContent = d === 0 ? 'Today' : (d === 1 ? 'Tomorrow' : d + ' days');
    cd.appendChild(lead);
    cd.appendChild(document.createTextNode(' — ' + view.countdown.label));
  }


  document.getElementById('barMsg').textContent = barMessage(view);

  // A dashboard that goes silently stale is worse than no dashboard.
  var stale = !state.fetched ||
    (Date.now() - new Date(state.fetched).getTime()) > 3 * 3600 * 1000;
  document.getElementById('bar').classList.toggle('stale', stale);
  document.getElementById('stamp').textContent =
    state.fetched ? ago(state.fetched)
                  : (configured() ? 'no data yet' : 'not set up on this device');

  document.getElementById('pending').textContent = queue.length
    ? queue.length + ' change' + (queue.length > 1 ? 's' : '') + ' waiting to sync'
    : '';
}

/* ---------- self-update ---------- */

/**
 * The service worker tells us when the shell on the server differs from the
 * cached copy. Reload to pick it up, but never yank the page out from under
 * someone who is mid-sentence — defer until they stop typing or come back to
 * the tab. Queued writes survive a reload (they live in localStorage), so a
 * pending queue is not a reason to wait.
 */
var pendingReload = false;

function busyTyping() {
  var el = document.activeElement;
  return !!(el && el.classList && el.classList.contains('add') && el.value.trim());
}

var reloadTimer = null;

function maybeReload() {
  if (!pendingReload || flushing || busyTyping() || reloadTimer) return;
  // Guard against a server that always looks new: at most one reload per 10s.
  var last = Number(sessionStorage.getItem('fd.reloadedAt') || 0);
  if (Date.now() - last < 10000) return;

  // Settle first. Shell files revalidate concurrently, so the notification for
  // one can arrive while another is still being written to the cache; reloading
  // instantly can pick up the old copy again and then be blocked by the guard
  // above, leaving the page one version behind.
  reloadTimer = setTimeout(function () {
    reloadTimer = null;
    if (busyTyping() || flushing) return;
    sessionStorage.setItem('fd.reloadedAt', String(Date.now()));
    location.reload();
  }, 700);
}

function watchForUpdates() {
  if (!('serviceWorker' in navigator)) return;

  // Two independent triggers, because a deploy can look like either one:
  //   1. sw.js itself changed -> a new worker installs and takes over. The
  //      shell is refreshed on install, so nothing differs by the time the
  //      revalidation runs; the takeover is the only signal.
  //   2. only page files changed -> the same worker keeps running and the
  //      background revalidation is what notices.
  var hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!hadController) return;   // first ever install: page is already current
    pendingReload = true;
    maybeReload();
  });

  navigator.serviceWorker.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'shell-updated') {
      pendingReload = true;
      maybeReload();
    }
  });
}

/* ---------- wiring ---------- */

function hookAdd(inputId, btnId, list) {
  var input = document.getElementById(inputId);
  var btn = document.getElementById(btnId);

  function syncBtn() { btn.disabled = !input.value.trim(); }

  function submit() {
    if (!input.value.trim()) { input.focus(); return; }
    addItem(list, input.value);
    input.value = '';
    syncBtn();
    input.focus();          // adding several things in a row is the common case
  }

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  input.addEventListener('input', syncBtn);
  btn.addEventListener('click', submit);
  syncBtn();
}

function init() {
  state = load(CACHE_KEY, state);
  queue = load(QUEUE_KEY, []);

  var shared = adoptSetupLink();

  hookAdd('addShopping', 'addShoppingBtn', 'shopping');
  hookAdd('addTodo', 'addTodoBtn', 'todo');

  // Register first. Offline support is the one thing that must survive a fault
  // anywhere else in init — previously this ran last, so a single throw above
  // it silently cost the whole service worker.
  if ('serviceWorker' in navigator) {
    try {
      navigator.serviceWorker.register('sw.js');
      watchForUpdates();
    } catch (e) { /* offline support unavailable; the app still works online */ }
  }

  render();
  refresh();
  flush();

  window.addEventListener('online', function () { flush(); refresh(); });

  // Coming back to the page should feel instant, not "wait for the next tick".
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { commitAllPending(); return; }
    noteActivity();
    flush();
    maybeReload();
    pollLoop();
  });
  window.addEventListener('focus', function () { noteActivity(); pollLoop(); });

  // Typing or scrolling means someone is looking: poll fast again.
  ['pointerdown', 'keydown'].forEach(function (evt) {
    document.addEventListener(evt, noteActivity, { passive: true });
  });

  document.addEventListener('blur', maybeReload, true);
  pollLoop();

  // Android share target lands here with ?share=<text>
  if (shared) addItem('shopping', shared);
}

init();
