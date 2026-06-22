'use strict';

/* ============ Данные ============ */
let DATA = null;
let TICKETS = []; // билеты для режима «Экзамен по билетам»
// inputPct — доля вопросов с вводом текста своими словами (проверяет ИИ в конце).
const EXAM_LEVELS = {
  easy:   { key: 'easy',   title: 'Лёгкий',  count: 10, timeSec: 0,    back: true,  pass: 0,  inputPct: 0.2 },
  medium: { key: 'medium', title: 'Средний', count: 20, timeSec: 0,    back: true,  pass: 0,  inputPct: 0.3 },
  hard:   { key: 'hard',   title: 'Сложный', count: 30, timeSec: 1500, back: false, pass: 80, inputPct: 0.4 }
};
let examInterval = null;
const app = document.getElementById('app');
const LETTERS = ['А', 'Б', 'В', 'Г', 'Д'];
let S = null; // текущая сессия (режим прохождения)

/* ============ Аналитика ============ */
const ANALYTICS_URL = (window.SNIPING_CONFIG && window.SNIPING_CONFIG.analyticsUrl) || '';
let USER = '';

function getUser() { try { return localStorage.getItem('userName') || ''; } catch (e) { return ''; } }
function setUser(n) { try { localStorage.setItem('userName', n); } catch (e) {} USER = n; }

function loadQueue() { try { return JSON.parse(localStorage.getItem('aq')) || []; } catch (e) { return []; } }
function saveQueue(q) { try { localStorage.setItem('aq', JSON.stringify(q)); } catch (e) {} }

// записать событие-ответ в очередь; батчем уходит на сервер
function logEvent(mode, themeId, questionId, correct) {
  if (!ANALYTICS_URL) return;
  const q = loadQueue();
  q.push({ name: USER || getUser(), mode: mode, themeId: themeId, questionId: questionId, correct: correct ? 1 : 0 });
  saveQueue(q);
  if (q.length >= 8) flushQueue(); // отправляем пачками
}

function flushQueue(useBeacon) {
  if (!ANALYTICS_URL) return;
  const q = loadQueue();
  if (!q.length) return;
  saveQueue([]); // оптимистично очищаем
  const body = JSON.stringify({ events: q });
  if (useBeacon && navigator.sendBeacon) { navigator.sendBeacon(ANALYTICS_URL, body); return; }
  fetch(ANALYTICS_URL, { method: 'POST', body: body, keepalive: true })
    .catch(() => { const cur = loadQueue(); saveQueue(q.concat(cur)); }); // вернуть при ошибке
}

// дослать очередь при сворачивании/закрытии
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushQueue(true); });
window.addEventListener('pagehide', () => flushQueue(true));

/* ============ Утилиты ============ */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function prepareQuestion(item) {
  const raw = item.raw;
  const opts = raw.options.map((text, i) => ({ text, isCorrect: i === raw.correct }));
  const mixed = shuffle(opts);
  return {
    id: raw.id, q: raw.q, theme: item.theme, themeId: item.themeId,
    explanation: raw.explanation || '',
    options: mixed.map(o => o.text),
    correct: mixed.findIndex(o => o.isCorrect)
  };
}
function allQuestions() {
  const out = [];
  DATA.themes.forEach(t => t.questions.forEach(q => out.push({ raw: q, theme: t.title, themeId: t.id })));
  return out;
}
function questionsOfTheme(themeId) {
  const t = DATA.themes.find(t => t.id === themeId);
  return t ? t.questions.map(q => ({ raw: q, theme: t.title, themeId: t.id })) : [];
}

/* ============ Прогресс и сессия (localStorage) ============ */
function loadProgress() {
  try {
    const p = JSON.parse(localStorage.getItem('progress'));
    return p && p.solved ? p : { solved: {}, perfect: {} };
  } catch (e) { return { solved: {}, perfect: {} }; }
}
function saveProgress(p) { try { localStorage.setItem('progress', JSON.stringify(p)); } catch (e) {} }
function themeStats(t, prog) {
  const total = t.questions.length;
  const solved = t.questions.filter(q => prog.solved[q.id]).length;
  return { solved, total, done: solved === total, perfect: !!prog.perfect[t.id] };
}
function sessKey(themeId) { return 'sess_t' + themeId; }
function sessKeyInput(themeId) { return 'sess_i' + (themeId == null ? 'all' : themeId); } // «Ввод ответа», в т.ч. «все темы»
function hasSession(themeId) { try { return !!localStorage.getItem(sessKey(themeId)); } catch (e) { return false; } }
function hasSessionInput(themeId) { try { return !!localStorage.getItem(sessKeyInput(themeId)); } catch (e) { return false; } }
function curSessKey() {
  if (!S) return null;
  if (S.mode === 'theme') return sessKey(S.themeId);
  if (S.mode === 'input') return sessKeyInput(S.themeId);
  return null;
}
function saveSession() {
  const key = curSessKey();
  if (!key) return;
  try { localStorage.setItem(key, JSON.stringify({ questions: S.questions, answers: S.answers, idx: S.idx })); } catch (e) {}
}
function readSession(key) {
  try {
    const s = JSON.parse(localStorage.getItem(key));
    return (s && Array.isArray(s.questions) && s.questions.length) ? s : null;
  } catch (e) { return null; }
}
function loadSession(themeId) { return readSession(sessKey(themeId)); }
function loadSessionInput(themeId) { return readSession(sessKeyInput(themeId)); }
function clearSession(themeId) { try { localStorage.removeItem(sessKey(themeId)); } catch (e) {} }
function clearSessionInput(themeId) { try { localStorage.removeItem(sessKeyInput(themeId)); } catch (e) {} }

// ----- статистика ошибок (для «Работы над ошибками») -----
// p.miss[id] = { w: всего ошибок, streak: верных ответов подряд после последней ошибки }
function recordInto(p, id, correct) {
  if (!p.miss) p.miss = {};
  const m = p.miss[id];
  if (correct) {
    if (m) { m.streak = (m.streak || 0) + 1; if (m.streak >= 2) delete p.miss[id]; } // выучен — убираем
  } else {
    if (m) { m.w++; m.streak = 0; } else { p.miss[id] = { w: 1, streak: 0 }; }
  }
}
function mistakeIds(p) {
  const m = p.miss || {};
  return Object.keys(m).sort((a, b) => m[b].w - m[a].w); // самые частые — первыми
}
function findItemById(id) {
  for (const t of DATA.themes) {
    for (const q of t.questions) if (q.id === id) return { raw: q, theme: t.title, themeId: t.id };
  }
  return null;
}

/* ============ Главное меню ============ */
function renderHome() {
  S = null;
  const prog = loadProgress();
  const doneCount = DATA.themes.filter(t => themeStats(t, prog).done).length;
  const missCount = mistakeIds(prog).length;
  const total = DATA.themes.reduce((s, t) => s + t.questions.length, 0);
  app.innerHTML = `
    <img class="brand-logo" src="./icons/logo.png" alt="Логотип">
    <h1 class="app-title">Снайперская подготовка</h1>
    <p class="app-sub">${DATA.themes.length} тем · ${total} вопросов</p>
    <button class="btn btn-primary" id="exam">
      <div class="btn-title">🎯 Экзамен</div>
      <div class="btn-desc">3 уровня сложности · разбор ошибок в конце</div>
    </button>
    ${TICKETS.length ? `<button class="btn btn-primary" id="tickets">
      <div class="btn-title">🎫 Экзамен по билетам</div>
      <div class="btn-desc">Билет из ${TICKETS.length}: пишешь ответы — ИИ строго разбирает</div>
    </button>` : ''}
    <button class="btn btn-primary" id="themes">
      <div class="btn-row"><span class="btn-title">📚 Темы</span><span class="count">${doneCount} / ${DATA.themes.length}</span></div>
      <div class="btn-desc">Прохождение по темам с учётом прогресса</div>
    </button>
    <button class="btn btn-primary" id="repeat">
      <div class="btn-title">🔄 Повторение</div>
      <div class="btn-desc">Бесконечный поток вопросов для зубрёжки</div>
    </button>
    <button class="btn btn-primary" id="input">
      <div class="btn-title">✍️ Ввод ответа</div>
      <div class="btn-desc">Пишешь ответ сам — ИИ проверяет по смыслу</div>
    </button>
    <button class="btn btn-primary" id="cards">
      <div class="btn-title">🃏 Карточки</div>
      <div class="btn-desc">Заучивание: вспомни ответ и проверь себя</div>
    </button>
    <button class="btn btn-mistakes" id="mistakes" ${missCount ? '' : 'disabled'}>
      <div class="btn-row"><span class="btn-title">❗ Работа над ошибками</span><span class="count">${missCount}</span></div>
      <div class="btn-desc">${missCount ? 'Вопросы, где ты чаще всего ошибаешься' : 'Пока ошибок нет — копятся по мере прохождения'}</div>
    </button>
    <p class="footnote">Вошёл как <b>${esc(USER || '—')}</b> · <span class="link-btn" id="rename">сменить</span> · <span class="link-btn" id="adminlink">админ</span></p>
  `;
  document.getElementById('exam').onclick = renderExamSetup;
  const tb = document.getElementById('tickets'); if (tb) tb.onclick = renderTicketMenu;
  document.getElementById('themes').onclick = renderThemeList;
  document.getElementById('repeat').onclick = renderRepeatMenu;
  document.getElementById('cards').onclick = renderCardsMenu;
  document.getElementById('input').onclick = renderInputMenu;
  if (missCount) document.getElementById('mistakes').onclick = startMistakes;
  document.getElementById('rename').onclick = () => renderNameGate(true);
  document.getElementById('adminlink').onclick = renderAdminLogin;
}

