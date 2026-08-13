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
var THEME_KEY = 'fd.theme';
var EMOJI_KEY = 'fd.emoji';
var AWAKE_KEY = 'fd.awake';
var BOARD_OK_KEY = 'fd.boardok';
var THEMES = ['paper', 'pastel', 'jewel', 'almanac'];

var state = { shopping: [], todo: [], note: '', events: [], chores: [], board: [], fetched: null };
var queue = [];
var who = localStorage.getItem(WHO_KEY) || '';

/**
 * Whether this device may see the board. The server decides this on every
 * single request and independently refuses board rows and board ops to any
 * device outside its allowlist, so this flag is only the UI affordance, never
 * the security boundary.
 *
 * It is remembered per device (same shape as fd.who / fd.theme / fd.awake) so
 * the icon is present offline and on the very first paint, before any response
 * arrives. Without that, the board would be unreachable offline even though its
 * rows sit in the local cache and board.js is in the service-worker shell —
 * which would defeat the offline-first design. A device whose access has been
 * revoked shows the icon exactly once more, gets nothing back, and clears the
 * flag. The kitchen tablet never receives boardAllowed: true at all, so it
 * never stores it.
 */
var boardAllowed = !!localStorage.getItem(BOARD_OK_KEY);

var BOARD_LIST_NAMES = { now: 'Now', week: 'This week', later: 'Later',
                         someday: 'Someday', done: 'Done' };
var BOARD_SOURCE_BADGE = { capture: '🎙', vault: '📓' };

function setBoardAllowed(on) {
  boardAllowed = !!on;
  if (boardAllowed) { localStorage.setItem(BOARD_OK_KEY, '1'); return; }
  localStorage.removeItem(BOARD_OK_KEY);
  // Access revoked mid-session: don't strand the device on a view the server
  // will no longer feed. syncSwitches() takes the icon away on the next render
  // either way, but the open view has to be closed explicitly.
  if (boardVisible()) showView('dashboard');
}

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

/* ---------- theme (per device, chosen from the gear menu) ---------- */

// A theme is only token values on :root plus an emoji class, so it never
// touches structure or the sync logic. Stored per device, so Sam and Zissy can
// pick differently on their own phones without any of it syncing.
function currentTheme() {
  var t = localStorage.getItem(THEME_KEY);
  return THEMES.indexOf(t) === -1 ? 'paper' : t;
}
function emojiOn() { return !!localStorage.getItem(EMOJI_KEY); }
function awakeOn() { return !!localStorage.getItem(AWAKE_KEY); }

function applyTheme(name) {
  if (THEMES.indexOf(name) === -1) name = 'paper';
  document.documentElement.setAttribute('data-theme', name);
  localStorage.setItem(THEME_KEY, name);
  syncMenu();
}
function applyEmoji(on) {
  document.documentElement.classList.toggle('emoji', !!on);
  if (on) localStorage.setItem(EMOJI_KEY, '1');
  else localStorage.removeItem(EMOJI_KEY);
  syncMenu();
}

/* ---------- display wake lock (per device, chosen from the gear menu) ---------- */

// The preference and the platform lock are deliberately separate. Android can
// release a lock when the app is hidden, power saver is enabled, or the battery
// is low. The saved preference stays on, and requestWakeLock() reacquires the
// platform lock when this page becomes visible again.
var wakeLock = null;

function wakeLockSupported() {
  return !!(navigator.wakeLock && navigator.wakeLock.request);
}

function requestWakeLock() {
  if (!awakeOn() || document.hidden || !wakeLockSupported()) return Promise.resolve(false);
  if (wakeLock && !wakeLock.released) return Promise.resolve(true);

  return navigator.wakeLock.request('screen').then(function (lock) {
    wakeLock = lock;
    lock.addEventListener('release', function () {
      if (wakeLock === lock) wakeLock = null;
    });
    return true;
  }).catch(function () {
    wakeLock = null;
    return false;
  });
}

function releaseWakeLock() {
  if (!wakeLock) return Promise.resolve();
  var lock = wakeLock;
  wakeLock = null;
  return lock.release().catch(function () {});
}

