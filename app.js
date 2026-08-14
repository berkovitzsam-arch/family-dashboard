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

/**
 * Everything a device has to forget once it is off the allowlist: the flag, the
 * cached rows, the rendered titles, and the view itself. Nothing here is lost
 * that the server would not hand back if access returned.
 */
function tearDownBoard() {
  boardAllowed = false;
  localStorage.removeItem(BOARD_OK_KEY);
  state.board = [];
  save(CACHE_KEY, state);
  // A queued cardAdd/cardEdit carries the card's title and note in plaintext.
  // Once a device can no longer see the board, nothing board-shaped should
  // still be waiting to leave it in the next flush() — but a shopping, to-do,
  // note or chore op queued beforehand belongs to the shared family lists and
  // has nothing to do with the board, so it must survive untouched.
  queue = queue.filter(function (op) { return op.op.slice(0, 4) !== 'card'; });
  save(QUEUE_KEY, queue);
  closeCardEditor();   // the card it points at no longer exists here
  // The titles are also sitting in the view's DOM, which nothing repaints once
  // it is hidden — clearing state alone would leave them on the device.
  var wrap = document.getElementById('boardColumns');
  if (wrap) wrap.innerHTML = '';
  // #live is screen-reader-only but still present in the accessibility tree,
  // and the add-card input can be holding an unsubmitted title — both can be
  // carrying a card's private text just as surely as the columns just cleared.
  var live = document.getElementById('live');
  if (live) live.textContent = '';
  var addInput = document.getElementById('addCard');
  if (addInput) addInput.value = '';
  // Don't strand the device on a view the server will no longer feed.
  // syncSwitches() takes the icon away on the next render either way, but the
  // open view has to be closed explicitly.
  if (boardVisible()) showView('dashboard');
}

function setBoardAllowed(on) {
  if (on) { boardAllowed = true; localStorage.setItem(BOARD_OK_KEY, '1'); return; }
  // Every device that is not on the allowlist takes this branch on every poll
  // for as long as it is switched on — the kitchen tablet, forever, every
  // 8-60s. Bail before touching localStorage unless there is something left to
  // forget. The condition is "is anything still here", not "was it true a
  // moment ago", so the first false on a device that never stored the flag
  // still wipes rows that are somehow cached.
  if (!boardAllowed && !localStorage.getItem(BOARD_OK_KEY) &&
      !state.board.length && !boardVisible()) return;
  tearDownBoard();
}

/**
 * A revoked token is the one failure that carries meaning: the server has
 * stopped trusting this device. Three in a row — never one, so a redeploy, a
 * quota blip, or a single odd response cannot wipe anything — and the private
 * rows come off the device.
 *
 * Be clear about what this buys: it wipes a lost or stolen phone that is ONLINE
 * and still running the app. A device that stays offline keeps its rows, a
 * device that is never opened again keeps its rows, and this is in no sense a
 * remote wipe. It shortens the window; it does not close it. The count is
 * per-session and resets on reload, which is fine — the app polls every 8-60s,
 * so three strikes land within a couple of minutes of the app being open.
 */
var BOARD_TOKEN_STRIKES = 3;
var tokenStrikes = 0;

function noteResponse(res) {
  if (res && res.ok) { tokenStrikes = 0; return; }
  // Only an outright token rejection counts. Anything else the server can say,
  // and anything that never reached it at all (those land in .catch and never
  // get here, so they neither add a strike nor clear one), must leave the
  // device's data alone.
  if (!res || !/bad token/i.test(String(res.error || ''))) return;
  if (++tokenStrikes < BOARD_TOKEN_STRIKES) return;
  tokenStrikes = 0;
  tearDownBoard();
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
      noteResponse(res);
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
    .then(function (res) { noteResponse(res); if (res.ok && !queue.length) adopt(res.data); })
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
    .then(function (res) { noteResponse(res); if (res.ok && !queue.length) adopt(res.data); })
    .catch(function () {})
    .then(function () { refreshingBoard = false; });
}

function boardVisible() {
  var el = document.getElementById('boardView');
  return !!el && !el.hidden;
}

/**
 * One request, aimed at whatever is on screen. The board response carries the
 * whole dashboard payload as well, so asking for both would only spend a second
 * call on data we already have — and the Apps Script quota is shared by the
 * whole family. Every trigger (first load, reconnect, poll tick) comes through
 * here so none of them can drift apart.
 */