/* ============ Экран входа (Имя Фамилия) ============ */
function renderNameGate(canCancel) {
  app.innerHTML = `
    <img class="brand-logo" src="./icons/logo.png" alt="Логотип">
    <h1 class="app-title">Снайперская подготовка</h1>
    <p class="app-sub">Вход</p>
    <p class="gate-hint">Введи имя и фамилию или позывной — по ним учитывается твой прогресс.</p>
    <form id="nameform">
      <input class="text-input" id="fio" type="text" name="name" placeholder="Имя Фамилия или позывной"
        value="${esc(getUser())}" maxlength="60"
        autocapitalize="words" autocorrect="off" spellcheck="false" enterkeyhint="go">
      <div class="gate-err" id="err"></div>
      <button class="btn btn-primary" type="submit"><div class="btn-title">Войти →</div></button>
    </form>
    ${canCancel ? '<button class="btn" id="cancel"><div class="btn-title">← Назад</div></button>' : ''}
  `;
  const inp = document.getElementById('fio');
  const submit = () => {
    const v = inp.value.trim().replace(/\s+/g, ' ');
    if (!v) {
      document.getElementById('err').textContent = 'Введи имя, фамилию или позывной.';
      return;
    }
    setUser(v);
    renderHome();
  };
  document.getElementById('nameform').addEventListener('submit', e => { e.preventDefault(); submit(); });
  if (canCancel) document.getElementById('cancel').onclick = renderHome;
}

