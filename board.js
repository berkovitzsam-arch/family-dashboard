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

  return {
    posBetween: posBetween,
    needsRenormalize: needsRenormalize,
    renormalize: renormalize,
    _test: { STEP: STEP, MIN_GAP: MIN_GAP }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = BOARD;