function refreshVisible() {
  if (boardVisible()) refreshBoard(); else refresh();
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
    refreshVisible();
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
 * The events for one day bucket. The backend emits exactly 'today' or
 * 'tomorrow' today, so matching the day by name is equivalent to "everything
 * that isn't tomorrow" right now — but only the positive test stays correct if
 * a third bucket is ever added, and having one definition means the dashboard
 * and the board's agenda line cannot drift apart.
 */
function eventsOn(day) {
  return (state.events || []).filter(function (ev) { return ev.day === day; });
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
  var todayEvents = eventsOn('today');
  var tomorrowEvents = eventsOn('tomorrow');

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

/** Which labels are on screen. Not synced — it is a way of looking, not data. */
var boardFilter = 'all';

// What the add-card control is currently set to. Held here rather than read off
// the pills so the pills stay presentation, the way choreChoice does it.
var addCardLabel = 'personal';
var addCardList = 'now';

/**
 * The card whose inline editor is open, or null.
 *
 * This has to live outside the DOM because renderBoard() rebuilds #boardColumns
 * wholesale on every poll tick (8-60s) and the editor sits inside a column. The
 * input guard below only defers the rebuild while a text field in there has
 * focus, so an editor whose focus is on a pill — or nowhere, because the user
 * paused — would silently vanish mid-interaction. Instead the rebuild carries it
 * across: which card (editingId), what its fields hold but have not saved
 * (editDraft), and which control had focus (captured per-rebuild below).
 */
var editingId = null;
var editDraft = null;
var openEditorFocus = null;   // one-shot: control to focus on the next rebuild
var focusCardId = null;       // one-shot: card to focus on the next rebuild
// Whose Delete is armed for its confirming second tap. Module-level for the
// same reason editingId is: pollLoop calls render() — and so renderBoard() —
// every 8s at the fast cadence, so a flag living in the button's closure would
// silently revert to "Delete" a second or two after it was armed, and the
// second tap would arm it again instead of deleting.
var deleteArmedId = null;

/** Forget the open editor. Its box goes on the next renderBoard(). */
function closeCardEditor() {
  editingId = null;
  editDraft = null;
  openEditorFocus = null;
  deleteArmedId = null;
}

/**
 * Release a focused text field inside the columns before anything that will
 * rebuild them.
 *
 * renderBoard's input guard defers the ENTIRE rebuild while a field in there
 * has focus. That is right for a poll tick and wrong for a write the user just
 * asked for: the write lands in state, the cache and the queue, but the screen
 * keeps the old card and an orphaned editor — and every later tick hits the
 * same guard, so the board stops repainting until something blurs the field.
 *
 * Enter never moves focus at all, and only Chrome moves it to a button on
 * click, so every path that writes from inside the editor has to do this for
 * itself. One helper, called from all of them, so they cannot drift apart.
 */
function blurBoardField() {
  var wrap = document.getElementById('boardColumns');
  var ae = document.activeElement;
  if (wrap && ae && wrap.contains(ae) && /^(INPUT|TEXTAREA)$/.test(ae.tagName)) ae.blur();
}

/**
 * The five horizon columns, rebuilt from state. Everything about a card —
 * which column, how urgent its date, how faded it has gone — is recomputed
 * locally by board.js, so the view is identical offline.
 */
function renderBoard() {
  var wrap = document.getElementById('boardColumns');
  if (!wrap) return;
  // Outside the guard below: the agenda is a one-line readout of data that is
  // already here, and freezing it because a card input has focus would leave a
  // stale time on screen for as long as someone is typing.
  renderBoardAgenda();

  // A poll must not destroy a drag in progress. This rebuild replaces the node
  // under the pointer AND every drop target with it, so the gesture would die
  // mid-air — and unlike the editor below, there is no way to carry a drag
  // across a rebuild. Defer instead; dragend repaints (and dragActive lets go
  // by itself if a drag ever fails to end).
  if (dragActive()) return;

  // A poll must not wipe a half-typed card. Same guard renderChores uses.
  if (wrap.contains(document.activeElement) &&
      /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;

  // Cards are focusable, and a click focuses one, so deferring the rebuild
  // while a card has focus (the way the input guard does) would freeze the
  // board for as long as it stayed focused. Rebuild, then put focus back on the
  // same card instead — Task 9's keyboard moves depend on it surviving a poll.
  var active = document.activeElement;
  var focusedId = (active && active.classList && active.classList.contains('card') &&
                   wrap.contains(active)) ? active.dataset.id : null;

  // Carry the open editor across the rebuild: its unsaved field values and
  // whichever of its controls had focus. Harvested only when the box on screen
  // still belongs to editingId, so switching cards can't resurrect the previous
  // card's draft into the new editor.
  var openBox = wrap.querySelector('.card-editor');
  var editorCtl = null;
  editDraft = null;
  if (openBox && openBox.dataset.card === editingId) {
    editDraft = readCardEditor(openBox);
    if (active && openBox.contains(active) && active.dataset.ctl) editorCtl = active.dataset.ctl;
  }
  // A just-opened editor asks for the title; a surviving one asks for whatever
  // it had. Either way it is consumed by this rebuild and not the next.
  var wantCtl = editorCtl || openEditorFocus;
  openEditorFocus = null;
  // A closing editor hands focus back to its card. Same one-shot discipline.
  var wantCard = focusCardId;
  focusCardId = null;

  var now = new Date().toISOString();
  // The filter is a view over state, never a filter on what gets written:
  // positions and neighbours are always computed from the whole board.
  var visible = boardFilter === 'all' ? state.board
    : state.board.filter(function (c) { return c.label === boardFilter; });
  var groups = BOARD.group(visible);
  wrap.innerHTML = '';

  BOARD.LISTS.forEach(function (listName) {
    var col = document.createElement('div');
    col.className = 'board-col';
    col.dataset.list = listName;
    wireColumnDrop(col, listName);

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
    cards.forEach(function (card) { col.appendChild(cardEl(card, now, listName)); });
    wrap.appendChild(col);
  });

  // Matched by id rather than by a built selector: card ids come from the
  // sheet, and nothing guarantees they are safe to interpolate into one.
  var cards = wrap.querySelectorAll('.card');
  var focusEl = null;
  var editEl = null;
  var wantCardEl = null;
  for (var i = 0; i < cards.length; i++) {
    if (focusedId && cards[i].dataset.id === focusedId) focusEl = cards[i];
    if (editingId && cards[i].dataset.id === editingId) editEl = cards[i];
    if (wantCard && cards[i].dataset.id === wantCard) wantCardEl = cards[i];
  }

  // The card being edited can go out from under the editor: deleted on the
  // other device, or filtered off screen. Don't keep pointing at it.
  var editing = editEl && findCard(editingId);
  if (editingId && !editing) closeCardEditor();
  if (editing) openCardEditor(editEl, editing, wantCtl);
  // However the editor closed, focus lands back on the card it belonged to —
  // otherwise Save and a column move drop it on <body> while a re-tap does not.
  if (wantCardEl) wantCardEl.focus();
  // If the editor just took focus, don't yank it back to the card behind it.
  else if (focusEl && !wantCtl) focusEl.focus();
}

/**
 * One card. Faded in proportion to how long it has sat untouched.
 *
 * `listName` is the column it is being drawn in, which is what a drop onto it
 * means — see wireCardDrag.
 */
function cardEl(card, nowIso, listName) {
  var el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = card.id;
  el.tabIndex = 0;
  // It opens an editor when activated, so announce it as the control it is —
  // same treatment choreRow gives its rows. No aria-label: the card's own text
  // (title, date, label) is a better name than anything we would write.
  el.setAttribute('role', 'button');
  el.setAttribute('aria-expanded', String(editingId === card.id));
  el.style.opacity = String(1 - 0.45 * BOARD.ageLevel(card, nowIso));

  var title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = card.title;
  el.appendChild(title);

  // The meta line reads: due date, then label, then note. The date goes first
  // because it is what the eye actually scans a column for.
  //
  // The label is drawn ONLY under the 'All' filter. Filtered to one label, the
  // pills at the top of the view already say which one you are looking at, so
  // the word on every single card is pure repetition. It is never colour-coded:
  // this app tells things apart by shape, never by hue.
  var bits = [];
  if (card.label && boardFilter === 'all') bits.push(card.label);
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

  var dueText = BOARD.dueLabel(card.due, nowIso);
  if (dueText) {
    var d = document.createElement('span');
    d.className = 'due-' + BOARD.dueState(card, nowIso);
    d.textContent = dueText;
    // 'Thu' and '20 Aug' are easier to read but carry less than the date did —
    // no year, no which-Thursday. The exact date stays one hover away rather
    // than being thrown out. Sliced the same way the editor's date field is.
    d.title = String(card.due).slice(0, 10);
    sub.appendChild(d);
    if (bits.length) sub.appendChild(document.createTextNode(' · '));
  }
  sub.appendChild(document.createTextNode(bits.join(' · ')));

  if (sub.childNodes.length) el.appendChild(sub);

  // The editor is inserted as the card's sibling, not its child, so nothing it
  // contains bubbles back through here — no stopPropagation needed, unlike the
  // chore rows.
  el.addEventListener('click', function () { toggleCardEditor(card); });
  el.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleCardEditor(card); }
  });

  // Deliberately NOT closing the editor on a drag, which is why closeCardEditor
  // was kept out of moveCard. The column picker closes it because on a phone the
  // card lands somewhere off screen and the box would be left pointing at
  // nothing; a drag is a wide-screen gesture where all five columns are visible
  // at once, and renderBoard re-anchors the editor to its card by id wherever it
  // ends up — carrying the unsaved draft with it. Throwing away someone's typing
  // because they dragged a different card would be worse than either.
  wireCardDrag(el, card, listName);
  return el;
}

