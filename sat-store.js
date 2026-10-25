/* =====================================================================
   sat-store.js — вход по имени (без пароля) + сохранение прогресса и результатов
   ---------------------------------------------------------------------
   Подключается на любой странице сайта:   <script src="sat-store.js"></script>
   Использование:
     SatStore.requireLogin().then(user => { ... });   // покажет окно входа, если имя ещё не введено
     SatStore.getProgress(testId) / setProgress(testId, obj) / clearProgress(testId)
     SatStore.getAttempts(testId) / addAttempt(testId, obj)
     SatStore.mountUserBar()                           // рисует «👤 Имя · Сменить» во всех [data-userbar]

   Где хранятся данные: по умолчанию в localStorage этого браузера (ключи satprep:v1:*).
   Это значит: данные переживают обновление страницы и повторное открытие сайта,
   но живут на ОДНОМ устройстве/браузере. Чтобы хранить их на сервере (общие для всех
   устройств), достаточно вызвать до requireLogin():
       SatStore.setBackend({ get: key => Promise<string|null>, set: (key, str) => Promise,
                             del: key => Promise, keys: () => Promise<string[]> });
   Остальной код менять не нужно.
   ===================================================================== */
(function () {
  'use strict';
  var NS = 'satprep:v1:';

  /* ---------- backend (по умолчанию localStorage, с запасным вариантом в памяти) ---------- */
  var mem = {};
  function lsOk() { try { var k = NS + '__t'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; } catch (e) { return false; } }
  var HAS_LS = lsOk();
  var localBackend = {
    get: function (k) { try { return Promise.resolve(HAS_LS ? localStorage.getItem(k) : (k in mem ? mem[k] : null)); } catch (e) { return Promise.resolve(null); } },
    set: function (k, v) { try { if (HAS_LS) localStorage.setItem(k, v); else mem[k] = v; return Promise.resolve(); } catch (e) { return Promise.reject(e); } },
    del: function (k) { try { if (HAS_LS) localStorage.removeItem(k); else delete mem[k]; } catch (e) {} return Promise.resolve(); },
    keys: function () {
      var out = [];
      try { if (HAS_LS) { for (var i = 0; i < localStorage.length; i++) out.push(localStorage.key(i)); } else out = Object.keys(mem); } catch (e) {}
      return Promise.resolve(out);
    }
  };
  var backend = localBackend;

  /* ---------- состояние ---------- */
  var user = null;      // { key, name }
  var doc = null;       // { name, created, tests: { [testId]: { progress, attempts: [] } } }
  var saveTimer = 0, dirty = false, warnedFail = false;

  function normKey(name) { return name.trim().replace(/\s+/g, ' ').toLowerCase(); }
  function cleanName(name) { return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40); }
  function userKey(k) { return NS + 'user:' + encodeURIComponent(k); }
  function T(id) {
    if (!doc) throw new Error('SatStore: сначала requireLogin()');
    if (!doc.tests[id]) doc.tests[id] = { progress: null, attempts: [] };
    return doc.tests[id];
  }

  function flush() {
    clearTimeout(saveTimer); saveTimer = 0;
    if (!dirty || !user) return Promise.resolve();
    dirty = false;
    return backend.set(userKey(user.key), JSON.stringify(doc)).then(function () { warnedFail = false; }, function () {
      dirty = true;
      if (!warnedFail) { warnedFail = true; alert('Не удалось сохранить прогресс в браузере (память заполнена или запрещена). Результаты могут не сохраниться.'); }
    });
  }
  function persist(now) {
    dirty = true;
    if (now) return flush();
    if (!saveTimer) saveTimer = setTimeout(flush, 250);
    return Promise.resolve();
  }
  window.addEventListener('pagehide', function () { flush(); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });

  /* ---------- стили окна входа ---------- */
  function injectCss() {
    if (document.getElementById('satstore-css')) return;
    var s = document.createElement('style'); s.id = 'satstore-css';
    s.textContent =
      '.ss-ov{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg,#F6F7F9);font-family:"Helvetica Neue",Arial,sans-serif;color:var(--ink,#1B2430)}' +
      '.ss-box{width:100%;max-width:420px;background:var(--card-bg,#fff);border:1px solid var(--line,#DCE1E9);border-radius:18px;padding:28px 26px;box-shadow:0 10px 40px rgba(0,0,0,.12)}' +
      '.ss-box h2{font-family:Georgia,serif;font-weight:400;font-size:26px;margin:0 0 6px;color:var(--head,#0C2340)}' +
      '.ss-box p{margin:0 0 16px;font-size:14px;line-height:1.55;color:var(--muted,#5A6577)}' +
      '.ss-box input[type=text]{width:100%;padding:13px 14px;font-size:16px;border-radius:12px;border:1.5px solid var(--line,#DCE1E9);background:var(--bg,#F6F7F9);color:var(--ink,#1B2430);font-family:inherit}' +
      '.ss-box input[type=text]:focus{outline:none;border-color:var(--accent,#7A3FE0)}' +
      '.ss-btn{display:inline-block;border:0;border-radius:12px;padding:12px 22px;font-size:15px;font-weight:700;background:var(--accent,#7A3FE0);color:#fff;font-family:inherit;cursor:pointer}' +
      '.ss-btn:disabled{opacity:.4;cursor:default}' +
      '.ss-btn.ghost{background:transparent;color:var(--head,#0C2340);border:1px solid var(--line,#DCE1E9)}' +
      '.ss-row{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}' +
      '.ss-known{margin-top:18px;font-size:12.5px;color:var(--muted,#5A6577)}' +
      '.ss-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}' +
      '.ss-chip{border:1px solid var(--line,#DCE1E9);background:var(--sel-bg,rgba(122,63,224,.1));color:var(--accent,#7A3FE0);font-weight:700;font-size:13px;padding:6px 14px;border-radius:20px;cursor:pointer;font-family:inherit}' +
      '.ss-err{color:var(--bad,#C0392B);font-size:13px;margin-top:8px;min-height:1em}' +
      '.ss-bar{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--muted,#5A6577);flex-wrap:wrap}' +
      '.ss-bar b{color:var(--head,#0C2340)}' +
      '.ss-link{background:none;border:0;padding:0;font:inherit;font-size:13px;color:var(--accent2,#0B5FFF);cursor:pointer;text-decoration:underline}';
    document.head.appendChild(s);
  }

  /* ---------- вход ---------- */
  function listUsers() {
    return backend.keys().then(function (keys) {
      var pref = NS + 'user:';
      return Promise.all(keys.filter(function (k) { return k.indexOf(pref) === 0; }).map(function (k) {
        return backend.get(k).then(function (v) { try { var d = JSON.parse(v); return { name: d.name, last: d.lastSeen || d.created || 0 }; } catch (e) { return null; } });
      }));
    }).then(function (a) { return a.filter(Boolean).sort(function (x, y) { return y.last - x.last; }); });
  }
  function loadUser(name) {
    var key = normKey(name);
    return backend.get(userKey(key)).then(function (raw) {
      var d = null;
      try { d = raw ? JSON.parse(raw) : null; } catch (e) { d = null; }
      if (!d || typeof d !== 'object' || !d.tests) d = { name: cleanName(name), created: Date.now(), tests: {} };
      d.name = d.name || cleanName(name);
      d.lastSeen = Date.now();
      user = { key: key, name: d.name }; doc = d; dirty = true;
      return backend.set(NS + 'current', key).catch(function () {}).then(function () { return flush(); }).then(function () { return user; });
    });
  }
  function showLogin() {
    injectCss();
    return listUsers().then(function (users) {
      return new Promise(function (resolve) {
        var ov = document.createElement('div'); ov.className = 'ss-ov';
        ov.innerHTML =
          '<div class="ss-box"><h2>Привет! Как тебя зовут?</h2>' +
          '<p>Введи имя — пароль не нужен. По нему сайт запомнит твой прогресс и результаты тестов: после обновления страницы или повторного открытия всё будет на месте.</p>' +
          '<input type="text" id="ss-name" maxlength="40" placeholder="Например: Айгерим К." autocomplete="name" autocapitalize="words">' +
          '<div class="ss-err" id="ss-err"></div>' +
          '<div class="ss-row"><button class="ss-btn" id="ss-go" disabled>Войти</button></div>' +
          (users.length ? '<div class="ss-known">Уже заходили с этого устройства:<div class="ss-chips" id="ss-chips"></div></div>' : '') +
          '<div class="ss-known">Пиши имя всегда одинаково — тогда найдётся твой прогресс.</div></div>';
        document.body.appendChild(ov);
        var inp = ov.querySelector('#ss-name'), go = ov.querySelector('#ss-go'), err = ov.querySelector('#ss-err');
        function submit(name) {
          name = cleanName(name);
          if (name.length < 2) { err.textContent = 'Введи хотя бы 2 символа.'; return; }
          go.disabled = true;
          loadUser(name).then(function (u) { ov.remove(); resolve(u); }, function () { go.disabled = false; err.textContent = 'Не получилось войти, попробуй ещё раз.'; });
        }
        inp.addEventListener('input', function () { go.disabled = cleanName(inp.value).length < 2; err.textContent = ''; });
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(inp.value); });
        go.addEventListener('click', function () { submit(inp.value); });
        var chips = ov.querySelector('#ss-chips');
        if (chips) users.forEach(function (u) {
          var b = document.createElement('button'); b.className = 'ss-chip'; b.textContent = u.name;
          b.addEventListener('click', function () { submit(u.name); });
          chips.appendChild(b);
        });
        setTimeout(function () { inp.focus(); }, 30);
      });
    });
  }

  var loginPromise = null;
  function requireLogin() {
    if (loginPromise) return loginPromise;
    loginPromise = new Promise(function (resolve) {
      function go() {
        backend.get(NS + 'current').then(function (key) {
          if (!key) return null;
          return backend.get(userKey(key)).then(function (raw) {
            if (!raw) return null;
            try { var d = JSON.parse(raw); return d && d.name ? d.name : null; } catch (e) { return null; }
          });
        }).then(function (name) {
          return name ? loadUser(name) : showLogin();
        }).then(function (u) { mountUserBar(); resolve(u); });
      }
      if (document.body) go(); else document.addEventListener('DOMContentLoaded', go);
    });
    return loginPromise;
  }
  function logout() {
    return flush().then(function () { return backend.del(NS + 'current'); }).then(function () { location.reload(); });
  }

  /* ---------- «👤 Имя · Сменить» ---------- */
  function mountUserBar() {
    injectCss();
    document.querySelectorAll('[data-userbar]').forEach(function (el) {
      el.innerHTML = '';
      if (!user) return;
      var w = document.createElement('span'); w.className = 'ss-bar';
      w.innerHTML = '<span>👤 <b></b></span>';
      w.querySelector('b').textContent = user.name;
      var sw = document.createElement('button'); sw.className = 'ss-link'; sw.textContent = 'Сменить'; sw.title = 'Войти под другим именем';
      sw.addEventListener('click', function () {
        if (typeof SatStore.onBeforeLogout === 'function' && SatStore.onBeforeLogout() === false) return;
        logout();
      });
      var ex = document.createElement('button'); ex.className = 'ss-link'; ex.textContent = 'Резервная копия'; ex.title = 'Скачать файл со всеми твоими результатами (чтобы перенести на другое устройство)';
      ex.addEventListener('click', exportData);
      var im = document.createElement('button'); im.className = 'ss-link'; im.textContent = 'Загрузить копию';
      im.addEventListener('click', importData);
      w.appendChild(sw); w.appendChild(ex); w.appendChild(im);
      el.appendChild(w);
    });
  }

  /* ---------- перенос между устройствами: файл-копия ---------- */
  function exportData() {
    flush().then(function () {
      var blob = new Blob([JSON.stringify({ satprep: 1, user: doc }, null, 1)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'sat-progress-' + user.key.replace(/[^a-z0-9а-яё]+/gi, '_') + '.json';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    });
  }
  function importData() {
    var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json';
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          var d = JSON.parse(r.result).user;
          if (!d || !d.tests) throw new Error('bad');
          // объединяем: попытки из файла добавляются к текущим (без дублей), прогресс берём более свежий
          Object.keys(d.tests).forEach(function (id) {
            var src = d.tests[id], dst = T(id), have = {};
            dst.attempts.forEach(function (a) { have[a.id] = 1; });
            (src.attempts || []).forEach(function (a) { if (!have[a.id]) dst.attempts.push(a); });
            dst.attempts.sort(function (a, b) { return a.finishedAt - b.finishedAt; });
            if (src.progress && (!dst.progress || (src.progress.savedAt || 0) > (dst.progress.savedAt || 0))) dst.progress = src.progress;
          });
          persist(true).then(function () { alert('Готово: результаты загружены.'); location.reload(); });
        } catch (e) { alert('Этот файл не похож на резервную копию прогресса.'); }
      };
      r.readAsText(f);
    });
    inp.click();
  }

  /* ---------- API для тестов ---------- */
  var SatStore = {
    requireLogin: requireLogin,
    mountUserBar: mountUserBar,
    setBackend: function (b) { backend = b || localBackend; loginPromise = null; },
    user: function () { return user; },
    getProgress: function (id) { return T(id).progress; },
    setProgress: function (id, snap) { T(id).progress = snap; return persist(false); },
    clearProgress: function (id) { T(id).progress = null; return persist(true); },
    getAttempts: function (id) { return T(id).attempts.slice(); },
    addAttempt: function (id, att) { var t = T(id); t.attempts.push(att); t.progress = null; return persist(true); },
    flush: flush,
    exportData: exportData,
    importData: importData,
    onBeforeLogout: null
  };
  window.SatStore = SatStore;
})();