function applyAwake(on) {
  if (on) localStorage.setItem(AWAKE_KEY, '1');
  else localStorage.removeItem(AWAKE_KEY);
  syncMenu();

  if (on) {
    requestWakeLock().then(function (held) {
      announce(held ? 'Display will stay awake' : 'Could not keep the display awake');
    });
  } else {
    releaseWakeLock();
    announce('Display can dim normally');
  }
}

function syncMenu() {
  var t = currentTheme();
  Array.prototype.forEach.call(document.querySelectorAll('.menu [data-theme]'), function (b) {
    b.setAttribute('aria-pressed', String(b.getAttribute('data-theme') === t));
  });
  var eb = document.getElementById('emojiToggle');
  if (eb) eb.setAttribute('aria-pressed', String(emojiOn()));
  var ab = document.getElementById('awakeToggle');
  if (ab) {
    ab.setAttribute('aria-pressed', String(awakeOn()));
    ab.disabled = !wakeLockSupported();
    ab.title = wakeLockSupported() ? '' : 'Not supported by this browser';
  }
}

function wireSettings() {
  var gear = document.getElementById('gear');
  var menu = document.getElementById('menu');
  if (!gear || !menu) return;

  function close() { menu.hidden = true; gear.setAttribute('aria-expanded', 'false'); }

  gear.addEventListener('click', function (e) {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    gear.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', function (e) {
    if (!menu.hidden && !menu.contains(e.target)) close();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  Array.prototype.forEach.call(document.querySelectorAll('.menu [data-theme]'), function (b) {
    b.addEventListener('click', function () { applyTheme(b.getAttribute('data-theme')); });
  });
  document.getElementById('emojiToggle')
    .addEventListener('click', function () { applyEmoji(!emojiOn()); });
  document.getElementById('awakeToggle')
    .addEventListener('click', function () { applyAwake(!awakeOn()); });
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

  // A link can also preset the look, e.g. ?theme=pastel or ?emoji=on — handy
  // for setting a device without opening the menu.
  var th = (params.get('theme') || '').trim();
  if (THEMES.indexOf(th) !== -1) { localStorage.setItem(THEME_KEY, th); dirty = true; }
  var em = params.get('emoji');
  if (em !== null) {
    if (em === '1' || em === 'on') localStorage.setItem(EMOJI_KEY, '1');
    else localStorage.removeItem(EMOJI_KEY);
    dirty = true;
  }

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
  state.chores = data.chores || [];
  // Board rows ride their own request, so most responses legitimately omit
  // them. Replacing state.board with [] here would blank the view every poll.
  if (data.board) state.board = data.board;
  if (typeof data.boardAllowed === 'boolean') setBoardAllowed(data.boardAllowed);
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

/**
 * Board rows are private, so they are NOT part of the payload every family
 * device polls. They are asked for explicitly, and only while the board is on
 * screen — a phone showing the dashboard never requests them at all.
 */
var refreshingBoard = false;
function refreshBoard() {
  if (refreshingBoard || !navigator.onLine || !configured()) return;
  refreshingBoard = true;
  post({ action: 'data', wantBoard: true })
    .then(function (res) { if (res.ok && !queue.length) adopt(res.data); })
    .catch(function () {})
    .then(function () { refreshingBoard = false; });
}

function boardVisible() {
  var el = document.getElementById('boardView');
  return !!el && !el.hidden;
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
    // The visible view decides what gets fetched: the private rows are only
    // ever requested while someone is actually looking at the board.
    if (boardVisible()) refreshBoard(); else refresh();
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
  // A labelled event says whose it is in words, so it does not also need a
  // rule. Without this the full-width "both" bar ends up on most rows and
  // stops meaning anything.
  d.className = 'ev ' + (ev.who || 'him') + (ev.label ? ' labelled' : '');

  var what = document.createElement('div');
  what.className = 'what';
  // Whose an event is *about* (a kid, medical) is carried by this label rather
  // than by more line styles, which stop being distinguishable past two.
  if (ev.label) {
    var lab = document.createElement('span');
    lab.className = 'evlabel';
    lab.textContent = ev.label;
    what.appendChild(lab);
  }
  what.appendChild(document.createTextNode(ev.what));
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

/**
 * Seven ticks, Sunday to Shabbat, showing where in the week we are. Days behind
 * are muted, today is emphasised, and Saturday sits heavier — the week visibly
 * builds toward Shabbat. dow is 0 (Sunday) to 6 (Saturday), computed in the NY
 * zone by FEEDS.
 */
function renderArc(dow) {
  var wk = document.getElementById('weekarc');
  if (!wk) return;
  wk.innerHTML = '';
  for (var d = 0; d < 7; d++) {
    var i = document.createElement('i');
    if (d === 6) i.className = 'shab';
    else if (d === dow) i.className = 'now';
    else if (d < dow) i.className = 'past';
    if (d === dow && d === 6) i.className = 'shab now';
    wk.appendChild(i);
  }
}

function render() {
  // Both corner icons are derived in one place, so a poll-driven render lands
  // on exactly the same answer showView() just produced instead of fighting it.
  syncSwitches();

  var view = FEEDS.view();

  document.getElementById('day').textContent = view.day;
  document.getElementById('sub').textContent = view.sub;
  document.getElementById('temp').textContent = view.temp;
  document.getElementById('cond').textContent = view.cond;
  renderArc(view.dow);

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
  var aheadLabel = (tomorrowEvents.length && view.dow !== 4) ? 'Tomorrow' : view.aheadLabel;
  var al = document.getElementById('aheadLabel');
  al.textContent = '';
  var alEm = document.createElement('span');
  alEm.className = 'em';
  alEm.textContent = '📅 ';
  al.appendChild(alEm);
  al.appendChild(document.createTextNode(aheadLabel));

  var ahead = document.getElementById('ahead');
  ahead.innerHTML = '';
  tomorrowEvents.forEach(function (ev) { ahead.appendChild(eventNode(ev)); });

  // Built as nodes, not markup: everything below originates from a remote feed,
  // and textContent means it can never become HTML.
  // Structured rows (label + value) rather than inline text + <br>, so a theme
  // can restyle the whole block — Almanac makes it a featured candle-lighting
  // box with the first line's time enlarged. Plain themes render it unchanged.
  var lines = view.aheadLines || [];
  if (lines.length) {
    var box = document.createElement('div');
    box.className = 'shablines';
    if (tomorrowEvents.length) box.style.marginTop = '10px';
    lines.forEach(function (line, i) {
      var row = document.createElement('div');
      row.className = 'shabline' + (i === 0 ? ' primary' : '');
      var lab = document.createElement('span');
      lab.className = 'sl-lab';
      lab.textContent = line.label;
      var val = document.createElement('b');
      val.className = 'sl-val';
      val.textContent = line.value;
      row.appendChild(lab);
      row.appendChild(document.createTextNode(' '));
      row.appendChild(val);
      box.appendChild(row);
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

  if (!document.getElementById('choresView').hidden) renderChores();
  if (boardVisible()) renderBoard();
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

/* ---------- chores view ---------- */

var pendingChore = {};   // id -> timer, mirrors pendingDone for the lists
var editingChore = null; // id of the chore whose inline editor is open, or null

function nowIso() { return new Date().toISOString(); }

function choreById(id) {
  for (var i = 0; i < state.chores.length; i++) if (state.chores[i].id === id) return state.chores[i];
  return null;
}

function startChoreDone(id) {
  if (pendingChore[id]) return;
  var c = choreById(id);
  pendingChore[id] = setTimeout(function () { commitChoreDone(id); }, UNDO_MS);
  if (c) announce(c.title + ' marked done');
  renderChores();
}

function cancelChoreDone(id) {
  if (!pendingChore[id]) return;
  clearTimeout(pendingChore[id]);
  delete pendingChore[id];
  renderChores();
}

function commitChoreDone(id) {
  if (pendingChore[id]) { clearTimeout(pendingChore[id]); delete pendingChore[id]; }
  var c = choreById(id);
  if (!c) return;
  c.last_done_at = nowIso();
  c.last_done_by = who;
  save(CACHE_KEY, state);
  enqueue({ op: 'choreDone', id: id, at: c.last_done_at, by: who });
}

/** "Still needed" on a handled-today chore: reopen it. */
function reopenChore(id) {
  var c = choreById(id);
  if (!c) return;
  c.last_done_at = '';
  c.last_done_by = '';
  save(CACHE_KEY, state);
  announce(c.title + ' reopened');
  enqueue({ op: 'choreUndone', id: id });
}

function addChore(title, owner, cadence, def) {
  title = title.trim();
  if (!title) return;
  var id = uuid();
  def = def || '';
  state.chores.push({ id: id, title: title, owner: owner, cadence: cadence,
                      cue: '', def: def, last_done_at: '', last_done_by: '' });
  save(CACHE_KEY, state);
  announce(title + ' added to chores');
  enqueue({ op: 'choreAdd', id: id, title: title, owner: owner, cadence: cadence, def: def });
}

/** Reassign owner / change cadence / edit description. Applies locally, then syncs. */
function editChore(id, changes) {
  var c = choreById(id);
  if (!c) return;
  if (changes.owner != null) c.owner = changes.owner;
  if (changes.cadence != null) c.cadence = changes.cadence;
  if (changes.def != null) c.def = changes.def;
  save(CACHE_KEY, state);
  enqueue({ op: 'choreEdit', id: id, owner: c.owner, cadence: c.cadence, def: c.def });
}

/** The owner / cadence / description picker shown inline when Edit is open. */
function choreEditor(c) {
  var box = document.createElement('div');
  box.className = 'chore-edit';
  // Keep editor keystrokes (typing a description, space on a pill) out of the
  // row's own key handler, which would otherwise swallow spaces / mark it done.
  box.addEventListener('keydown', function (e) { e.stopPropagation(); });

  var segRow = document.createElement('div');
  segRow.className = 'seg-row';
  function seg(label, active, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(active));
    b.onclick = function (e) { e.stopPropagation(); fn(); };
    return b;
  }
  segRow.appendChild(seg('Sam', c.owner === 'Sam', function () { editChore(c.id, { owner: 'Sam' }); }));
  segRow.appendChild(seg('Zissy', c.owner === 'Zissy', function () { editChore(c.id, { owner: 'Zissy' }); }));
  segRow.appendChild(seg('Daily', c.cadence === 'daily', function () { editChore(c.id, { cadence: 'daily' }); }));
  segRow.appendChild(seg('Weekly', c.cadence === 'weekly', function () { editChore(c.id, { cadence: 'weekly' }); }));
  segRow.appendChild(seg('As needed', c.cadence === 'asneeded', function () { editChore(c.id, { cadence: 'asneeded' }); }));
  box.appendChild(segRow);

  var def = document.createElement('input');
  def.className = 'add chore-def-input';
  def.value = c.def || '';
  def.placeholder = 'What does "done" mean? (optional)';
  def.setAttribute('autocomplete', 'off');
  def.setAttribute('aria-label', 'Description for ' + c.title);
  def.onclick = function (e) { e.stopPropagation(); };
  def.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); def.blur(); } };
  def.onchange = function () { editChore(c.id, { def: def.value }); };   // commits on blur / Enter
  box.appendChild(def);
  return box;
}

/**
 * A due-chore row: tap to mark done (same inline-undo grace as the lists). The
 * "done" standard shows as a muted subline; Edit opens an inline owner/cadence
 * picker. While the editor is open, row taps are inert so you can't complete the
 * chore by accident.
 */
function choreRow(c) {
  var waiting = !!pendingChore[c.id];
  var editing = editingChore === c.id;

  var li = document.createElement('li');
  li.className = 'chore' + (waiting ? ' going' : '');

  var body = document.createElement('div');
  body.className = 'chore-body';

  var title = document.createElement('span');
  title.className = 'chore-title';
  title.textContent = c.title;
  body.appendChild(title);

  var subText = [c.cue, c.def].filter(function (s) { return s; }).join(' · ');
  if (subText) {
    var sub = document.createElement('span');
    sub.className = 'chore-sub';
    sub.textContent = subText;
    body.appendChild(sub);
  }
  // As-needed chores are condition-based, not on a clock — show recency instead.
  if (c.cadence === 'asneeded') {
    var last = document.createElement('span');
    last.className = 'chore-sub chore-last';
    last.textContent = c.last_done_at
      ? 'Last done ' + ago(c.last_done_at) + (c.last_done_by ? ' · ' + c.last_done_by : '')
      : 'Not done yet';
    body.appendChild(last);
  }
  if (editing) body.appendChild(choreEditor(c));
  li.appendChild(body);

  if (waiting) {
    var undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'undoInline';
    undo.textContent = 'Undo';
    undo.setAttribute('aria-label', 'Undo marking ' + c.title + ' done');
    undo.onclick = function (e) { e.stopPropagation(); cancelChoreDone(c.id); };
    li.appendChild(undo);
  } else {
    var edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'rowbtn';
    edit.textContent = editing ? 'Done' : 'Edit';
    edit.setAttribute('aria-label', (editing ? 'Close editor for ' : 'Edit ') + c.title);
    edit.onclick = function (e) {
      e.stopPropagation();
      editingChore = editing ? null : c.id;
      renderChores();
    };
    li.appendChild(edit);
  }

  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  li.setAttribute('aria-label', waiting ? c.title + ' done, undo available' : 'Mark ' + c.title + ' done');
  function activate() {
    if (editing) return;                         // editor open: don't complete on a stray tap
    if (pendingChore[c.id]) cancelChoreDone(c.id); else startChoreDone(c.id);
  }
  li.onclick = activate;
  li.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } };
  return li;
}

/** A handled-today row: shows who did it, with a quiet "still needed" reopen. */
function handledRow(c) {
  var li = document.createElement('li');
  li.className = 'going';
  var span = document.createElement('span');
  span.textContent = c.title;
  li.appendChild(span);
  var meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = c.last_done_by || 'done';
  li.appendChild(meta);
  var re = document.createElement('button');
  re.type = 'button';
  re.className = 'undoInline';
  re.textContent = 'Still needed';
  re.onclick = function (e) { e.stopPropagation(); reopenChore(c.id); };
  li.appendChild(re);
  return li;
}

function choreGroup(title, chores, rowFn, handled) {
  var wrap = document.createElement('div');
  wrap.className = 'chores-group' + (handled ? ' handled' : '');
  var h = document.createElement('h2');
  h.textContent = title;
  wrap.appendChild(h);
  var ul = document.createElement('ul');
  if (!chores.length) {
    var li = document.createElement('li');
    li.className = 'empty';
    li.textContent = handled ? 'Nothing yet today' : 'All clear';
    ul.appendChild(li);
  } else {
    chores.forEach(function (c) { ul.appendChild(rowFn(c)); });
  }
  wrap.appendChild(ul);
  return wrap;
}

function partnerName() {
  // The other person. Two-person household; fall back gracefully if `who` unset.
  return who === 'Sam' ? 'Zissy' : (who === 'Zissy' ? 'Sam' : 'Partner');
}

/**
 * Only the three groups re-render on sync; the add control below them is static
 * HTML wired once (wireChoreAdd), so a background poll never wipes what you are
 * typing or the owner/cadence you have picked — same discipline as the lists.
 */
function renderChores() {
  var groups = document.getElementById('choresGroups');
  if (!groups) return;
  // A background poll calls render(); don't yank a description field out from
  // under someone mid-type by rebuilding while an input in here is focused.
  var ae = document.activeElement;
  if (ae && groups.contains(ae) && ae.tagName === 'INPUT') return;
  var g = CHORES.group(state.chores, who, nowIso());
  groups.innerHTML = '';
  groups.appendChild(choreGroup('My chores', g.mine, choreRow, false));
  groups.appendChild(choreGroup(partnerName() + '’s chores', g.partner, choreRow, false));
  if (g.asNeeded.length) groups.appendChild(choreGroup('As needed', g.asNeeded, choreRow, false));
  groups.appendChild(choreGroup('Handled today', g.handledToday, handledRow, true));
}

var choreChoice = { owner: 'Sam', cadence: 'weekly' };

function wireChoreAdd() {
  var input = document.getElementById('addChore');
  var btn = document.getElementById('addChoreBtn');
  var opts = document.getElementById('choreAddOpts');
  var defInput = document.getElementById('addChoreDef');
  if (!input || !btn || !opts) return;
  choreChoice.owner = who === 'Zissy' ? 'Zissy' : 'Sam';

  var segs = [];
  function addSeg(label, group, value) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(choreChoice[group] === value));
    b.onclick = function () {
      choreChoice[group] = value;
      segs.forEach(function (s) {
        if (s.group === group) s.el.setAttribute('aria-pressed', String(s.value === value));
      });
    };
    opts.appendChild(b);
    segs.push({ el: b, group: group, value: value });
  }
  addSeg('Sam', 'owner', 'Sam');
  addSeg('Zissy', 'owner', 'Zissy');
  addSeg('Daily', 'cadence', 'daily');
  addSeg('Weekly', 'cadence', 'weekly');
  addSeg('As needed', 'cadence', 'asneeded');

  function submit() {
    if (!input.value.trim()) { input.focus(); return; }
    addChore(input.value, choreChoice.owner, choreChoice.cadence, defInput ? defInput.value : '');
    input.value = '';
    if (defInput) defInput.value = '';
    input.focus();
  }
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  if (defInput) defInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
}