/** Today's events, already in the payload — free context beside the cards. */
function renderBoardAgenda() {
  var el = document.getElementById('boardAgenda');
  if (!el) return;
  var today = eventsOn('today');
  el.textContent = today.length
    ? 'Today: ' + today.map(function (ev) { return ev.when + ' ' + ev.what; }).join('  ·  ')
    : '';
}

/* ---------- board writes ---------- */

/**
 * Every one of these applies locally, saves, and queues — the same optimistic
 * path the lists and chores use, so the board works with no signal. None of
 * them calls renderBoard(): enqueue() runs render(), which repaints the board
 * when it is the visible view. That is exactly how addChore/editChore work, and
 * doing both would rebuild the columns (and the open editor) twice per write.
 *
 * All four bail on a device that may not see the board. The server refuses
 * board ops from any device outside its allowlist regardless — this only stops
 * the client from queueing an op that could never land, and from touching
 * private rows on a device that should not hold them.
 */
function findCard(id) {
  for (var i = 0; i < state.board.length; i++) {
    if (state.board[i].id === id) return state.board[i];
  }
  return null;
}

/**
 * The position for a card appended to the end of `list`. Read off the whole
 * board, never the filtered view. `0` is a legitimate position ("before the
 * first card"), so the neighbour is tested for length, never truthiness.
 */
function endPos(list) {
  var inList = BOARD.group(state.board)[list];
  var last = inList.length ? inList[inList.length - 1].pos : null;
  return BOARD.posBetween(last, null);
}

