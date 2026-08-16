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
  var RAIN_PROB = 50;                // % chance at which an hour counts as "rain"

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

  // A precipitation code is one whose plain word is wet; drives the rain verb.
  function precipWord(code) {
    var w = condition(code);
    return (w === 'drizzle' || w === 'rain' || w === 'showers' ||
            w === 'snow' || w === 'snow showers' || w === 'thunderstorms') ? w : 'rain';
  }

  /** Bare hour, no minutes: 14 -> "2 pm", 0 -> "12 am". */
  function hourLabel(h) {
    var ampm = h >= 12 ? 'pm' : 'am';
    var hh = h % 12; if (hh === 0) hh = 12;
    return hh + ' ' + ampm;
  }

  /**
   * The next stretch of rain today, as a short phrase ("rain 2-5 pm",
   * "showers til 4 pm"), or '' if none is coming. Pure and timezone-safe:
   * Open-Meteo hourly times are already NY-local strings, so the hour is read
   * straight from the ISO text and compared against nowHour (also NY) - no Date
   * parsing, which is where the earlier timezone bugs lived. `todayKey` and
   * `nowHour` are passed in so this can be pinned in tests.
   */
  function rainPhrase(hourly, todayKey, nowHour) {
    if (!hourly || !hourly.time || !hourly.precipitation_probability) return '';
    var times = hourly.time, probs = hourly.precipitation_probability, codes = hourly.weather_code || [];

    var startH = -1, lastH = -1, peakCode = 0;
    for (var i = 0; i < times.length; i++) {
      if (times[i].slice(0, 10) !== todayKey) continue;      // today only
      var h = parseInt(times[i].slice(11, 13), 10);
      if (h < nowHour) continue;                             // future (or current) hours only
      var wet = (probs[i] || 0) >= RAIN_PROB;
      if (wet) {
        if (startH === -1) startH = h;
        lastH = h;
        if ((codes[i] || 0) > peakCode) peakCode = codes[i] || 0;
      } else if (startH !== -1) {
        break;                                               // first contiguous block only
      }
    }
    if (startH === -1) return '';

    var verb = precipWord(peakCode);
    var endH = Math.min(lastH + 1, 23);                      // block runs through the last wet hour
    if (startH <= nowHour) return verb + ' til ' + hourLabel(endH);
    var a = hourLabel(startH), b = hourLabel(endH);
    // collapse the shared am/pm: "2-5 pm" rather than "2 pm-5 pm"
    if (a.slice(-2) === b.slice(-2)) a = a.slice(0, -3);
    return verb + ' ' + a + '-' + b;
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

  /** Current hour (0-23) as seen in TZ, so rain timing never uses the device zone. */
  function nowHourIn(d) {
    return parseInt(d.toLocaleTimeString('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }), 10);
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
            '&hourly=precipitation_probability,weather_code' +
            '&temperature_unit=fahrenheit&timezone=' + encodeURIComponent(TZ) +
            '&forecast_days=1';
    return fetch(u).then(function (r) { return r.json(); }).then(function (d) {
      var now = new Date();
      save(WEATHER_KEY, {
        at: Date.now(),
        temp: Math.round(d.current.temperature_2m),
        hi: Math.round(d.daily.temperature_2m_max[0]),
        lo: Math.round(d.daily.temperature_2m_min[0]),
        cond: condition(d.current.weather_code),
        rain: rainPhrase(d.hourly, dateKeyIn(now), nowHourIn(now))
      });
    });
  }

  /** 'gy=2026&gm=8&gd=14' from a 'YYYY-MM-DD' key, unpadded as Hebcal wants. */
  function hebcalDate(key) {
    var p = String(key).split('-');
    return 'gy=' + (+p[0]) + '&gm=' + (+p[1]) + '&gd=' + (+p[2]);
  }

  function converterUrl(key) {
    return 'https://www.hebcal.com/converter?cfg=json&' + hebcalDate(key) + '&g2h=1&strict=1';
  }

  /**
   * Both Hebcal URLs pin the date they are asking about.
   *
   * The converter always did, because it has to. /shabbat did not: it answers
   * "the upcoming Shabbat" for whoever is asking, so its URL used to be
   * byte-identical every day of the year - a single cache key whose correct
   * answer changes every week. Nothing in this file controlled that response's
   * lifetime, and on 14 Aug 2026 a cache somewhere between a tablet and Hebcal
   * served the previous week's copy for days: the dashboard showed a correct,
   * current Hebrew date beside last week's parsha and a candle time nine
   * minutes late, with every internal freshness check satisfied.
   *
   * Pinning the date makes each day its own cache key, exactly like the
   * converter, which also flips Hebcal's week-long max-age on the dated form
   * from a hazard into a correct answer. `cache: 'no-cache'` on top forces
   * revalidation rather than trusting any of it - the same defence, and for the
   * same reason, as the one documented in sw.js.
   */
  function shabbatUrl(key) {
    return 'https://www.hebcal.com/shabbat?cfg=json&zip=' + ZIP +
           '&b=' + CANDLE_MINUTES + '&M=on&' + hebcalDate(key);
  }

  var REVALIDATE = { cache: 'no-cache' };

  function fetchJewish() {
    var key = dateKeyIn(new Date());                  // TZ date, not device date

    return Promise.all([
      fetch(converterUrl(key), REVALIDATE).then(function (r) { return r.json(); }),
      fetch(shabbatUrl(key), REVALIDATE).then(function (r) { return r.json(); })
    ]).then(function (both) {
      var c = both[0], s = both[1];
      var rec = {
        at: Date.now(),
        // Stamped with the key the request was built from, not with "now". A
        // fetch that straddles midnight describes the day it asked about, and
        // refreshIfStale should see that and go again.
        dateKey: key,
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

  /**
   * The parsha, candle lighting and havdalah describe one specific Shabbat, and
   * they stop being true the moment that Shabbat is over. This checks the
   * payload's own timestamps rather than how long ago it was fetched, and that
   * distinction is the whole point: on 14 Aug 2026 the record had been written
   * that morning - fresh by every measure the app had - while the Shabbat half
   * of it described the week before. Only the times inside it could give that
   * away. Weather gets the same protection a different way, by refusing to
   * render once it is old enough to lie (see WEATHER_SHOW_AGE).
   *
   * Passing a time also retires it. Once candles are lit that line disappears
   * instead of sitting under Saturday's "Tonight" heading all day advertising a
   * lighting that already happened, and once havdalah passes the block empties
   * out rather than showing a Shabbat in the past tense.
   *
   * Anything unreadable is treated as expired. A candle-lighting time is the
   * one number here that is worse wrong than missing.
   */
  function shabbatNow(j, nowMs) {
    var out = { parsha: '', candles: null, havdalah: null };
    if (!j) return out;

    var lit = j.candles ? Date.parse(j.candles.iso) : NaN;
    var done = j.havdalah ? Date.parse(j.havdalah.iso) : NaN;
    var candlesAhead = !isNaN(lit) && nowMs < lit;
    var havdalahAhead = !isNaN(done) && nowMs < done;

    // Nothing in the block is still ahead, so it belongs to a Shabbat that is
    // finished. A week-stale record and one that simply expired an hour ago are
    // indistinguishable here, and both should show nothing.
    if (!candlesAhead && !havdalahAhead) return out;

    out.parsha = j.parsha || '';
    if (candlesAhead) out.candles = j.candles;
    if (havdalahAhead) out.havdalah = j.havdalah;
    return out;
  }

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
      // When rain is coming, its timing is the useful thing to show, so it
      // takes the condition slot ("64–83 · rain 2–5 pm"); otherwise the plain
      // condition word ("64–83 · clear").
      var tail = w.rain || w.cond;
      v.cond = w.lo + '–' + w.hi + (tail ? ' · ' + tail : '');
    }

    if (j) {
      // The Hebrew date is dated by the request that fetched it, so it stands
      // on its own; everything below is only as good as its own timestamps.
      var shab = shabbatNow(j, now.getTime());

      if (j.hebrew) v.sub += ' · ' + j.hebrew;
      if (shab.parsha) v.sub += ' · ' + shab.parsha;

      if (shab.candles) v.aheadLines.push({ label: 'Candles', value: shab.candles.time });
      if (shab.havdalah) v.aheadLines.push({ label: 'Havdalah', value: shab.havdalah.time });

      // Thursday onward, Shabbat stops being a footnote.
      if (dow === 6) v.aheadLabel = 'Tonight';
      else if (dow === 5) v.aheadLabel = 'Shabbat';
      else if (dow === 4) v.aheadLabel = 'Tomorrow · Friday';
      else if (v.aheadLines.length) v.aheadLabel = 'This Shabbat';

      // Bottom bar: the single most time-critical thing, in priority order.
      if (j.fastBegins && isToday(j.fastBegins.iso)) v.alert = 'Fast begins ' + j.fastBegins.time;
      else if (j.fastEnds && isToday(j.fastEnds.iso)) v.alert = 'Fast ends ' + j.fastEnds.time;
      // shab, not j: the alert bar is the most prominent thing on the screen and
      // must not outlive the time it is announcing either.
      else if (shab.candles && isToday(shab.candles.iso)) v.alert = 'Candles ' + shab.candles.time;
      else if (shab.havdalah && isToday(shab.havdalah.iso)) v.alert = 'Havdalah ' + shab.havdalah.time;

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
             isToday: isToday, rainPhrase: rainPhrase, hourLabel: hourLabel, TZ: TZ,
             shabbatNow: shabbatNow, shabbatUrl: shabbatUrl, converterUrl: converterUrl }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FEEDS;