/* ---------- board view ---------- */

/**
 * The five horizon columns, rebuilt from state. Everything about a card —
 * which column, how urgent its date, how faded it has gone — is recomputed
 * locally by board.js, so the view is identical offline.
 */
function renderBoard() {
  var wrap = document.getElementById('boardColumns');
  if (!wrap) return;
  // A poll must not wipe a half-typed card. Same guard renderChores uses.
  if (wrap.contains(document.activeElement) &&
      /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;

  var now = new Date().toISOString();
  var groups = BOARD.group(state.board);
  wrap.innerHTML = '';

  BOARD.LISTS.forEach(function (listName) {
    var col = document.createElement('div');
    col.className = 'board-col';
    col.dataset.list = listName;

    var h = document.createElement('h2');
    h.textContent = BOARD_LIST_NAMES[listName];
    col.appendChild(h);

    var cards = groups[listName];
    if (!cards.length) {
      var empty = document.createElement('div');
      empty.className = 'card-empty';
      empty.textContent = '—';
      col.appendChild(empty);
    }
    cards.forEach(function (card) { col.appendChild(cardEl(card, now)); });
    wrap.appendChild(col);
  });

  renderBoardAgenda();
}

/** One card. Faded in proportion to how long it has sat untouched. */
function cardEl(card, nowIso) {
  var el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = card.id;
  el.tabIndex = 0;
  el.style.opacity = String(1 - 0.45 * BOARD.ageLevel(card, nowIso));

  var title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = card.title;
  el.appendChild(title);

  var bits = [];
  if (card.label) bits.push(card.label);
  if (card.note) bits.push(card.note);

  var sub = document.createElement('div');
  sub.className = 'card-sub';

  var badge = BOARD_SOURCE_BADGE[card.source];
  if (badge) {
    var b = document.createElement('span');
    b.className = 'card-badge';
    b.textContent = badge;
    b.title = card.source === 'capture' ? 'From a voice capture' : 'From the vault';
    sub.appendChild(b);
  }

  if (card.due) {
    var d = document.createElement('span');
    d.className = 'due-' + BOARD.dueState(card, nowIso);
    d.textContent = card.due;
    sub.appendChild(d);
    if (bits.length) sub.appendChild(document.createTextNode(' · '));
  }
  sub.appendChild(document.createTextNode(bits.join(' · ')));

  if (sub.childNodes.length) el.appendChild(sub);
  return el;
}

/** Today's events, already in the payload — free context beside the cards. */
function renderBoardAgenda() {
  var el = document.getElementById('boardAgenda');
  if (!el) return;
  var today = (state.events || []).filter(function (ev) { return ev.day === 'today'; });
  el.textContent = today.length
    ? 'Today: ' + today.map(function (ev) { return ev.when + ' ' + ev.what; }).join('  ·  ')
    : '';
}

/* ---------- view switch (dashboard <-> chores <-> board) ---------- */

var VIEW_KEY = 'fd.view';   // navigation state (per device, not synced)

/**
 * The single owner of both corner buttons. showView() and render() both need
 * them updated, and render() runs on every poll tick — so rather than each
 * deciding for itself (and re-showing a button the other just hid), both derive
 * the same answer from boardAllowed and whichever view is actually on screen.
 *
 * `hidden` is set as a property, never as inline display: `.switch` sets
 * display:flex, which beats the user-agent [hidden] rule, so index.html carries
 * an explicit `.switch[hidden] { display: none; }` for exactly this.
 */
function syncSwitches() {
  var boardEl = document.getElementById('boardView');
  var choresEl = document.getElementById('choresView');
  var onBoard = !!boardEl && !boardEl.hidden;
  var onChores = !!choresEl && !choresEl.hidden;

  var ch = document.getElementById('choresToggle');
  if (ch) {
    ch.hidden = onBoard;                  // the open view owns the 12px slot
    ch.classList.toggle('on', onChores);  // swaps the broom icon for a back chevron
    ch.setAttribute('aria-label', onChores ? 'Back to dashboard' : 'Switch to chores');
  }

  var bd = document.getElementById('boardToggle');
  if (bd) {
    bd.hidden = !boardAllowed || onChores;
    bd.classList.toggle('on', onBoard);
    bd.setAttribute('aria-label', onBoard ? 'Back to dashboard' : 'Switch to board');
  }

  // Two icons need a wider inset on the dashboard header than one does.
  document.body.classList.toggle('has-board', boardAllowed);
}

function showView(name) {
  var isChores = name === 'chores';
  // A device the server has not cleared cannot reach the board even by asking
  // for it directly; it lands back on the dashboard instead.
  var isBoard = name === 'board' && boardAllowed;
  document.getElementById('dashboardView').hidden = isChores || isBoard;
  document.getElementById('choresView').hidden = !isChores;
  document.getElementById('boardView').hidden = !isBoard;
  syncSwitches();

  // Store what actually opened, not what was asked for, so a refused 'board'
  // is not replayed on every reload.
  var opened = isBoard ? 'board' : (isChores ? 'chores' : 'dashboard');
  try { sessionStorage.setItem(VIEW_KEY, opened); } catch (e) {}

  if (isChores) renderChores();
  if (isBoard) { renderBoard(); refreshBoard(); }
}

function wireSwitch() {
  var ch = document.getElementById('choresToggle');
  if (ch) ch.addEventListener('click', function () {
    showView(document.getElementById('choresView').hidden ? 'chores' : 'dashboard');
  });
  var bd = document.getElementById('boardToggle');
  if (bd) bd.addEventListener('click', function () {
    showView(boardVisible() ? 'dashboard' : 'board');
  });
}

function init() {
  state = load(CACHE_KEY, state);
  // load() replaces state wholesale, and a cache written by an older build has
  // no board key at all. BOARD.group tolerates undefined, but the card writes
  // that follow do not — this is what stops state.board.push from throwing on a
  // device that has been running the app since before the board existed.
  if (!Array.isArray(state.board)) state.board = [];
  queue = load(QUEUE_KEY, []);

  var shared = adoptSetupLink();

  // Apply the saved look before first paint so there is no flash of the wrong
  // theme; adoptSetupLink has already honoured any ?theme=/?emoji= override.
  applyTheme(currentTheme());
  applyEmoji(emojiOn());
  wireSettings();
  requestWakeLock();
  wireSwitch();
  wireChoreAdd();
  var savedView = sessionStorage.getItem(VIEW_KEY);
  if (savedView === 'chores' || savedView === 'board') showView(savedView);

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
    requestWakeLock();
    noteActivity();
    flush();
    maybeReload();
    pollLoop();
  });
  window.addEventListener('focus', function () {
    requestWakeLock();
    noteActivity();
    pollLoop();
  });

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