function addCard(title) {
  if (!boardAllowed) return;
  title = (title || '').trim();
  if (!title) return;
  var id = uuid();
  var now = new Date().toISOString();
  var card = {
    id: id, title: title, note: '', list: addCardList, pos: endPos(addCardList),
    label: addCardLabel, due: '', source: 'manual', source_ref: '',
    created_at: now, updated_at: now,
    // Matches what cardAdd_ writes for a card added straight into Done, so the
    // local row does not disagree with the sheet until the next fetch.
    done_at: addCardList === 'done' ? now : ''
  };
  state.board.push(card);
  save(CACHE_KEY, state);
  announce(title + ' added to ' + BOARD_LIST_NAMES[card.list]);
  enqueue({ op: 'cardAdd', id: id, title: title, list: card.list, pos: card.pos,
            label: card.label, due: '', note: '', source: 'manual', source_ref: '' });
}

/** Only the fields passed are changed, and only those are sent. */
function editCard(id, fields) {
  if (!boardAllowed) return;
  var card = findCard(id);
  if (!card) return;
  var op = { op: 'cardEdit', id: id };
  Object.keys(fields).forEach(function (k) {
    card[k] = fields[k];
    op[k] = fields[k];
  });
  card.updated_at = new Date().toISOString();
  save(CACHE_KEY, state);
  enqueue(op);
}

/**
 * Move between columns and/or reorder. There is deliberately no cardDone op:
 * landing in 'done' is what completes a card, and moving back out clears the
 * stamp again — mirroring cardMove_ so the local row matches the sheet.
 */
function moveCard(id, list, pos) {
  if (!boardAllowed) return;
  var card = findCard(id);
  if (!card) return;
  card.list = list;
  card.pos = pos;
  card.updated_at = new Date().toISOString();
  card.done_at = list === 'done' ? card.updated_at : '';
  save(CACHE_KEY, state);
  enqueue({ op: 'cardMove', id: id, list: list, pos: pos });
}

/**
 * Where a card dropped above `beforeId` in `listName` should sit; a null
 * beforeId means "at the end". Read off the whole board rather than the
 * filtered view, for the same reason endPos is: a hidden card is still a
 * neighbour. `0` is a legitimate position, so neighbours are tested for
 * existence, never for truthiness — posBetween does the rest.
 */
function dropPosition(listName, beforeId) {
  var cards = BOARD.group(state.board)[listName];
  if (!beforeId) {
    return BOARD.posBetween(cards.length ? cards[cards.length - 1].pos : null, null);
  }
  for (var i = 0; i < cards.length; i++) {
    if (cards[i].id === beforeId) {
      return BOARD.posBetween(i > 0 ? cards[i - 1].pos : null, cards[i].pos);
    }
  }
  // The card dropped onto has gone (deleted on the other device between the
  // rebuild and the drop). Landing at the end beats throwing the drop away.
  return BOARD.posBetween(cards.length ? cards[cards.length - 1].pos : null, null);
}

/**
 * Respace a list whose positions have closed up. Midpoint insertion halves the
 * gap every time, so repeated drops into the same place eventually run out of
 * room; board.js decides when, this writes the answer back.
 *
 * Only the rows that actually move are written. An op for a card already
 * sitting on its fresh position would spend an Apps Script call from a quota
 * the whole family shares, and bump its updated_at — which resets the age fade
 * on a card nobody touched, and that fade is the point of the aging.
 */
function renormalizeList(listName) {
  if (!boardAllowed) return;
  var cards = BOARD.group(state.board)[listName];
  if (!BOARD.needsRenormalize(cards.map(function (c) { return c.pos; }))) return;
  var fresh = BOARD.renormalize(cards.length);
  var ops = [];
  cards.forEach(function (card, i) {
    if (card.pos === fresh[i]) return;
    card.pos = fresh[i];
    // cardMove_ stamps updated_at on the server whatever the op carries, so the
    // local row has to agree or the next fetch would visibly jump the fade.
    card.updated_at = new Date().toISOString();
    // No `list`: cardMove_ writes only the fields an op carries, so a pos-only
    // move leaves the column — and the done_at stamp that goes with it — alone.
    ops.push({ op: 'cardMove', id: card.id, pos: fresh[i] });
  });
  if (!ops.length) return;
  save(CACHE_KEY, state);
  ops.forEach(function (op) { enqueue(op); });
}

function deleteCard(id) {
  if (!boardAllowed) return;
  var card = findCard(id);
  if (!card) return;
  if (editingId === id) closeCardEditor();   // nothing left to edit
  state.board = state.board.filter(function (c) { return c.id !== id; });
  save(CACHE_KEY, state);
  announce(card.title + ' deleted');
  enqueue({ op: 'cardDelete', id: id });
}

/* ---------- board drag and drop (wide screens only) ---------- */

/**
 * Dragging is a laptop shortcut, never the only route: the card editor's column
 * picker does everything a drag does, which is what makes the phone layout —
 * one stacked column, nothing draggable — work at all. Below 900px this whole
 * section stays unwired.
 *
 * The card being dragged, when it started, and the column currently outlined as
 * its destination. All three live out here rather than in a handler's closure
 * because renderBoard() rebuilds #boardColumns wholesale on every poll tick: a
 * drag outlives any element it began on.
 */
var draggingId = null;
var dragStartedAt = 0;
var dropCol = null;

