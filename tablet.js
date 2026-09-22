/** Pure New York holiday timing and date-qualified display data. */
var TABLET = (function () {
  'use strict';
  var TZ = 'America/New_York';
  var TASKS = ['Boil water', 'Plug in the plata', 'Cut toilet paper', 'Cut paper towels',
    'Set AC timers', 'Set up candles', 'Bathe the children'];
  function key(value) {
    return new Date(value).toLocaleDateString('en-CA', { timeZone: TZ });
  }
  function plus(date, n) {
    return new Date(Date.parse(date + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  }
  function hour(value) {
    return Number(new Date(value).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }));
  }
  function time(value) {
    if (!Number.isFinite(Date.parse(value))) return '—';
    return new Date(value).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).toLowerCase();
  }
  function day(date) {
    return new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
  }
  // Hebcal omits havdalah between adjacent holy days. Keep every lighting,
  // then close the whole interval at its final havdalah. Never bridge a week
  // when malformed/incomplete data loses an end event.
  function periods(items) {
    var out = [], current = null;
    (items || []).filter(function (x) {
      return (x.category === 'candles' || x.category === 'havdalah') && Number.isFinite(Date.parse(x.date));
    }).slice().sort(function (a, b) { return Date.parse(a.date) - Date.parse(b.date); }).forEach(function (x) {
      var ms = Date.parse(x.date);
      if (current && (ms - Date.parse(current.start) > 4 * 86400000 ||
          key(x.date) > plus(key(current.candles[current.candles.length - 1]), 1))) current = null;
      if (x.category === 'candles') {
        if (!current) current = { id: key(x.date), start: x.date, candles: [] };
        current.candles.push(x.date);
      } else if (current && ms > Date.parse(current.start)) {
        current.end = x.date;
        current.items = (items || []).filter(function (it) {
          return (it.yomtov === true || it.category === 'parashat') &&
            it.date.slice(0, 10) > current.id && it.date.slice(0, 10) <= key(x.date);
        });
        out.push(current); current = null;
      }
    });
    return out;
  }
  function mode(enabled, items, now) {
    if (!enabled) return { name: 'normal' };
    var ms = +new Date(now), today = key(now), ps = periods(items);
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (ms >= Date.parse(p.start) && ms < Date.parse(p.end)) return { name: 'holy', period: p };
      if (today === p.id && hour(now) >= 12 && ms < Date.parse(p.start)) return { name: 'prep', period: p };
    }
    return { name: 'normal' };
  }
  function displayDate(p, now) {
    // On the first evening show tomorrow's daytime zmanim; thereafter today's.
    var today = key(now);
    var nextLighting = p.candles.some(function (iso) { return key(iso) === today && +new Date(now) >= Date.parse(iso); });
    return today === p.id || (nextLighting && today < key(p.end)) ? plus(today, 1) : today;
  }
  function title(p, date) {
    var items = p.items.filter(function (x) { return x.date.slice(0, 10) === date; });
    var holiday = items.find(function (x) { return x.yomtov; });
    var parsha = items.find(function (x) { return x.category === 'parashat'; });
    return holiday ? holiday.title : (parsha ? 'Shabbat · ' + parsha.title.replace(/^Parashat\s+/, '') : 'Shabbat');
  }
  function sourceURL(value) {
    try { var u = new URL(value); return u.protocol === 'https:' && u.hostname === 'www.thebayit.org'; } catch (e) { return false; }
  }
  function bulletinURL(value) {
    try { var u = new URL(value); return u.protocol === 'https:' &&
      ((u.hostname === 'images.shulcloud.com' && u.pathname.indexOf('/111/uploads/bulletin/') === 0) || u.hostname === 'www.thebayit.org');
    } catch (e) { return false; }
  }
  function services(data, p, now) {
    if (!data || data.version !== 1 || !Array.isArray(data.services)) return [];
    return data.services.filter(function (s) {
      var ms = Date.parse(s.at);
      return s.minyan === 'main' && typeof s.label === 'string' &&
        (sourceURL(s.sourceUrl) || bulletinURL(s.sourceUrl)) &&
        Number.isFinite(ms) && key(s.at) >= key(now) && key(s.at) >= p.id &&
        key(s.at) <= key(p.end) && ms <= Date.parse(p.end) + 2 * 3600000 && ms >= +new Date(now) - 2 * 3600000;
    }).sort(function (a, b) { return Date.parse(a.at) - Date.parse(b.at); });
  }
  return { TZ: TZ, TASKS: TASKS, key: key, plus: plus, hour: hour, time: time,
    day: day, periods: periods, mode: mode, displayDate: displayDate, title: title, services: services, sourceURL: sourceURL, bulletinURL: bulletinURL };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = TABLET;
