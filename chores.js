/**
 * Pure chore logic: "is this chore due now?" and how to group the list for the
 * two views. No DOM, no state, no network — app.js owns those. Kept pure so it
 * can be unit-tested the way feeds.js is (tests/chores.test.js), and so the
 * "due" decision stays correct offline where the client recomputes it locally.
 *
 * EVERY date is bucketed in TZ, never the device zone — a chore marked done at
 * 11pm must not read as "yesterday" on a phone a few zones over.
 */
var CHORES = (function () {
  var TZ = 'America/New_York';

  /** 'YYYY-MM-DD' for an ISO instant, as seen in TZ. en-CA yields ISO order. */
  function dateKeyIn(iso) {
    return new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
  }

  /**
   * The Sunday-anchored week's start, as a day-number, for a 'YYYY-MM-DD' key.
   * The key is read as midnight UTC — an exact integer day count, so no half-day
   * rounding can push a Saturday into the next week. 1970-01-01 was a Thursday,
   * so (dayNum + 4) % 7 is days-since-Sunday. Two dates share a week iff equal.
   */
  function weekIndex(key) {
    var dayNum = Math.round(Date.parse(key + 'T00:00:00Z') / 86400000);
    return dayNum - ((dayNum + 4) % 7);
  }

  /** Was this chore already handled in its current period? */
  function done(chore, nowIso) {
    if (!chore.last_done_at) return false;
    var last = dateKeyIn(chore.last_done_at);
    var today = dateKeyIn(nowIso);
    if (chore.cadence === 'daily') return last === today;
    return weekIndex(last) === weekIndex(today);   // weekly (default)
  }

  /** A chore is due when it hasn't been handled this period. */
  function due(chore, nowIso) { return !done(chore, nowIso); }

  /** Handled *today* specifically — drives the "handled today" glance. */
  function doneToday(chore, nowIso) {
    return !!chore.last_done_at && dateKeyIn(chore.last_done_at) === dateKeyIn(nowIso);
  }

  /**
   * Split the chores into the three lists the view shows. `who` is this device's
   * person. Ownership decides mine-vs-partner; either person can still complete
   * either list (coverage), so this is display grouping only.
   */
  function group(chores, who, nowIso) {
    var out = { mine: [], partner: [], handledToday: [] };
    (chores || []).forEach(function (c) {
      if (doneToday(c, nowIso)) out.handledToday.push(c);
      if (due(c, nowIso)) (c.owner === who ? out.mine : out.partner).push(c);
    });
    return out;
  }

  return {
    due: due, group: group,
    _test: { dateKeyIn: dateKeyIn, weekIndex: weekIndex, done: done, doneToday: doneToday, TZ: TZ }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CHORES;