/**
 * How long a drag may hold off the rebuild before the hold is assumed stuck.
 *
 * dragend is specified to fire however a drag ends — dropped on nothing,
 * cancelled with Escape, the window taken away mid-gesture — and it does, which
 * is what normally clears this. But the cost of the two failures is wildly
 * asymmetric: a flag stuck on freezes the board for the rest of the session,
 * while an expiry that fires under a genuinely slow drag costs one drag the
 * user can simply repeat. So it expires too. Half a minute is far longer than
 * any real drag and far shorter than "never repaints again".
 */
var DRAG_MAX_MS = 30000;

/** True while a drag is in flight — and self-clearing if one never ended. */
function dragActive() {
  if (!draggingId) return false;
  if (Date.now() - dragStartedAt < DRAG_MAX_MS) return true;
  endDrag();
  return false;
}

/** Forget the drag and take every visual trace of it off screen. */
function endDrag() {
  draggingId = null;
  dragStartedAt = 0;
  setDropCol(null);
  // Found by query rather than kept in a closure: after the expiry above, the
  // element the drag started on may already have been rebuilt away.
  var wrap = document.getElementById('boardColumns');
  if (!wrap) return;
  var lit = wrap.querySelectorAll('.card.dragging');
  for (var i = 0; i < lit.length; i++) lit[i].classList.remove('dragging');
}

/** Outline exactly one column as the destination, or none. */
function setDropCol(col) {
  if (dropCol === col) return;
  if (dropCol) dropCol.classList.remove('drop-target');
  dropCol = col;
  if (dropCol) dropCol.classList.add('drop-target');
}

/**
 * Land the dragged card in `listName`, above `beforeId` — null meaning at the
 * end. Both drop paths (onto a card, onto a column) come through here so the
 * blur, the position, the respace and the repaint cannot drift apart.
 */
function dropCard(listName, beforeId) {
  var id = draggingId;
  // Before the write, not after: the rebuild the write triggers is the repaint,
  // and it must not be deferred by a drag it has already finished.
  endDrag();
  if (!id) return;
  // The seventh caller of this, and for the usual reason: renderBoard defers
  // the ENTIRE rebuild while a field in the columns has focus, so the move
  // would land in state, the cache and the queue and never appear on screen.
  // A mousedown on a card normally focuses the card and blurs the field for
  // us — but "normally" is not a guarantee across browsers, and this costs
  // nothing when there was nothing focused.
  blurBoardField();
  moveCard(id, listName, dropPosition(listName, beforeId));
  renormalizeList(listName);
  // No renderBoard() here: moveCard enqueues, enqueue() renders, and so does
  // every op renormalizeList adds. Calling it as well would rebuild the columns
  // (and the open editor) twice for one drop — see the board writes above.
}

/**
 * Make one card draggable, and a landing place for the others.
 *
 * The breakpoint is re-read here rather than latched at startup, and this runs
 * per card on every rebuild — so a window dragged across 900px corrects itself
 * on the next repaint (a poll tick at worst) instead of needing a reload.
 *
 * `listName` is the column the card is drawn in, not card.list: group() files a
 * card with an unrecognised list under 'later', and what the user is dropping
 * into is the column they can see.
 */
function wireCardDrag(el, card, listName) {
  if (!window.matchMedia || !window.matchMedia('(min-width: 900px)').matches) return;
  el.draggable = true;

  el.addEventListener('dragstart', function (ev) {
    endDrag();                     // anything a previous drag left behind
    draggingId = card.id;
    dragStartedAt = Date.now();
    el.classList.add('dragging');
    if (!ev.dataTransfer) return;
    // Firefox starts no drag at all unless the transfer carries something.
    try { ev.dataTransfer.setData('text/plain', card.id); } catch (e) {}
    ev.dataTransfer.effectAllowed = 'move';
  });

  el.addEventListener('dragend', function () {
    // draggingId is still set only if the drag ended WITHOUT a drop — dropCard
    // clears it first — so a completed drop does not rebuild the columns a
    // second time. A cancelled one does need the repaint: every poll tick since
    // dragstart was deferred, and the board may be showing stale rows.
    var cancelled = !!draggingId;
    endDrag();
    if (cancelled) renderBoard();
  });

  // Dropping onto a card means "above this one". Only `drop` is handled here;
  // dragover is deliberately left to bubble to the column, which is what keeps
  // the column outlined while the pointer is over the cards inside it.
  el.addEventListener('drop', function (ev) {
    if (!draggingId) return;              // someone else's drag: not ours to eat
    ev.preventDefault();
    ev.stopPropagation();                 // this card is the target, not the column
    // Dropped on itself. The event is still consumed — letting it reach the
    // column would append the card to the end of its own list, which is not
    // "nothing" by any reading of the gesture. dragend does the cleanup.
    if (draggingId === card.id) return;
    dropCard(listName, card.id);
  });
}

/** A whole column as a landing place: dropping on it appends to the end. */
function wireColumnDrop(col, listName) {
  if (!window.matchMedia || !window.matchMedia('(min-width: 900px)').matches) return;

  // Some engines decide droppability on dragenter as well as dragover. Both,
  // and only while one of our own cards is in flight — a file or a selection
  // dragged in from elsewhere is not something this board accepts.
  col.addEventListener('dragenter', function (ev) {
    if (!draggingId) return;
    ev.preventDefault();
  });
  col.addEventListener('dragover', function (ev) {
    if (!draggingId) return;
    // This preventDefault is what makes the column a drop site — and the cards
    // inside it too, since their dragover bubbles up to here.
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    setDropCol(col);
  });
  col.addEventListener('drop', function (ev) {
    if (!draggingId) return;
    ev.preventDefault();
    dropCard(listName, null);
  });
}

