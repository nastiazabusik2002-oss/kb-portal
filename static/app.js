// TTN Chat Desk — інтерфейс агента. Уся робота з Zammad іде через наш сервер (/api/...).
(function () {
  'use strict';

  const S = {
    me: null, meta: { reasons: [], templates: [], auto_reason: 'mytickets.chat' },
    tab: 'queue', counts: {}, chats: [], prevQueue: null,
    agent: null,               // id агента, чиї чати зараз показуємо (замість вкладки «В інших»)
    agents: [],
    sel: null, t: null, dept: null,
    side: 'dossier', draft: '', trPreview: '',
    reasonOpen: false, reasonQ: '', reasonAct: -1, tplQ: '',
    deptMode: 'note', deptDraft: '', bookingDraft: '',
    create: null,              // форма «нове звернення у відділ»
    mode: 'reply',             // композер: reply — клієнту, note — внутрішня нотатка колегам
    search: null,              // результати пошуку за booking
    myTakes: new Set(),        // чати, які взяла я сама (щоб відрізнити «передали мені»)
    mineInit: false,
    transferOpen: false, transferQ: '', transferFound: [],
    tr: new Map(), trPending: new Set(),
    files: [],                 // вкладення до відповіді (вставлені скріни / 📎)
    queueSeen: null,           // id чатів у черзі на попередньому опитуванні
    mineAct: {},               // id → остання активність клієнта у «Моїх»
  };
  // Коли агент востаннє дивився чат (для мітки «нове повідомлення»)
  const SEEN_KEY = 'desk_seen_v1';
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); } catch (e) {}
  function markSeen(id, at) {
    if (!id) return;
    const v = at || new Date().toISOString();
    if (!seen[id] || seen[id] < v) seen[id] = v;
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch (e) {}
  }
  function isUnread(id, act) { return !!act && (!seen[id] || seen[id] < act); }
  // Чернетки відповідей — окремо для кожного чату, переживають перемикання й F5
  const DRAFT_KEY = 'desk_drafts_v1';
  let drafts = {};
  try { drafts = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); } catch (e) {}
  function saveDraft(id, text) {
    if (!id) return;
    if (text && text.trim()) drafts[id] = text; else delete drafts[id];
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts)); } catch (e) {}
  }
  // Скільки чекає клієнт: 15+ хв — помаранчевий, 30+ — червоний
  function waitMins(iso) { return iso ? Math.max(0, Math.floor((Date.now() - new Date(iso)) / 60000)) : null; }
  function waitLevel(m) { return m === null ? '' : m >= 30 ? 'w30' : m >= 15 ? 'w15' : 'w0'; }
  function waitText(m) { return m < 60 ? `${m} хв` : `${Math.floor(m / 60)} год ${m % 60} хв`; }
  const $ = (id) => document.getElementById(id);

  // ─── Утиліти ─────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function initials(n) {
    const p = String(n || '').replace(/[#@].*$/, '').trim().split(/[\s._-]+/).filter(Boolean);
    return ((p[0] || '?')[0] + (p[1] ? p[1][0] : '')).toUpperCase();
  }
  const AV = [['#EEF4FF', '#2F5BEA'], ['#FDF2FA', '#C11574'], ['#ECFDF3', '#067647'], ['#FFF4ED', '#C4320A'], ['#F4F3FF', '#5925DC']];
  function av(name, id, size) {
    const c = AV[(Number(id) || 0) % AV.length];
    return `<span class="av" style="width:${size}px;height:${size}px;background:${c[0]};color:${c[1]};font-size:${Math.round(size * 0.36)}px">${esc(initials(name))}</span>`;
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso), now = new Date();
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toDateString() === now.toDateString() ? hm : `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${hm}`;
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  }
  function ago(iso) {
    if (!iso) return '';
    const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
    if (m < 1) return 'щойно';
    if (m < 60) return `${m} хв`;
    if (m < 1440) return `${Math.round(m / 60)} год`;
    return `${Math.round(m / 1440)} д`;
  }
  function nice(r) { return String(r || '').split('|').join(' › '); }
  let toastT;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastT);
    toastT = setTimeout(() => el.classList.add('hidden'), 3000);
  }
  // Звуки. Браузер дозволяє звук лише після першого кліку на сторінці —
  // тому AudioContext «розблоковуємо» на першу взаємодію.
  let audio = null;
  function unlockAudio() {
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
    } catch (e) {}
  }
  document.addEventListener('pointerdown', unlockAudio);
  document.addEventListener('keydown', unlockAudio);
  // seq: [частота, старт, тривалість, (кінцева частота — «ковзання»)]
  function tones(seq, type) {
    if (!audio || !prefs.sound) return;
    const t0 = audio.currentTime;
    const peak = 0.05 + 0.3 * prefs.volume;
    seq.forEach(([f, t, d, f2]) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = type || 'sine'; o.frequency.setValueAtTime(f, t0 + t);
      if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + t + d);
      o.connect(g); g.connect(audio.destination);
      g.gain.setValueAtTime(0.0001, t0 + t);
      g.gain.exponentialRampToValueAtTime(peak, t0 + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + t + d);
      o.start(t0 + t); o.stop(t0 + t + d + 0.02);
    });
  }
  // Варіанти звуків — агент обирає сам у налаштуваннях
  const CHAT_SOUNDS = {
    bell:   ['Дзвіночок', () => tones([[660, 0, 0.16], [880, 0.15, 0.16], [1175, 0.3, 0.28]], 'triangle')],
    arp:    ['Арпеджіо', () => tones([[523, 0, 0.14], [659, 0.1, 0.14], [784, 0.2, 0.14], [1047, 0.3, 0.3]], 'sine')],
    alarm:  ['Сигнал', () => tones([[880, 0, 0.12], [880, 0.2, 0.12], [880, 0.4, 0.12]], 'square')],
    marimba:['Ксилофон', () => tones([[1319, 0, 0.09], [1568, 0.08, 0.09], [2093, 0.16, 0.18]], 'triangle')],
  };
  const MSG_SOUNDS = {
    soft:  ['М’який дзинь', () => tones([[988, 0, 0.12], [740, 0.13, 0.22]], 'sine')],
    drop:  ['Крапля', () => tones([[1400, 0, 0.18, 500]], 'sine')],
    knock: ['Тук-тук', () => tones([[330, 0, 0.07], [330, 0.13, 0.07]], 'triangle')],
    ping:  ['Пінг', () => tones([[1760, 0, 0.25]], 'sine')],
  };
  function soundNewChat() { (CHAT_SOUNDS[prefs.chatSound] || CHAT_SOUNDS.bell)[1](); }
  function soundNewMsg() { (MSG_SOUNDS[prefs.msgSound] || MSG_SOUNDS.soft)[1](); }

  // ─── Налаштування агента (звук, тема) — у браузері ──────────
  const PREFS_KEY = 'desk_prefs_v1';
  const prefs = Object.assign({ sound: true, volume: 0.6, chatSound: 'bell', msgSound: 'soft', theme: 'light' },
    (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch (e) { return {}; } })());
  function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }
  const IC_BELL = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
  const IC_BELL_OFF = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  const IC_MOON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  const IC_SUN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';

  function applyPrefs() {
    document.documentElement.dataset.theme = prefs.theme === 'dark' ? 'dark' : 'light';
    const sb = $('sound-btn'), tb = $('theme-btn');
    if (sb) {
      sb.innerHTML = prefs.sound ? IC_BELL : IC_BELL_OFF;
      sb.classList.toggle('off', !prefs.sound);
      sb.title = prefs.sound ? 'Звук увімкнено — натисніть, щоб вимкнути' : 'Звук вимкнено — натисніть, щоб увімкнути';
      sb.setAttribute('aria-label', sb.title);
    }
    if (tb) {
      tb.innerHTML = prefs.theme === 'dark' ? IC_SUN : IC_MOON;
      tb.title = prefs.theme === 'dark' ? 'Світла тема' : 'Темна тема';
      tb.setAttribute('aria-label', tb.title);
    }
    if (!$('prefs').classList.contains('hidden')) renderPrefs();
  }

  function renderPrefs() {
    const opt = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(v[0])}</option>`).join('');
    const play = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
    $('prefs').innerHTML = `
      <h4>Налаштування</h4>
      <label class="switch">Звукові сповіщення<input type="checkbox" id="pf-sound"${prefs.sound ? ' checked' : ''}></label>
      <div class="pref-row"><span>Гучність</span><input type="range" id="pf-vol" min="0" max="1" step="0.05" value="${prefs.volume}"></div>
      <div class="pref-row"><span>Новий чат у черзі</span>
        <div class="pref-line"><select id="pf-chat">${opt(CHAT_SOUNDS, prefs.chatSound)}</select>
          <button class="btn-ghost icon-btn" data-act="pf-play" data-kind="chat" aria-label="Прослухати">${play}</button></div></div>
      <div class="pref-row"><span>Нове повідомлення в моєму чаті</span>
        <div class="pref-line"><select id="pf-msg">${opt(MSG_SOUNDS, prefs.msgSound)}</select>
          <button class="btn-ghost icon-btn" data-act="pf-play" data-kind="msg" aria-label="Прослухати">${play}</button></div></div>
      <div class="pref-row"><span>Тема</span>
        <div class="seg-sm"><button data-act="pf-theme" data-theme="light" class="${prefs.theme !== 'dark' ? 'on' : ''}">Світла</button>
          <button data-act="pf-theme" data-theme="dark" class="${prefs.theme === 'dark' ? 'on' : ''}">Темна</button></div></div>`;
    $('pf-sound').addEventListener('change', e => { prefs.sound = e.target.checked; savePrefs(); applyPrefs(); });
    $('pf-vol').addEventListener('input', e => { prefs.volume = Number(e.target.value); savePrefs(); });
    $('pf-vol').addEventListener('change', () => soundNewMsg());
    $('pf-chat').addEventListener('change', e => { prefs.chatSound = e.target.value; savePrefs(); unlockAudio(); soundNewChat(); });
    $('pf-msg').addEventListener('change', e => { prefs.msgSound = e.target.value; savePrefs(); unlockAudio(); soundNewMsg(); });
  }
  // ─── Моя статистика ─────────────────────────────────────────
  async function openStats() {
    const p = $('stats');
    p.classList.toggle('hidden');
    if (p.classList.contains('hidden')) return;
    p.innerHTML = '<h4>Моя статистика</h4><span class="sec-empty">Рахую…</span>';
    try {
      const r = await api('/api/stats');
      const L = [['today', 'Сьогодні'], ['yesterday', 'Вчора'], ['week', 'Цей тиждень'], ['month', 'Цей місяць']];
      p.innerHTML = `<h4>Моя статистика</h4>
        <div class="stat-grid">${L.map(([k, l]) => `<div class="stat"><small>${l}</small><b>${r.periods[k].mine}</b>
          <span>закрито · команда ${r.periods[k].team}</span></div>`).join('')}</div>
        <div class="stat-now">Зараз веду: <b>${r.now_taken}</b></div>
        <p class="stat-note">Рахуються чати, які закрили, коли ви були їх власником. Тиждень — з понеділка, за київським часом. Оновлюється раз на хвилину.</p>`;
    } catch (e) { p.innerHTML = `<h4>Моя статистика</h4><span class="err">${esc(e.message)}</span>`; }
  }

  // Клік поза панеллю налаштувань — закриваємо
  document.addEventListener('pointerdown', (e) => {
    const p = $('prefs');
    if (p && !p.classList.contains('hidden') && !e.target.closest('.top-ctrl')) p.classList.add('hidden');
    const st = $('stats');
    if (st && !st.classList.contains('hidden') && !e.target.closest('.top-ctrl')) st.classList.add('hidden');
  });

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.form || (opts.body ? JSON.stringify(opts.body) : undefined),
      credentials: 'same-origin',
    });
    if (res.status === 401 && path !== '/api/login') { showLogin(); throw Object.assign(new Error('Потрібно увійти'), { status: 401 }); }
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw Object.assign(new Error((data && data.detail) || `Помилка ${res.status}`), { status: res.status });
    return data;
  }

  // ─── Вхід ───────────────────────────────────────────────────
  function showLogin() {
    $('desk').classList.add('hidden');
    $('login').classList.remove('hidden');
    stopPolling();
  }
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('login-btn');
    btn.disabled = true; $('login-err').textContent = '';
    try {
      await api('/api/login', { method: 'POST', body: { login: $('lg').value, password: $('pw').value } });
      $('pw').value = '';
      await startDesk();
    } catch (err) {
      $('login-err').textContent = err.message;
    } finally { btn.disabled = false; }
  });
  $('logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST', body: {} }).catch(() => {});
    S.sel = null; S.t = null; S.dept = null;
    showLogin();
  });

  async function startDesk() {
    S.me = await api('/api/me');
    $('login').classList.add('hidden');
    $('desk').classList.remove('hidden');
    $('me-name').textContent = S.me.name;
    $('me-av').textContent = initials(S.me.name);
    renderTabs(); renderMain(); renderSide();
    api('/api/meta').then(m => { S.meta = m; if (S.t) renderSide(); }).catch(() => {});
    await loadChats();
    startPolling();
  }

  // ─── Опитування ─────────────────────────────────────────────
  let pollT = null;
  function startPolling() {
    stopPolling();
    pollT = setInterval(() => { loadChats().catch(() => {}); pollTicket().catch(() => {}); }, 5000);
  }
  function stopPolling() { if (pollT) clearInterval(pollT); pollT = null; }

  // ─── Список чатів ───────────────────────────────────────────
  const TABS = [['queue', 'Черга'], ['mine', 'Мої']];
  function renderTabs() {
    $('tabs').innerHTML = TABS.map(([k, l]) => {
      const c = k === 'history' ? '' : `<span class="cnt">${S.counts[k] || 0}</span>`;
      const dot = k === 'mine' && Object.entries(S.mineAct).some(([id, a]) => Number(id) !== S.sel && isUnread(id, a))
        ? '<span class="tab-dot" title="Є нові повідомлення"></span>' : '';
      return `<button data-act="tab" data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${l}${c}${dot}</button>`;
    }).join('');
    renderAgents();
  }

  // «Зараз ведуть»: хто з агентів скільки чатів веде; клік — показати його чати
  function renderAgents() {
    const el = $('agents');
    if (!el) return;
    if (!S.agents.length) { el.innerHTML = '<span class="agents-empty">Зараз ніхто не веде чатів</span>'; return; }
    el.innerHTML = '<span class="agents-title">Зараз ведуть</span><div class="agents-list">' + S.agents.map(a => `
      <button class="agent${a.me ? ' me' : ''}${S.tab === 'agent' && S.agent === a.id ? ' on' : ''}" data-act="agent" data-id="${a.id}"
        title="${esc(a.name)} — ${a.count} ${a.count === 1 ? 'чат' : 'чатів'}. Клікніть, щоб побачити">
        ${av(a.name, a.id, 24)}<span class="agent-name">${esc(a.me ? 'Я' : a.name.split(' ')[0])}</span><b>${a.count}</b></button>`).join('') + '</div>';
  }

  async function loadChats() {
    const want = S.tab === 'agent' ? `agent:${S.agent}` : S.tab;
    const r = await api(S.tab === 'agent' ? `/api/chats?tab=agent&agent=${S.agent}` : `/api/chats?tab=${S.tab}`);
    S.agents = r.agents || [];
    if (r.tab !== want) return;
    S.counts = r.counts; S.chats = r.chats;
    $('q-count').textContent = r.counts.queue || 0;
    // Кількість у черзі видно і на вкладці браузера
    document.title = (r.counts.queue ? `(${r.counts.queue}) ` : '') + 'TTN Chat Desk';
    $('conn-err').textContent = r.error ? 'Zammad не відповідає — дані можуть бути застарілі' : '';
    // Новий чат у черзі (id, якого не було на минулому опитуванні)
    const qIds = new Set(r.queue_ids || []);
    if (S.queueSeen && [...qIds].some(id => !S.queueSeen.has(id))) soundNewChat();
    S.queueSeen = qIds;
    // Нове повідомлення клієнта в моєму чаті
    const mine = r.mine || {};
    const fresh = Object.entries(mine).filter(([id, a]) => S.mineAct[id] !== undefined && a > S.mineAct[id]);
    // Чат з'явився в «Моїх»: взяла сама — вважаємо прочитаним; передав колега — нове
    let handed = false;
    Object.entries(mine).forEach(([id, a]) => {
      if (S.mineAct[id] !== undefined) return;
      if (S.mineInit && !S.myTakes.has(Number(id))) { handed = true; toast('Колега передав вам чат — він у «Моїх»'); }
      else if (!seen[id]) markSeen(id, a);
    });
    S.mineAct = mine; S.mineInit = true;
    if (handed || fresh.some(([id]) => !(Number(id) === S.sel && document.hasFocus()))) soundNewMsg();
    if (S.sel && mine[S.sel] && document.hasFocus()) markSeen(S.sel, mine[S.sel]);
    renderTabs(); renderList();
  }

  const CHIP = { queue: 'Вільний', mine: 'Я веду', history: 'Закрито' };
  function chipHtml(cat, owner) {
    const label = cat === 'others' ? owner : CHIP[cat];
    return `<span class="chip chip-${cat}">${esc(label || '')}</span>`;
  }

  function renderList() {
    const el = $('list');
    if (S.search) return renderSearch();
    const head = S.tab === 'agent' ? (() => {
      const a = S.agents.find(x => x.id === S.agent);
      return `<div class="list-head"><span>Чати: <b>${esc(a ? a.name : 'агента')}</b></span><button data-act="tab" data-tab="queue">✕ До черги</button></div>`;
    })() : '';
    if (!S.chats.length) { el.innerHTML = head + '<p class="empty">Тут порожньо</p>'; return; }
    el.innerHTML = head + S.chats.map(c => {
      const unread = c.category === 'mine' && c.id !== S.sel && isUnread(c.id, S.mineAct[c.id]);
      const wm = waitMins(c.waiting_since), wl = waitLevel(wm);
      const wait = wm !== null ? `<span class="wait ${wl}" title="Клієнт чекає відповіді агента">⏱ ${waitText(wm)}</span>` : '';
      return `
      <button class="item ${wl ? 'i' + wl : ''}${c.id === S.sel ? ' sel' : ''}${unread ? ' unread' : ''}" data-act="open" data-id="${c.id}">
        ${av(c.customer, c.customer_id, 40)}
        <span class="item-body">
          <span class="item-top"><span class="item-name">${esc(c.customer)}</span>
            <span class="item-time" title="${esc(fmtTime(c.last_customer_at || c.updated_at))}">${esc(ago(S.tab === 'queue' ? (c.last_customer_at || c.created_at) : c.updated_at))}</span></span>
          <span class="item-meta">${chipHtml(c.category, c.owner)}<span>${esc(c.site)}</span><span>· #${esc(c.number)}</span></span>
          ${wait}
        </span>
        ${unread ? '<span class="unread-dot" title="Нове повідомлення"></span>' : ''}
      </button>`;
    }).join('');
  }

  // ─── Пошук за booking ───────────────────────────────────────
  async function doSearch(q) {
    q = (q || '').trim();
    if (!q) { S.search = null; renderList(); return; }
    S.search = { booking: q, results: null };
    renderList();
    try {
      const r = await api(`/api/search?booking=${encodeURIComponent(q)}`);
      if (!S.search || S.search.booking !== q) return;
      S.search = r;
    } catch (e) { S.search = { booking: q, results: [], error: e.message }; }
    renderList();
  }
  function renderSearch() {
    const r = S.search, el = $('list');
    const head = `<div class="list-head"><span>Пошук: <b>${esc(r.booking)}</b></span><button data-act="search-clear">✕ Закрити</button></div>`;
    if (r.results === null) { el.innerHTML = head + '<p class="empty">Шукаю…</p>'; return; }
    if (r.error) { el.innerHTML = head + `<p class="empty">${esc(r.error)}</p>`; return; }
    if (!r.results.length) { el.innerHTML = head + '<p class="empty">Нічого не знайдено</p>'; return; }
    el.innerHTML = head + r.results.map(x => `
      <button class="item${x.id === S.sel ? ' sel' : ''}" data-act="open" data-id="${x.id}">
        ${groupIcon(x.group)}
        <span class="item-body">
          <span class="item-top"><span class="item-name">${esc(x.customer)}</span><span class="item-time">${esc(fmtDate(x.updated_at))}</span></span>
          <span class="item-meta"><span class="state ${x.open ? 'open' : 'closed'}">${x.open ? 'відкритий' : 'закритий'}</span><span>${esc(x.group)} · #${esc(x.number)}</span></span>
          <span class="item-meta">${esc(x.title)}</span>
        </span>
      </button>`).join('');
  }

  // ─── Тикет ──────────────────────────────────────────────────
  async function openTicket(id) {
    S.sel = id; S.dept = null; S.create = null; S.draft = drafts[id] || ''; S.trPreview = ''; S.reasonOpen = false; S.bookingDraft = ''; S.files = [];
    S.mode = 'reply'; S.transferOpen = false;
    markSeen(id, S.mineAct[id]);
    S.t = null;
    renderList();
    $('main').innerHTML = '<div class="center">Завантаження…</div>';
    try {
      const t = await api(`/api/tickets/${id}`);
      if (S.sel !== id) return;
      S.t = t;
      renderMain(); renderSide();
    } catch (err) {
      $('main').innerHTML = `<div class="center">${esc(err.message)}</div>`;
    }
  }

  // Оновлюємо відкритий тикет (без «Звернень клієнта» — вони важкі)
  // force — одразу після власної дії (взяв, надіслав); інакше сервер відповідає
  // «без змін», не звертаючись до Zammad, поки тикет не оновився
  async function pollTicket(force) {
    const cur = S.dept || S.t;
    if (!cur) return;
    const since = !force && cur.updated_at ? `&since=${encodeURIComponent(cur.updated_at)}` : '';
    const t = await api(`/api/tickets/${cur.id}?with_related=false${since}`);
    if (t.unchanged) return;
    if (S.dept && S.dept.id === t.id) {
      const changed = t.articles.length !== S.dept.articles.length;
      Object.assign(S.dept, t, { related: S.dept.related });
      if (changed) renderMsgs();
    } else if (S.t && S.t.id === t.id) {
      const changed = t.articles.length !== S.t.articles.length;
      const headChanged = t.category !== S.t.category || t.owner !== S.t.owner;
      Object.assign(S.t, t, { related: S.t.related });
      if (changed && !S.dept) renderMsgs();
      if (headChanged && !S.dept) renderHead();
    }
  }

  function renderMain() {
    const m = $('main');
    if (!S.t) { m.innerHTML = '<div class="center">Оберіть чат зліва</div>'; return; }
    if (S.create) return renderCreate();
    if (S.dept) return renderDept();
    m.innerHTML = `
      <div class="chat-head" id="chat-head"></div>
      <div id="alert-wrap"></div>
      <div id="msgs" class="scroll"></div>
      <div class="composer">
        <div class="seg-sm" id="mode-seg"></div>
        <div id="trp"></div>
        <label for="ta" class="sr">Відповідь клієнту</label>
        <textarea id="ta" rows="3"></textarea>
        <div id="files" class="files"></div>
        <input type="file" id="file-in" multiple class="hidden">
        <div id="emoji" class="emoji hidden"></div>
        <div class="row">
          <button class="btn-ghost icon-btn" data-act="emoji-toggle" aria-label="Смайлики" title="Смайлики" style="font-size:18px">🙂</button>
          <button class="btn-ghost icon-btn" data-act="attach" aria-label="Прикріпити файл" title="Прикріпити файл">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></button>
          <button class="btn-ghost" data-act="side" data-side="tpl">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><line x1="7" y1="8" x2="17" y2="8"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="7" y1="16" x2="13" y2="16"/></svg>
            Шаблони</button>
          <button class="btn-soft" data-act="translate" id="tr-btn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
            Перекласти мовою клієнта</button>
          <div class="grow"></div>
          <button class="btn-primary" data-act="send" id="send-btn">Надіслати
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
        </div>
      </div>`;
    const ta = $('ta');
    ta.value = S.draft;
    ta.addEventListener('input', () => { S.draft = ta.value; saveDraft(S.t && S.t.id, ta.value); if (S.trPreview) { S.trPreview = ''; renderTrPreview(); } });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
    // Скрін із буфера: Ctrl+V / Cmd+V прямо в поле відповіді
    ta.addEventListener('paste', (e) => {
      const imgs = [...(e.clipboardData && e.clipboardData.items || [])]
        .filter(it => it.kind === 'file').map(it => it.getAsFile()).filter(Boolean);
      if (!imgs.length) return;
      e.preventDefault();
      imgs.forEach((f, i) => {
        const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const name = f.name && f.name !== 'image.png' ? f.name : `скрін-${new Date().toTimeString().slice(0, 8).replace(/:/g, '-')}${i ? '-' + i : ''}.${ext}`;
        addFile(new File([f], name, { type: f.type }));
      });
    });
    $('file-in').addEventListener('change', (e) => { [...e.target.files].forEach(addFile); e.target.value = ''; });
    renderHead(); renderAlert(); renderMsgs(true); renderTrPreview(); renderFiles(); renderMode();
  }

  // Режим композера: відповідь клієнту чи внутрішня нотатка в цьому чаті
  function renderMode() {
    const note = S.mode === 'note';
    $('mode-seg').innerHTML = `<button data-act="mode" data-mode="reply" class="${note ? '' : 'on'}">Клієнту</button>
      <button data-act="mode" data-mode="note" class="${note ? 'on' : ''}">Нотатка колегам</button>`;
    const ta = $('ta');
    ta.classList.toggle('note', note);
    ta.placeholder = note ? 'Внутрішня нотатка — бачать лише колеги, клієнт не отримає. Ctrl+Enter — додати'
      : 'Напишіть відповідь українською — переклад зробить кнопка нижче. Скрін — просто Ctrl+V сюди. Ctrl+Enter — надіслати';
    $('tr-btn').classList.toggle('hidden', note);
    $('send-btn').firstChild.textContent = note ? 'Додати нотатку ' : 'Надіслати ';
    if (note && S.trPreview) { S.trPreview = ''; renderTrPreview(); }
  }

  // ─── Місцевий час клієнта (за ринком сайту) ─────────────────
  const SITE_TZ = {
    'tickets.ge': ['Asia/Tbilisi', 'Тбілісі'], 'tickets.az': ['Asia/Baku', 'Баку'], 'tickets.kz': ['Asia/Almaty', 'Алмати'],
    'tickets.uz': ['Asia/Tashkent', 'Ташкент'], 'tickets.kg': ['Asia/Bishkek', 'Бішкек'], 'tickets.am': ['Asia/Yerevan', 'Єреван'],
    'tickets.md': ['Europe/Chisinau', 'Кишинів'], 'tickets.by': ['Europe/Minsk', 'Мінськ'], 'tickets.pl': ['Europe/Warsaw', 'Варшава'],
    'tickets.lv': ['Europe/Riga', 'Рига'], 'tickets.lt': ['Europe/Vilnius', 'Вільнюс'], 'tickets.ee': ['Europe/Tallinn', 'Таллінн'],
    'tickets.com.tr': ['Europe/Istanbul', 'Стамбул'], 'kissandfly.com.tr': ['Europe/Istanbul', 'Стамбул'],
    'mytickets.ae': ['Asia/Dubai', 'Дубай'], 'alrehlat.com': ['Asia/Kuwait', 'Кувейт'], 'mytickets.co.il': ['Asia/Jerusalem', 'Єрусалим'],
    'tickets.ua': ['Europe/Kyiv', 'Київ'], 'kissandfly.de': ['Europe/Berlin', 'Берлін'], 'kissandfly.at': ['Europe/Vienna', 'Відень'],
    'kissandfly.ch': ['Europe/Zurich', 'Цюрих'], 'kissandfly.it': ['Europe/Rome', 'Рим'], 'kissandfly.ro': ['Europe/Bucharest', 'Бухарест'],
    'kissandfly.ng': ['Africa/Lagos', 'Лагос'], 'kissandfly.mx': ['America/Mexico_City', 'Мехіко'],
    'travelfrom.es': ['Europe/Madrid', 'Мадрид'], 'travelfrom.fr': ['Europe/Paris', 'Париж'], 'travelfrom.nl': ['Europe/Amsterdam', 'Амстердам'],
  };
  function clientTime(site) {
    const key = String(site || '').toLowerCase().replace(/^(my|www)\./, '');
    const tz = SITE_TZ[key];
    if (!tz) return '';  // напр. kissandfly.com — міжнародний, країну не знаємо
    try {
      const hm = new Intl.DateTimeFormat('uk-UA', { timeZone: tz[0], hour: '2-digit', minute: '2-digit' }).format(new Date());
      const h = Number(hm.slice(0, 2));
      const night = h >= 22 || h < 8;
      return `<span class="ctime${night ? ' night' : ''}" title="Місцевий час клієнта (${esc(tz[1])})">🕐 у клієнта ${hm} · ${esc(tz[1])}${night ? ' · ніч' : ''}</span>`;
    } catch (e) { return ''; }
  }
  // Годинник у шапці оновлюємо раз на хвилину
  setInterval(() => { if (S.t && !S.dept && !S.create) renderHead(); }, 60000);

  function renderHead() {
    const t = S.t, h = $('chat-head');
    if (!h || !t) return;
    const cat = t.category;
    const btn = !t.is_chat ? '' :
      cat === 'queue' ? '<button class="btn-primary" data-act="take">Взяти чат</button>' :
      cat === 'others' ? '<button class="btn-primary" data-act="take">Перехопити</button>' :
      cat === 'mine' ? '<button class="btn-ghost" data-act="release">Відпустити в чергу</button>' : '';
    const transfer = t.is_chat && t.open ? `<div class="transfer"><button class="btn-ghost" data-act="transfer-toggle">Передати</button>
      ${S.transferOpen ? '<div class="dd transfer-dd" id="transfer-dd"></div>' : ''}</div>` : '';
    const wm = waitMins(t.waiting_since);
    const wait = wm !== null ? `<span class="wait ${waitLevel(wm)}">⏱ клієнт чекає ${waitText(wm)}</span>` : '';
    const lang = t.tpl_lang ? `<span class="dot">•</span><span>${esc(t.tpl_lang.trim())}</span>` : '';
    h.innerHTML = `
      ${av(t.customer.name, t.customer.id, 44)}
      <div class="chat-head-info">
        <span class="chat-name">${esc(t.customer.name)}</span>
        <span class="chat-sub">${cat ? chipHtml(cat, t.owner) : ''}<span>${esc(t.site || t.group)}</span>
          <span class="dot">•</span><a href="${esc(t.zammad_url)}" target="_blank" rel="noopener">#${esc(t.number)}</a>${lang}</span>
        <span class="head-extra">${clientTime(t.site)}${wait}</span>
      </div>${transfer}${btn}`;
    if (S.transferOpen) renderTransfer();
  }

  // ─── Передати чат колезі ────────────────────────────────────
  function renderTransfer() {
    const box = $('transfer-dd');
    if (!box) return;
    const now = S.agents.filter(a => !a.me);
    const list = S.transferQ.trim().length >= 2 ? S.transferFound : now;
    box.innerHTML = `<label for="tr-q" class="sr">Пошук колеги</label><input id="tr-q" placeholder="Ім'я колеги…" autocomplete="off">
      <div class="dd-list scroll">${list.length ? list.map(a => `<button data-act="transfer-to" data-id="${a.id}" data-name="${esc(a.name)}">
        ${av(a.name, a.id, 24)} <span>${esc(a.name)}</span>${a.count ? `<small>${a.count} чат.</small>` : ''}</button>`).join('')
        : `<div class="empty" style="padding:12px">${S.transferQ.trim().length >= 2 ? 'Нікого не знайдено' : 'Почніть вводити ім’я'}</div>`}</div>`;
    const q = $('tr-q');
    q.value = S.transferQ;
    q.focus();
    let timer;
    q.addEventListener('input', () => {
      S.transferQ = q.value;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (S.transferQ.trim().length >= 2) {
          try { S.transferFound = (await api(`/api/agents?q=${encodeURIComponent(S.transferQ.trim())}`)).agents.filter(a => a.id !== S.me.id); }
          catch (e) { S.transferFound = []; }
        }
        renderTransfer();
      }, 300);
    });
  }
  async function transferTo(id, name) {
    if (!confirm(`Передати чат колезі ${name}?`)) return;
    try {
      await api(`/api/tickets/${S.t.id}/transfer`, { method: 'POST', body: { to: id } });
      S.transferOpen = false; S.transferQ = '';
      toast(`Чат передано: ${name}`);
      await Promise.all([pollTicket(true), loadChats()]);
      renderHead(); renderMsgs(true);
    } catch (e) { toast(e.message); }
  }

  function renderAlert() {
    const w = $('alert-wrap');
    if (!w) return;
    const open = (S.t.related || []).filter(r => r.dept && r.open);
    w.innerHTML = open.length ? `<div class="alert">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#B54708" stroke-width="2" stroke-linecap="round" style="flex-shrink:0;margin-top:1px" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <span>По бронюванню ${esc(S.t.booking)} вже працює ${open.map(r => `${esc(r.group)} (#${esc(r.number)})`).join(', ')}. Не створюйте повторний запит — перевірте тикет справа.</span></div>` : '';
  }

  function renderTrPreview() {
    const el = $('trp');
    if (!el) return;
    el.innerHTML = S.trPreview ? `<div class="tr-preview">
      <div class="tr-preview-head"><span>Клієнт отримає переклад</span><button data-act="clear-tr">Скасувати</button></div>
      <div class="tr-preview-text">${esc(S.trPreview)}</div></div>` : '';
  }

  function msgHtml(a) {
    const mine = a.author_id && S.me && a.author_id === S.me.id;
    const cls = a.kind === 'a' && mine ? 'a me' : a.kind;
    let tr = '';
    if (a.translate) {
      if (S.tr.has(a.text)) {
        const v = S.tr.get(a.text);
        if (v) tr = `<div class="tr"><span aria-hidden="true">🌐</span><span>${esc(v)}</span></div>`;
      } else {
        tr = '<div class="tr wait">перекладаю…</div>';
      }
    }
    const atts = (a.attachments || []).map(x => x.image
      ? `<img src="${esc(x.url)}" alt="${esc(x.name)}" data-act="img" data-url="${esc(x.url)}">`
      : `<a href="${esc(x.url)}" target="_blank" rel="noopener">📎 ${esc(x.name)}</a>`).join('');
    const meta = a.kind === 'c' ? fmtTime(a.time)
      : a.kind === 'note' ? `Внутрішня нотатка · ${a.author} · ${fmtTime(a.time)}`
      : a.kind === 'sys' ? `Система · ${fmtTime(a.time)}`
      : `${mine ? 'Я · ' : ''}${a.author} · ${fmtTime(a.time)}`;
    return `<div class="msg ${cls}"><div class="bubble">${esc(a.text || (atts ? '' : '(без тексту)'))}${tr}${atts ? `<div class="att">${atts}</div>` : ''}</div>
      <span class="meta">${esc(meta)}</span></div>`;
  }

  function renderMsgs(forceBottom) {
    const box = $('msgs');
    const src = S.dept || S.t;
    if (!box || !src) return;
    const atBottom = forceBottom || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    let lastDay = '';
    box.innerHTML = src.articles.length ? src.articles.map(a => {
      const day = fmtDate(a.time);
      const sep = day !== lastDay ? `<span class="day">${esc(day)}</span>` : '';
      lastDay = day;
      return sep + msgHtml(a);
    }).join('') : '<div class="center">Повідомлень немає</div>';
    if (atBottom) box.scrollTop = box.scrollHeight;
    translatePending();
  }

  async function translatePending() {
    const src = S.dept || S.t;
    if (!src) return;
    const texts = [...new Set(src.articles.filter(a => a.translate && !S.tr.has(a.text) && !S.trPending.has(a.text)).map(a => a.text))];
    if (!texts.length) return;
    texts.forEach(x => S.trPending.add(x));
    try {
      const r = await api('/api/translate', { method: 'POST', body: { texts } });
      Object.entries(r.results || {}).forEach(([k, v]) => S.tr.set(k, v));
    } catch (e) {
      texts.forEach(x => S.tr.set(x, null));
    } finally {
      texts.forEach(x => S.trPending.delete(x));
    }
    renderMsgs();
  }

  // ─── Смайлики ───────────────────────────────────────────────
  // Набір під підтримку: ввічливі, позитивні, «вибачте», подорожі
  const EMOJI = [
    ['Часті', '🙂 😊 😉 🙏 👍 👌 ✅ 🤝 ❤️ 😔 🙌 👋'],
    ['Емоції', '😀 😃 😄 😁 😅 😂 🥰 😍 🤗 🤔 😌 😇 😎 🥲 😢 😞 😕 🙁 😮 😯 😬 😴'],
    ['Жести', '👍 👎 👏 🙌 🙏 🤝 👋 ✌️ 🤞 👌 👉 👆 💪 ✍️'],
    ['Подорожі', '✈️ 🛫 🛬 🧳 🎫 🛂 🚆 🚌 🚕 🏨 🗺️ 🌍 ⏰ 📅 📍'],
    ['Символи', '✅ ☑️ ❗ ❓ ⚠️ ℹ️ 🔔 📩 📞 💳 💰 🔁 ⏳ ⭐ 🎉 🔥 💙 💛'],
  ];
  function renderEmoji() {
    $('emoji').innerHTML = EMOJI.map(([g, list]) => `<div class="emoji-group"><span>${g}</span><div>${
      list.split(' ').map(e => `<button data-act="emoji" data-e="${e}" aria-label="${e}">${e}</button>`).join('')}</div></div>`).join('');
  }
  // Вставляємо смайлик туди, де стоїть курсор
  function insertEmoji(e) {
    const ta = $('ta');
    const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, a) + e + ta.value.slice(b);
    ta.selectionStart = ta.selectionEnd = a + e.length;
    ta.focus();
    S.draft = ta.value;
    if (S.trPreview) { S.trPreview = ''; renderTrPreview(); }
  }
  document.addEventListener('pointerdown', (e) => {
    const p = $('emoji');
    if (p && !p.classList.contains('hidden') && !e.target.closest('#emoji') && !e.target.closest('[data-act="emoji-toggle"]')) p.classList.add('hidden');
  });

  // ─── Вкладення ──────────────────────────────────────────────
  function addFile(f) {
    if (f.size > 15 * 1024 * 1024) return toast(`${f.name}: більше 15 МБ`);
    if (S.files.length >= 10) return toast('Не більше 10 файлів');
    S.files.push({ file: f, url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null });
    renderFiles();
  }
  function renderFiles() {
    const el = $('files');
    if (!el) return;
    el.innerHTML = S.files.map((x, i) => `<span class="file">
      ${x.url ? `<img src="${esc(x.url)}" alt="">` : '<span class="file-ic">📎</span>'}
      <span class="file-name">${esc(x.file.name)}</span>
      <button data-act="rm-file" data-i="${i}" aria-label="Прибрати файл">×</button></span>`).join('');
  }

  // ─── Дії в чаті ─────────────────────────────────────────────
  async function take(force) {
    try {
      S.myTakes.add(S.t.id);
      await api(`/api/tickets/${S.t.id}/take`, { method: 'POST', body: { force: !!force } });
      toast('Чат у вкладці «Мої» — колеги бачать, що його ведете ви');
      S.tab = 'mine';
      await Promise.all([pollTicket(true), loadChats()]);
      renderHead();
    } catch (err) {
      if (err.status === 409 && !force && confirm(`${err.message}. Перехопити на себе?`)) return take(true);
      if (err.status !== 409) toast(err.message);
    }
  }

  async function release() {
    try {
      await api(`/api/tickets/${S.t.id}/release`, { method: 'POST', body: {} });
      toast('Чат повернувся в загальну чергу');
      S.tab = 'queue';
      await Promise.all([pollTicket(true), loadChats()]);
      renderHead();
    } catch (err) { toast(err.message); }
  }

  async function translateReply() {
    if (!S.draft.trim()) return toast('Спершу напишіть відповідь');
    if (!S.t.lang_sample) return toast('Клієнт пише кирилицею — переклад не потрібен');
    const b = $('tr-btn');
    b.disabled = true;
    try {
      const r = await api('/api/translate-reply', { method: 'POST', body: { text: S.draft, sample: S.t.lang_sample } });
      S.trPreview = r.text;
      renderTrPreview();
    } catch (err) { toast(err.message); } finally { b.disabled = false; }
  }

  async function send(force) {
    if (S.mode === 'note') return sendNote();
    const text = (S.trPreview || S.draft).trim();
    if (!text && !S.files.length) return;
    const b = $('send-btn');
    b.disabled = true;
    try {
      const wasQueue = S.t.category === 'queue';
      S.myTakes.add(S.t.id);  // відповідь з черги = взяла сама (до запиту, щоб опитування не прийняло за «передали»)
      const fd = new FormData();
      fd.append('text', text);
      if (force) fd.append('force', '1');
      S.files.forEach(x => fd.append('files', x.file, x.file.name));
      await api(`/api/tickets/${S.t.id}/reply`, { method: 'POST', form: fd });
      S.files.forEach(x => x.url && URL.revokeObjectURL(x.url));
      S.draft = ''; S.trPreview = ''; S.files = []; saveDraft(S.t.id, '');
      S.myTakes.add(S.t.id);
      $('ta').value = ''; renderTrPreview(); renderFiles();
      if (wasQueue) { toast('Відповіли — чат автоматично взято на вас'); S.tab = 'mine'; }
      await Promise.all([pollTicket(true), loadChats()]);
      renderHead(); renderMsgs(true);
    } catch (err) {
      if (err.status === 409 && !force && confirm(`${err.message}. Все одно надіслати й перехопити чат?`)) { b.disabled = false; return send(true); }
      toast(err.message);
    } finally { b.disabled = false; }
  }

  async function sendNote() {
    const text = S.draft.trim();
    if (!text) return;
    if (S.files.length) return toast('До нотатки файли поки не додаються — надішліть їх клієнтом або в Zammad');
    const b = $('send-btn');
    b.disabled = true;
    try {
      await api(`/api/tickets/${S.t.id}/article`, { method: 'POST', body: { text, mode: 'note' } });
      S.draft = ''; saveDraft(S.t.id, ''); $('ta').value = '';
      toast('Нотатку додано — її бачать лише колеги');
      await pollTicket(true); renderMsgs(true);
    } catch (e) { toast(e.message); } finally { b.disabled = false; }
  }

  // ─── Тикет відділу в центрі ─────────────────────────────────
  async function openDept(id) {
    try {
      const d = await api(`/api/tickets/${id}?with_related=false`);
      S.dept = d; S.deptDraft = ''; S.deptMode = d.is_chat ? 'mail' : 'note';
      renderMain(); renderSide();
    } catch (err) { toast(err.message); }
  }

  const GROUP_IC = { 'Виписка': ['ВП', '#EEF4FF', '#2F5BEA'], 'Рефанд': ['РФ', '#FDF2FA', '#C11574'], 'Інвол': ['ІН', '#FFF4ED', '#C4320A'], 'ССО': ['СО', '#F4F3FF', '#5925DC'], 'Пошта': ['@', '#F2F4F7', '#475467'], 'Чат': ['Ч', '#ECFDF3', '#067647'] };
  function groupIcon(g) {
    const s = GROUP_IC[g] || [initials(g), '#F4F3FF', '#5925DC'];
    return `<span class="rel-ic" style="background:${s[1]};color:${s[2]}">${esc(s[0])}</span>`;
  }

  function renderDept() {
    const d = S.dept, note = S.deptMode === 'note';
    const tpls = note ? (d.internal_templates || []) : [];
    $('main').innerHTML = `
      <div class="chat-head">
        <button class="btn-ghost" data-act="dept-back">← До чату</button>
        ${groupIcon(d.group)}
        <div class="chat-head-info">
          <span class="chat-sub" style="color:var(--ink)"><span class="chat-name">${esc(d.group)} · #${esc(d.number)}</span>
            <span class="state ${d.open ? 'open' : 'closed'}">${d.open ? 'відкритий' : 'закритий'}</span></span>
          <span class="chat-sub">${esc(d.title)} · клієнт ${esc(d.customer.name)}</span>
        </div>
        <a href="${esc(d.zammad_url)}" target="_blank" rel="noopener">Відкрити в Zammad</a>
      </div>
      <div id="msgs" class="scroll"></div>
      <div class="composer">
        <div class="seg-sm">
          <button data-act="dept-mode" data-mode="note" class="${note ? 'on' : ''}">Нотатка для відділу</button>
          <button data-act="dept-mode" data-mode="mail" class="${note ? '' : 'on'}">Лист клієнту</button>
        </div>
        <span style="font-size:13px;color:var(--muted)">${note ? 'Нотатку бачить лише відділ — клієнт її не отримає. У чат автоматично додасться запис, що ви написали у відділ.' : 'Лист піде клієнту на пошту в цей тикет.'}</span>
        ${tpls.length ? `<div class="chips">${tpls.map((x, i) => `<button data-act="dept-tpl" data-i="${i}">${esc(x.label)}</button>`).join('')}</div>` : ''}
        <label for="dta" class="sr">Текст</label>
        <textarea id="dta" rows="3" class="${note ? 'note' : ''}" placeholder="${note ? 'Напишіть колегам з відділу…' : 'Лист клієнту…'}"></textarea>
        <div class="row"><div class="grow"></div><button class="btn-primary" data-act="dept-send" id="dept-send">${note ? 'Додати нотатку' : 'Надіслати лист'}</button></div>
      </div>`;
    const ta = $('dta');
    ta.value = S.deptDraft;
    ta.addEventListener('input', () => { S.deptDraft = ta.value; });
    renderMsgs(true);
  }

  async function deptSend() {
    const text = S.deptDraft.trim();
    if (!text) return;
    const b = $('dept-send');
    b.disabled = true;
    try {
      await api(`/api/tickets/${S.dept.id}/article`, { method: 'POST', body: { text, mode: S.deptMode, from_chat: S.t.id } });
      S.deptDraft = ''; $('dta').value = '';
      toast(`${S.deptMode === 'note' ? 'Нотатку додано' : 'Лист надіслано'} — і записано в чат`);
      await pollTicket(true);
      renderMsgs(true);
    } catch (err) { toast(err.message); } finally { b.disabled = false; }
  }

  // ─── Нове звернення у відділ ────────────────────────────────
  function openCreate() {
    const depts = S.meta.depts || [];
    if (!depts.length) return toast('Довідники ще завантажуються, спробуйте за секунду');
    S.dept = null;
    S.create = { gid: depts[0].id, subject: '', text: '', urgent: false };
    renderMain(); renderSide();
  }

  function renderCreate() {
    const c = S.create, t = S.t;
    const depts = S.meta.depts || [];
    const d = depts.find(x => x.id === c.gid) || depts[0];
    const dup = (t.related || []).filter(r => r.dept && r.open && r.group === d.name);
    const reasonOk = t.reason && t.reason !== S.meta.auto_reason;
    $('main').innerHTML = `
      <div class="chat-head">
        <button class="btn-ghost" data-act="create-back">← До чату</button>
        <div class="chat-head-info"><span class="chat-name">Нове звернення у відділ</span>
          <span class="chat-sub">Клієнт ${esc(t.customer.name)} · booking ${esc(t.booking || '—')}</span></div>
      </div>
      <div class="scroll create">
        <div class="field"><span class="sec-title">Відділ</span>
          <div class="seg-sm">${depts.map(x => `<button data-act="create-dept" data-id="${x.id}" class="${x.id === c.gid ? 'on' : ''}">${esc(x.name)}</button>`).join('')}</div></div>
        ${dup.length ? `<div class="alert" style="margin:0">
          <span>У ${esc(d.name)} вже є відкрите звернення по цьому бронюванню: ${dup.map(r => `<a href="#" data-act="dept" data-id="${r.id}">#${esc(r.number)}</a>`).join(', ')}. Можливо, краще написати туди нотатку, ніж створювати нове.</span></div>` : ''}
        <div class="field"><label for="cr-subj">Коротко суть — піде в назву тикета</label>
          <div class="subj"><span>${esc(t.booking || '')}</span><input id="cr-subj" placeholder="напр.: додати багаж" autocomplete="off"></div></div>
        <div class="field"><label for="cr-text">Запит для відділу</label>
          ${d.templates && d.templates.length ? `<div class="chips">${d.templates.map((x, i) => `<button data-act="create-tpl" data-i="${i}">${esc(x.label)}</button>`).join('')}</div>` : ''}
          <textarea id="cr-text" rows="5" class="note" placeholder="Що потрібно від колег з відділу…"></textarea></div>
        <label class="check"><input type="checkbox" id="cr-urgent"${c.urgent ? ' checked' : ''}> Терміново (високий пріоритет)</label>
        <span style="font-size:13px;color:var(--muted)">Причина звернення: ${reasonOk ? `<b style="color:var(--ink2)">${esc(nice(t.reason))}</b> (з чату)` : 'не вказана в чаті — тикет створиться без неї'}</span>
        <span class="err" id="cr-err"></span>
        <div class="row"><div class="grow"></div><button class="btn-primary" data-act="create-send" id="cr-send">Створити звернення</button></div>
      </div>`;
    const subj = $('cr-subj'), txt = $('cr-text'), urg = $('cr-urgent');
    subj.value = c.subject; txt.value = c.text;
    subj.addEventListener('input', () => { c.subject = subj.value; });
    txt.addEventListener('input', () => { c.text = txt.value; });
    urg.addEventListener('change', () => { c.urgent = urg.checked; });
    subj.focus();
  }

  async function createSend() {
    const c = S.create, t = S.t;
    const err = $('cr-err');
    if (!c.subject.trim()) { err.textContent = 'Вкажіть коротко суть'; return $('cr-subj').focus(); }
    if (!c.text.trim()) { err.textContent = 'Опишіть запит для відділу'; return $('cr-text').focus(); }
    const b = $('cr-send');
    b.disabled = true;
    try {
      const r = await api('/api/dept-tickets', { method: 'POST', body: {
        group_id: c.gid, subject: c.subject, text: c.text, urgent: c.urgent,
        booking: t.booking, reason: t.reason, from_chat: t.id } });
      const name = ((S.meta.depts || []).find(x => x.id === c.gid) || {}).name || 'відділ';
      toast(`Створено звернення у ${name} #${r.number} — і записано в чат`);
      S.create = null;
      // Оновлюємо «Звернення клієнта» і відкриваємо новий тикет
      const fresh = await api(`/api/tickets/${t.id}`);
      if (S.t && S.t.id === fresh.id) S.t = fresh;
      await openDept(r.id);
    } catch (e) {
      err.textContent = e.message;
    } finally { const bb = $('cr-send'); if (bb) bb.disabled = false; }
  }

  // ─── Права панель ───────────────────────────────────────────
  function renderSide() {
    const s = $('side');
    if (!S.t) { s.innerHTML = '<div class="center">Тут буде інформація про клієнта і шаблони</div>'; return; }
    s.innerHTML = `
      <div class="pad"><div class="seg">
        <button data-act="side" data-side="dossier" class="${S.side === 'dossier' ? 'on' : ''}">Клієнт</button>
        <button data-act="side" data-side="tpl" class="${S.side === 'tpl' ? 'on' : ''}">Шаблони</button>
      </div></div>
      <div id="side-body" class="scroll"></div>`;
    S.side === 'tpl' ? renderTpls() : renderDossier();
  }

  function renderDossier() {
    const t = S.t, b = $('side-body');
    const relRow = r => `
      <div class="rel">
        <button class="rel-main${S.dept && S.dept.id === r.id ? ' on' : ''}" data-act="dept" data-id="${r.id}">
          ${groupIcon(r.group)}
          <span class="rel-txt">
            <span class="rel-top"><span class="rel-num">#${esc(r.number)}</span>
              <span class="state ${r.open ? 'open' : 'closed'}">${r.open ? 'відкритий' : 'закритий'}</span>
              <span style="font-size:12px;color:var(--muted2)">${esc(fmtDate(r.created_at))}</span></span>
            <span class="rel-title">${esc(r.group)} · ${esc(r.title)}</span>
          </span>
        </button>
        <a class="rel-ext" href="${esc(t.zammad_url.replace(/\d+$/, r.id))}" target="_blank" rel="noopener" aria-label="Відкрити в Zammad" title="Відкрити в Zammad">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#667085" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>
      </div>`;
    // Три окремі блоки: відділи / листи / попередні чати
    const SECS = [
      ['dept', 'Звернення у відділи', 'Виписка, Рефанд, Інвол, ССО по цьому бронюванню', 'sec-dept'],
      ['mail', 'Листи', 'Пошта та інші звернення клієнта', 'sec-mail'],
      ['chat', 'Попередні чати', '', 'sec-chat'],
    ];
    const rel = t.related === null ? '<span style="color:var(--muted2)">Завантаження…</span>'
      : SECS.map(([k, title, sub, cls]) => {
        const items = (t.related || []).filter(r => (r.kind || (r.dept ? 'dept' : 'mail')) === k);
        return `<div class="sec ${cls}">
          <span class="sec-title">${title}<span class="sec-cnt">${items.length}</span></span>
          ${sub ? `<span class="sec-sub">${sub}</span>` : ''}
          ${items.length ? items.map(relRow).join('') : '<span class="sec-empty">Немає</span>'}
          ${k === 'dept' && t.is_chat ? '<button class="btn-ghost new-dept" data-act="create-open">+ Нове звернення у відділ</button>' : ''}</div>`;
      }).join('');
    const auto = !t.reason || t.reason === S.meta.auto_reason;
    const closable = t.is_chat && t.open;
    b.innerHTML = `
      <div class="client">${av(t.customer.name, t.customer.id, 44)}
        <div style="min-width:0"><div class="client-name">${esc(t.customer.name)}</div><div class="client-mail">${esc(t.customer.email)}</div></div></div>
      <div class="boxes">
        <button class="box" data-act="copy-booking" title="Клікни, щоб скопіювати"><small>Booking</small><b id="bk">${esc(t.booking || '—')}</b></button>
        <div class="box"><small>Сайт</small><b>${esc(t.site || t.group)}</b></div>
      </div>
      ${rel}
      ${closable ? `
      <div class="sec">
        <span class="sec-title">Причина звернення *</span>
        <button class="reason-btn${auto ? ' auto' : ''}" data-act="reason-toggle"><span class="grow">${esc(t.reason ? nice(t.reason) : 'Не вказана')}</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>
        ${S.reasonOpen ? `<div class="dd"><label for="rq" class="sr">Пошук причини</label><input id="rq" placeholder="Пошук причини…" autocomplete="off"><div class="dd-list scroll" id="rlist"></div></div>` : ''}
        ${auto ? '<span class="hint-warn">Зараз стоїть автоматична «mytickets.chat» — оберіть справжню</span>' : ''}
        ${t.booking ? '' : `<div class="field"><label for="bk-in">Booking Number *</label><input id="bk-in" style="height:44px" value="${esc(S.bookingDraft)}"></div>`}
        <button class="btn-green" data-act="close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
          Закрити чат</button>
        <span class="err" id="close-err"></span>
      </div>` : ''}`;
    if (S.reasonOpen) {
      const rq = $('rq');
      rq.value = S.reasonQ;
      rq.addEventListener('input', () => { S.reasonQ = rq.value; S.reasonAct = -1; renderReasons(); });
      rq.addEventListener('keydown', reasonKeys);
      renderReasons();
      rq.focus();
    }
    const bk = $('bk-in');
    if (bk) bk.addEventListener('input', () => { S.bookingDraft = bk.value; });
  }

  function reasonList() {
    const q = S.reasonQ.trim().toLowerCase();
    return S.meta.reasons.filter(r => r !== S.meta.auto_reason && (!q || nice(r).toLowerCase().includes(q)));
  }
  function renderReasons() {
    const el = $('rlist');
    if (!el) return;
    const list = reasonList();
    el.innerHTML = list.length ? list.map((r, i) =>
      `<button data-act="reason" data-i="${i}" class="${i === S.reasonAct ? 'act' : ''}">${esc(nice(r))}</button>`).join('')
      : `<div class="empty" style="padding:12px">${S.meta.reasons.length ? 'Нічого не знайдено' : 'Список причин завантажується…'}</div>`;
  }
  function reasonKeys(e) {
    const n = reasonList().length;
    if (e.key === 'ArrowDown') { e.preventDefault(); S.reasonAct = Math.min(S.reasonAct + 1, n - 1); renderReasons(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); S.reasonAct = Math.max(S.reasonAct - 1, 0); renderReasons(); }
    else if (e.key === 'Enter') { e.preventDefault(); const i = S.reasonAct >= 0 ? S.reasonAct : (n === 1 ? 0 : -1); if (i >= 0) pickReason(i); }
    else if (e.key === 'Escape') { S.reasonOpen = false; renderDossier(); }
  }
  async function pickReason(i) {
    const r = reasonList()[i];
    if (!r) return;
    const prev = S.t.reason;
    S.t.reason = r; S.reasonOpen = false; S.reasonQ = ''; S.reasonAct = -1;
    renderDossier();
    try {
      await api(`/api/tickets/${S.t.id}/reason`, { method: 'POST', body: { reason: r } });
    } catch (err) { S.t.reason = prev; renderDossier(); toast(err.message); }
  }

  async function closeChat() {
    const err = $('close-err');
    const t = S.t;
    if (!t.reason || t.reason === S.meta.auto_reason) { err.textContent = 'Щоб закрити чат, оберіть причину звернення'; S.reasonOpen = true; renderDossier(); return; }
    if (!t.booking && !S.bookingDraft.trim()) { err.textContent = 'Щоб закрити чат, вкажіть Booking Number'; return; }
    try {
      await api(`/api/tickets/${t.id}/close`, { method: 'POST', body: { reason: t.reason, booking: S.bookingDraft } });
      toast('Чат закрито. Якщо клієнт напише знову — він повернеться в «Чергу»');
      S.sel = null; S.t = null; S.dept = null;
      renderMain(); renderSide();
      await loadChats();
    } catch (e) { err.textContent = e.message; }
  }

  function tplList() {
    const q = S.tplQ.trim().toLowerCase();
    return (S.meta.templates || []).filter(x => !q || (x.label + ' ' + x.ua).toLowerCase().includes(q));
  }
  function renderTpls() {
    const b = $('side-body');
    const lang = S.t.tpl_lang;
    b.innerHTML = `
      <div><label for="tq" class="sr">Пошук шаблону</label>
        <input id="tq" placeholder="Пошук шаблону…" autocomplete="off" style="width:100%;height:44px;border:1px solid var(--line2);border-radius:12px;padding:0 14px">
        <p style="margin:10px 2px 0;font-size:12px;color:var(--muted);line-height:1.5">${lang ? `Переклад із таблиці: <b style="color:var(--ink2)">${esc(lang.trim())}</b> — шаблон вставиться одразу з перекладом` : 'Шаблони українською'}</p></div>
      <div id="tpl-list" style="display:flex;flex-direction:column;gap:10px"></div>`;
    const tq = $('tq');
    tq.value = S.tplQ;
    tq.addEventListener('input', () => { S.tplQ = tq.value; renderTplItems(); });
    renderTplItems();
  }
  function renderTplItems() {
    const el = $('tpl-list');
    const lang = S.t.tpl_lang;
    const list = tplList();
    el.innerHTML = list.length ? list.map((x, i) => {
      const tr = lang && x.tr[lang];
      return `<button class="tpl" data-act="tpl" data-i="${i}"><b>${esc(x.label)}</b><span>${esc(x.ua)}</span>${tr ? `<i>${esc(tr)}</i>` : ''}</button>`;
    }).join('') : `<p class="empty" style="padding:20px">${(S.meta.templates || []).length ? 'Нічого не знайдено' : 'Шаблони завантажуються…'}</p>`;
  }
  function useTpl(i) {
    const x = tplList()[i];
    if (!x) return;
    if (S.dept) { S.dept = null; renderMain(); }
    const tr = S.t.tpl_lang && x.tr[S.t.tpl_lang];
    S.draft = x.ua;
    S.trPreview = tr || '';
    $('ta').value = S.draft;
    renderTrPreview();
    $('ta').focus();
    toast(tr ? 'Шаблон вставлено з перекладом — перевірте і надішліть' : 'Шаблон вставлено');
  }

  // ─── Кліки (одна делегація на все) ──────────────────────────
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'agent') {
      const id = Number(el.dataset.id);
      const me = S.agents.find(a => a.id === id && a.me);
      if (S.tab === 'agent' && S.agent === id) { S.tab = 'queue'; S.agent = null; }
      else if (me) { S.tab = 'mine'; S.agent = null; }
      else { S.tab = 'agent'; S.agent = id; }
      S.chats = []; renderTabs(); $('list').innerHTML = '<p class="empty">Завантаження…</p>';
      loadChats().catch(err => toast(err.message));
    }
    else if (act === 'tab') { S.tab = el.dataset.tab; S.agent = null; S.chats = []; renderTabs(); $('list').innerHTML = '<p class="empty">Завантаження…</p>'; loadChats().catch(err => toast(err.message)); }
    else if (act === 'open') openTicket(Number(el.dataset.id));
    else if (act === 'take') take(false);
    else if (act === 'release') release();
    else if (act === 'translate') translateReply();
    else if (act === 'clear-tr') { S.trPreview = ''; renderTrPreview(); }
    else if (act === 'send') send(false);
    else if (act === 'mode') { S.mode = el.dataset.mode; renderMode(); $('ta').focus(); }
    else if (act === 'transfer-toggle') { S.transferOpen = !S.transferOpen; S.transferQ = ''; S.transferFound = []; renderHead(); }
    else if (act === 'transfer-to') transferTo(Number(el.dataset.id), el.dataset.name);
    else if (act === 'search-clear') { S.search = null; $('search-in').value = ''; renderList(); }
    else if (act === 'sound-toggle') { prefs.sound = !prefs.sound; savePrefs(); applyPrefs(); unlockAudio(); if (prefs.sound) soundNewMsg(); toast(prefs.sound ? 'Звук увімкнено' : 'Звук вимкнено'); }
    else if (act === 'theme-toggle') { prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark'; savePrefs(); applyPrefs(); }
    else if (act === 'stats-toggle') { $('prefs').classList.add('hidden'); openStats(); }
    else if (act === 'prefs-toggle') { $('stats').classList.add('hidden'); const p = $('prefs'); p.classList.toggle('hidden'); if (!p.classList.contains('hidden')) renderPrefs(); }
    else if (act === 'pf-play') { unlockAudio(); const was = prefs.sound; prefs.sound = true; el.dataset.kind === 'chat' ? soundNewChat() : soundNewMsg(); prefs.sound = was; }
    else if (act === 'pf-theme') { prefs.theme = el.dataset.theme; savePrefs(); applyPrefs(); }
    else if (act === 'attach') $('file-in').click();
    else if (act === 'emoji-toggle') { const p = $('emoji'); if (!p.innerHTML) renderEmoji(); p.classList.toggle('hidden'); }
    else if (act === 'emoji') insertEmoji(el.dataset.e);
    else if (act === 'rm-file') { const x = S.files.splice(Number(el.dataset.i), 1)[0]; if (x && x.url) URL.revokeObjectURL(x.url); renderFiles(); }
    else if (act === 'side') { S.side = el.dataset.side; renderSide(); }
    else if (act === 'tpl') useTpl(Number(el.dataset.i));
    else if (act === 'dept') { e.preventDefault(); S.create = null; openDept(Number(el.dataset.id)); }
    else if (act === 'create-open') openCreate();
    else if (act === 'create-back') { S.create = null; renderMain(); }
    else if (act === 'create-dept') { S.create.gid = Number(el.dataset.id); renderCreate(); }
    else if (act === 'create-tpl') {
      const d = (S.meta.depts || []).find(x => x.id === S.create.gid);
      const x = d && d.templates[Number(el.dataset.i)];
      if (x) { S.create.text = x.text; $('cr-text').value = x.text; $('cr-text').focus(); }
    }
    else if (act === 'create-send') createSend();
    else if (act === 'dept-back') { S.dept = null; renderMain(); renderSide(); }
    else if (act === 'dept-mode') { S.deptMode = el.dataset.mode; renderDept(); }
    else if (act === 'dept-tpl') { const x = (S.dept.internal_templates || [])[Number(el.dataset.i)]; if (x) { S.deptDraft = x.text; $('dta').value = x.text; $('dta').focus(); } }
    else if (act === 'dept-send') deptSend();
    else if (act === 'reason-toggle') { S.reasonOpen = !S.reasonOpen; S.reasonQ = ''; S.reasonAct = -1; renderDossier(); }
    else if (act === 'reason') pickReason(Number(el.dataset.i));
    else if (act === 'close') closeChat();
    else if (act === 'img') window.open(el.dataset.url, '_blank', 'noopener');
    else if (act === 'copy-booking') {
      if (!S.t.booking) return;
      navigator.clipboard.writeText(S.t.booking).then(() => {
        $('bk').textContent = 'Скопійовано';
        setTimeout(() => { const b = $('bk'); if (b) b.textContent = S.t.booking; }, 1200);
      }).catch(() => toast('Не вдалося скопіювати'));
    }
  });

  $('search-form').addEventListener('submit', (e) => { e.preventDefault(); doSearch($('search-in').value); });
  $('search-in').addEventListener('input', (e) => { if (!e.target.value.trim() && S.search) { S.search = null; renderList(); } });

  // ─── Старт ──────────────────────────────────────────────────
  applyPrefs();
  api('/api/me').then(startDesk).catch(() => showLogin());
})();
