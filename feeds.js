/**
 * Real weather and Jewish calendar. Replaces the old stubs.js.
 *
 * Both APIs are called straight from the browser on purpose. Apps Script's
 * UrlFetch quota is account-wide and shared with Capture the Thought, whose
 * pipeline halts silently if that account runs dry - so these must never move
 * server-side. Both send Access-Control-Allow-Origin: *, verified.
 *
 * EVERY date and time is computed in TZ, never in the device's local zone.
 * The device zone is wrong on a travelling phone and on any wall tablet with a
 * misconfigured clock, and "candle lighting" is the one number here that must
 * never be off by an hour. See tests/feeds.test.js.
 *
 * view() stays synchronous and always returns something sensible: it reads a
 * localStorage cache, so the dashboard still renders offline and on first paint
 * before anything has been fetched.
 */

var FEEDS = (function () {
  var ZIP = '10463';                 // Bronx, NY
  var LAT = 40.879335, LON = -73.910328;
  var TZ = 'America/New_York';
  var CANDLE_MINUTES = 18;           // minutes before sunset

  var WEATHER_KEY = 'fd.weather';
  var JEWISH_KEY = 'fd.jewish';
  var WEATHER_MAX_AGE = 30 * 60 * 1000;      // refetch after 30 min
  var WEATHER_SHOW_AGE = 6 * 3600 * 1000;    // past this, show nothing rather than lie
  var JEWISH_MAX_AGE = 6 * 3600 * 1000;

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // WMO weather codes, collapsed to what a person would actually say.
  function condition(code) {
    if (code === 0) return 'clear';
    if (code === 1) return 'mostly clear';
    if (code === 2) return 'partly cloudy';
    if (code === 3) return 'overcast';
    if (code === 45 || code === 48) return 'fog';
    if (code >= 51 && code <= 57) return 'drizzle';
    if (code >= 61 && code <= 67) return 'rain';
    if (code >= 71 && code <= 77) return 'snow';
    if (code >= 80 && code <= 82) return 'showers';
    if (code === 85 || code === 86) return 'snow showers';
    // Bounded: WMO codes stop at 99, and an unbounded >= 95 would report any
    // unexpected value as a thunderstorm.
    if (code >= 95 && code <= 99) return 'thunderstorms';
    return '';
  }

  /* ---------- time, always in TZ ---------- */

  /** 'YYYY-MM-DD' for the given instant, as seen in TZ. en-CA yields ISO order. */
  function dateKeyIn(d) {
    return d.toLocaleDateString('en-CA', { timeZone: TZ });
  }

  function dowIn(d) {
    return DAYS.indexOf(d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long' }));
  }

  function monthDayIn(d) {
    return d.toLocaleDateString('en-US', { timeZone: TZ, month: 'long', day: 'numeric' });
  }

  /** "8:01 pm" in TZ. ICU inserts a narrow no-break space before AM/PM. */
  function hhmm(iso) {
    var s = new Date(iso).toLocaleTimeString('en-US', {
      timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true
    });
    return s.replace(/[  ]/g, ' ')
            .replace(/\s*(AM|PM)/i, function (_, p) { return ' ' + p.toLowerCase(); });
  }

  /**
   * Whole days from today to a 'YYYY-MM-DD', both anchored at noon UTC so DST
   * cannot shift the count. `fromKey` exists so tests can pin "today" — the
   * function otherwise reads the system clock and is untestable.
   */
  function daysUntil(dateStr, fromKey) {
    var today = fromKey || dateKeyIn(new Date());
    var then = String(dateStr).slice(0, 10);
    return Math.round(
      (Date.parse(then + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 86400000
    );
  }

  function isToday(iso) {
    return !!iso && dateKeyIn(new Date(iso)) === dateKeyIn(new Date());
  }

  /**
   * Hebcal returns vowelled Hebrew including the year ("ו׳ בְּאָב תשפ״ו").
   * Nikud is noise at 14px, and the year is noise on a screen you glance at.
   */
  function hebrewDate(s) {
    var clean = String(s || '').replace(/[֑-ׇ]/g, '').trim();
    var parts = clean.split(/\s+/);
    return parts.length > 2 ? parts.slice(0, -1).join(' ') : clean;
  }

  /* ---------- cache ---------- */

  function load(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function age(rec) { return rec && rec.at ? Date.now() - rec.at : Infinity; }

  /* ---------- fetching ---------- */

  function fetchWeather() {
    var u = 'https://api.open-meteo.com/v1/forecast?latitude=' + LAT + '&longitude=' + LON +
            '&current=temperature_2m,weather_code' +
            '&daily=temperature_2m_max,temperature_2m_min' +
            '&temperature_unit=fahrenheit&timezone=' + encodeURIComponent(TZ) +
            '&forecast_days=1';
    return fetch(u).then(function (r) { return r.json(); }).then(function (d) {
      save(WEATHER_KEY, {
        at: Date.now(),
        temp: Math.round(d.current.temperature_2m),
        hi: Math.round(d.daily.temperature_2m_max[0]),
        lo: Math.round(d.daily.temperature_2m_min[0]),
        cond: condition(d.current.weather_code)
      });
    });
  }

  function fetchJewish() {
    var key = dateKeyIn(new Date()).split('-');       // TZ date, not device date
    var conv = 'https://www.hebcal.com/converter?cfg=json&gy=' + (+key[0]) +
               '&gm=' + (+key[1]) + '&gd=' + (+key[2]) + '&g2h=1&strict=1';
    var shab = 'https://www.hebcal.com/shabbat?cfg=json&zip=' + ZIP +
               '&b=' + CANDLE_MINUTES + '&M=on';

    return Promise.all([
      fetch(conv).then(function (r) { return r.json(); }),
      fetch(shab).then(function (r) { return r.json(); })
    ]).then(function (both) {
      var c = both[0], s = both[1];
      var rec = {
        at: Date.now(),
        dateKey: dateKeyIn(new Date()),
        hebrew: hebrewDate(c.hebrew),
        parsha: '',
        candles: null, havdalah: null,
        fastBegins: null, fastEnds: null,
        holidays: []
      };
      (s.items || []).forEach(function (it) {
        if (it.category === 'candles') rec.candles = { iso: it.date, time: hhmm(it.date) };
        else if (it.category === 'havdalah') rec.havdalah = { iso: it.date, time: hhmm(it.date) };
        else if (it.category === 'parashat') rec.parsha = it.title.replace(/^Parashat\s+/, '');
        else if (it.category === 'zmanim' && it.subcat === 'fast') {
          if (/begin/i.test(it.title)) rec.fastBegins = { iso: it.date, time: hhmm(it.date) };
          else rec.fastEnds = { iso: it.date, time: hhmm(it.date) };
        } else if (it.category === 'holiday' && it.subcat === 'major') {
          rec.holidays.push({ title: it.title, date: it.date });
        }
      });
      save(JEWISH_KEY, rec);
    });
  }

  /** Called from the poll loop; each feed decides for itself whether it is due. */
  function refreshIfStale(onUpdate) {
    if (!navigator.onLine) return;
    var jobs = [];
    if (age(load(WEATHER_KEY)) > WEATHER_MAX_AGE) jobs.push(fetchWeather());

    var j = load(JEWISH_KEY);
    if (age(j) > JEWISH_MAX_AGE || !j || j.dateKey !== dateKeyIn(new Date())) {
      jobs.push(fetchJewish());
    }
    if (!jobs.length) return;
    Promise.all(jobs.map(function (p) { return p.catch(function () {}); }))
      .then(function () { if (onUpdate) onUpdate(); });
  }

  /* ---------- view ---------- */

  function view() {
    var now = new Date();
    var dow = dowIn(now);
    var w = load(WEATHER_KEY);
    var j = load(JEWISH_KEY);

    var v = {
      dow: dow,
      day: DAYS[dow],
      sub: monthDayIn(now),
      temp: '—',
      cond: '',
      events: [],
      // Google Calendar needs OAuth, so it has to come through Apps Script and
      // is not wired up yet. Say so rather than implying the day is empty.
      eventsNote: 'Calendar not connected yet',
      aheadLabel: 'Tomorrow',
      // Structured, not markup: app.js renders these with textContent so remote
      // strings can never become HTML.
      aheadLines: [],
      countdown: null,
      alert: null
    };

    // A temperature from this morning is worse than no temperature.
    if (w && age(w) < WEATHER_SHOW_AGE) {
      v.temp = w.temp + '°';
      v.cond = w.lo + '–' + w.hi + (w.cond ? ' · ' + w.cond : '');
    }

    if (j) {
      if (j.hebrew) v.sub += ' · ' + j.hebrew;
      if (j.parsha) v.sub += ' · ' + j.parsha;

      if (j.candles) v.aheadLines.push({ label: 'Candles', value: j.candles.time });
      if (j.havdalah) v.aheadLines.push({ label: 'Havdalah', value: j.havdalah.time });

      // Thursday onward, Shabbat stops being a footnote.
      if (dow === 6) v.aheadLabel = 'Tonight';
      else if (dow === 5) v.aheadLabel = 'Shabbat';
      else if (dow === 4) v.aheadLabel = 'Tomorrow · Friday';
      else if (v.aheadLines.length) v.aheadLabel = 'This Shabbat';

      // Bottom bar: the single most time-critical thing, in priority order.
      if (j.fastBegins && isToday(j.fastBegins.iso)) v.alert = 'Fast begins ' + j.fastBegins.time;
      else if (j.fastEnds && isToday(j.fastEnds.iso)) v.alert = 'Fast ends ' + j.fastEnds.time;
      else if (j.candles && isToday(j.candles.iso)) v.alert = 'Candles ' + j.candles.time;
      else if (j.havdalah && isToday(j.havdalah.iso)) v.alert = 'Havdalah ' + j.havdalah.time;

      var soon = (j.holidays || [])
        .map(function (h) { return { title: h.title, days: daysUntil(h.date) }; })
        .filter(function (h) { return h.days >= 0; })
        .sort(function (a, b) { return a.days - b.days; })[0];
      if (soon) {
        v.countdown = { label: soon.title, days: soon.days };
        if (!v.alert && soon.days === 0) v.alert = soon.title;
      }
    }

    return v;
  }

  return {
    view: view,
    refreshIfStale: refreshIfStale,
    // Exposed for tests/feeds.test.js only.
    _test: { hhmm: hhmm, daysUntil: daysUntil, dateKeyIn: dateKeyIn, dowIn: dowIn,
             monthDayIn: monthDayIn, hebrewDate: hebrewDate, condition: condition,
             isToday: isToday, TZ: TZ }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FEEDS;