/**
 * The outline goes on from dragover and comes off when the drag leaves the
 * columns altogether.
 *
 * Wired once, on the container renderBoard empties rather than replaces, so it
 * survives every rebuild. On dragleave, relatedTarget is the element being
 * entered: moving between two columns, or from a column onto a card inside it,
 * must not clear an outline the very next dragover would put straight back —
 * that reads as a flicker. When it is null (the pointer left the window)
 * contains() says false, which is exactly the right answer.
 */
function wireBoardDrag() {
  var wrap = document.getElementById('boardColumns');
  if (!wrap) return;
  wrap.addEventListener('dragleave', function (ev) {
    if (!draggingId) return;
    if (wrap.contains(ev.relatedTarget)) return;
    setDropCol(null);
  });
}

/* ---------- board card editor ---------- */

var LIST_OPTIONS = [
  { value: 'now', label: 'Now' }, { value: 'week', label: 'This week' },
  { value: 'later', label: 'Later' }, { value: 'someday', label: 'Someday' },
  { value: 'done', label: 'Done' }
];
var LABEL_OPTIONS = [
  { value: 'personal', label: 'Personal' }, { value: 'school', label: 'School' }
];
var FILTER_OPTIONS = [{ value: 'all', label: 'All' }].concat(LABEL_OPTIONS);

/**
 * A row of segmented pills, one pressed — the picker wireChoreAdd and
 * choreEditor each build by hand, generalised. Pressed state is updated in
 * place rather than by redrawing the row, so picking one does not throw away
 * the button under the pointer (or the keyboard focus on it).
 *
 * `ctl`, when given, prefixes a data-ctl tag on each button so the editor's
 * focus can be restored across a rebuild.
 */
function segRow(options, current, onPick, ctl) {
  var row = document.createElement('div');
  row.className = 'seg-row';
  var btns = [];
  options.forEach(function (opt) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg';
    b.textContent = opt.label;
    if (ctl) b.dataset.ctl = ctl + opt.value;
    b.setAttribute('aria-pressed', String(opt.value === current));
    b.addEventListener('click', function () {
      btns.forEach(function (o) {
        o.el.setAttribute('aria-pressed', String(o.value === opt.value));
      });
      onPick(opt.value);
    });
    row.appendChild(b);
    btns.push({ el: b, value: opt.value });
  });
  return row;
}

/**
 * A captioned picker: `row` under a small heading in the same micro-type the
 * column headers use.
 *
 * The board stacks two pickers that choose different things — a label and a
 * column — and without a caption apiece they read as one flat run of seven
 * pills with no hint that picking from the left half means something different
 * from picking from the right. The chore pickers deliberately do NOT use this:
 * each of those sits in a row that has already said what it is.
 *
 * role=group + aria-label rather than aria-labelledby, so nothing here has to
 * mint a unique id — the board never builds a selector out of a value either.
 */
function segGroup(caption, row) {
  var g = document.createElement('div');
  g.className = 'seg-group';
  g.setAttribute('role', 'group');
  g.setAttribute('aria-label', caption);
  var cap = document.createElement('div');
  cap.className = 'seg-cap';
  cap.textContent = caption;
  cap.setAttribute('aria-hidden', 'true');   // the group's own name already says it
  g.appendChild(cap);
  g.appendChild(row);
  return g;
}

/**
 * The control inside `box` carrying this data-ctl key. Walked rather than
 * selected — the keys here are our own constants and would be safe either way,
 * but the board deliberately never builds a selector out of a value.
 */
function ctlIn(box, key) {
  var els = box.querySelectorAll('[data-ctl]');
  for (var i = 0; i < els.length; i++) if (els[i].dataset.ctl === key) return els[i];
  return null;
}

/** What the editor's text fields hold right now, saved or not. */
function readCardEditor(box) {
  var out = {};
  ['title', 'note', 'due'].forEach(function (k) {
    var el = ctlIn(box, k);
    if (el) out[k] = el.value;
  });
  return out;
}

/**
 * `box`'s text fields, shaped as a cardEdit payload, but only the ones that
 * actually differ from `card` — empty when nothing was touched, for the same
 * reason openCardEditor's commit() cares: a no-op write costs an Apps Script
 * call and bumps updated_at for nothing. Pulled out to module level, rather
 * than left as a closure inside openCardEditor, so the filter pill — which
 * sits outside that closure, in wireBoardControls — can commit a card's
 * unsaved typing before its own click hides it, the same way the label pill
 * already does from inside the editor.
 */
function changedCardFields(card, box) {
  var out = {};
  var t = ctlIn(box, 'title');
  var n = ctlIn(box, 'note');
  var d = ctlIn(box, 'due');
  var tVal = (t ? t.value.trim() : '') || card.title;
  if (tVal !== card.title) out.title = tVal;
  if (n && n.value !== (card.note || '')) out.note = n.value;
  if (d && d.value !== String(card.due || '').slice(0, 10)) out.due = d.value;
  return out;
}

function editField(ctl, label, value, type, placeholder) {
  var el = document.createElement('input');
  el.className = 'add';
  el.dataset.ctl = ctl;
  if (type) el.type = type;
  el.value = value || '';
  if (placeholder) el.placeholder = placeholder;
  el.setAttribute('autocomplete', 'off');
  el.setAttribute('aria-label', label);
  return el;
}

