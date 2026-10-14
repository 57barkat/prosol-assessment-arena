const GROUPS = ['Group 1', 'Group 2', 'Group 3', 'Group 4', 'Group 5'];
const DEFAULT_QUIZ_SIZE = 5;
const DEFAULT_QUIZ_SECONDS = 3 * 60;
const REQUIRED_RATIO = 0.70;
let state = loadState();
let current = Number(localStorage.getItem('ps_current_question') || 0);
let activeId = localStorage.getItem('ps_active_participant') || null;
let timerTick = null;
let refreshTick = null;
let participantSaveQueue = Promise.resolve();

function defaultState() {
  return { participants: {}, resultsReleased: false, settings: { quizSize: DEFAULT_QUIZ_SIZE, quizSeconds: DEFAULT_QUIZ_SECONDS }, theme: localStorage.getItem('ps_theme') || 'light' };
}
function loadState() { return defaultState(); }
function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
function getSettings() {
  if (!state.settings) state.settings = { quizSize: DEFAULT_QUIZ_SIZE, quizSeconds: DEFAULT_QUIZ_SECONDS };
  state.settings.quizSize = clampInt(state.settings.quizSize, 1, 100, DEFAULT_QUIZ_SIZE);
  state.settings.quizSeconds = clampInt(state.settings.quizSeconds, 60, 3600, DEFAULT_QUIZ_SECONDS);
  return state.settings;
}
function setTheme(t) { state.theme = t; localStorage.setItem('ps_theme', t); applyTheme(); }
async function api(path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}
async function saveParticipant(p, submitted = false) {
  const body = JSON.stringify({
    answers: { ...p.answers },
    remainingSeconds: Number(p.remainingSeconds ?? 0),
    submitted
  });
  const pendingSave = participantSaveQueue.then(() => api(`/api/participants/${encodeURIComponent(p.id)}`, {
    method: 'PATCH',
    body
  }));
  participantSaveQueue = pendingSave.catch(() => {});
  return pendingSave;
}
function showApiError(prefix, error) {
  console.error(prefix, error);
  toast(`${prefix}: ${error.message}`);
}
function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme || 'light');
  const b = document.getElementById('themeBtn');
  if (b) b.textContent = state.theme === 'dark' ? 'Light mode' : 'Dark mode';
}
function shuffle(a) {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function sampleQuestions(n = getSettings().quizSize) { return shuffle(window.QUESTION_BANK).slice(0, Math.min(n, window.QUESTION_BANK.length)); }
function pct(a, b) { return b ? Math.round((a / b) * 100) : 0; }
function safe(value) { return String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch])); }
function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2400);
}
function participantArray() { return Object.values(state.participants || {}); }
function answeredCount(p) { return Object.keys(p.answers || {}).length; }
function requiredCount(p) { return Math.ceil((p.questions || []).length * REQUIRED_RATIO); }
function requiredPercent() { return Math.round(REQUIRED_RATIO * 100); }
function formatTime(seconds) {
  const s = Math.max(0, Number(seconds || 0));
  const m = String(Math.floor(s / 60)).padStart(2, '0');
  const r = String(s % 60).padStart(2, '0');
  return `${m}:${r}`;
}
function calculateParticipant(p) {
  let score = 0;
  (p.questions || []).forEach((q, i) => {
    if (p.answers && Number(p.answers[i]) === q.answerIndex) score++;
  });
  return { score, total: (p.questions || []).length, percentage: pct(score, (p.questions || []).length) };
}
function groupStats() {
  if (state.publicGroupStats) return state.publicGroupStats;
  return GROUPS.map(g => {
    const ps = participantArray().filter(p => p.group === g && p.submitted);
    const avg = ps.length ? Math.round(ps.reduce((s, p) => s + calculateParticipant(p).percentage, 0) / ps.length) : 0;
    return { group: g, count: ps.length, avg, participants: ps };
  }).sort((a, b) => b.avg - a.avg);
}
function renderBars(targetId) {
  const el = document.getElementById(targetId);
  if (!el) return;
  const stats = groupStats();
  el.innerHTML = stats.map((g, i) => `
    <div class="resultCard ${i === 0 && g.count ? 'rank1' : ''}">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center"><h3 style="margin:0">${i + 1}. ${safe(g.group)}</h3><strong>${g.avg}%</strong></div>
      <div class="scoreBar" style="margin:12px 0"><span style="width:${g.avg}%"></span></div>
      <p class="small">Submitted participants: ${g.count}</p>
    </div>`).join('') || '<p class="small">No submissions yet.</p>';
}
function renderParticipants(targetId) {
  const el = document.getElementById(targetId);
  if (!el) return;
  const ps = participantArray().sort((a, b) => (b.submitted ? 1 : 0) - (a.submitted ? 1 : 0) || a.group.localeCompare(b.group));
  el.innerHTML = ps.length ? `<table class="table"><thead><tr><th>Name</th><th>Group</th><th>Status</th><th>Score</th></tr></thead><tbody>${ps.map(p => {
    const r = calculateParticipant(p);
    return `<tr><td>${safe(p.name)}</td><td>${safe(p.group)}</td><td><span class="status ${p.submitted ? 'ok' : 'wait'}">${p.submitted ? 'Submitted' : 'In progress'}</span></td><td>${p.submitted ? `${r.score}/${r.total} (${r.percentage}%)` : '-'}</td></tr>`;
  }).join('')}</tbody></table>` : '<p class="small">No participants registered yet.</p>';
}
function renderStatus(targetId) {
  const el = document.getElementById(targetId);
  if (!el) return;
  const ps = participantArray();
  el.innerHTML = `<div class="stack" style="gap:12px">${GROUPS.map(g => {
    const members = ps.filter(p => p.group === g);
    const done = members.filter(p => p.submitted).length;
    return `<div class="resultCard"><div style="display:flex;justify-content:space-between"><strong>${g}</strong><span>${done}/${members.length} submitted</span></div><div class="progress" style="margin-top:10px"><span style="width:${pct(done, members.length)}%"></span></div></div>`;
  }).join('')}</div>`;
}
function exportResults() {
  const data = {
    exportedAt: new Date().toISOString(),
    groupAverages: groupStats(),
    participants: participantArray().map(p => ({ ...p, calculated: calculateParticipant(p) }))
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'prosol-assessment-results.json';
  a.click();
  URL.revokeObjectURL(a.href);
}
function initCommon() {
  applyTheme();
  const b = document.getElementById('themeBtn');
  if (b) b.onclick = () => setTheme(state.theme === 'dark' ? 'light' : 'dark');
}
async function initParticipant() {
  if (activeId) {
    try {
      const data = await api(`/api/participants/${encodeURIComponent(activeId)}`);
      if (!data.participant.submitted) {
        state.participants[activeId] = data.participant;
        showQuiz();
        return;
      }
      localStorage.removeItem('ps_active_participant');
      activeId = null;
    } catch (error) {
      if (error.status === 404) {
        localStorage.removeItem('ps_active_participant');
        activeId = null;
      } else {
        showApiError('Could not restore your quiz', error);
        return;
      }
    }
  }
  const btn = document.getElementById('startQuizBtn');
  if (btn) btn.onclick = async () => {
    const name = document.getElementById('participantName').value.trim();
    const group = document.getElementById('participantGroup').value;
    if (!name) return toast('Please enter participant name');
    btn.disabled = true;
    try {
      const { settings } = await api('/api/config');
      const data = await api('/api/participants', {
        method: 'POST',
        body: JSON.stringify({ name, group, questions: sampleQuestions(settings.quizSize) })
      });
      const participant = data.participant;
      state.participants[participant.id] = participant;
      activeId = participant.id;
      current = 0;
      localStorage.setItem('ps_active_participant', activeId);
      localStorage.setItem('ps_current_question', '0');
      showQuiz();
    } catch (error) {
      showApiError('Could not start quiz', error);
    } finally {
      btn.disabled = false;
    }
  };
}
function showQuiz() {
  document.getElementById('participantLogin')?.classList.add('hidden');
  document.getElementById('quizArea')?.classList.remove('hidden');
  startParticipantTimer();
  renderQuestion();
}
function startParticipantTimer() {
  if (timerTick) clearInterval(timerTick);
  let timeoutSubmitInProgress = false;
  timerTick = setInterval(async () => {
    const p = state.participants[activeId];
    if (!p || p.submitted || timeoutSubmitInProgress) return;
    p.remainingSeconds = Math.max(0, Number(p.remainingSeconds ?? getSettings().quizSeconds) - 1);
    if (p.remainingSeconds === 0) {
      timeoutSubmitInProgress = true;
      try {
        await saveParticipant(p, true);
        p.submitted = true;
        p.submittedAt = new Date().toISOString();
        finishParticipant(p, true);
      } catch (error) {
        timeoutSubmitInProgress = false;
        showApiError('Could not submit your timed-out quiz', error);
      }
      return;
    }
    updateTimerOnly();
    if (p.remainingSeconds % 5 === 0) {
      saveParticipant(p).catch(error => showApiError('Could not save your quiz progress', error));
    }
  }, 1000);
}
function updateTimerOnly() {
  const p = state.participants[activeId];
  const time = document.getElementById('timeLeftText');
  if (time && p) time.textContent = formatTime(p.remainingSeconds ?? getSettings().quizSeconds);
}
function finishParticipant(p, timedOut = false) {
  if (timerTick) clearInterval(timerTick);
  localStorage.removeItem('ps_active_participant');
  const r = calculateParticipant(p);
  const area = document.getElementById('quizArea');
  if (area) {
    area.innerHTML = `<section class="panel hero"><span class="badge">${timedOut ? 'Time completed' : 'Submitted'}</span><h2 class="title">Thank you, ${safe(p.name)}</h2><p class="subtitle">Your quiz has been submitted for ${safe(p.group)}. Your score is ${r.score}/${r.total} (${r.percentage}%).</p><a href="participant.html" class="btn" style="display:inline-block;margin-top:18px">Start another participant</a></section>`;
  }
}
function renderQuestion() {
  const p = state.participants[activeId];
  if (!p) return;
  if (p.submitted) return finishParticipant(p);
  const q = p.questions[current];
  const time = document.getElementById('timeLeftText');
  if (time) time.textContent = formatTime(p.remainingSeconds ?? getSettings().quizSeconds);
  const meta = document.getElementById('quizMetaText');
  if (meta) meta.textContent = `${p.name} • ${p.group}`;
  document.getElementById('categoryText').textContent = q.category;
  document.getElementById('questionBadge').textContent = `Question ${current + 1} of ${p.questions.length}`;
  document.getElementById('questionId').textContent = '';
  document.getElementById('questionText').textContent = q.question;
  const selected = p.answers[current];
  document.getElementById('optionsGrid').innerHTML = q.options.map((o, i) => `<button class="option ${Number(selected) === i ? 'selected' : ''}" data-i="${i}"><span class="optionKey">${'ABCD'[i]}</span><span>${safe(o)}</span></button>`).join('');
  document.querySelectorAll('.option').forEach(btn => btn.onclick = () => {
    p.answers[current] = Number(btn.dataset.i);
    saveParticipant(p).catch(error => showApiError('Could not save your answer', error));
    renderQuestion();
  });
  document.getElementById('prevBtn').onclick = () => { current = Math.max(0, current - 1); localStorage.setItem('ps_current_question', String(current)); renderQuestion(); };
  document.getElementById('nextBtn').onclick = () => { current = Math.min(p.questions.length - 1, current + 1); localStorage.setItem('ps_current_question', String(current)); renderQuestion(); };
  document.getElementById('reviewBtn').onclick = () => document.getElementById('reviewPanel')?.classList.add('open');
  document.getElementById('closeReviewBtn').onclick = () => document.getElementById('reviewPanel')?.classList.remove('open');
  const submit = document.getElementById('submitBtn');
  const required = requiredCount(p);
  submit.disabled = answeredCount(p) < required;
  submit.textContent = submit.disabled ? 'Submit locked' : 'Submit quiz';
  const attempted = answeredCount(p);
  document.getElementById('attemptNote').textContent = submit.disabled ? `Submit unlocks after answering at least ${requiredPercent()}% of questions (${attempted}/${required} required).` : `Submit is unlocked. You have answered ${attempted}/${p.questions.length} questions and may continue reviewing.`;
  submit.onclick = async () => {
    if (answeredCount(p) < required) return toast(`Please answer at least ${requiredPercent()}% of questions before submitting`);
    submit.disabled = true;
    try {
      await saveParticipant(p, true);
      p.submitted = true;
      p.submittedAt = new Date().toISOString();
      finishParticipant(p);
    } catch (error) {
      showApiError('Could not submit your quiz', error);
      renderQuestion();
    }
  };
  document.getElementById('reviewGrid').innerHTML = p.questions.map((_, i) => `<button class="reviewBtn ${p.answers[i] !== undefined ? 'answered' : ''} ${i === current ? 'current' : ''}" data-i="${i}">${i + 1}</button>`).join('');
  document.querySelectorAll('.reviewBtn').forEach(btn => btn.onclick = () => { current = Number(btn.dataset.i); localStorage.setItem('ps_current_question', String(current)); document.getElementById('reviewPanel')?.classList.remove('open'); renderQuestion(); });
}
function initAdmin() {
  const login = document.getElementById('adminLoginBtn');
  if (login) login.onclick = async () => {
    login.disabled = true;
    try {
      await api('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ password: document.getElementById('adminPass').value })
      });
      const data = await api('/api/admin/state');
      sessionStorage.setItem('ps_admin_ok', '1');
      showAdmin(data);
    } catch (error) {
      showApiError(error.status === 401 ? 'Wrong password' : 'Admin login failed', error);
    } finally {
      login.disabled = false;
    }
  };
  if (sessionStorage.getItem('ps_admin_ok') === '1') {
    api('/api/admin/state').then(showAdmin).catch(error => {
      sessionStorage.removeItem('ps_admin_ok');
      if (error.status !== 401) showApiError('Could not load admin data', error);
    });
  }
}
function showAdmin(data) {
  state = { ...data, theme: localStorage.getItem('ps_theme') || 'light' };
  document.getElementById('adminLogin')?.classList.add('hidden');
  document.getElementById('adminArea')?.classList.remove('hidden');
  bindAdminActions();
  renderAdmin();
  if (refreshTick) clearInterval(refreshTick);
  refreshTick = setInterval(() => refreshAdminState().catch(error => {
    if (error.status === 401) {
      clearInterval(refreshTick);
      refreshTick = null;
      sessionStorage.removeItem('ps_admin_ok');
      document.getElementById('adminArea')?.classList.add('hidden');
      document.getElementById('adminLogin')?.classList.remove('hidden');
    } else {
      showApiError('Could not refresh admin data', error);
    }
  }), 3000);
}
async function refreshAdminState() {
  const data = await api('/api/admin/state');
  state = { ...data, theme: localStorage.getItem('ps_theme') || 'light' };
  renderAdmin();
}
function bindAdminActions() {
  const release = document.getElementById('releaseBtn');
  if (release) release.onclick = () => updateResultsRelease(true);
  const hide = document.getElementById('hideBtn');
  if (hide) hide.onclick = () => updateResultsRelease(false);
  const reset = document.getElementById('resetBtn');
  if (reset) reset.onclick = async () => {
    if (!confirm('Reset all participants and scores?')) return;
    try {
      await api('/api/admin/state', { method: 'DELETE' });
      await refreshAdminState();
    } catch (error) {
      showApiError('Could not reset quiz data', error);
    }
  };
  const saveSettings = document.getElementById('saveSettingsBtn');
  if (saveSettings) saveSettings.onclick = async () => {
    const q = clampInt(document.getElementById('settingQuestionCount')?.value, 1, 100, DEFAULT_QUIZ_SIZE);
    const m = clampInt(document.getElementById('settingDuration')?.value, 1, 60, 3);
    try {
      await api('/api/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify({ quizSize: q, quizSeconds: m * 60 })
      });
      await refreshAdminState();
      toast('Quiz settings saved for new participants');
    } catch (error) {
      showApiError('Could not save quiz settings', error);
    }
  };
  const exp = document.getElementById('exportBtn');
  if (exp) exp.onclick = exportResults;
}
async function updateResultsRelease(released) {
  try {
    await api('/api/admin/results', {
      method: 'PATCH',
      body: JSON.stringify({ released })
    });
    await refreshAdminState();
    toast(released ? 'Results released to main console' : 'Results hidden');
  } catch (error) {
    showApiError('Could not update score visibility', error);
  }
}
function renderAdmin() {
  const ps = participantArray();
  const mp = document.getElementById('mParticipants'); if (mp) mp.textContent = ps.length;
  const ms = document.getElementById('mSubmitted'); if (ms) ms.textContent = ps.filter(p => p.submitted).length;
  const settings = getSettings();
  const mq = document.getElementById('mQuizSize'); if (mq) mq.textContent = settings.quizSize;
  const md = document.getElementById('mDuration'); if (md) md.textContent = Math.round(settings.quizSeconds / 60) + 'm';
  const qInput = document.getElementById('settingQuestionCount'); if (qInput) qInput.value = settings.quizSize;
  const dInput = document.getElementById('settingDuration'); if (dInput) dInput.value = Math.round(settings.quizSeconds / 60);
  renderBars('groupResults');
  renderParticipants('participantResults');
  const ar = document.getElementById('answerReview');
  if (ar) {
    const subs = ps.filter(p => p.submitted);
    ar.innerHTML = subs.length ? subs.map(p => {
      const r = calculateParticipant(p);
      return `<details class="resultCard"><summary><strong>${safe(p.name)}</strong> - ${safe(p.group)} - ${r.score}/${r.total} (${r.percentage}%)</summary><div style="margin-top:14px" class="stack">${p.questions.map((q, i) => {
        const ans = p.answers[i];
        const ok = Number(ans) === q.answerIndex;
        return `<div class="panel compact"><span class="badge">${ok ? 'Correct' : 'Review'}</span><p><strong>Question ${i + 1}.</strong> ${safe(q.question)}</p><p class="small">Participant answer: ${ans !== undefined ? `${'ABCD'[ans]}. ${safe(q.options[ans])}` : 'Not answered'}</p><p class="small">Correct answer: ${safe(q.answer)}. ${safe(q.options[q.answerIndex])}</p><p class="small">Explanation: ${safe(q.explanation)}</p></div>`;
      }).join('')}</div></details>`;
    }).join('') : '<p class="small">No submitted quizzes yet.</p>';
  }
}
async function refreshConsoleState() {
  const data = await api('/api/summary');
  state = {
    ...defaultState(),
    participants: data.participants,
    resultsReleased: data.resultsReleased,
    publicGroupStats: data.groupAverages
  };
  initConsoleView();
}
function initConsoleView() {
  renderStatus('consoleStatus');
  if (state.resultsReleased) {
    document.getElementById('lockedPanel')?.classList.add('hidden');
    document.getElementById('resultsPanel')?.classList.remove('hidden');
    renderBars('consoleGroups');

  } else {
    document.getElementById('lockedPanel')?.classList.remove('hidden');
    document.getElementById('resultsPanel')?.classList.add('hidden');
  }
}
function initConsole() {
  refreshConsoleState().catch(error => showApiError('Could not load shared quiz status', error));
  if (refreshTick) clearInterval(refreshTick);
  refreshTick = setInterval(() => refreshConsoleState().catch(error => showApiError('Could not refresh shared quiz status', error)), 3000);
}
function renderCurrentPage() {
  const p = document.body.dataset.page;
  if (p === 'admin' && document.getElementById('adminArea') && !document.getElementById('adminArea').classList.contains('hidden')) renderAdmin();
  if (p === 'console') initConsole();
  if (p === 'participant' && activeId && state.participants[activeId] && !state.participants[activeId].submitted) renderQuestion();
  applyTheme();
}
function route() {
  const p = document.body.dataset.page;
  if (p === 'participant') initParticipant();
  if (p === 'admin') initAdmin();
  if (p === 'console') initConsole();
}
initCommon();
route();