/* ============ Дашборд «Админ» ============ */
function renderAdminLogin() {
  app.innerHTML = `
    <div class="topbar"><button class="back-btn" id="back">← Меню</button><h2>Админ</h2></div>
    <p class="gate-hint">Пароль для просмотра результатов всех пользователей.</p>
    <input class="text-input" id="pw" type="password" placeholder="Пароль" autocomplete="off">
    <div class="gate-err" id="err"></div>
    <button class="btn btn-primary" id="go"><div class="btn-title">Показать сводку</div></button>
  `;
  document.getElementById('back').onclick = renderHome;
  const inp = document.getElementById('pw'); inp.focus();
  const go = () => {
    const pw = inp.value;
    if (!pw) return;
    if (!ANALYTICS_URL) { document.getElementById('err').textContent = 'Аналитика не настроена.'; return; }
    document.getElementById('err').textContent = 'Загружаю…';
    fetch(ANALYTICS_URL + '?secret=' + encodeURIComponent(pw))
      .then(r => r.json())
      .then(d => {
        if (!d.ok) { document.getElementById('err').textContent = 'Неверный пароль.'; return; }
        renderAdminDashboard(d.rows, d.inputs || []);
      })
      .catch(() => { document.getElementById('err').textContent = 'Ошибка загрузки.'; });
  };
  document.getElementById('go').onclick = go;
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

let ADMIN_DATA = null;
function admFmtDate(s) { try { return new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
function admThemeName(id) { const t = DATA.themes.find(t => String(t.id) === String(id)); return t ? t.title : ('Тема ' + id); }

function renderAdminDashboard(rows, inputs) {
  ADMIN_DATA = { rows: rows || [], inputs: inputs || [] };
  renderAdminTab('summary');
}

function admTabs(active) {
  return `
    <div class="adm-tabs">
      <button class="adm-tab ${active === 'summary' ? 'active' : ''}" id="tab-sum">📊 Сводка</button>
      <button class="adm-tab ${active === 'inputs' ? 'active' : ''}" id="tab-inp">✍️ Ввод-ответы</button>
    </div>`;
}
function admWireTabs(active) {
  document.getElementById('back').onclick = renderHome;
  document.getElementById('refresh').onclick = renderAdminLogin;
  const ts = document.getElementById('tab-sum'); if (ts) ts.onclick = () => renderAdminTab('summary');
  const ti = document.getElementById('tab-inp'); if (ti) ti.onclick = () => renderAdminTab('inputs');
}
function renderAdminTab(tab) {
  if (tab === 'inputs') renderAdminInputs(); else renderAdminSummary();
}

// Вкладка «Сводка» — агрегаты по пользователям (как было).
function renderAdminSummary() {
  const data = ADMIN_DATA.rows.slice(1); // [ts, name, mode, themeId, questionId, correct]
  const byUser = {};
  data.forEach(r => {
    const name = r[1] || '—', mode = r[2], theme = String(r[3]), correct = Number(r[5]) === 1, ts = r[0];
    if (!byUser[name]) byUser[name] = { total: 0, correct: 0, themes: {}, last: '', modes: {} };
    const u = byUser[name];
    u.total++; if (correct) u.correct++;
    u.modes[mode] = (u.modes[mode] || 0) + 1;
    if (!u.themes[theme]) u.themes[theme] = { t: 0, c: 0 };
    u.themes[theme].t++; if (correct) u.themes[theme].c++;
    if (ts > u.last) u.last = ts;
  });
  const names = Object.keys(byUser).sort((a, b) => byUser[b].total - byUser[a].total);
  const cards = names.map(n => {
    const u = byUser[n];
    const pct = u.total ? Math.round(u.correct / u.total * 100) : 0;
    const themesHtml = Object.keys(u.themes).sort((a, b) => Number(a) - Number(b)).map(tid => {
      const th = u.themes[tid]; const p = Math.round(th.c / th.t * 100);
      return `<div class="adm-theme"><span>${esc(admThemeName(tid))}</span><span class="adm-th-num">${th.c}/${th.t} · ${p}%</span></div>`;
    }).join('');
    return `
      <div class="admin-card">
        <div class="adm-head"><span class="adm-name">${esc(n)}</span><span class="adm-pct">${pct}%</span></div>
        <div class="adm-sub">Ответов: ${u.total} · верно: ${u.correct} · ${admFmtDate(u.last)}</div>
        <div class="adm-themes">${themesHtml}</div>
      </div>`;
  }).join('');
  app.innerHTML = `
    <div class="topbar"><button class="back-btn" id="back">← Меню</button><h2>Админ</h2></div>
    ${admTabs('summary')}
    <p class="gate-hint">Пользователей: ${names.length} · всего ответов: ${data.length}</p>
    <button class="btn" id="refresh"><div class="btn-title">↻ Обновить</div></button>
    ${cards || '<p class="gate-hint">Пока нет данных.</p>'}
  `;
  admWireTabs('summary');
}

// Вкладка «Ввод-ответы» — детальный лог развёрнутых ответов (новые сверху).
function renderAdminInputs() {
  // inputs[0] — шапка; далее [ts, name, mode, themeId, questionId, question, answer, correct, reason]
  const rows = ADMIN_DATA.inputs.slice(1).slice().reverse();
  const modeLabel = m => ({ input: 'Ввод', exam: 'Экзамен', practice: 'Повторение', ticket: 'Билет' }[m] || (m || '—'));
  const cards = rows.map(r => {
    const ts = r[0], name = r[1] || '—', mode = r[2], answer = r[6], correct = Number(r[7]) === 1, reason = r[8], question = r[5];
    return `
      <div class="inp-card ${correct ? 'ok' : 'no'}">
        <div class="inp-head">
          <span class="adm-name">${esc(name)}</span>
          <span class="inp-meta">${esc(modeLabel(mode))} · ${admFmtDate(ts)}</span>
        </div>
        <div class="inp-q">${esc(question)}</div>
        <div class="inp-a"><b>Ответ:</b> ${esc(answer || '—')}</div>
        <div class="inp-verdict ${correct ? 'v-ok' : 'v-no'}">${correct ? '✔ зачтено' : '✗ не зачтено'}</div>
        ${reason ? `<div class="inp-reason">👨‍🏫 ${esc(reason)}</div>` : ''}
      </div>`;
  }).join('');
  app.innerHTML = `
    <div class="topbar"><button class="back-btn" id="back">← Меню</button><h2>Админ</h2></div>
    ${admTabs('inputs')}
    <p class="gate-hint">Развёрнутых ответов: ${rows.length} (новые сверху)</p>
    <button class="btn" id="refresh"><div class="btn-title">↻ Обновить</div></button>
    ${cards || '<p class="gate-hint">Пока нет развёрнутых ответов.</p>'}
  `;
  admWireTabs('inputs');
}

/* ============ Меню «Темы» ============ */
function renderThemeList() {
  S = null;
  const prog = loadProgress();
  const doneCount = DATA.themes.filter(t => themeStats(t, prog).done).length;
  const items = DATA.themes.map(t => {
    const s = themeStats(t, prog);
    const pct = Math.round(s.solved / s.total * 100);
    const resume = hasSession(t.id) ? '<span class="badge" title="есть незавершённое прохождение">⏸</span>' : '';
    return `
      <button class="btn theme-item ${s.done ? 'done' : ''}" data-theme="${t.id}">
        <div class="btn-row">
          <span class="btn-title">${t.id}. ${esc(t.title)} ${s.perfect ? '<span class="badge">🏅</span>' : ''} ${resume}</span>
          <span class="count">${s.solved}/${s.total}</span>
        </div>
        <div class="mini-bar"><span style="width:${pct}%"></span></div>
      </button>`;
  }).join('');
  app.innerHTML = `
    <div class="topbar">
      <button class="back-btn" id="back">← Меню</button>
      <span class="progress">Пройдено ${doneCount} / ${DATA.themes.length}</span>
    </div>
    <p class="hint">Зелёная — все вопросы освоены · 🏅 — пройдена без ошибок · ⏸ — можно продолжить.</p>
    ${items}
    <button class="btn reset-btn" id="reset"><div class="btn-title">↺ Сбросить весь прогресс</div></button>
  `;
  document.getElementById('back').onclick = renderHome;
  app.querySelectorAll('[data-theme]').forEach(b => { b.onclick = () => startTheme(Number(b.dataset.theme)); });
  document.getElementById('reset').onclick = () => {
    if (confirm('Сбросить весь прогресс и незавершённые прохождения?')) {
      saveProgress({ solved: {}, perfect: {} });
      DATA.themes.forEach(t => clearSession(t.id));
      renderThemeList();
    }
  };
}

/* ============ Меню «Повторение» ============ */
function renderRepeatMenu() {
  S = null;
  const themesHtml = DATA.themes.map(t => `
    <button class="btn" data-theme="${t.id}">
      <div class="btn-row"><span class="btn-title">${t.id}. ${esc(t.title)}</span><span class="count">${t.questions.length}</span></div>
    </button>`).join('');
  app.innerHTML = `
    <div class="topbar"><button class="back-btn" id="back">← Меню</button><h2>Повторение</h2></div>
    <div class="mode-desc">🔄 Бесконечный поток вопросов для зубрёжки. Вопросы идут по кругу — тренируйся сколько хочешь. Стрелкой «назад» можно вернуться к пройденным. Прогресс здесь не засчитывается.</div>
    <button class="btn btn-primary" data-theme="all">
      <div class="btn-title">🔁 Все темы</div><div class="btn-desc">Случайные вопросы из всех тем</div>
    </button>
    <div class="section-label">Или выбери тему</div>
    ${themesHtml}
  `;
  document.getElementById('back').onclick = renderHome;
  app.querySelectorAll('[data-theme]').forEach(b => {
    b.onclick = () => startPractice(b.dataset.theme === 'all' ? null : Number(b.dataset.theme));
  });
}

/* ============ Запуск режимов ============ */
/* ============ Экзамен: выбор сложности ============ */
function renderExamSetup() {
  S = null;
  clearExamTimer();
  app.innerHTML = `
    <div class="topbar"><button class="back-btn" id="back">← Меню</button><h2>Экзамен</h2></div>
    <div class="mode-desc">Выбери уровень. Чем сложнее — тем больше вопросов, часть из них нужно написать своими словами (проверит ИИ в конце), и жёстче условия.</div>
    <button class="btn btn-primary lvl" data-l="easy">
      <div class="btn-title">🟢 Лёгкий</div>
      <div class="btn-desc">10 вопросов · ~2 с вводом текста · без таймера · можно листать назад</div>
    </button>
    <button class="btn btn-primary lvl" data-l="medium">
      <div class="btn-title">🟡 Средний</div>
      <div class="btn-desc">20 вопросов · ~6 с вводом текста · без таймера · можно листать назад</div>
    </button>
    <button class="btn btn-mistakes lvl" data-l="hard">
      <div class="btn-title">🔴 Сложный</div>
      <div class="btn-desc">30 вопросов · ~12 с вводом текста · таймер 25 мин · без возврата · проходной 80%</div>
    </button>
  `;
  document.getElementById('back').onclick = renderHome;
  app.querySelectorAll('.lvl').forEach(b => { b.onclick = () => startExam(b.dataset.l); });
}

function startExam(levelKey) {
  const lvl = EXAM_LEVELS[levelKey] || EXAM_LEVELS.medium;
  const all = allQuestions();
  const pool = shuffle(all).slice(0, Math.min(lvl.count, all.length));
  const questions = pool.map(prepareQuestion);
  // часть вопросов — с вводом текста своими словами (доля зависит от уровня)
  const inputCount = Math.round(questions.length * (lvl.inputPct || 0));
  const inputIdx = new Set(shuffle(questions.map((_, i) => i)).slice(0, inputCount));
  questions.forEach((q, i) => { q.kind = inputIdx.has(i) ? 'input' : 'test'; });
  S = {
    mode: 'exam', level: lvl, questions,
    answers: new Array(questions.length).fill(null), idx: 0,
    verdicts: {}, // ИИ-вердикты по input-вопросам (заполняются в finishExam)
    timeLeft: lvl.timeSec > 0 ? lvl.timeSec : null
  };
  if (lvl.timeSec > 0) startExamTimer();
  renderQuestion();
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}
function clearExamTimer() { if (examInterval) { clearInterval(examInterval); examInterval = null; } }
function startExamTimer() {
  clearExamTimer();
  examInterval = setInterval(() => {
    if (!S || S.mode !== 'exam' || S.timeLeft == null) { clearExamTimer(); return; }
    S.timeLeft--;
    const el = document.getElementById('timer');
    if (el) { el.textContent = '⏱ ' + fmtTime(Math.max(0, S.timeLeft)); if (S.timeLeft <= 30) el.classList.add('low'); }
    if (S.timeLeft <= 0) { clearExamTimer(); finishExam(); }
  }, 1000);
}

/* ============ Меню «Карточки» ============ */
function renderCardsMenu() {
  S = null;
  const themesHtml = DATA.themes.map(t => `
    <button class="btn" data-theme="${t.id}">
      <div class="btn-row"><span class="btn-title">${t.id}. ${esc(t.title)}</span><span class="count">${t.questions.length}</span></div>
    </button>`).join('');
  app.innerHTML = `
    <div class="topbar"><button class="back-btn" id="back">← Меню</button><h2>Карточки</h2></div>
    <div class="mode-desc">🃏 Смотришь вопрос, вспоминаешь ответ в уме, переворачиваешь карточку и проверяешь себя. Активное вспоминание — лучший способ заучить определения.</div>
    <button class="btn btn-primary" data-theme="all"><div class="btn-title">🔁 Все темы</div></button>
    <div class="section-label">Или выбери тему</div>
    ${themesHtml}
  `;
  document.getElementById('back').onclick = renderHome;
  app.querySelectorAll('[data-theme]').forEach(b => {
    b.onclick = () => startCards(b.dataset.theme === 'all' ? null : Number(b.dataset.theme));
  });
}

/* ============ Режим «Карточки» ============ */
function startCards(themeId) {
  const pool = themeId == null ? allQuestions() : questionsOfTheme(themeId);
  const questions = shuffle(pool).map(prepareQuestion);
  S = { mode: 'cards', themeId: themeId, questions, idx: 0, flipped: false, known: 0, unknown: 0 };
  renderCard();
}

function renderCard() {
  const q = S.questions[S.idx];
  const answer = q.options[q.correct];
  const face = S.flipped
    ? `<div class="flashcard back" id="card">
         <div class="card-label">Ответ</div>
         <p class="card-a">${esc(answer)}</p>
         ${q.explanation ? `<div class="explain"><b>Пояснение.</b> ${esc(q.explanation)}</div>` : ''}
       </div>`
    : `<div class="flashcard" id="card">
         <span class="theme-tag">${esc(q.theme)}</span>
         <p class="card-q">${esc(q.q)}</p>
         <div class="card-hint">👆 нажми, чтобы перевернуть</div>
       </div>`;
  app.innerHTML = `
    <div class="topbar">
      <button class="back-btn" id="back">← Меню</button>
      <span class="progress">${S.idx + 1} / ${S.questions.length} · 😎 ${S.known} 😕 ${S.unknown}</span>
    </div>
    ${face}
    ${S.flipped ? `
      <div class="nav-row">
        <button class="btn nav-btn card-no" id="no"><div class="btn-title">😕 Не знал</div></button>
        <button class="btn nav-btn card-yes" id="yes"><div class="btn-title">😎 Знал</div></button>
      </div>` : ''}
  `;
  document.getElementById('back').onclick = renderHome;
  if (!S.flipped) {
    document.getElementById('card').onclick = () => { S.flipped = true; renderCard(); };
  } else {
    document.getElementById('no').onclick = () => cardAnswer(false);
    document.getElementById('yes').onclick = () => cardAnswer(true);
  }
}

function cardAnswer(known) {
  const q = S.questions[S.idx];
  if (known) S.known++; else S.unknown++;
  const p = loadProgress();
  recordInto(p, q.id, known);     // «не знал» попадёт в работу над ошибками
  saveProgress(p);
  logEvent('cards', q.themeId, q.id, known);
  S.idx++;
  S.flipped = false;
  if (S.idx >= S.questions.length) finishCards();
  else renderCard();
}

function finishCards() {
  flushQueue();
  const total = S.known + S.unknown;
  const pct = total ? Math.round(S.known / total * 100) : 0;
  const themeId = S.themeId;
  app.innerHTML = `
    <h1 class="app-title">Карточки пройдены</h1>
    <div class="result-score">${S.known}/${total}</div>
    <div class="result-pct">знал ${pct}%</div>
    <p class="result-line">${S.unknown === 0 ? '🔥 Всё знал!' : `Не знал: ${S.unknown} — они попали в «Работу над ошибками»`}</p>
    <button class="btn btn-primary" id="again"><div class="btn-title">↻ Ещё раз</div></button>
    <button class="btn" id="home"><div class="btn-title">← В меню</div></button>
  `;
  window.scrollTo(0, 0);
  document.getElementById('again').onclick = () => startCards(themeId);
  document.getElementById('home').onclick = renderHome;
}

/* ============ Меню «Ввод ответа» ============ */
// прогресс сохранённой сессии ввода: сколько проверено из скольки
function inputSessProgress(themeId) {
  const s = readSession(sessKeyInput(themeId));
  if (!s) return null;
  const answered = s.answers.filter(a => a && typeof a === 'object').length;
  return { answered: answered, total: s.questions.length };
}
function renderInputMenu() {
  S = null;
  const themeBtn = (id, title, count, cls) => {
    const p = inputSessProgress(id);
    const resume = p ? `<span class="badge" title="можно продолжить">⏸ ${p.answered}/${p.total}</span>` : '';
    return `
      <button class="btn ${cls || ''}" data-theme="${id == null ? 'all' : id}">
        <div class="btn-row"><span class="btn-title">${title} ${resume}</span><span class="count">${count}</span></div>
      </button>`;
  };
  const allCount = DATA.themes.reduce((s, t) => s + t.questions.length, 0);
  const themesHtml = DATA.themes.map(t => themeBtn(t.id, `${t.id}. ${esc(t.title)}`, t.questions.length, '')).join('');
  app.innerHTML = `
    <div class="topbar"><button class="back-btn" id="back">← Меню</button><h2>Ввод ответа</h2></div>
    <div class="mode-desc">✍️ Пишешь ответ своими словами — ИИ проверяет по смыслу. Можно листать вопросы и продолжить с того места, где остановился (⏸).</div>
    ${themeBtn(null, '🔁 Все темы', allCount, 'btn-primary')}
    <div class="section-label">Или выбери тему</div>
    ${themesHtml}
  `;
  document.getElementById('back').onclick = renderHome;
  app.querySelectorAll('[data-theme]').forEach(b => {
    b.onclick = () => startInput(b.dataset.theme === 'all' ? null : Number(b.dataset.theme));
  });
}

/* ============ Режим «Экзамен по билетам» ============ */
function renderTicketMenu() {
  S = null;
  const items = TICKETS.map(t => `
    <button class="btn" data-n="${t.n}">
      <div class="btn-row"><span class="btn-title">Билет № ${t.n}</span><span class="count">${t.questions.length} вопр.</span></div>
    </button>`).join('');
  app.innerHTML = `
    <div class="topbar"><button class="back-btn" id="back">← Меню</button><h2>Экзамен по билетам</h2></div>
    <div class="mode-desc">🎫 Берёшь билет, письменно отвечаешь на все вопросы своими словами. ИИ проверяет строго, как экзаменатор: укажет смысловые ошибки и что упущено. В конце — «сдал / не сдал» и разбор по каждому вопросу.</div>
    <button class="btn btn-primary" id="rnd"><div class="btn-title">🎲 Случайный билет</div></button>
    <div class="section-label">Или выбери билет</div>
    ${items}
  `;
  document.getElementById('back').onclick = renderHome;
  document.getElementById('rnd').onclick = () => startTicket(TICKETS[Math.floor(Math.random() * TICKETS.length)].n);
  app.querySelectorAll('[data-n]').forEach(b => { b.onclick = () => startTicket(Number(b.dataset.n)); });
}

function startTicket(n) {
  const t = TICKETS.find(x => x.n === n);
  if (!t) { renderTicketMenu(); return; }
  const questions = t.questions.map((q, i) => ({
    q: q.q, key: q.key,
    options: [q.key], correct: 0,        // совместимость с aiCheck: эталон = key
    id: 'b' + n + 'q' + (i + 1), themeId: n
  }));
  S = { mode: 'ticket', n: n, questions, answers: questions.map(() => ''), verdicts: {} };
  renderTicket();
}

function renderTicket() {
  const blocks = S.questions.map((q, i) => `
    <div class="ticket-q">
      <div class="ticket-qn">Вопрос ${i + 1}</div>
      <p class="question">${esc(q.q)}</p>
      <textarea class="answer-input tk-ans" data-i="${i}" rows="4" placeholder="Напиши ответ своими словами…"
        autocapitalize="sentences" autocorrect="on">${esc(S.answers[i])}</textarea>
    </div>`).join('');
  const allFilled = S.answers.every(a => a.trim() !== '');
  app.innerHTML = `
    <div class="topbar"><button class="back-btn" id="back">← Меню</button><h2>Билет № ${S.n}</h2></div>
    <p class="gate-hint">Ответь на все ${S.questions.length} вопроса, затем нажми «Сдать билет». Проверит ИИ-экзаменатор.</p>
    ${blocks}
    <button class="btn btn-primary" id="submit" ${allFilled ? '' : 'disabled'}><div class="btn-title">Сдать билет</div></button>
    <div id="tkafter"></div>
  `;
  document.getElementById('back').onclick = () => { if (confirm('Выйти из билета? Ответы не сохранятся.')) renderTicketMenu(); };
  app.querySelectorAll('.tk-ans').forEach(ta => {
    ta.oninput = () => {
      S.answers[Number(ta.dataset.i)] = ta.value;
      const ok = S.answers.every(a => a.trim() !== '');
      const sb = document.getElementById('submit'); if (sb) sb.disabled = !ok;
    };
  });
  document.getElementById('submit').onclick = submitTicket;
}

function submitTicket() {
  if (!S.answers.every(a => a.trim() !== '')) return;
  const sess = S; // фиксируем сессию (защита от смены S за время проверки)
  app.innerHTML = `<div class="loading">Проверяю билет…<br><span class="gate-hint">ИИ-экзаменатор читает ответы, это займёт пару секунд ⚡</span></div>`;
  window.scrollTo(0, 0);
  Promise.all(sess.questions.map((q, i) => aiCheck(sess.answers[i], q, 'ticket').then(res => {
    if (res) { sess.verdicts[i] = { correct: res.correct, reason: res.reason, checked: true }; return; }
    const off = checkOffline(sess.answers[i], q); // нет сети — резервная оффлайн-проверка
    if (off === 'yes') sess.verdicts[i] = { correct: true, checked: true };
    else if (off === 'no') sess.verdicts[i] = { correct: false, checked: true };
    else sess.verdicts[i] = { correct: false, checked: false };
  }))).then(() => { if (S === sess) renderTicketResult(); });
}

function renderTicketResult() {
  S.questions.forEach((q, i) => logEvent('ticket', q.themeId, q.id, !!(S.verdicts[i] && S.verdicts[i].correct)));
  flushQueue();
  let correct = 0;
  S.questions.forEach((q, i) => { if (S.verdicts[i] && S.verdicts[i].correct) correct++; });
  const total = S.questions.length;
  const passed = correct >= 2; // порог: сдал при 2 из 3 и выше
  const n = S.n;
  const reviewHtml = S.questions.map((q, i) => {
    const v = S.verdicts[i] || {};
    const ok = !!v.correct;
    return `
      <div class="review-item ${ok ? 'ok' : ''}">
        <div class="review-q">Вопрос ${i + 1}. ${esc(q.q)}</div>
        <div class="review-a your-ans">Твой ответ: ${esc(S.answers[i] || '—')}</div>
        ${!v.checked
          ? '<div class="review-a">⚠️ Не удалось проверить (нет сети)</div>'
          : `<div class="review-a ${ok ? 'correct-ans' : 'your-wrong'}">${ok ? '✔ Зачтено' : '✗ Не зачтено'} <span class="by-ai">⚡ИИ</span></div>`}
        ${v.reason ? `<div class="review-expl coach">👨‍🏫 ${esc(v.reason)}</div>` : ''}
        <div class="review-expl"><b>Эталон.</b> ${esc(q.key)}</div>
      </div>`;
  }).join('');
  app.innerHTML = `
    <h1 class="app-title">Билет № ${n}</h1>
    <div class="result-score">${correct}/${total}</div>
    <p class="result-line ticket-verdict ${passed ? 'passed' : 'failed'}">${passed ? '✅ СДАЛ' : '❌ НЕ СДАЛ'}</p>
    <button class="btn btn-primary" id="another"><div class="btn-title">🎫 Другой билет</div></button>
    <button class="btn" id="home"><div class="btn-title">← В меню</div></button>
    <div class="section-label">Разбор по вопросам</div>
    ${reviewHtml}
  `;
  window.scrollTo(0, 0);
  document.getElementById('another').onclick = renderTicketMenu;
  document.getElementById('home').onclick = renderHome;
}

/* ============ Текстовый анализ ответа (оффлайн) ============ */
const RU_STOP = new Set('и в во на с со к по за из от до о об у не ни но а или что это как для при над под же бы ли то так его ее их чем чём также есть быть это того тем при том чтобы'.split(' '));
function normalizeText(s) {
  return String(s).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim();
}
function levSim(a, b) {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const d = [];
  for (let i = 0; i <= a.length; i++) d[i] = [i];
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    }
  return 1 - d[a.length][b.length] / Math.max(a.length, b.length);
}
function stem(w) { return w.slice(0, Math.min(w.length, 6)); }
function keyCoverage(userNorm, etalon) {
  const keys = normalizeText(etalon).split(' ').filter(w => w.length >= 4 && !RU_STOP.has(w));
  if (!keys.length) return 1;
  const uw = userNorm.split(' ');
  let m = 0;
  keys.forEach(k => { const ks = stem(k); if (uw.some(u => { const us = stem(u); return us === ks || u.includes(ks) || ks.includes(us); })) m++; });
  return m / keys.length;
}
// 'yes' | 'no' | 'unsure' | 'empty'
function checkOffline(userText, q) {
  const ans = normalizeText(userText);
  if (!ans) return 'empty';
  const etRaw = q.options[q.correct];
  if (levSim(ans, normalizeText(etRaw)) >= 0.8) return 'yes';
  const cov = keyCoverage(ans, etRaw);
  if (cov >= 0.6) return 'yes';
  if (cov <= 0.2) return 'no';
  return 'unsure';
}
// ИИ-проверка по смыслу через Claude (GET — без CORS-проблем). Возвращает {correct,reason}/null.
// mode — откуда пришёл ответ ('input' | 'exam' | 'practice'); сервер пишет его в лог inputs.
function aiCheck(userText, q, mode) {
  if (!ANALYTICS_URL) return Promise.resolve(null);
  const tok = (window.SNIPING_CONFIG && window.SNIPING_CONFIG.checkToken) || '';
  const url = ANALYTICS_URL + '?checkq=' + encodeURIComponent(q.q)
    + '&checkc=' + encodeURIComponent(q.options[q.correct])
    + '&checka=' + encodeURIComponent(userText)
    + '&name=' + encodeURIComponent(USER || getUser() || '')
    + '&mode=' + encodeURIComponent(mode || 'input')
    + '&themeId=' + encodeURIComponent(q.themeId != null ? q.themeId : '')
    + '&questionId=' + encodeURIComponent(q.id != null ? q.id : '')
    + '&t=' + encodeURIComponent(tok);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  return fetch(url, { signal: ctrl.signal })
    .then(r => r.json())
    .then(d => { clearTimeout(t); return (d && typeof d.correct === 'boolean') ? { correct: d.correct, reason: d.reason || '' } : null; })
    .catch(() => { clearTimeout(t); return null; });
}

/* ============ Режим «Ввод ответа» (конечный список, с листанием) ============ */
function startInput(themeId, fresh) {
  if (!fresh) {
    const s = loadSessionInput(themeId); // продолжить с того места, где закончил
    if (s) { S = { mode: 'input', themeId: themeId, questions: s.questions, answers: s.answers, idx: s.idx }; renderQuestion(); return; }
  }
  const pool = themeId == null ? allQuestions() : questionsOfTheme(themeId);
  const questions = shuffle(pool).map(prepareQuestion);
  questions.forEach(q => { q.kind = 'input'; }); // все вопросы — ввод текста
  S = { mode: 'input', themeId: themeId, questions, answers: new Array(questions.length).fill(null), idx: 0 };
  clearSessionInput(themeId);
  saveSession();
  renderQuestion(); // kind==='input' → renderQuestionInput (общий движок с листанием)
}

function finishInput() {
  clearSessionInput(S.themeId);
  flushQueue();
  let correct = 0, answered = 0;
  S.answers.forEach(a => { if (a && typeof a === 'object') { answered++; if (a.correct) correct++; } });
  const wrong = answered - correct;
  const total = S.questions.length;
  const pct = answered ? Math.round(correct / answered * 100) : 0;
  const themeId = S.themeId;
  app.innerHTML = `
    <h1 class="app-title">Ввод ответа</h1>
    <div class="result-score">${correct}/${total}</div>
    <div class="result-pct">${pct}% верно</div>
    <p class="result-line">${wrong === 0 ? '🔥 Всё верно!' : `Неверно: ${wrong} — попали в «Работу над ошибками»`}</p>
    <button class="btn btn-primary" id="again"><div class="btn-title">↻ Ещё раз</div></button>
    <button class="btn" id="home"><div class="btn-title">← В меню</div></button>
  `;
  window.scrollTo(0, 0);
  document.getElementById('again').onclick = () => startInput(themeId, true);
  document.getElementById('home').onclick = renderHome;
}

function makeBag(n) { return shuffle(Array.from({ length: n }, (_, i) => i)); }
function startPractice(themeId) {
  const pool = themeId == null ? allQuestions() : questionsOfTheme(themeId);
  S = { mode: 'practice', pool, bag: makeBag(pool.length), pos: 0, prev: -1, questions: [], answers: [], idx: 0 };
  drawPractice();        // первый вопрос
  S.idx = 0;
  renderQuestion();
}
function drawPractice() {
  // достаём следующий индекс из «перемешанного мешка»
  if (S.pos >= S.bag.length) {
    const nb = makeBag(S.pool.length);
    if (S.pool.length > 1 && nb[0] === S.prev) { [nb[0], nb[1]] = [nb[1], nb[0]]; }
    S.bag = nb; S.pos = 0;
  }
  const idx = S.bag[S.pos++];
  S.prev = idx;
  const item = prepareQuestion(S.pool[idx]);
  item.kind = Math.random() < 0.5 ? 'input' : 'test'; // микс: ~половина вопросов — ввод текста
  S.questions.push(item);
  S.answers.push(null);
}

function startTheme(themeId, fresh) {
  const t = DATA.themes.find(t => t.id === themeId);
  if (!fresh) {
    const s = loadSession(themeId);
    if (s) { S = { mode: 'theme', themeId, title: t.title, questions: s.questions, answers: s.answers, idx: s.idx }; renderQuestion(); return; }
  }
  const questions = shuffle(questionsOfTheme(themeId)).map(prepareQuestion);
  S = { mode: 'theme', themeId, title: t.title, questions, answers: new Array(questions.length).fill(null), idx: 0 };
  clearSession(themeId);
  saveSession();
  renderQuestion();
}

/* ============ Рендер вопроса (универсальный) ============ */
// Универсальные «отвечен ли» / «верно ли» — учитывают вопросы с вводом текста.
// input в exam → ответ хранится строкой; input в practice → объектом {text,correct,...} после проверки.
function qAnswered(i) {
  const q = S.questions[i], a = S.answers[i];
  if (q.kind === 'input') {
    if (S.mode === 'exam') return typeof a === 'string' && a.trim() !== '';
    return a != null && typeof a === 'object';
  }
  return a !== null;
}
function qCorrect(i) {
  const q = S.questions[i], a = S.answers[i];
  if (q.kind === 'input') return !!(a && typeof a === 'object' && a.correct);
  return a !== null && a === q.correct;
}
function answeredCount() { let n = 0; for (let i = 0; i < S.questions.length; i++) if (qAnswered(i)) n++; return n; }
function correctCount() { let n = 0; for (let i = 0; i < S.questions.length; i++) if (qCorrect(i)) n++; return n; }

function renderQuestion() {
  const q = S.questions[S.idx];
  if (q.kind === 'input') return renderQuestionInput(); // вопрос с вводом текста — отдельный рендер
  const ans = S.answers[S.idx];
  const answered = ans !== null;
  const reveal = S.mode !== 'exam' && answered; // показать правильность (темы/повторение)
  const last = S.mode !== 'practice' && S.idx === S.questions.length - 1;

  const timerHtml = (S.mode === 'exam' && S.timeLeft != null)
    ? ` · <span class="timer ${S.timeLeft <= 30 ? 'low' : ''}" id="timer">⏱ ${fmtTime(Math.max(0, S.timeLeft))}</span>` : '';
  const topRight = S.mode === 'practice'
    ? `✔ ${correctCount()} / ${answeredCount()}`
    : `Вопрос ${S.idx + 1} / ${S.questions.length}${timerHtml}`;
  const bar = S.mode === 'practice' ? '' :
    `<div class="progress-bar"><span style="width:${Math.round((S.idx) / S.questions.length * 100)}%"></span></div>`;
  const backLabel = S.mode === 'exam' ? '← Выход' : '← Меню';

  const opts = q.options.map((o, i) => {
    let cls = '';
    if (S.mode === 'exam') { if (ans === i) cls = 'selected'; }
    else if (reveal) { if (i === q.correct) cls = 'correct'; else if (i === ans) cls = 'wrong'; }
    const dis = (S.mode !== 'exam' && answered) ? 'disabled' : '';
    return `<button class="option ${cls}" data-i="${i}" ${dis}>
      <span class="letter">${LETTERS[i]}</span><span>${esc(o)}</span></button>`;
  }).join('');

  const expl = (reveal && ans !== q.correct && q.explanation)
    ? `<div class="explain"><b>Пояснение.</b> ${esc(q.explanation)}</div>` : '';
  const fb = reveal ? `<div class="feedback ${ans === q.correct ? 'ok' : 'no'}">${ans === q.correct ? '✔ Верно!' : '✗ Неверно'}</div>` : '';

  // правая кнопка навигации — всегда активна: листай вопросы и выбирай, на какой отвечать
  let rightBtn;
  if (last) {
    rightBtn = `<button class="btn btn-primary nav-btn" id="finish">
      <div class="btn-title">${S.mode === 'exam' ? 'Завершить экзамен' : 'Завершить тему'}</div></button>`;
  } else {
    rightBtn = `<button class="btn btn-primary nav-btn" id="next">
      <div class="btn-title">Вперёд →</div></button>`;
  }

  app.innerHTML = `
    <div class="topbar">
      <button class="back-btn" id="back">${backLabel}</button>
      <span class="progress">${topRight}</span>
    </div>
    ${bar}
    <span class="theme-tag">${esc(q.theme)}</span>
    <p class="question">${esc(q.q)}</p>
    <div id="options">${opts}</div>
    ${fb}${expl}
    <div class="nav-row">
      <button class="btn nav-btn" id="prev" ${(S.idx === 0 || (S.mode === 'exam' && S.level && !S.level.back)) ? 'disabled' : ''}><div class="btn-title">← Назад</div></button>
      ${rightBtn}
    </div>
  `;

  document.getElementById('back').onclick = onBack;
  app.querySelectorAll('.option').forEach(b => { b.onclick = () => selectOption(Number(b.dataset.i)); });
  const prev = document.getElementById('prev'); if (prev) prev.onclick = goPrev;
  const next = document.getElementById('next'); if (next) next.onclick = goNext;
  const fin = document.getElementById('finish'); if (fin) fin.onclick = goNext;
}

/* ====== Рендер вопроса с вводом текста (экзамен и повторение) ====== */
function renderQuestionInput() {
  const q = S.questions[S.idx];
  const isExam = S.mode === 'exam';
  const stored = S.answers[S.idx];
  const checked = (!isExam && stored && typeof stored === 'object') ? stored : null; // уже проверено (объект-вердикт)
  // текст: проверенный ответ, либо черновик-строка (сохраняется по ходу ввода), либо пусто
  const textVal = checked ? checked.text : (typeof stored === 'string' ? stored : '');
  const answered = isExam ? (textVal.trim() !== '') : !!checked;
  const last = S.mode !== 'practice' && S.idx === S.questions.length - 1;

  const timerHtml = (isExam && S.timeLeft != null)
    ? ` · <span class="timer ${S.timeLeft <= 30 ? 'low' : ''}" id="timer">⏱ ${fmtTime(Math.max(0, S.timeLeft))}</span>` : '';
  let topRight;
  if (S.mode === 'practice') topRight = `✔ ${correctCount()} / ${answeredCount()}`;
  else if (S.mode === 'input') topRight = `Вопрос ${S.idx + 1} / ${S.questions.length} · ✔ ${correctCount()}`;
  else topRight = `Вопрос ${S.idx + 1} / ${S.questions.length}${timerHtml}`;
  const bar = S.mode === 'practice' ? '' :
    `<div class="progress-bar"><span style="width:${Math.round((S.idx) / S.questions.length * 100)}%"></span></div>`;
  const backLabel = isExam ? '← Выход' : '← Меню';
  const prevDisabled = (S.idx === 0 || (isExam && S.level && !S.level.back)) ? 'disabled' : '';

  // фидбэк показываем только в повторении (после проверки); в экзамене разбор будет в конце
  let feedbackHtml = '';
  if (checked) {
    const tag = checked.by === 'ai' ? ' <span class="by-ai">⚡ИИ</span>' : '';
    const aiReason = checked.reason ? `<div class="explain coach">👨‍🏫 ${esc(checked.reason)}</div>` : '';
    feedbackHtml = `
      <div class="feedback ${checked.correct ? 'ok' : 'no'}">${checked.correct ? '✔ Верно!' : '✗ Неверно'}${tag}</div>
      ${aiReason}
      <div class="explain"><b>Эталон.</b> ${esc(q.options[q.correct])}${q.explanation ? '<br><br>💡 ' + esc(q.explanation) : ''}</div>`;
  }

  const hint = isExam
    ? '✍️ Ответь своими словами — проверю в конце экзамена.'
    : '✍️ Ответь своими словами, потом нажми «Проверить».';
  const checkBtn = (!isExam && !checked)
    ? '<button class="btn btn-primary" id="pcheck"><div class="btn-title">Проверить</div></button>' : '';

  // кнопка вперёд/завершить — всегда активна: можно листать и пропускать вопросы
  let rightBtn;
  if (isExam) {
    const id = last ? 'finish' : 'next';
    rightBtn = `<button class="btn btn-primary nav-btn" id="${id}"><div class="btn-title">${last ? 'Завершить экзамен' : 'Вперёд →'}</div></button>`;
  } else if (S.mode === 'input') {
    const id = last ? 'finish' : 'next';
    rightBtn = `<button class="btn btn-primary nav-btn" id="${id}"><div class="btn-title">${last ? 'Завершить' : 'Вперёд →'}</div></button>`;
  } else {
    rightBtn = `<button class="btn btn-primary nav-btn" id="next"><div class="btn-title">Вперёд →</div></button>`;
  }

  app.innerHTML = `
    <div class="topbar">
      <button class="back-btn" id="back">${backLabel}</button>
      <span class="progress">${topRight}</span>
    </div>
    ${bar}
    <span class="theme-tag">✍️ ${esc(q.theme)}</span>
    <p class="question">${esc(q.q)}</p>
    <p class="gate-hint">${hint}</p>
    <textarea class="answer-input" id="examans" rows="4" placeholder="Напиши ответ своими словами…"
      autocapitalize="sentences" autocorrect="on" ${checked ? 'disabled' : ''}>${esc(textVal)}</textarea>
    <div id="pafter">${feedbackHtml}</div>
    ${checkBtn}
    <div class="nav-row">
      <button class="btn nav-btn" id="prev" ${prevDisabled}><div class="btn-title">← Назад</div></button>
      ${rightBtn}
    </div>
  `;

  document.getElementById('back').onclick = onBack;
  const ta = document.getElementById('examans');
  const prevB = document.getElementById('prev'); if (prevB && !prevDisabled) prevB.onclick = goPrev;
  const nextB = document.getElementById('next'); if (nextB) nextB.onclick = goNext;
  const finB = document.getElementById('finish'); if (finB) finB.onclick = goNext;

  if (ta && !checked) {
    ta.oninput = () => {
      S.answers[S.idx] = ta.value; // черновик/ответ сохраняем по ходу ввода
      saveSession(); // resume для «Ввода ответа» (no-op для practice/exam)
    };
  }
  const pc = document.getElementById('pcheck');
  if (pc && ta) pc.onclick = () => doCheckText(ta.value);
}

// Проверка введённого текста (повторение и «Ввод ответа»): ИИ → оффлайн → самооценка, разбор сразу.
function doCheckText(text) {
  const q = S.questions[S.idx];
  if (!normalizeText(text)) { document.getElementById('pafter').innerHTML = '<div class="gate-err">Напиши ответ.</div>'; return; }
  const sess = S, idx = S.idx; // фиксируем сессию и номер вопроса на момент проверки
  const ta = document.getElementById('examans'); if (ta) ta.disabled = true;
  const pc = document.getElementById('pcheck'); if (pc) pc.style.display = 'none';
  // блокируем навигацию на время анализа, чтобы вердикт не «переехал» на другой вопрос
  ['prev', 'next', 'finish'].forEach(id => { const el = document.getElementById(id); if (el) el.disabled = true; });
  document.getElementById('pafter').innerHTML = '<div class="gate-hint">Проверяю по смыслу… ⚡</div>';
  aiCheck(text, q, S.mode).then(res => { // mode = 'practice' | 'input' → пишется в лог inputs
    if (S !== sess || S.idx !== idx) return; // ушли с вопроса/сессии — результат не трогаем
    if (res) return commitText(text, res.correct, res.reason, 'ai');
    const off = checkOffline(text, q);
    if (off === 'yes') return commitText(text, true, '', 'offline');
    if (off === 'no') return commitText(text, false, '', 'offline');
    selfAssessText(text); // ни ИИ, ни оффлайн не дали ответа
  });
}
function selfAssessText(text) {
  const q = S.questions[S.idx];
  document.getElementById('pafter').innerHTML = `
    <div class="feedback">🤔 Сравни сам с эталоном:</div>
    <div class="explain"><b>Эталон.</b> ${esc(q.options[q.correct])}${q.explanation ? '<br><br>💡 ' + esc(q.explanation) : ''}</div>
    <div class="nav-row">
      <button class="btn nav-btn card-no" id="psno"><div class="btn-title">Не верно</div></button>
      <button class="btn nav-btn card-yes" id="psyes"><div class="btn-title">Верно</div></button>
    </div>`;
  document.getElementById('psyes').onclick = () => commitText(text, true, '', 'self');
  document.getElementById('psno').onclick = () => commitText(text, false, '', 'self');
}
function commitText(text, correct, reason, by) {
  const q = S.questions[S.idx];
  S.answers[S.idx] = { text: text, correct: correct, reason: reason || '', by: by };
  const p = loadProgress(); recordInto(p, q.id, correct); saveProgress(p);
  logEvent(S.mode, q.themeId, q.id, correct);
  saveSession(); // запомнить прогресс «Ввода ответа» (resume)
  renderQuestionInput();
}

function onBack() {
  if (S.mode === 'exam') { if (confirm('Выйти из экзамена? Результат не сохранится.')) { clearExamTimer(); renderHome(); } }
  else if (S.mode === 'theme') { saveSession(); renderThemeList(); }
  else if (S.mode === 'input') { saveSession(); renderInputMenu(); } // сохранить место и вернуться к выбору
  else renderHome();
}

function selectOption(i) {
  if (S.mode === 'exam') { S.answers[S.idx] = i; renderQuestion(); return; }
  // темы / повторение / частые ошибки — фиксируем ответ
  if (S.answers[S.idx] !== null) return;
  S.answers[S.idx] = i;
  const q = S.questions[S.idx];
  const ok = i === q.correct;
  const p = loadProgress();
  if (S.mode === 'theme' && ok) p.solved[q.id] = 1;
  recordInto(p, q.id, ok);        // статистика ошибок — во всех режимах с проверкой
  saveProgress(p);
  logEvent(S.mode, q.themeId, q.id, ok);   // аналитика
  if (S.mode === 'theme') saveSession();
  renderQuestion();
}

function goPrev() {
  if (S.idx === 0) return;
  S.idx--;
  saveSession(); // no-op кроме theme/input
  renderQuestion();
}

function goNext() {
  // листать вперёд можно всегда, в любом режиме (даже не ответив на текущий вопрос)
  if (S.mode === 'practice') {
    if (S.idx < S.questions.length - 1) S.idx++;
    else { drawPractice(); S.idx++; }
    renderQuestion();
    return;
  }
  // exam / theme / input / mistakes
  if (S.idx < S.questions.length - 1) {
    S.idx++;
    saveSession(); // no-op кроме theme/input
    renderQuestion();
  } else {
    if (S.mode === 'exam') finishExam();
    else if (S.mode === 'theme') finishTheme();
    else if (S.mode === 'input') finishInput();
    else finishMistakes();
  }
}

/* ============ Завершение «Темы» ============ */
function finishTheme() {
  const total = S.questions.length;
  const correct = correctCount();
  const pct = Math.round(correct / total * 100);
  const perfect = correct === total;
  if (perfect) { const p = loadProgress(); p.perfect[S.themeId] = 1; saveProgress(p); }
  clearSession(S.themeId);
  flushQueue();
  const themeId = S.themeId, title = S.title;
  app.innerHTML = `
    <h1 class="app-title">${esc(title)}</h1>
    <div class="result-score">${correct}/${total}</div>
    <div class="result-pct">${pct}% правильных</div>
    <p class="result-line">${perfect ? '🏅 Пройдена без ошибок! Тема засчитана.' : `Ошибок: ${total - correct}. Пройди без ошибок для 🏅`}</p>
    <button class="btn btn-primary" id="again"><div class="btn-title">↻ Пройти тему ещё раз</div></button>
    <button class="btn" id="themes"><div class="btn-title">← К списку тем</div></button>
  `;
  window.scrollTo(0, 0);
  document.getElementById('again').onclick = () => startTheme(themeId, true);
  document.getElementById('themes').onclick = renderThemeList;
}

/* ============ Завершение «Экзамена» ============ */
// верно ли отвечено: test — по индексу, input — по вердикту ИИ
function examCorrect(i) {
  const q = S.questions[i];
  if (q.kind === 'input') { const v = S.verdicts[i]; return !!(v && v.correct); }
  return S.answers[i] === q.correct;
}

function finishExam() {
  clearExamTimer();
  const sess = S; // фиксируем сессию: если за время проверки её сменят/обнулят — не трогаем чужой S
  const toCheck = [];
  sess.questions.forEach((q, i) => { if (q.kind === 'input') toCheck.push(i); });
  if (!toCheck.length) { renderExamResults(); return; }
  app.innerHTML = `<div class="loading">Проверяю развёрнутые ответы…<br><span class="gate-hint">ИИ читает твои формулировки, это займёт пару секунд ⚡</span></div>`;
  window.scrollTo(0, 0);
  Promise.all(toCheck.map(i => {
    const q = sess.questions[i];
    const txt = typeof sess.answers[i] === 'string' ? sess.answers[i] : '';
    if (!txt.trim()) { sess.verdicts[i] = { correct: false, checked: true, empty: true }; return Promise.resolve(); }
    return aiCheck(txt, q, 'exam').then(res => {
      if (res) { sess.verdicts[i] = { correct: res.correct, reason: res.reason, checked: true, by: 'ai' }; return; }
      const off = checkOffline(txt, q); // нет сети — резервная оффлайн-проверка
      if (off === 'yes') sess.verdicts[i] = { correct: true, checked: true, by: 'offline' };
      else if (off === 'no') sess.verdicts[i] = { correct: false, checked: true, by: 'offline' };
      else sess.verdicts[i] = { correct: false, checked: false }; // совсем не удалось проверить
    });
  })).then(() => { if (S === sess) renderExamResults(); }); // отрисовываем только если сессия не сменилась
}

function renderExamResults() {
  const pr = loadProgress();
  S.questions.forEach((q, i) => recordInto(pr, q.id, examCorrect(i)));
  saveProgress(pr);
  S.questions.forEach((q, i) => logEvent('exam', q.themeId, q.id, examCorrect(i))); // аналитика (сводка)
  flushQueue();
  let correct = 0;
  S.questions.forEach((q, i) => { if (examCorrect(i)) correct++; });
  const total = S.questions.length;
  const pct = Math.round(correct / total * 100);
  const wrong = total - correct;
  const lvl = S.level || EXAM_LEVELS.medium;
  const passed = lvl.pass > 0 ? pct >= lvl.pass : null;
  const headline = passed === null
    ? (wrong === 0 ? '🎯 Без ошибок! Отлично!' : `Ошибок: ${wrong}`)
    : (passed ? `✅ СДАЛ (порог ${lvl.pass}%)` : `❌ НЕ СДАЛ (порог ${lvl.pass}%)`);
  const reviewHtml = S.questions.map((q, i) => {
    if (q.kind === 'input') {
      const v = S.verdicts[i] || {};
      const your = typeof S.answers[i] === 'string' ? S.answers[i] : '';
      const ok = !!v.correct;
      const verdictLine = !v.checked
        ? '<div class="review-a">⚠️ Не удалось проверить (нет сети)</div>'
        : `<div class="review-a ${ok ? 'correct-ans' : 'your-wrong'}">${ok ? '✔ Зачтено' : '✗ Не зачтено'} <span class="by-ai">⚡ИИ</span></div>`;
      return `
        <div class="review-item ${ok ? 'ok' : ''}">
          <div class="review-q">${i + 1}. ✍️ ${esc(q.q)}</div>
          <div class="review-a your-ans">Твой ответ: ${your ? esc(your) : '—'}</div>
          ${verdictLine}
          ${v.reason ? `<div class="review-expl coach">👨‍🏫 ${esc(v.reason)}</div>` : ''}
          <div class="review-a correct-ans">Эталон: ${esc(q.options[q.correct])}</div>
        </div>`;
    }
    const your = S.answers[i];
    const ok = your === q.correct;
    return `
      <div class="review-item ${ok ? 'ok' : ''}">
        <div class="review-q">${i + 1}. ${esc(q.q)}</div>
        ${ok
          ? `<div class="review-a correct-ans">✔ ${esc(q.options[q.correct])}</div>`
          : `<div class="review-a your-wrong">✗ Ты выбрал: ${your === null ? '—' : esc(q.options[your])}</div>
             <div class="review-a correct-ans">✔ Правильно: ${esc(q.options[q.correct])}</div>
             ${q.explanation ? `<div class="review-expl">${esc(q.explanation)}</div>` : ''}`}
      </div>`;
  }).join('');
  app.innerHTML = `
    <h1 class="app-title">Результат</h1>
    <div class="result-score">${correct}/${total}</div>
    <div class="result-pct">${pct}% правильных</div>
    <p class="result-line">${headline}</p>
    <button class="btn btn-primary" id="again"><div class="btn-title">🎯 Новый экзамен</div></button>
    <button class="btn" id="home"><div class="btn-title">← В меню</div></button>
    <div class="section-label">Разбор (✔ верно · ✗ ошибка)</div>
    ${reviewHtml}
  `;
  window.scrollTo(0, 0);
  document.getElementById('again').onclick = renderExamSetup;
  document.getElementById('home').onclick = renderHome;
}

/* ============ Режим «Работа над ошибками» ============ */
function startMistakes() {
  const prog = loadProgress();
  const items = mistakeIds(prog).map(findItemById).filter(Boolean);
  if (!items.length) { renderHome(); return; }
  const questions = items.map(prepareQuestion); // порядок сохранён: самые частые сверху
  S = { mode: 'mistakes', questions, answers: new Array(questions.length).fill(null), idx: 0 };
  renderQuestion();
}

function finishMistakes() {
  const total = S.questions.length;
  const correct = correctCount();
  const pct = Math.round(correct / total * 100);
  const left = mistakeIds(loadProgress()).length;
  flushQueue();
  app.innerHTML = `
    <h1 class="app-title">Работа над ошибками</h1>
    <div class="result-score">${correct}/${total}</div>
    <div class="result-pct">${pct}% правильных</div>
    <p class="result-line">Осталось в списке: ${left}. Вопрос выходит из работы над ошибками после 2 верных ответов подряд.</p>
    <button class="btn btn-primary" id="again" ${left ? '' : 'disabled'}><div class="btn-title">↻ Ещё раз</div></button>
    <button class="btn" id="home"><div class="btn-title">← В меню</div></button>
  `;
  window.scrollTo(0, 0);
  if (left) document.getElementById('again').onclick = startMistakes;
  document.getElementById('home').onclick = renderHome;
}

/* ============ Загрузка ============ */
Promise.all([
  fetch('./data/questions.json').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
  fetch('./data/tickets.json').then(r => r.ok ? r.json() : { tickets: [] }).catch(() => ({ tickets: [] }))
])
  .then(([d, t]) => { DATA = d; TICKETS = (t && t.tickets) || []; USER = getUser(); USER ? renderHome() : renderNameGate(); })
  .catch(err => { app.innerHTML = `<div class="loading">Ошибка загрузки вопросов:<br>${esc(err.message)}</div>`; });

if ('serviceWorker' in navigator) {
  // при активации нового SW (он делает skipWaiting+claim) — один раз перезагружаемся на свежую версию
  let swRefreshed = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swRefreshed) return; swRefreshed = true; location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      reg.update(); // принудительно проверять обновление при каждом заходе
      const watch = sw => { if (!sw) return; sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) location.reload();
      }); };
      watch(reg.installing);
      reg.addEventListener('updatefound', () => watch(reg.installing));
    }).catch(() => {});
  });
}