/** Open a card's editor, or close it if it is the one already open. */
function toggleCardEditor(card) {
  // Tapping a card ends any typing in the editor above it — without this the
  // rebuild is deferred and the tap appears to do nothing at all.
  blurBoardField();
  if (editingId === card.id) { closeCardEditor(); focusCardId = card.id; }
  else {
    editingId = card.id;
    editDraft = null;
    deleteArmedId = null;    // a Delete armed on the card we just left
    openEditorFocus = 'title';
  }
  renderBoard();
}

/**
 * One editor for both layouts, inserted as the card's sibling. On a phone this
 * is the only way to move a card; on a laptop it is the accessible equivalent
 * of dragging.
 *
 * Called only from renderBoard(), which owns editingId — so there is exactly
 * one of these on screen and it is always anchored to the right card, whatever
 * a poll tick does to the columns underneath it.
 */
function openCardEditor(anchor, card, focusCtl) {
  var box = document.createElement('div');
  box.className = 'card-editor';
  box.dataset.card = card.id;
  var draft = editDraft || {};

  var title = editField('title', 'Card title',
                        draft.title != null ? draft.title : card.title);
  var note = editField('note', 'Description',
                       draft.note != null ? draft.note : card.note, null, 'Description');
  // A date input silently rejects anything that is not YYYY-MM-DD. The backend
  // normalises due dates on read, but a feed can put a full timestamp in the
  // sheet, so slice here too rather than let the field come up empty and then
  // save that emptiness over a real date.
  var due = editField('due', 'Due date',
                      String(draft.due != null ? draft.due : (card.due || '')).slice(0, 10),
                      'date');
  box.appendChild(title);
  box.appendChild(note);
  box.appendChild(due);

  /**
   * Only the text fields that actually differ from the card, shaped as a
   * cardEdit payload. Empty when nothing was touched — Save then queues
   * nothing, because a no-op write costs an Apps Script call from a quota the
   * whole family shares AND bumps updated_at, which would reset the age fade on
   * a card nobody edited. That fade is the whole point of the aging.
   */
  function changedFields() { return changedCardFields(card, box); }

  function commit() {
    // Enter does not move focus, so without this the rebuild below is deferred
    // by renderBoard's input guard and the write lands invisibly.
    blurBoardField();
    var fields = changedFields();
    // Close first: editCard queues, which renders, which is what takes the box
    // off screen. Doing it the other way round would just reopen it.
    closeCardEditor();
    focusCardId = card.id;
    if (Object.keys(fields).length) editCard(card.id, fields);
    else renderBoard();   // nothing to queue, but the box still has to go
  }
  [title, note, due].forEach(function (f) {
    f.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
    });
  });

  // Changing the label normally leaves the editor open: it is a property of the
  // card you are still editing, the card stays exactly where it is, and closing
  // would throw away anything typed into the fields above but not yet saved.
  // The rebuild carries both across (see editDraft in renderBoard).
  box.appendChild(segGroup('Label', segRow(LABEL_OPTIONS, card.label, function (v) {
    if (v === card.label) return;                 // already this label: nothing to write
    blurBoardField();
    var fields = { label: v };
    // Under a filter, though, the new label can take the card off screen — and
    // the editor with it, along with anything typed into it. Losing someone's
    // typing to a filter is not acceptable, so commit the text alongside the
    // label and say what happened, since the card is about to vanish.
    var leaving = boardFilter !== 'all' && v !== boardFilter;
    if (leaving) {
      var edits = changedFields();
      Object.keys(edits).forEach(function (k) { fields[k] = edits[k]; });
    }
    editCard(card.id, fields);
    if (leaving) {
      announce((fields.title || card.title) + ' saved as ' + v +
               ' — hidden by the ' + boardFilter + ' filter');
    }
  }, 'label:')));

  // Moving does close it: the card leaves the column this box is anchored
  // under, which on a phone means it lands somewhere off screen entirely. The
  // move is the whole gesture, so it ends the interaction — announced, because
  // with the editor gone the only feedback is the card appearing elsewhere.
  box.appendChild(segGroup('Column', segRow(LIST_OPTIONS, card.list, function (v) {
    if (v === card.list) return;
    blurBoardField();
    var pos = endPos(v);
    closeCardEditor();
    focusCardId = card.id;
    announce(card.title + ' moved to ' + BOARD_LIST_NAMES[v]);
    moveCard(card.id, v, pos);
  }, 'list:')));

  var actions = document.createElement('div');
  actions.className = 'card-editor-actions';

  var saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'addbtn';
  saveBtn.dataset.ctl = 'save';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', commit);
  actions.appendChild(saveBtn);

  /**
   * Delete is a hard delete on the server and sits directly under the column
   * pills, one tap away in a panel that itself opens on a tap. Everywhere else
   * this app makes an accidental tap recoverable — a crossed-off item gets
   * three seconds of Undo before it even reaches the server — so this asks
   * twice instead. Same pill vocabulary as the pickers above it: no modal.
   */
  var del = document.createElement('button');
  del.type = 'button';
  del.className = 'seg card-del';
  del.dataset.ctl = 'delete';

  /** Paint whichever of the two states deleteArmedId says we are in. */
  function paintDel() {
    var armed = deleteArmedId === card.id;
    del.classList.toggle('armed', armed);
    del.textContent = armed ? 'Delete?' : 'Delete';
    del.setAttribute('aria-label',
      (armed ? 'Confirm deleting ' : 'Delete ') + card.title);
  }
  function disarm() {
    if (deleteArmedId !== card.id) return;
    deleteArmedId = null;
    paintDel();
  }
  paintDel();   // a rebuild mid-confirm comes back up still armed

  del.addEventListener('click', function () {
    if (deleteArmedId !== card.id) {
      deleteArmedId = card.id;
      paintDel();
      announce('Tap Delete again to remove ' + card.title);
      return;
    }
    blurBoardField();
    deleteCard(card.id);
  });
  actions.appendChild(del);
  box.appendChild(actions);

  // Touching anything else in the editor takes the safety back off. An armed
  // Delete must not sit there waiting to fire on a stray tap after the user has
  // moved on. Closing the editor, or opening another card's, disarms it too.
  ['pointerdown', 'keydown', 'focusin'].forEach(function (evt) {
    box.addEventListener(evt, function (e) { if (!del.contains(e.target)) disarm(); }, true);
  });

  anchor.parentNode.insertBefore(box, anchor.nextSibling);

  // Only ever on request. A poll tick that merely rebuilds an editor which
  // nobody is touching must not steal the focus from wherever it actually is.
  if (focusCtl) {
    var f = ctlIn(box, focusCtl);
    if (f) f.focus();
  }
}

