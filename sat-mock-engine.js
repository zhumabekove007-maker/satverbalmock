/* =====================================================================
   sat-mock-engine.js — общий движок mock-тестов (Reading & Writing)
   Подключается после: sat-common.js, sat-store.js, <testN>-data.js
   Запуск:  startMockApp({ testId:'mock1', modules:[MODULE1, MODULE2], expl:EXPL });
   Сохранение: прогресс текущей попытки (ответы, отметки, вычеркнутые варианты, таймер,
   экран) пишется в SatStore при каждом действии; готовые попытки — в историю.
   ===================================================================== */
function startMockApp(cfg) {
  'use strict';
  const $ = id => document.getElementById(id);
  const LETTERS = ['A', 'B', 'C', 'D'];
  const TEST_ID = cfg.testId;
  const MODS = cfg.modules;
  const NQ = MODS[0].length;
  const N_SITE = SITE_WORDS.length;
  console.assert(MODS[0].length === NQ && MODS[1].length === NQ, 'each module must have ' + NQ + ' questions');

  /* ---------- post-processing: letter -> index, explanations, vocabulary tags ---------- */
  function plainText(h) { return String(h).replace(/<[^>]+>/g, ' ').toLowerCase(); }
  function tagWords(q) {
    const text = plainText([q.p, q.q, (q.notes || []).join(' '), q.o.join(' ')].join(' '));
    return SITE_WORDS.filter(w => new RegExp('\\b' + w + '(?:s|es|ed|d|ing|ly)?\\b').test(text));
  }
  MODS.forEach((M, mi) => M.forEach((q, i) => {
    if (typeof q.a === 'string') q.a = 'ABCD'.indexOf(q.a);
    q.e = cfg.expl[mi + 1][i + 1];
    q.w = tagWords(q);
  }));

  /* ---------- state ---------- */
  const S = {
    phase: 'intro',            // intro | test | review | break | results
    minutes: 39, mod: 0, idx: 0, deadline: 0, timerHidden: false, warned: false, timerId: null,
    ans: [[], []], flag: [[], []], elim: [[], []], used: [0, 0], auto: [false, false],
    viewing: null              // завершённая попытка, которую сейчас смотрим
  };
  const blank = () => Array(NQ).fill(null);
  function resetAttempt() {
    S.mod = 0; S.idx = 0; S.warned = false;
    S.ans = [blank(), blank()];
    S.flag = [Array(NQ).fill(false), Array(NQ).fill(false)];
    S.elim = [0, 1].map(() => Array.from({ length: NQ }, () => []));
    S.used = [0, 0]; S.auto = [false, false];
  }
  resetAttempt();

  /* ---------- persistence ---------- */
  function snapshot() {
    return { v: 1, phase: S.phase, mod: S.mod, idx: S.idx, minutes: S.minutes, deadline: S.deadline,
      ans: S.ans, flag: S.flag, elim: S.elim, used: S.used, auto: S.auto, savedAt: Date.now() };
  }
  function save() {
    if (S.phase === 'test' || S.phase === 'review' || S.phase === 'break') SatStore.setProgress(TEST_ID, snapshot());
  }
  function validSnapshot(p) {
    const arr = (a, f) => Array.isArray(a) && a.length === 2 && a.every(x => Array.isArray(x) && x.length === NQ && x.every(f));
    return p && p.v === 1 && ['test', 'review', 'break'].includes(p.phase) && (p.mod === 0 || p.mod === 1) &&
      Number.isInteger(p.idx) && p.idx >= 0 && p.idx < NQ && (p.minutes === 39 || p.minutes === 32) &&
      arr(p.ans, x => x === null || (Number.isInteger(x) && x >= 0 && x < 4)) &&
      arr(p.flag, x => typeof x === 'boolean') && arr(p.elim, Array.isArray) &&
      Array.isArray(p.used) && Array.isArray(p.auto);
  }
  function restore(p) {
    S.phase = p.phase; S.mod = p.mod; S.idx = p.idx; S.minutes = p.minutes; S.deadline = p.deadline || 0;
    S.ans = p.ans; S.flag = p.flag; S.elim = p.elim; S.used = p.used.slice(0, 2); S.auto = p.auto.slice(0, 2).map(Boolean);
  }

  /* ---------- helpers ---------- */
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function show(name) {
    S.phase = name === 'results' || name === 'intro' ? name : S.phase;
    ['intro', 'test', 'review', 'break', 'results'].forEach(n => { $('screen-' + n).hidden = (n !== name); });
    window.scrollTo(0, 0);
  }
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 4500);
  }
  function fmtDate(ts) {
    try { return new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return new Date(ts).toISOString().slice(0, 16).replace('T', ' '); }
  }
  function explHTML(e) {
    const parts = String(e || '').split(/ (?=Choice [A-D] is incorrect)/);
    return '<div class="expl"><b>Разбор</b>' + parts.map(p => '<p>' + esc(p) + '</p>').join('') + '</div>';
  }

  /* ---------- graphs (inline SVG) ---------- */
  function figMarker(shape, x, y) {
    if (shape === 'tri') return '<path d="M' + x + ' ' + (y - 6) + ' L' + (x + 6) + ' ' + (y + 5) + ' L' + (x - 6) + ' ' + (y + 5) + ' Z" class="fm solid"/>';
    if (shape === 'sq') return '<rect x="' + (x - 5) + '" y="' + (y - 5) + '" width="10" height="10" class="fm"/>';
    if (shape === 'circ') return '<circle cx="' + x + '" cy="' + y + '" r="4.5" class="fm"/>';
    return '<path d="M' + x + ' ' + (y - 7) + ' L' + (x + 7) + ' ' + y + ' L' + x + ' ' + (y + 7) + ' L' + (x - 7) + ' ' + y + ' Z" class="fm"/>';
  }
  function figHTML(f) {
    const lines = f.title.split('\n');
    const grouped = f.type === 'gbar';
    const ylines = grouped ? String(f.yLabel).split('\n') : [f.yLabel];
    const W = 460, L = 60 + (ylines.length - 1) * 14, R = 18, T = 20 + lines.length * 17 + 12;
    const B = grouped ? (f.rot ? 118 : 46) : (f.type === 'line' ? 58 : 40);
    const H = grouped ? T + 190 + B : 300 + (lines.length - 2) * 17;
    const iw = W - L - R, ih = H - T - B, n = f.cats.length, step = iw / n;
    const Y = v => T + ih - (v / f.yMax) * ih;
    const X = i => L + step * (i + 0.5);
    const fmt = v => v >= 1000 ? v.toLocaleString('en-US') : v;
    let s = '<svg class="fig" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(lines.join(' ')) + '" xmlns="http://www.w3.org/2000/svg">';
    lines.forEach((ln, i) => { s += '<text x="' + (L + iw / 2) + '" y="' + (18 + i * 17) + '" text-anchor="middle" class="ft">' + esc(ln) + '</text>'; });
    for (let v = 0; v <= f.yMax; v += f.yStep) {
      s += '<line x1="' + L + '" x2="' + (L + iw) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" class="fg"/><text x="' + (L - 8) + '" y="' + (Y(v) + 4) + '" text-anchor="end" class="fl">' + fmt(v) + '</text>';
    }
    if (f.type === 'line') f.cats.forEach((c, i) => { s += '<line x1="' + X(i) + '" x2="' + X(i) + '" y1="' + T + '" y2="' + (T + ih) + '" class="fg"/>'; });
    s += '<line x1="' + L + '" x2="' + L + '" y1="' + T + '" y2="' + (T + ih) + '" class="fa"/><line x1="' + L + '" x2="' + (L + iw) + '" y1="' + (T + ih) + '" y2="' + (T + ih) + '" class="fa"/>';
    ylines.forEach((ln, i) => {
      s += '<text transform="translate(' + (14 + i * 14) + ' ' + (T + ih / 2) + ') rotate(-90)" text-anchor="middle" class="fl">' + esc(ln) + '</text>';
    });
    f.cats.forEach((c, i) => {
      if (grouped && f.rot) s += '<text transform="translate(' + (X(i) + 4) + ' ' + (T + ih + 14) + ') rotate(-38)" text-anchor="end" class="fl">' + esc(c) + '</text>';
      else s += '<text x="' + X(i) + '" y="' + (T + ih + 18) + '" text-anchor="middle" class="fl">' + esc(c) + '</text>';
    });
    if (f.xLabel) s += '<text x="' + (L + iw / 2) + '" y="' + (grouped ? H - 8 : T + ih + 40) + '" text-anchor="middle" class="fl">' + esc(f.xLabel) + '</text>';
    if (f.type === 'bar') {
      f.vals.forEach((v, i) => { const bw = step * 0.42; s += '<rect x="' + (X(i) - bw / 2) + '" y="' + Y(v) + '" width="' + bw + '" height="' + (T + ih - Y(v)) + '" class="fb"/>'; });
    } else if (grouped) {
      const ns = f.series.length, gw = step * 0.78, bw = gw / ns;
      f.cats.forEach((c, ci) => f.series.forEach((se, si) => {
        const v = se.vals[ci], x = L + step * ci + (step - gw) / 2 + bw * si;
        s += '<rect x="' + x + '" y="' + Y(v) + '" width="' + bw + '" height="' + (T + ih - Y(v)) + '" class="fb ' + se.shade + '"><title>' + esc(se.name + ': ' + v) + '</title></rect>';
      }));
    } else {
      f.series.forEach(se => {
        const pts = se.vals.map((v, i) => X(i) + ',' + Y(v)).join(' ');
        s += '<polyline points="' + pts + '" class="fs' + (se.thick ? ' thick' : '') + '"' + (se.dash ? ' stroke-dasharray="' + se.dash + '"' : '') + '/>';
      });
      f.series.forEach(se => { se.vals.forEach((v, i) => { s += figMarker(se.marker, X(i), Y(v)); }); });
    }
    s += '</svg>';
    let legend = '';
    if (f.type === 'line') {
      legend = '<div class="figlegend">' + f.series.map(se =>
        '<span><svg width="34" height="14" viewBox="0 0 34 14" aria-hidden="true"><line x1="0" x2="34" y1="7" y2="7" class="fs' + (se.thick ? ' thick' : '') + '"' + (se.dash ? ' stroke-dasharray="' + se.dash + '"' : '') + '/>' + figMarker(se.marker, 17, 7) + '</svg>' + esc(se.name) + '</span>').join('') + '</div>';
    } else if (grouped) {
      legend = '<div class="figlegend">' + f.series.map(se => '<span><i class="sw ' + se.shade + '"></i>' + esc(se.name) + '</span>').join('') + '</div>';
    }
    return '<div class="figwrap">' + s + legend + '</div>';
  }

  /* ---------- intro (+ история и данные из шаблона) ---------- */
  function fillIntro() {
    const cnt = M => { const c = {}; M.forEach(q => { c[q.d] = (c[q.d] || 0) + 1; }); return c; };
    const c1 = cnt(MODS[0]), c2 = cnt(MODS[1]);
    const two = d => c1[d] === c2[d] ? String(c1[d]) : c1[d] + ' в Модуле 1, ' + c2[d] + ' в Модуле 2';
    $('intro-order').innerHTML = 'В каждом модуле вопросы идут в том же порядке, что и на реальном экзамене: <b>Craft &amp; Structure</b> (' + two('cs') +
      ') → <b>Information &amp; Ideas</b> (' + two('ii') + ') → <b>Standard English Conventions</b> (' + two('sec') +
      ') → <b>Expression of Ideas</b> (' + two('eoi') + '). Каждый вопрос — короткий текст и 4 варианта ответа; в некоторых есть график, таблица или заметки.';
    document.querySelectorAll('.nq').forEach(e => { e.textContent = NQ; });
    document.querySelectorAll('.nq2').forEach(e => { e.textContent = NQ * 2; });
  }
  function renderHistory() {
    const card = $('history-card'), at = SatStore.getAttempts(TEST_ID).slice().reverse();
    card.hidden = !at.length;
    if (!at.length) return;
    const best = Math.max.apply(null, at.map(a => a.score));
    $('history-body').innerHTML = '<table class="hist"><tr><th>Дата</th><th>Балл</th><th>Верно</th><th></th></tr>' +
      at.map(a => '<tr><td>' + esc(fmtDate(a.finishedAt)) + '</td><td class="sc">' + a.score +
        (a.score === best && at.length > 1 ? '<span class="best">лучший</span>' : '') + '</td><td>' + (a.m1 + a.m2) + '/' + NQ * 2 +
        '</td><td class="go"><button class="btn ghost small" data-open="' + esc(a.id) + '">Смотреть</button></td></tr>').join('') + '</table>';
    $('history-body').querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => {
      const a = SatStore.getAttempts(TEST_ID).find(x => x.id === b.dataset.open);
      if (a) showResults(a, true);
    }));
  }
  function toIntro() {
    clearInterval(S.timerId);
    S.viewing = null;
    renderHistory();
    show('intro');
  }
  document.querySelectorAll('input[name=mins]').forEach(r => r.addEventListener('change', () => {
    const m = document.querySelector('input[name=mins]:checked').value;
    $('t1').textContent = m + ' мин'; $('t2').textContent = m + ' мин';
  }));
  $('btn-start').addEventListener('click', () => {
    resetAttempt();
    S.minutes = +document.querySelector('input[name=mins]:checked').value;
    startModule(0);
  });

  /* ---------- module flow ---------- */
  function startModule(m) {
    S.mod = m; S.idx = 0; S.warned = false;
    S.deadline = Date.now() + S.minutes * 60000;
    enterTest();
    save();
  }
  function enterTest() {
    clearInterval(S.timerId);
    S.timerId = setInterval(tick, 400);
    $('mod-label').textContent = 'Reading and Writing · Module ' + (S.mod + 1);
    $('nav-pop').hidden = true;
    S.phase = 'test';
    show('test');
    renderQuestion();
    tick();
  }
  function tick() {
    if (S.phase !== 'test' && S.phase !== 'review') return;
    const rem = Math.max(0, S.deadline - Date.now());
    const mm = Math.floor(rem / 60000), ss = Math.floor((rem % 60000) / 1000);
    const el = $('timer');
    el.textContent = S.timerHidden ? '— : —' : String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
    el.classList.toggle('low', rem <= 300000);
    if (rem <= 300000 && rem > 0 && !S.warned) { S.warned = true; toast('Осталось 5 минут'); }
    if (rem === 0) submitModule(true);
  }
  $('timer-toggle').addEventListener('click', () => {
    S.timerHidden = !S.timerHidden;
    $('timer-toggle').textContent = S.timerHidden ? 'Показать' : 'Скрыть';
    tick();
  });

  /* ---------- rendering a question ---------- */
  function passageHTML(q) {
    let h = (q.fig ? figHTML(q.fig) : '');
    if (q.table) {
      h += '<table class="data"><caption>' + esc(q.table.cap) + '</caption><tr>' + q.table.head.map(x => '<th>' + esc(x) + '</th>').join('') + '</tr>' +
        q.table.rows.map(r => '<tr>' + r.map(x => '<td>' + esc(x) + '</td>').join('') + '</tr>').join('') + '</table>';
    }
    h += '<div class="ptext">' + q.p + '</div>';
    if (q.notes) h += '<ul class="notes">' + q.notes.map(n => '<li>' + n + '</li>').join('') + '</ul>';
    return h;
  }
  function renderQuestion() {
    const m = S.mod, i = S.idx, q = MODS[m][i];
    $('pane-passage').innerHTML = passageHTML(q);
    $('pane-q').innerHTML =
      '<div class="qhead"><span class="qnum">' + (i + 1) + '</span>' +
      '<button class="flagbtn" id="flagbtn"></button></div>' +
      '<p class="qtext">' + esc(q.q) + '</p><div id="opts"></div>';
    $('flagbtn').addEventListener('click', () => { S.flag[m][i] = !S.flag[m][i]; renderFlag(); save(); });
    renderFlag(); renderOptions();
    $('btn-nav').textContent = 'Вопрос ' + (i + 1) + ' из ' + NQ + ' ▴';
    $('btn-back').disabled = (i === 0);
    $('btn-next').textContent = (i === NQ - 1) ? 'К проверке' : 'Далее';
    $('pane-passage').scrollTop = 0; $('pane-q').scrollTop = 0;
  }
  function renderFlag() {
    const b = $('flagbtn'); const on = S.flag[S.mod][S.idx];
    b.textContent = on ? '⚑ Отмечен для проверки' : '⚐ Отметить для проверки';
    b.classList.toggle('on', on);
  }
  function renderOptions() {
    const m = S.mod, i = S.idx, q = MODS[m][i];
    const wrap = $('opts'); wrap.innerHTML = '';
    q.o.forEach((txt, k) => {
      const row = document.createElement('div');
      row.className = 'opt' + (S.ans[m][i] === k ? ' sel' : '') + (S.elim[m][i].includes(k) ? ' elim' : '');
      row.innerHTML = '<button class="optmain"><span class="letter">' + LETTERS[k] + '</span><span class="otext">' + txt + '</span></button>' +
        '<button class="strike" title="Вычеркнуть вариант">' + LETTERS[k] + '</button>';
      row.querySelector('.optmain').addEventListener('click', () => {
        S.ans[m][i] = (S.ans[m][i] === k) ? null : k;
        S.elim[m][i] = S.elim[m][i].filter(x => x !== k);
        renderOptions(); save();
      });
      row.querySelector('.strike').addEventListener('click', () => {
        const arr = S.elim[m][i];
        if (arr.includes(k)) S.elim[m][i] = arr.filter(x => x !== k);
        else { arr.push(k); if (S.ans[m][i] === k) S.ans[m][i] = null; }
        renderOptions(); save();
      });
      wrap.appendChild(row);
    });
  }

  /* ---------- navigation ---------- */
  function goTo(i) { S.idx = i; renderQuestion(); save(); }
  $('btn-back').addEventListener('click', () => { if (S.idx > 0) goTo(S.idx - 1); });
  $('btn-next').addEventListener('click', () => { if (S.idx < NQ - 1) goTo(S.idx + 1); else openReview(); });
  $('btn-to-review').addEventListener('click', openReview);
  function buildGrid(el, onClick) {
    const m = S.mod; el.innerHTML = '';
    for (let i = 0; i < NQ; i++) {
      const b = document.createElement('button');
      b.className = 'gq' + (S.ans[m][i] !== null ? ' ans' : '') + (S.flag[m][i] ? ' flag' : '') + (el.id === 'pop-grid' && i === S.idx ? ' cur' : '');
      b.textContent = i + 1;
      b.addEventListener('click', () => onClick(i));
      el.appendChild(b);
    }
  }
  $('btn-nav').addEventListener('click', () => {
    const pop = $('nav-pop');
    if (!pop.hidden) { pop.hidden = true; return; }
    $('pop-title').textContent = 'Модуль ' + (S.mod + 1) + ' · вопросы';
    buildGrid($('pop-grid'), i => { $('nav-pop').hidden = true; goTo(i); });
    pop.hidden = false;
  });
  $('pop-close').addEventListener('click', () => { $('nav-pop').hidden = true; });
  $('pop-review').addEventListener('click', openReview);

  /* ---------- review screen ---------- */
  function openReview() {
    $('nav-pop').hidden = true;
    $('confirm-box').hidden = true;
    $('abort-box').hidden = true;
    const m = S.mod;
    $('rev-kicker').textContent = 'Модуль ' + (m + 1);
    const answered = S.ans[m].filter(x => x !== null).length;
    const flagged = S.flag[m].filter(Boolean).length;
    $('rev-sub').textContent = 'Нажми на номер, чтобы вернуться к вопросу. Время идёт — таймер в верхней панели продолжает работать.';
    $('rev-counts').textContent = 'С ответом: ' + answered + ' из ' + NQ + ' · Без ответа: ' + (NQ - answered) + ' · Отмечено: ' + flagged;
    buildGrid($('rev-grid'), i => { S.phase = 'test'; show('test'); goTo(i); });
    S.phase = 'review'; show('review'); save();
  }
  $('rev-back').addEventListener('click', () => { S.phase = 'test'; show('test'); renderQuestion(); save(); });
  $('rev-submit').addEventListener('click', () => {
    const m = S.mod;
    const unanswered = S.ans[m].filter(x => x === null).length;
    let txt = 'Отправить Модуль ' + (m + 1) + '? После отправки вернуться к вопросам нельзя.';
    if (unanswered) txt = 'У тебя ' + unanswered + ' вопрос(ов) без ответа — они будут считаться неверными. ' + txt;
    $('confirm-text').textContent = txt;
    $('abort-box').hidden = true;
    $('confirm-box').hidden = false;
  });
  $('confirm-no').addEventListener('click', () => { $('confirm-box').hidden = true; });
  $('confirm-yes').addEventListener('click', () => submitModule(false));
  $('rev-abort').addEventListener('click', () => { $('confirm-box').hidden = true; $('abort-box').hidden = false; });
  $('abort-no').addEventListener('click', () => { $('abort-box').hidden = true; });
  $('abort-yes').addEventListener('click', () => {
    SatStore.clearProgress(TEST_ID).then(() => { resetAttempt(); toIntro(); });
  });

  function countCorrect(m, ans) {
    let c = 0;
    MODS[m].forEach((q, i) => { if (ans[m][i] === q.a) c++; });
    return c;
  }
  function submitModule(auto) {
    if (S.phase !== 'test' && S.phase !== 'review') return;
    clearInterval(S.timerId);
    const m = S.mod;
    S.used[m] = auto ? S.minutes * 60 : Math.min(S.minutes * 60, Math.round((Date.now() - (S.deadline - S.minutes * 60000)) / 1000));
    S.auto[m] = !!auto;
    $('nav-pop').hidden = true;
    if (m === 0) {
      enterBreak(auto);
    } else {
      finishTest();
    }
  }
  function enterBreak(auto) {
    const ans = S.ans[0].filter(x => x !== null).length;
    $('break-info').textContent = (auto || S.auto[0] ? 'Время вышло, модуль отправлен автоматически. ' : '') + 'Ответов в Модуле 1: ' + ans + ' из ' + NQ + '.';
    S.phase = 'break'; S.mod = 0;
    show('break'); save();
  }
  $('btn-start2').addEventListener('click', () => startModule(1));

  /* ---------- scoring ---------- */
  function estScore(m1, m2) {
    const p = (m1 + m2) / (NQ * 2);
    let s = 200 + 600 * Math.pow(p, 0.75);
    s = Math.round(s / 10) * 10;
    return Math.max(200, Math.min(800, s));
  }
  function finishTest() {
    const m1 = countCorrect(0, S.ans), m2 = countCorrect(1, S.ans);
    const attempt = {
      id: String(Date.now()), finishedAt: Date.now(), minutes: S.minutes,
      ans: S.ans, flag: S.flag, used: S.used, auto: S.auto, m1, m2, score: estScore(m1, m2)
    };
    SatStore.addAttempt(TEST_ID, attempt);   // заодно очищает сохранённый прогресс
    showResults(attempt, false);
  }

  /* ---------- results ---------- */
  function showResults(a, fromHistory) {
    S.viewing = a; S.phase = 'results';
    const m1 = a.m1, m2 = a.m2, sc = a.score;
    $('viewing-note').textContent = 'Попытка от ' + fmtDate(a.finishedAt) + (a.auto && (a.auto[0] || a.auto[1]) ? ' · время вышло в ' + (a.auto[0] && a.auto[1] ? 'обоих модулях' : 'Модуле ' + (a.auto[0] ? 1 : 2)) : '');
    $('res-score').textContent = sc;
    $('res-range').textContent = 'Ориентировочный диапазон: ' + Math.max(200, sc - 30) + '–' + Math.min(800, sc + 30) + ' (Reading & Writing, шкала 200–800)';
    $('res-route').textContent = 'Полный тест: 2 модуля × ' + NQ + ' вопроса · ' + a.minutes + ' мин на модуль';
    $('res-m1').textContent = m1 + '/' + NQ;
    $('res-m2').textContent = m2 + '/' + NQ;
    $('res-total').textContent = (m1 + m2) + '/' + (NQ * 2);

    const stat = {}; ORDER.forEach(d => stat[d] = { c: 0, n: 0 });
    [0, 1].forEach(m => MODS[m].forEach((q, i) => { stat[q.d].n++; if (a.ans[m][i] === q.a) stat[q.d].c++; }));
    $('res-domains').innerHTML = ORDER.map(d => {
      const p = stat[d].n ? Math.round(stat[d].c / stat[d].n * 100) : 0;
      return '<div class="drow"><div class="dl"><span>' + DOM[d] + '</span><b>' + stat[d].c + ' / ' + stat[d].n + '</b></div><div class="bar"><i style="width:' + p + '%"></i></div></div>';
    }).join('');

    const missedWords = new Set(), seenWords = new Set();
    [0, 1].forEach(m => MODS[m].forEach((q, i) => {
      (q.w || []).forEach(w => seenWords.add(w));
      if (a.ans[m][i] !== q.a) (q.w || []).forEach(w => missedWords.add(w));
    }));
    if (missedWords.size) {
      $('res-words-note').textContent = 'В тесте встретилось слов из тренажёра: ' + seenWords.size + ' из ' + N_SITE + '. В вопросах, где ты ошибся или не ответил, были такие слова — пройди по ним карточки ещё раз:';
      $('res-words').innerHTML = [...missedWords].map(w => '<span class="chip">' + esc(w) + '</span>').join('');
    } else {
      $('res-words-note').textContent = 'В тесте встретилось слов из тренажёра: ' + seenWords.size + ' из ' + N_SITE + '. В вопросах со словами с сайта ошибок нет — отлично!';
      $('res-words').innerHTML = '';
    }

    [...$('filters').children].forEach(x => x.classList.toggle('on', x.dataset.f === 'all'));
    renderReviewList('all');
    // на странице есть и «пройти заново», и «к истории»
    $('btn-again').textContent = fromHistory ? 'Пройти тест ещё раз' : 'Пройти заново';
    show('results');
  }
  function renderReviewList(filter) {
    const a = S.viewing; if (!a) return;
    const list = $('review-list'); list.innerHTML = '';
    [0, 1].forEach(m => {
      MODS[m].forEach((q, i) => {
        const ans = a.ans[m][i], fl = a.flag[m][i];
        const ok = ans === q.a, skip = ans === null;
        if (filter === 'wrong' && ok) return;
        if (filter === 'flag' && !fl) return;
        const d = document.createElement('details'); d.className = 'rv';
        const mod = 'M' + (m + 1) + ' · Q' + (i + 1);
        d.innerHTML =
          '<summary><span class="mark ' + (ok ? 'ok' : skip ? 'skip' : 'no') + '">' + (ok ? '✓' : skip ? '–' : '✕') + '</span>' +
          '<span>' + mod + ' · ' + esc(q.t) + (fl ? ' · ⚑' : '') + '</span></summary>' +
          '<div class="rvbody"><div class="tagline">' + DOM[q.d] + (q.w && q.w.length ? ' · слова с сайта: ' + esc(q.w.join(', ')) : '') + '</div>' +
          passageHTML(q) +
          '<p class="qtext" style="margin-top:14px;">' + esc(q.q) + '</p>' +
          q.o.map((t, k) => '<div class="ro' + (k === q.a ? ' correct' : (k === ans ? ' wrong' : '')) + '"><b>' + LETTERS[k] + '</b><span>' + t +
            (k === ans ? ' <em class="muted">(твой ответ)</em>' : '') + '</span></div>').join('') +
          explHTML(q.e) + '</div>';
        list.appendChild(d);
      });
    });
    if (!list.children.length) list.innerHTML = '<p class="muted">Здесь ничего нет.</p>';
  }
  $('filters').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    [...$('filters').children].forEach(x => x.classList.toggle('on', x === b));
    renderReviewList(b.dataset.f);
  });
  $('btn-again').addEventListener('click', () => { resetAttempt(); toIntro(); });
  $('btn-history').addEventListener('click', toIntro);

  /* ---------- вход и восстановление ---------- */
  SatStore.onBeforeLogout = () => {
    if (S.phase === 'test' || S.phase === 'review') return confirm('Идёт тест. Прогресс сохранён — войти под другим именем?');
    return true;
  };
  fillIntro();
  SatStore.requireLogin().then(() => {
    const p = SatStore.getProgress(TEST_ID);
    if (p && validSnapshot(p)) {
      restore(p);
      if (p.phase === 'break') { enterBreak(false); toast('Прогресс восстановлен'); return; }
      if (Date.now() >= S.deadline) {
        // пока страницы не было, время модуля истекло — отправляем как при автозавершении
        S.phase = 'test';
        toast('Пока тебя не было, время модуля вышло — он отправлен автоматически');
        submitModule(true);
        return;
      }
      enterTest();
      if (p.phase === 'review') openReview();
      toast('Прогресс восстановлен: Модуль ' + (S.mod + 1) + ', вопрос ' + (S.idx + 1));
      return;
    }
    if (p) SatStore.clearProgress(TEST_ID);
    toIntro();
  });
}
