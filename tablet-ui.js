/** Kitchen-tablet-only display. Public feeds never contain family data. */
var TABLET_UI = (function () {
  'use strict';
  var PREF = 'fd.tablet', CACHE = 'fd.tabletfeeds', CHECKS = 'fd.shabbatchecks';
  var data = read(CACHE, {}), inflight = false, lastTry = 0, lastMode = '', prepId = '';
  var ZMANIM = [['sunrise', 'Sunrise'], ['sofZmanShmaMGA', 'Latest Shema · MGA'],
    ['sofZmanShma', 'Latest Shema · GRA'], ['sofZmanTfilla', 'Latest Shacharit · GRA'],
    ['chatzot', 'Chatzot'], ['minchaGedola', 'Mincha Gedola'], ['sunset', 'Sunset']];
  function read(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) || fallback; } catch (e) { return fallback; } }
  function write(k, value) { try { localStorage.setItem(k, JSON.stringify(value)); } catch (e) {} }
  function enabled() { return localStorage.getItem(PREF) === '1'; }
  function el(id) { return document.getElementById(id); }
  function node(tag, text, cls) { var n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; }
  function json(url) {
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 20000);
    return fetch(url, { cache: 'no-store', signal: controller.signal }).then(function (r) {
      if (!r.ok) throw new Error('Feed unavailable'); return r.json();
    }).finally(function () { clearTimeout(timer); });
  }
  function changed() { write(CACHE, data); render(); }
  function refresh() {
    if (!enabled() || !navigator.onLine || inflight || Date.now() - lastTry < 60000) return;
    lastTry = Date.now(); inflight = true;
    var now = Date.now(), today = TABLET.key(now), jobs = [];
    if (!data.calendar || now - data.calendar.at > 6 * 3600000 || data.calendar.day !== today) {
      var url = 'https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&c=on&zip=10463&b=18&M=on&s=on&i=off&leyning=off&start=' + TABLET.plus(today, -7) + '&end=' + TABLET.plus(today, 28);
      jobs.push(json(url).then(function (d) {
        if (!Array.isArray(d.items) || !TABLET.periods(d.items).length) throw new Error('Incomplete calendar');
        var active = TABLET.mode(true, data.calendar && data.calendar.items, Date.now());
        if (active.name === 'holy' && TABLET.mode(true, d.items, Date.now()).name !== 'holy') {
          throw new Error('Calendar lost an active interval');
        }
        data.calendar = { at: Date.now(), day: today, items: d.items }; changed();
      }));
    }
    if (!data.weather || now - data.weather.at > 30 * 60000) {
      jobs.push(json('https://api.open-meteo.com/v1/forecast?latitude=40.879335&longitude=-73.910328&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=America%2FNew_York&timeformat=unixtime&forecast_days=7').then(function (d) {
        if (!d.hourly || !Array.isArray(d.hourly.time)) throw new Error('No hourly forecast');
        data.weather = { at: Date.now(), hourly: d.hourly }; changed();
      }));
    }
    if (!data.hirAt || now - data.hirAt > 30 * 60000) {
      jobs.push(json('hir-schedule.json').then(function (d) {
        if (d.version !== 1 || !Array.isArray(d.services)) throw new Error('Invalid HIR schedule');
        data.hir = d; data.hirAt = Date.now(); changed();
      }));
    }
    // Cache upcoming days before candle lighting, including a three-day Yom Tov.
    data.zmanim = data.zmanim || {};
    for (var i = 0; i < 5; i++) (function (date) {
      if (data.zmanim[date]) return;
      jobs.push(json('https://www.hebcal.com/zmanim?cfg=json&zip=10463&date=' + date).then(function (d) {
        if (d.date !== date || !d.times || !d.times.sunset) throw new Error('Wrong zmanim date');
        data.zmanim[date] = d.times; changed();
      }));
    })(TABLET.plus(today, i));
    Object.keys(data.zmanim).forEach(function (date) { if (date < TABLET.plus(today, -2)) delete data.zmanim[date]; });
    Promise.all(jobs.map(function (p) { return p.catch(function () {}); })).finally(function () { inflight = false; });
  }
  function row(container, label, value, extra) {
    var r = node('div', null, 'holy-row'); r.appendChild(node('span', label));
    r.appendChild(node('strong', value)); container.appendChild(r);
    if (extra) container.appendChild(node('div', extra, 'holy-detail'));
  }
  function prep(p) {
    el('prepHeading').textContent = 'Getting ready · ' + TABLET.title(p, TABLET.plus(p.id, 1));
    el('prepCandles').textContent = 'Candle lighting ' + TABLET.time(p.start);
    if (prepId === p.id) return;
    prepId = p.id;
    var record = read(CHECKS, {});
    if (record.id !== p.id) { record = { id: p.id, done: [] }; write(CHECKS, record); }
    var list = el('prepTasks'); list.replaceChildren();
    TABLET.TASKS.forEach(function (task, i) {
      var label = node('label', null, 'prep-task'), input = node('input');
      input.type = 'checkbox'; input.checked = record.done.indexOf(i) !== -1;
      input.addEventListener('change', function () {
        var current = read(CHECKS, { id: p.id, done: [] });
        current.done = current.done.filter(function (x) { return x !== i; });
        if (input.checked) current.done.push(i); write(CHECKS, current);
      });
      label.appendChild(input); label.appendChild(node('span', task)); list.appendChild(label);
    });
  }
  function holy(p, now) {
    var date = TABLET.displayDate(p, now);
    el('holyTitle').textContent = TABLET.title(p, date);
    el('holyDate').textContent = TABLET.day(date) + ' · ';
    var hebrew = node('bdi', new Date(date + 'T12:00:00Z').toLocaleDateString('he-IL-u-ca-hebrew', { timeZone: TABLET.TZ, day: 'numeric', month: 'long', year: 'numeric' }));
    hebrew.dir = 'rtl'; hebrew.lang = 'he'; el('holyDate').appendChild(hebrew);
    el('holyClock').textContent = TABLET.time(new Date(now).toISOString());
    el('holyEnd').textContent = 'Ends ' + TABLET.day(TABLET.key(p.end)) + ' · ' + TABLET.time(p.end);
    var z = el('holyZmanim'); z.replaceChildren();
    var times = data.zmanim && data.zmanim[date];
    if (times) ZMANIM.forEach(function (pair) { if (times[pair[0]]) row(z, pair[1], TABLET.time(times[pair[0]])); });
    else z.appendChild(node('p', 'Zmanim unavailable for this date.'));
    p.candles.filter(function (iso) { return Date.parse(iso) > now; }).forEach(function (iso) {
      row(z, 'Candles · ' + TABLET.day(TABLET.key(iso)), TABLET.time(iso));
    });
    var h = el('holyServices'); h.replaceChildren();
    var services = TABLET.services(data.hir, p, now);
    if (!services.length) h.appendChild(node('p', 'HIR schedule not yet verified for these dates.', 'holy-detail'));
    services.slice(0, 5).forEach(function (s) {
      row(h, s.label, TABLET.time(s.at), TABLET.day(TABLET.key(s.at)));
      if (s.speaker && s.bulletinDate === TABLET.key(s.at) && TABLET.bulletinURL(s.bulletinUrl)) {
        h.appendChild(node('div', 'Drasha · ' + s.speaker, 'holy-speaker'));
      }
    });
    if (services.length > 5) h.appendChild(node('div', 'Next 5 of ' + services.length + ' services · advances automatically', 'holy-detail'));
    el('hirChecked').textContent = services.length && data.hir.checkedAt ? 'Verified ' + TABLET.day(TABLET.key(data.hir.checkedAt)) + ' · HIR / The Bayit' : 'HIR / The Bayit';
    var w = el('holyHours'); w.replaceChildren();
    var weather = data.weather, age = weather ? now - weather.at : Infinity;
    if (!weather || age > 24 * 3600000) {
      w.appendChild(node('p', 'Hourly weather unavailable.'));
      el('weatherChecked').textContent = 'Waiting for a current forecast'; return;
    }
    var hourly = weather.hourly;
    var indices = hourly.time.map(function (t, i) { return i; }).filter(function (i) {
      return hourly.time[i] * 1000 >= Math.floor(now / 3600000) * 3600000 && hourly.time[i] * 1000 < Date.parse(p.end);
    }).slice(0, 6);
    function val(field, i, suffix, digits) {
      var v = hourly[field] && hourly[field][i];
      return v == null || !Number.isFinite(v) ? '—' : (digits ? v.toFixed(digits) : Math.round(v)) + suffix;
    }
    indices.forEach(function (i) {
      var iso = new Date(hourly.time[i] * 1000).toISOString(), card = node('div', null, 'holy-hour');
      card.appendChild(node('div', TABLET.time(iso), 'hour-label'));
      if (TABLET.key(iso) !== TABLET.key(now)) card.appendChild(node('div', TABLET.day(TABLET.key(iso)), 'holy-detail'));
      card.appendChild(node('div', val('temperature_2m', i, '°'), 'hour-temp'));
      card.appendChild(node('div', FEEDS._test.condition(hourly.weather_code[i])));
      card.appendChild(node('div', 'Feels ' + val('apparent_temperature', i, '°')));
      card.appendChild(node('div', 'Rain ' + val('precipitation_probability', i, '%')));
      card.appendChild(node('div', val('precipitation', i, ' in', 2) + ' · ' + val('wind_speed_10m', i, ' mph')));
      w.appendChild(card);
    });
    if (!indices.length) w.appendChild(node('p', 'No remaining hourly forecast for this period.'));
    el('weatherChecked').textContent = (age > 3 * 3600000 ? 'Older forecast · ' : 'Updated ') + TABLET.day(TABLET.key(weather.at)) + ' ' + TABLET.time(new Date(weather.at).toISOString()) + ' · Open-Meteo';
  }
  function render() {
    var now = Date.now(), m = TABLET.mode(enabled(), data.calendar && data.calendar.items, now);
    document.body.classList.toggle('tablet-prep', m.name === 'prep');
    document.body.classList.toggle('tablet-holy', m.name === 'holy');
    el('prepView').hidden = m.name !== 'prep'; el('holyView').hidden = m.name !== 'holy';
    if (m.name !== lastMode && m.name !== 'normal') {
      showView('dashboard'); el('menu').hidden = true;
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    }
    if (m.name === 'prep') prep(m.period);
    if (m.name === 'holy') {
      el('prepTasks').replaceChildren(); prepId = ''; holy(m.period, now);
    }
    if (m.name !== 'prep') prepId = '';
    lastMode = m.name;
    el('tabletToggle').setAttribute('aria-pressed', String(enabled()));
    el('tabletStatus').textContent = enabled() && !data.calendar ? 'Tablet mode: waiting for holiday times' : '';
  }
  function init() {
    el('tabletToggle').addEventListener('click', function () {
      if (enabled()) localStorage.removeItem(PREF); else {
        localStorage.setItem(PREF, '1');
        if (wakeLockSupported()) applyAwake(true);
      }
      render(); refresh();
    });
    // Exact transition on a running tablet; recalculate from timestamps after sleep.
    setInterval(function () {
      if (!enabled()) return;
      var m = TABLET.mode(true, data.calendar && data.calendar.items, Date.now());
      if (m.name !== lastMode || new Date().getSeconds() === 0) render();
    }, 1000);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { render(); refresh(); } });
    render(); refresh(); setInterval(refresh, 60000);
  }
  return { init: init, render: render, enabled: enabled };
})();