/**
 * The add-card row and the label filter. Wired once and updated in place — the
 * same discipline as wireChoreAdd, and the reason a poll tick can never wipe a
 * half-typed card or the column you picked for it: none of this is inside
 * #boardColumns, so renderBoard() never touches it.
 */
function wireBoardControls() {
  var input = document.getElementById('addCard');
  var btn = document.getElementById('addCardBtn');
  var opts = document.getElementById('addCardOpts');
  var filter = document.getElementById('boardFilter');
  if (!input || !btn || !opts || !filter) return;

  function submit() {
    if (!input.value.trim()) { input.focus(); return; }
    // The eighth write path that touches the board, and the one that was
    // missing this: with focus in an open editor's field, renderBoard's input
    // guard would defer the rebuild the new card needs to appear at all.
    blurBoardField();
    addCard(input.value);
    input.value = '';
    input.focus();          // adding several cards in a row is the common case
  }
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });

  // Captioned for the same reason the editor's two pickers are: "Personal
  // School Now This week Later Someday Done" in one run says nothing about
  // which half does what.
  opts.appendChild(segGroup('Label',
    segRow(LABEL_OPTIONS, addCardLabel, function (v) { addCardLabel = v; })));
  opts.appendChild(segGroup('Column',
    segRow(LIST_OPTIONS, addCardList, function (v) { addCardList = v; })));

  filter.appendChild(segRow(FILTER_OPTIONS, boardFilter, function (v) {
    // The sixth caller of the rebuild, and the last one to need this: on a
    // browser that does not focus a button on click, a field inside the editor
    // keeps focus, renderBoard's guard defers, and the pressed pill disagrees
    // with the columns until something else blurs.
    blurBoardField();
    // This click can take the card behind an open editor out of view just as
    // surely as changing its label can — the same hazard the label pill
    // guards against (see openCardEditor). Left alone, renderBoard() below
    // finds the box no longer anchored to a visible card and closes it,
    // taking anything typed but unsaved with it, silently. So commit first,
    // the same way the label pill does, and say what happened.
    var editing = editingId && findCard(editingId);
    var box = editing && document.querySelector('#boardColumns .card-editor');
    if (box && box.dataset.card !== editingId) box = null;
    var leaving = !!(editing && box && v !== 'all' && editing.label !== v);
    var fields = leaving ? changedCardFields(editing, box) : {};
    boardFilter = v;
    if (leaving && Object.keys(fields).length) {
      editCard(editing.id, fields);   // enqueues, which renders under the new filter
      announce((fields.title || editing.title) + ' saved — hidden by the ' + v + ' filter');
    } else {
      renderBoard();
    }
  }));
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
  // Leaving the board ends whatever was being edited: the box is about to be
  // hidden, and coming back should not resume a half-finished edit.
  if (!isBoard) closeCardEditor();
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
  // load() replaces state wholesale, so a cache written by an older build is
  // missing every key added since it was last written — `board` in this build,
  // `chores` for anything dormant since before 2026-07-23. The group() helpers
  // tolerate undefined, but state.board.push / state.chores.push do not, so a
  // device that had sat unopened would throw on the first thing it added.
  // Repair every list before anything reads one.
  ['shopping', 'todo', 'events', 'chores', 'board'].forEach(function (k) {
    if (!Array.isArray(state[k])) state[k] = [];
  });
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
  // Unconditional, like wireChoreAdd: boardAllowed can turn true mid-session on
  // a response, long after init() has run. Everything wired here lives inside
  // #boardView, which stays hidden until the server says otherwise, and every
  // write it can reach re-checks boardAllowed for itself.
  wireBoardControls();
  wireBoardDrag();
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
  // Not refresh(): a reload that restored the board has already asked for the
  // board (showView above), and that response carries the dashboard too.
  refreshVisible();
  flush();

  window.addEventListener('online', function () { flush(); refreshVisible(); });

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
