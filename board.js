/**
 * Pure board logic: card ordering, which horizon a card sits in, how urgent its
 * due date is, and how faded an untouched card should look. No DOM, no state,
 * no network — app.js owns those. Kept pure so it can be unit-tested the way
 * chores.js is (tests/board.test.js), and so the view stays correct offline
 * where the client recomputes all of it locally.
 *
 * EVERY date is bucketed in TZ, never the device zone — a card due today must
 * not read as overdue on a laptop a few zones over.
 */
var BOARD = (function () {
  // Positions are spaced integers with midpoint insertion, the same scheme
  // Trello uses. Repeated drops into the same gap halve it, so once neighbours
  // are closer than MIN_GAP the list is respaced rather than left to collapse
  // into float noise.
  var STEP = 1000;
  var MIN_GAP = 2;
  var TZ = 'America/New_York';
  var LISTS = ['now', 'week', 'later', 'someday', 'done'];

  // Aging is deliberately slow: a card should recede only once it has genuinely
  // been left alone, and never fade so far it becomes unreadable.
  var AGE_START = 14;
  var AGE_FULL = 60;

  /** Position for a card dropped between two neighbours. Either may be null. */
  function posBetween(before, after) {
    if (before == null && after == null) return STEP;
    if (before == null) return after - STEP;
    if (after == null) return before + STEP;
    return (before + after) / 2;
  }

  /** True when any adjacent pair in this ordered list has closed up. */
  function needsRenormalize(positions) {
    for (var i = 1; i < positions.length; i++) {
      if (Math.abs(positions[i] - positions[i - 1]) < MIN_GAP) return true;
    }
    return false;
  }

  /** Evenly respaced positions for a list of n cards, order preserved. */
  function renormalize(n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push((i + 1) * STEP);
    return out;
  }

  /** 'YYYY-MM-DD' for an ISO instant, as seen in TZ. en-CA yields ISO order. */
  function dateKeyIn(iso) {
    return new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
  }

  /** A 'YYYY-MM-DD' key as an exact integer day count, read as midnight UTC. */
  function dayNum(key) {
    return Math.round(Date.parse(key + 'T00:00:00Z') / 86400000);
  }

  /** Whole days from today (in TZ) to a 'YYYY-MM-DD' date. Negative = past. */
  function daysUntil(key, nowIso) {
    return dayNum(key) - dayNum(dateKeyIn(nowIso));
  }

  /** Feeds may hand us a full ISO timestamp; only the calendar date matters here. */
  function dueKey(due) { return String(due || '').slice(0, 10); }

  /** The lists a card can be in, each sorted by position. */
  function group(cards) {
    var out = {};
    LISTS.forEach(function (l) { out[l] = []; });
    (cards || []).forEach(function (c) {
      var l = LISTS.indexOf(c.list) === -1 ? 'later' : c.list;
      out[l].push(c);
    });
    LISTS.forEach(function (l) {
      out[l].sort(function (a, b) { return (a.pos || 0) - (b.pos || 0); });
    });
    return out;
  }

  /** How urgent a card's due date is. Styling only — nothing acts on this. */
  function dueState(card, nowIso) {
    if (!card || !card.due) return 'none';
    var d = daysUntil(dueKey(card.due), nowIso);
    if (d < 0) return 'overdue';
    if (d === 0) return 'today';
    if (d <= 3) return 'soon';
    return 'none';
  }

  /**
   * 0 while a card is fresh, ramping to 1 once it has sat untouched for
   * AGE_FULL days. The view maps this onto opacity, so an ignored card visibly
   * recedes — the one Trello idea aimed at cards rotting unlooked-at.
   */
  function ageLevel(card, nowIso) {
    var stamp = (card && (card.updated_at || card.created_at)) || '';
    if (!stamp) return 0;
    var days = -daysUntil(dateKeyIn(stamp), nowIso);
    if (!(days > AGE_START)) return 0;  // also catches NaN from a malformed stamp
    if (days >= AGE_FULL) return 1;
    return (days - AGE_START) / (AGE_FULL - AGE_START);
  }

  /**
   * Which horizon an item arriving from a feed (voice capture, vault sweep)
   * belongs in. Undated work goes to 'later' rather than jumping the queue.
   */
  function placeByDue(due, nowIso) {
    if (!due) return 'later';
    var d = daysUntil(dueKey(due), nowIso);
    if (d <= 3) return 'now';
    if (d <= 14) return 'week';
    return 'later';
  }

  return {
    LISTS: Object.freeze(LISTS.slice()),  // a frozen copy — the view iterates
                                   // these to draw its columns; frozen so a
                                   // caller can neither mutate the array
                                   // group() closes over internally nor grow
                                   // this one out from under a future
                                   // groups[name] lookup
    posBetween: posBetween,
    needsRenormalize: needsRenormalize,
    renormalize: renormalize,
    group: group,
    dueState: dueState,
    ageLevel: ageLevel,
    placeByDue: placeByDue,
    _test: { TZ: TZ, STEP: STEP, MIN_GAP: MIN_GAP,
             dateKeyIn: dateKeyIn, dayNum: dayNum, daysUntil: daysUntil,
             dueKey: dueKey }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = BOARD;
