// Card news agent web screen. No build step: plain ES module.
// The server is the source of truth; this page polls the project snapshot and
// keeps only unsent drafts (checked candidates, a half-written answer) locally.

const $app = document.getElementById('app');
const POLL_MS = 1500;

const STAGE_LABEL = {
  created: '조사 전',
  researching: '후보 조사 중',
  selecting: '후보 선택',
  deep_research: '심층 조사 중',
  editorial_ready: '편집 방향 확인',
  storyboard_drafting: '스토리보드 만드는 중',
  storyboard_review: '스토리보드 승인 대기',
  producing: '이미지 제작 중',
  reviewing: '검수',
};
const RUN_KIND = { research: '후보 조사', deep_research: '심층 조사', storyboard: '스토리보드', images: '이미지 생성', revision: '카드 수정', export: '최종 승인·내보내기' };
const ERROR_LABEL = {
  search_failed: '검색 실패',
  auth_required: '로그인 필요',
  engine_failed: '엔진 오류',
  image_failed: '이미지 실패',
  cancelled: '취소됨',
  interrupted: '중단됨',
};
const RUN_STATUS = {
  running: '진행 중',
  waiting_for_user: '답변 대기 중',
  succeeded: '완료',
  failed: '실패',
  cancelled: '취소됨',
  interrupted: '중단됨',
};

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : '#');
// A mock date is generated relative to today, so it is labelled to keep it from reading as real news.
const dateOr = (d, mock = false) =>
  (d ? `${esc(d)}${mock ? ' <span class="tag mock">모의 날짜</span>' : ''}` : '<span class="unknown">미확인</span>');
const fmtTime = (iso) => new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });

// index.html loads this file with ?v=<hash of the screen files>; the server sends
// its own hash on every API response. A mismatch means this tab has old code.
const APP_VERSION = new URL(import.meta.url).searchParams.get('v');

function checkVersion(res) {
  if (res.headers.get('x-server-outdated') && !document.getElementById('outdated-banner')) {
    const el = document.createElement('div');
    el.id = 'outdated-banner';
    el.className = 'stale-banner';
    el.innerHTML = '<b>서버를 다시 켜야 합니다.</b> 프로그램 파일이 바뀌었지만 지금 서버는 예전 코드로 동작 중이라, 새 기능(예: 삭제)이 동작하지 않을 수 있습니다. 서버 창에서 <b>Ctrl+C</b>로 끄고 <b>npm start</b>로 다시 켠 뒤 이 화면을 새로고침하세요.';
    document.body.prepend(el);
  }
  const server = res.headers.get('x-app-version');
  if (!APP_VERSION || !server || server === APP_VERSION || document.getElementById('stale-banner')) return;
  const el = document.createElement('div');
  el.id = 'stale-banner';
  el.className = 'stale-banner';
  el.innerHTML = '화면이 새 버전으로 바뀌었습니다. 버튼이 제대로 동작하도록 새로고침하세요. <button>새로고침</button>';
  el.querySelector('button').addEventListener('click', () => location.reload());
  document.body.prepend(el);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  checkVersion(res);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // App errors are { error: { code, message, nextAction } }; anything else (such as
    // a route the running server does not have) gets a plain explanation.
    const e = typeof data.error === 'object' && data.error?.message ? data.error
      : res.status === 404 && /^Route /.test(data.message ?? '')
        ? { message: '서버가 이 기능을 모릅니다(404).', nextAction: '서버를 예전 코드로 켜 둔 것일 수 있습니다. 서버 창에서 Ctrl+C로 끄고 npm start로 다시 켠 뒤 새로고침하세요.' }
        : { message: `요청 실패 (${res.status})`, nextAction: '잠시 후 다시 시도하세요. 계속되면 서버를 다시 켜 보세요.' };
    throw Object.assign(new Error(e.message), e);
  }
  return data;
}

// In-page dialogs instead of confirm()/alert(): some embedded browsers (such as
// the Claude app's browser pane) close native dialogs at once, which made
// "approve" silently do nothing (B23).
function dialogBox(message, { ok = '확인', cancel = null } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'box';
    dlg.innerHTML = `<p>${esc(message).replace(/\n/g, '<br>')}</p>
      <div class="row">${cancel ? `<button class="secondary" value="no">${esc(cancel)}</button>` : ''}<button value="yes">${esc(ok)}</button></div>`;
    // Answer from the click itself: the 'close' event did not arrive while the
    // window was not drawing. 'close' still covers the Esc key.
    const done = (answer) => { dlg.remove(); resolve(answer); };
    for (const b of dlg.querySelectorAll('button')) b.addEventListener('click', () => done(b.value === 'yes'));
    dlg.addEventListener('close', () => done(false));
    document.body.append(dlg);
    dlg.showModal();
  });
}
const ask = (message, ok = '확인') => dialogBox(message, { ok, cancel: '취소' });

/** In-page text prompt; resolves to the entered text, or null when cancelled. */
function promptBox(message, value = '', { maxLength = 100, placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'box';
    dlg.innerHTML = `<form method="dialog"><p>${esc(message)}</p>
      <input type="text" maxlength="${maxLength}" placeholder="${esc(placeholder)}" value="${esc(value)}">
      <div class="row"><button type="button" class="secondary" value="no">취소</button><button value="yes">저장</button></div></form>`;
    const input = dlg.querySelector('input');
    const done = (v) => { dlg.remove(); resolve(v); };
    dlg.querySelector('[value=no]').addEventListener('click', () => done(null));
    dlg.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); done(input.value.trim()); });
    dlg.addEventListener('close', () => done(null));
    document.body.append(dlg);
    dlg.showModal();
    input.select();
  });
}

const projectTitle = (p) => p.name || p.topic;
const notify = (message) => dialogBox(message);

function toast(err) {
  notify(`${err.message}\n${err.nextAction ?? ''}`.trim());
}

// ---------- routing ----------

let stopPolling = () => {};

async function route() {
  stopPolling();
  const r = location.hash.match(/^#\/render\/([\w-]+)\/(\d+)$/);
  if (r) return showRender(r[1], Number(r[2]));
  const m = location.hash.match(/^#\/p\/([\w-]+)/);
  if (m) await showProject(m[1]);
  else await showHome();
}
window.addEventListener('hashchange', route);

(async () => {
  try {
    const h = await api('GET', '/api/health');
    const badge = document.getElementById('engine-badge');
    badge.textContent = `엔진: ${h.engine}`;
    badge.classList.toggle('mock', h.mock);
    document.getElementById('mock-banner').hidden = !h.mock;
  } catch { /* the page itself will show the error */ }
  route();
})();

// ---------- home ----------

async function showHome() {
  $app.innerHTML = `
    <h1>주제를 입력하세요</h1>
    <p class="muted">입력한 주제로 최근 자료를 조사해 후보를 보여 줍니다. 예: AI 최신소식</p>
    <form class="new card">
      <input type="text" name="topic" placeholder="AI 최신소식" maxlength="200" required>
      <select name="period" aria-label="조사 기간">
        <option value="7">최근 7일</option>
        <option value="30">최근 30일</option>
      </select>
      <button>조사 시작</button>
    </form>
    <section class="card">
      <div class="plist-head"><h2 id="plist-title">이전 프로젝트</h2><button type="button" class="link" id="plist-toggle" hidden></button></div>
      <p class="muted" id="plist-help"></p>
      <ul class="projects" id="plist"><li class="muted">불러오는 중…</li></ul>
    </section>`;

  const form = $app.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const topic = form.topic.value.trim();
      const periodDays = Number(form.period.value);
      const { projectId } = await api('POST', '/api/projects', { topic, periodDays, requestId: crypto.randomUUID() });
      await api('POST', `/api/projects/${projectId}/research`, { requestId: crypto.randomUUID() });
      location.hash = `#/p/${projectId}`;
    } catch (err) {
      toast(err);
      btn.disabled = false;
    }
  });

  await loadProjectList(false);
}

// The home list: newest work first; projects can be renamed, archived (hidden,
// kept) or deleted (gone, with their files).
async function loadProjectList(archived) {
  const list = $app.querySelector('#plist');
  if (!list) return;
  let data;
  try {
    data = await api('GET', `/api/projects${archived ? '?archived=1' : ''}`);
  } catch (err) {
    list.innerHTML = `<li class="error">${esc(err.message)}</li>`;
    return;
  }
  const { projects, archivedCount } = data;
  $app.querySelector('#plist-title').textContent = archived ? `보관함 (${projects.length})` : '이전 프로젝트';
  $app.querySelector('#plist-help').textContent = archived
    ? '보관한 프로젝트는 첫 목록에서 숨겨질 뿐 내용은 그대로 남아 있습니다. "꺼내기"를 누르면 다시 목록에 나옵니다.'
    : '최근에 작업한 순서입니다. 다 쓴 프로젝트는 "보관"으로 숨기고, 필요 없는 것은 "삭제"하세요.';
  const toggle = $app.querySelector('#plist-toggle');
  toggle.hidden = !archived && archivedCount === 0;
  toggle.textContent = archived ? '← 이전 프로젝트로' : `보관함 보기 (${archivedCount})`;
  toggle.onclick = () => loadProjectList(!archived);

  list.innerHTML = projects.length
    ? projects.map((p) => `<li class="proj" data-id="${esc(p.id)}">
        <div class="proj-main">
          <a href="#/p/${esc(p.id)}" class="proj-title">${esc(projectTitle(p))}</a>
          ${p.name ? `<span class="muted"> · 주제: ${esc(p.topic)}</span>` : ''}
          <div class="proj-meta">
            <span class="tag">${esc(STAGE_LABEL[p.stage] ?? p.stage)}</span>
            ${p.mock ? '<span class="tag mock">모의</span>' : ''}
            ${p.busy ? '<span class="tag">작업 중</span>' : ''}
            ${p.cards ? `<span class="tag">카드 ${p.cards}장${p.images ? ` · 이미지 ${p.images}장` : ''}</span>` : ''}
            <span class="muted">마지막 작업 ${fmtTime(p.updatedAt)} · 만든 날 ${fmtTime(p.createdAt)}</span>
          </div>
        </div>
        <div class="proj-actions">
          <button type="button" class="link" data-pact="rename">이름 바꾸기</button>
          <button type="button" class="link" data-pact="archive">${archived ? '꺼내기' : '보관'}</button>
          <button type="button" class="link danger" data-pact="delete">삭제</button>
        </div>
      </li>`).join('')
    : `<li class="muted">${archived ? '보관한 프로젝트가 없습니다.' : '아직 없습니다.'}</li>`;

  for (const li of list.querySelectorAll('.proj')) {
    const p = projects.find((x) => x.id === li.dataset.id);
    const run = async (btn, fn) => {
      btn.disabled = true;
      try { await fn(); await loadProjectList(archived); } catch (err) { toast(err); btn.disabled = false; }
    };
    li.querySelector('[data-pact=rename]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const name = await promptBox('프로젝트 이름 (비우면 주제가 이름으로 보입니다)', p.name ?? '', { placeholder: p.topic });
      if (name === null) return;
      run(btn, () => api('POST', `/api/projects/${p.id}/name`, { name }));
    });
    li.querySelector('[data-pact=archive]').addEventListener('click', (e) =>
      run(e.currentTarget, () => api('POST', `/api/projects/${p.id}/archive`, { archived: !archived })));
    li.querySelector('[data-pact=delete]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const ok = await ask(`"${projectTitle(p)}" 프로젝트를 삭제할까요?\n조사 기록, 스토리보드, 생성한 이미지 파일이 모두 지워지고 되돌릴 수 없습니다. 나중에 볼 수도 있다면 "보관"을 쓰세요.`, '삭제');
      if (!ok) return;
      run(btn, () => api('DELETE', `/api/projects/${p.id}`));
    });
  }
}

// ---------- project ----------

const draft = {
  preTool: 'agy',       // drawing tool picked before approving the storyboard (B50)
  checked: null,        // Set of candidate IDs not yet saved, or null = follow server
  checkedFor: null,     // selection.savedAt the draft was based on
  candsOpen: false,     // candidate list unfolded after a result exists
  layouts: new Map(),   // card index → unsaved text layout
  revText: new Map(),   // card index → unsent change request
  phoneOpen: false,     // phone preview shown
};

// Answer drafts survive a refresh, so a resubmitted answer reuses its requestId.
function answerDraft(questionId) {
  const key = `answer:${questionId}`;
  let d;
  try { d = JSON.parse(sessionStorage.getItem(key) ?? 'null'); } catch { d = null; }
  d ??= { choice: null, text: '', requestId: crypto.randomUUID() };
  return { d, save: () => { try { sessionStorage.setItem(key, JSON.stringify(d)); } catch { /* private mode */ } } };
}

async function showProject(id) {
  $app.innerHTML = `<div id="head"></div><div id="run-slot"></div><div id="q-slot"></div><div id="body-slot"></div>`;
  const keys = {};
  let snap = null;
  let alive = true;
  let timer = null;
  stopPolling = () => { alive = false; clearTimeout(timer); };
  draft.checked = null;
  draft.checkedFor = null;
  draft.candsOpen = false;
  draft.layouts = new Map();
  draft.revText = new Map();
  draft.phoneOpen = false;

  const slot = (name, key, html, bind) => {
    if (keys[name] === key) return;
    keys[name] = key;
    const el = document.getElementById(name);
    el.innerHTML = html;
    bind?.(el);
  };

  const refresh = async () => {
    try {
      snap = await api('GET', `/api/projects/${id}`);
    } catch (err) {
      if (err.code === 'not_found') { $app.innerHTML = `<div class="card error">${esc(err.message)} <a href="#/">처음으로</a></div>`; return; }
      slot('run-slot', 'neterr', `<div class="card run failed"><div class="error">서버에 연결할 수 없습니다. 서버가 켜져 있는지 확인하세요.</div></div>`);
      schedule();
      return;
    }
    render();
    schedule();
  };
  const schedule = () => { if (alive) timer = setTimeout(refresh, POLL_MS); };
  const kick = () => { clearTimeout(timer); refresh(); };

  function render() {
    const { project, research, runs, question } = snap;
    TRUST = snap.trust ?? {};
    // Photo designs fit themselves to each picture; redraw when a measurement lands.
    if (snap.design === 'news' || snap.design === 'cinema') {
      for (const c of snap.images?.cards ?? []) {
        const src = imageUrl(snap, c.index);
        if (src && !FIT.has(src)) fitPicture(src).then(() => alive && render());
      }
    }
    slot('head', JSON.stringify([project.stage, research?.searchedAt, research?.periodDays, project.topic, project.name, project.archivedAt]), renderHead(snap));

    const run = runs[0];
    slot('run-slot', JSON.stringify([run ?? null, jumps(snap).map((j) => j.id)]), renderRun(run, snap), (el) => bindRun(el, run, snap, kick));
    slot('q-slot', JSON.stringify(question ?? null), question ? renderQuestion(question) : '', (el) => question && bindQuestion(el, question, id, kick));
    slot('body-slot', JSON.stringify([project.version, project.stage, !!runs.find(isActive), FIT_VERSION]), renderBody(snap), (el) => bindBody(el, snap, kick));
  }

  await refresh();
}

// Source trust tags (B36): official / major news / trade / needs checking.
const TRUST_LABEL = { official: '공식', major: '주요 언론', trade: '전문 매체', unverified: '확인 필요' };
let TRUST = {};
const trustTag = (url) => {
  const t = TRUST[url];
  return t ? `<span class="tag tr-${t}" title="출처 신뢰 등급">${TRUST_LABEL[t]}</span>` : '';
};

/** Every on-topic article the research found in the period, newest first (B43). */
const articlesHtml = (research) => {
  const list = [...(research.articles ?? [])].sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  if (!list.length) return '';
  return `<details class="articles"><summary>조사 기간 안에 찾은 기사 ${list.length}건 모두 보기 (후보로 고르지 않은 기사 포함)</summary>
    <ul class="sources">${list.map((s) => `<li>${trustTag(s.url)}<span class="muted">${dateOr(s.publishedAt)} · ${esc(s.publisher)}</span> <a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a></li>`).join('')}</ul>
  </details>`;
};

/** Which of the newspapers the user asked for made it into the candidates. */
const outletsHtml = (research) => {
  const list = research.outlets;
  if (!list?.length) return '';
  const missing = list.filter((o) => !o.count);
  return `<details class="outlets"><summary>꼭 찾아볼 언론사 ${list.length}곳 중 ${list.length - missing.length}곳의 기사가 후보에 들어갔습니다</summary>
    <ul>${list.map((o) => `<li class="${o.count ? 'ok' : 'none'}">${esc(o.name)} — ${o.count ? `후보 ${o.count}개` : '조사 기간 안의 관련 기사 없음'}${o.via === 'gnews' ? ' <span class="muted">(사이트가 검색을 막아 구글 뉴스 목록으로 찾음)</span>' : ''}</li>`).join('')}</ul>
  </details>`;
};

const isActive = (r) => r.status === 'running' || r.status === 'waiting_for_user';

function renderHead({ project, research }) {
  const period = research
    ? `<span>조사 기준 시각 <b>${fmtTime(research.searchedAt)}</b></span>
       <span>조사 기간 <b>${esc(research.periodStart)} ~ ${esc(research.periodEnd)} (최근 ${research.periodDays}일)</b></span>`
    : `<span>조사 기간 <b>최근 ${project.periodDays}일</b> (조사 시작 시각 기준)</span>`;
  return `
    <p class="muted"><a href="#/">← 처음으로</a></p>
    <h1>${esc(projectTitle(project))}</h1>
    ${project.name ? `<p class="muted">주제: ${esc(project.topic)}</p>` : ''}
    ${project.archivedAt ? '<p class="notice">보관함에 있는 프로젝트입니다. 첫 화면 목록에는 보이지 않습니다.</p>' : ''}
    <div class="meta">
      <span>단계 <b>${esc(STAGE_LABEL[project.stage] ?? project.stage)}</b></span>
      ${period}
      ${research?.mock ? '<span class="tag mock">모의 데이터</span>' : ''}
    </div>`;
}

// ----- run status -----

/** "3분 12초" from seconds. */
const minSec = (s) => {
  const t = Math.max(0, Math.round(s));
  return t < 60 ? `${t}초` : `${Math.floor(t / 60)}분${t % 60 ? ` ${t % 60}초` : ''}`;
};
/**
 * Elapsed time of a run (ticking while it runs) and how long that kind usually takes.
 * The text is refreshed every second by tickRunTimes() without re-rendering the card.
 */
function runTime(run, snap) {
  const live = isActive(run);
  const typical = snap.typicalSeconds?.[run.kind];
  const usual = live && typical ? `<span class="muted"> · 보통 약 ${minSec(typical >= 60 ? Math.round(typical / 60) * 60 : typical)} 걸려요</span>` : '';
  return `<span class="run-time" data-start="${esc(run.startedAt)}" data-end="${esc(run.finishedAt ?? '')}" data-live="${live ? 1 : ''}">${runTimeText(run.startedAt, run.finishedAt, live)}</span>${usual}`;
}
const runTimeText = (start, end, live) => {
  const s = ((live || !end ? Date.now() : Date.parse(end)) - Date.parse(start)) / 1000;
  if (!Number.isFinite(s)) return '';
  return live ? ` · ${minSec(s)}째` : end ? ` · 걸린 시간 ${minSec(s)}` : '';
};
function tickRunTimes() {
  for (const el of document.querySelectorAll('.run-time[data-live="1"]')) el.textContent = runTimeText(el.dataset.start, '', true);
}
setInterval(tickRunTimes, 1000);

function renderRun(run, snap) {
  if (!run) {
    return `<div class="card run"><p>아직 조사를 시작하지 않았습니다.</p>
      <div class="row"><button data-act="research">조사 시작</button></div></div>`;
  }
  const steps = run.progress.slice(-6).map((p) => `<li>${esc(p.message)}</li>`).join('');
  const err = run.error && run.status !== 'succeeded'
    ? `<div class="error"><span class="tag err">${esc(ERROR_LABEL[run.error.code] ?? '오류')}</span> <b>${esc(run.error.message)}</b><br>${esc(run.error.nextAction)}</div>` : '';
  const actions = [];
  if (isActive(run)) actions.push('<button class="danger" data-act="cancel">작업 취소</button>');
  // Image failures are retried per card in the images section.
  if (['failed', 'cancelled', 'interrupted'].includes(run.status) && !snap.question && run.kind !== 'images') {
    actions.push(`<button data-act="retry">다시 시도</button>`);
  }
  if (run.kind === 'images' && !isActive(run) && run.status !== 'succeeded') {
    actions.push('<span class="muted">아래 이미지 목록에서 실패한 카드의 "다시 시도"를 누르세요.</span>');
  }
  if (run.status === 'interrupted' && snap.question) {
    actions.push('<span class="muted">아래 질문에 답하면 이어서 진행합니다.</span>');
  }
  // Results sit below a long candidate list, so the run card links straight to them.
  const links = jumps(snap).map((j) => `<button class="link ${j.kind === run.kind && run.status === 'succeeded' ? 'primary' : ''}" data-jump="${j.id}">${
    j.kind === run.kind && run.status === 'succeeded' ? `결과로 이동: ${j.label}` : j.label} ↓</button>`).join('');
  return `<div class="card run ${esc(run.status)}">
    <b>${esc(RUN_KIND[run.kind] ?? run.kind)}</b> · ${esc(RUN_STATUS[run.status] ?? run.status)}
    ${runTime(run, snap)}
    ${run.status === 'waiting_for_user' ? '<span class="muted"> — 실패가 아니라 아래 질문의 답을 기다리는 중입니다.</span>' : ''}
    ${steps ? `<ol>${steps}</ol>` : ''}
    ${err}
    ${actions.length ? `<div class="row">${actions.join('')}</div>` : ''}
    ${links ? `<nav class="jumps">${links}</nav>` : ''}
  </div>`;
}

/** Result sections that exist in this snapshot, in page order. */
function jumps(snap) {
  const out = [];
  if (snap.deep) {
    out.push({ id: 'sec-deep', kind: 'deep_research', label: '조사 기록' });
    out.push({ id: 'sec-editorial', kind: null, label: '편집 방향' });
    out.push({ id: 'sec-storyboard', kind: 'storyboard', label: '스토리보드' });
  }
  if (snap.images) out.push({ id: 'sec-images', kind: 'images', label: '카드 이미지' });
  if (snap.layouts) out.push({ id: 'sec-cards', kind: 'revision', label: '글자 배치·카드 수정' });
  if (snap.layouts) out.push({ id: 'sec-final', kind: 'export', label: '최종 승인·내보내기' });
  return out;
}

function bindRun(el, run, snap, kick) {
  for (const b of el.querySelectorAll('[data-jump]')) {
    b.addEventListener('click', () => document.getElementById(b.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }
  el.querySelector('[data-act=research]')?.addEventListener('click', (e) => act(e.currentTarget, kick, () =>
    api('POST', `/api/projects/${snap.project.id}/research`, { requestId: crypto.randomUUID() })));
  el.querySelector('[data-act=cancel]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!(await ask('진행 중인 작업을 취소할까요?', '작업 취소'))) return;
    act(btn, kick, () => api('POST', `/api/runs/${run.id}/cancel`));
  });
  el.querySelector('[data-act=retry]')?.addEventListener('click', (e) => act(e.currentTarget, kick, () => {
    const id = snap.project.id;
    const base = { requestId: crypto.randomUUID(), version: snap.project.version };
    if (run.kind === 'research') return api('POST', `/api/projects/${id}/research`, { requestId: base.requestId });
    if (run.kind === 'storyboard') return api('POST', `/api/projects/${id}/storyboard`, { ...base, instruction: run.input?.instruction ?? null });
    return api('POST', `/api/projects/${id}/deep-research`, base);
  }));
}

/** Disables the clicked button for the duration of a request. */
async function act(btn, kick, fn) {
  btn.disabled = true;
  try { await fn(); } catch (err) { toast(err); } finally { btn.disabled = false; kick(); }
}

// ----- question -----

function renderQuestion(q) {
  const { d } = answerDraft(q.id);
  const opts = q.options.map((o) => `
    <label class="option">
      <input type="radio" name="choice" value="${esc(o.label)}" ${d.choice === o.label ? 'checked' : ''}>
      <span><b>${esc(o.label)}</b>${o.label === q.recommended ? '<span class="rec">추천</span>' : ''}
      <br><span class="desc">${esc(o.description)}</span></span>
    </label>`).join('');
  return `<section class="card question">
    <h2>${esc(q.question)}</h2>
    ${q.recommendationReason ? `<p class="why"><b>추천: ${esc(q.recommended)}</b> — ${esc(q.recommendationReason)}<br>
      <span class="muted">추천은 참고용이며, 직접 선택해야 답변으로 저장됩니다.</span></p>` : ''}
    <form>
      ${opts}
      ${q.allowFreeText ? `<p class="label">직접 입력 (선택 대신 또는 함께)</p><textarea name="text" maxlength="500">${esc(d.text)}</textarea>` : ''}
      <div class="row"><button>답변 제출</button></div>
    </form>
  </section>`;
}

function bindQuestion(el, q, projectId, kick) {
  const { d, save } = answerDraft(q.id);
  const form = el.querySelector('form');
  form.addEventListener('input', () => {
    d.choice = form.querySelector('input[name=choice]:checked')?.value ?? null;
    d.text = form.text?.value ?? '';
    save();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!d.choice && !d.text.trim()) { notify('선택지를 고르거나 내용을 입력하세요.'); return; }
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await api('POST', `/api/projects/${projectId}/answers`, {
        questionId: q.id, questionVersion: q.version,
        answer: { choice: d.choice, text: d.text.trim() || null }, requestId: d.requestId,
      });
    } catch (err) {
      toast(err);
      btn.disabled = false;
    }
    kick();
  });
}

// ----- body: candidates and results -----

function renderBody(snap) {
  const { project, research, selection, deep, runs } = snap;
  const busy = runs.some(isActive);
  if (!research) return '';
  if (draft.checked === null || draft.checkedFor !== (selection?.savedAt ?? null)) {
    draft.checked = new Set(selection?.candidateIds ?? []);
    draft.checkedFor = selection?.savedAt ?? null;
  }
  const canSelect = !busy && (project.stage === 'selecting' || project.stage === 'editorial_ready');

  const items = research.candidates.map((c) => {
    const on = draft.checked.has(c.id);
    return `<li class="cand ${on ? 'checked' : ''}">
      <input type="checkbox" value="${esc(c.id)}" ${on ? 'checked' : ''} ${canSelect ? '' : 'disabled'} aria-label="${esc(c.title)} 선택">
      <div>
        <h3>${esc(c.title)}</h3>
        <div><span class="tag">${esc(c.category)}</span>${research.mock ? '<span class="tag mock">모의</span>' : ''}${c.sources.length > 1 ? `<span class="tag">기사 ${c.sources.length}건 묶음</span>` : ''}${!research.mock && !c.sources.some((s) => ['official', 'major'].includes(TRUST[s.url])) ? '<span class="tag tr-unverified" title="공식 발표나 주요 언론 보도를 찾지 못한 후보입니다. 출처를 열어 직접 확인하세요.">출처 확인 필요</span>' : ''}</div>
        <div class="cand-value"><span class="cv-label">선택할 가치</span><p>${esc(c.value)}</p></div>
        <p>${esc(c.summary)}</p>
        <p class="muted">게시일 ${dateOr(c.publishedAt, research.mock)} · 사건 발생일 ${dateOr(c.eventDate, research.mock)}</p>
        <div class="cand-risk"><span class="cr-label">불확실성</span><p>${esc(c.uncertainty)}</p></div>
        <ul class="sources">${c.sources.map((s) => `<li>${trustTag(s.url)}<a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a> · ${esc(s.publisher)} · ${dateOr(s.publishedAt, research.mock)}</li>`).join('')}</ul>
      </div>
    </li>`;
  }).join('');

  const saved = selection ? `저장된 선택 ${selection.candidateIds.length}개` : '아직 저장한 선택이 없습니다';
  const list = `
      <p class="muted">1~3개를 고른 뒤 아래 버튼을 누르세요. 선택하기 전에는 제작을 시작하지 않습니다.</p>
      <ul class="cands">${items}</ul>
      <div class="sticky">
        <span id="sel-count" class="muted"></span>
        <span class="muted">· ${esc(saved)}</span>
        <button data-act="proceed" ${canSelect ? '' : 'disabled'}>선택 저장 후 심층 조사</button>
        ${canSelect && research.periodDays < 30 ? '<button class="secondary" data-act="widen">30일로 다시 조사</button>' : ''}
      </div>`;
  // Once a deep result exists the long list is folded, leaving the chosen titles visible.
  const picked = research.candidates.filter((c) => selection?.candidateIds.includes(c.id));
  const folded = `
      <details class="cands-fold" ${draft.candsOpen ? 'open' : ''}>
        <summary>선택한 후보 ${picked.length}개 · 전체 후보 ${research.candidates.length}개 보기${canSelect ? '·다시 고르기' : ''}</summary>
        ${list}
      </details>
      ${picked.length ? `<ul class="picked">${picked.map((c) => `<li>${esc(c.title)}</li>`).join('')}</ul>` : ''}`;
  return `
    <section class="card">
      <h2>후보 ${research.candidates.length}개</h2>
      ${research.note ? `<p class="notice">${esc(research.note)}</p>` : ''}
      ${outletsHtml(research)}
      ${articlesHtml(research)}
      ${research.candidates.length ? '' : '<p class="muted">찾은 후보가 없습니다. 기간을 넓혀 다시 조사해 보세요.</p>'}
      ${research.held?.length ? `<details class="held"><summary>보류한 소식 ${research.held.length}개 — 공식 발표나 주요 언론으로 확인되지 않아 후보에서 뺐습니다</summary>
        <ul>${research.held.map((h) => `<li><b>${esc(h.title)}</b> <span class="muted">${dateOr(h.publishedAt)}</span><br><span class="unknown">${esc(h.heldReason)}</span>
          <ul class="sources">${h.sources.map((s) => `<li>${trustTag(s.url)}<a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a> · ${esc(s.publisher)}</li>`).join('')}</ul></li>`).join('')}</ul>
      </details>` : ''}
      ${deep ? folded : list}
    </section>
    ${deep ? renderDeep(deep, research, runs) : ''}
    ${deep ? renderStoryboard(snap) : ''}
    ${snap.images ? renderImages(snap) : ''}
    ${snap.layouts ? renderLayouts(snap) : ''}
    ${snap.layouts ? renderFinal(snap) : ''}`;
}

function renderDeep(deep, research, runs) {
  const title = (id) => research.candidates.find((c) => c.id === id)?.title ?? id;
  // A re-run that has not succeeded leaves the earlier result in place; say which one this is.
  const lastDeep = runs.find((r) => r.kind === 'deep_research');
  const kept = lastDeep && lastDeep.status !== 'succeeded'
    ? `<p class="warn">아래는 이전에 성공한 결과입니다. 마지막 심층 조사는 ${esc(RUN_STATUS[lastDeep.status] ?? lastDeep.status)} 상태라 아직 반영되지 않았습니다.</p>` : '';
  const list = (arr, fn) => (arr.length ? `<ul>${arr.map(fn).join('')}</ul>` : '<p class="muted">없음</p>');
  const link = (u) => `${trustTag(u)}<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener noreferrer">출처</a>`;
  const records = deep.records.map((r) => `
    <div class="card">
      <h2>${esc(title(r.candidateId))}</h2>
      <p class="label">확인된 사실</p>${list(r.facts, (f) => `<li>${esc(f.text)} (${link(f.sourceUrl)})</li>`)}
      <p class="label">발표 주체의 주장 (독립 검증 아님)</p>${list(r.claims, (c) => `<li>${esc(c.text)} — ${esc(c.by)} (${link(c.sourceUrl)})</li>`)}
      <p class="label">한계·미확인</p>${list(r.limits, (t) => `<li>${esc(t)}</li>`)}
      <p class="label">상충하는 내용</p>${list(r.conflicts, (t) => `<li>${esc(t)}</li>`)}
    </div>`).join('');
  const e = deep.editorial;
  return `
    <section class="card" id="sec-deep">
      <h2>조사 기록 ${deep.mock ? '<span class="tag mock">모의</span>' : ''}</h2>
      ${kept}
      ${records}
    </section>
    <section class="card" id="sec-editorial">
      <h2>편집 방향 제안</h2>
      ${e.formats ? renderEditorial(e, link, deep.mock) : renderLegacyEditorial(e)}
    </section>`;
}

const FORMAT_LABEL = { list: '목록형', story: '이야기형' };

function renderEditorial(e, link, mock) {
  const formats = ['list', 'story'].map((f) => `
    <div class="format ${f === e.recommendedFormat ? 'picked' : ''}">
      <h3>${FORMAT_LABEL[f]}${f === e.recommendedFormat ? '<span class="rec">추천</span>' : ''}</h3>
      <p><span class="label">맞는 점</span> ${esc(e.formats[f].fit)}</p>
      <p><span class="label">아쉬운 점</span> ${esc(e.formats[f].drawback)}</p>
    </div>`).join('');
  const hooks = e.hooks.map((h) => `
    <li><b>${esc(h.text)}</b>
      ${h.latestBasis ? `<div class="basis latest">'최신' 근거: ${esc(h.latestBasis)}${mock ? ' <span class="tag mock">모의 날짜</span>' : ''}</div>` : ''}
      <ul class="basis">${h.basis.map((b) => `<li>근거: ${esc(b.fact)} (${link(b.sourceUrl)})</li>`).join('')}</ul>
    </li>`).join('');
  const excluded = e.excludedHooks.length ? `
    <dt>규칙에 맞지 않아 제외한 후킹 문구</dt>
    <dd><ul class="excluded">${e.excludedHooks.map((x) => `<li><s>${esc(x.text)}</s> — ${esc(x.reason)}</li>`).join('')}</ul></dd>` : '';
  const warnings = e.warnings.length
    ? `<div class="warn">${e.warnings.map((w) => `<p>${esc(w)}</p>`).join('')}</div>` : '';
  return `
    ${warnings}
    <dl class="editorial">
      <dt>독자</dt><dd>${esc(e.audience)}</dd>
      <dt>독자에게 유용한 이유</dt><dd>${esc(e.whyUseful)}</dd>
      <dt>카드 형식 비교</dt>
      <dd><div class="formats">${formats}</div>
        <p class="why"><b>${FORMAT_LABEL[e.recommendedFormat]} 추천</b> — ${esc(e.formatReason)}</p></dd>
      <dt>카드 구성 (${FORMAT_LABEL[e.recommendedFormat]})</dt>
      <dd><ol class="structure">${e.structure.map((s) => `<li><b>${esc(s.role)}</b> ${esc(s.summary)}</li>`).join('')}</ol></dd>
      <dt>후킹 문구 후보 (확인된 사실과 연결된 것만)</dt><dd><ol class="hooks">${hooks}</ol></dd>
      ${excluded}
      <dt>판단 근거</dt><dd>${esc(e.reasoning)}</dd>
    </dl>`;
}

/** Results saved before the format rules existed (DECISIONS D12–D14). */
function renderLegacyEditorial(e) {
  return `
    <p class="notice">형식 비교 규칙 이전에 만든 결과입니다. 새 규칙을 적용하려면 심층 조사를 다시 실행하세요.</p>
    <dl class="editorial">
      <dt>독자</dt><dd>${esc(e.audience)}</dd>
      <dt>독자에게 유용한 이유</dt><dd>${esc(e.whyUseful)}</dd>
      <dt>카드 형식</dt><dd>${esc(e.format)}</dd>
      <dt>후킹 문구 후보</dt><dd><ol class="hooks">${(e.hooks ?? []).map((h) => `<li>${esc(typeof h === 'string' ? h : h.text)}</li>`).join('')}</ol></dd>
    </dl>`;
}

// ----- storyboard -----

function renderStoryboard(snap) {
  const { storyboard: sb, runs, project } = snap;
  const busy = runs.some(isActive);
  if (!sb) {
    return `<section class="card" id="sec-storyboard">
      <h2>스토리보드</h2>
      <p class="muted">조사 기록과 편집 방향으로 5~8장 카드 기획을 만듭니다. 장마다 핵심 문장, 본문, 이미지 역할, 출처를 보여 줍니다.</p>
      <div class="row"><button data-act="storyboard" ${busy ? 'disabled' : ''}>스토리보드 만들기</button></div>
    </section>`;
  }
  const link = (u) => `${trustTag(u)}<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener noreferrer">원문</a>`;
  const cards = sb.cards.map((c) => `
    <article class="sb-card">
      <div class="sb-head"><span class="sb-num">${c.index}</span><span class="tag">${esc(c.role)}</span></div>
      <p class="sb-headline">${esc(c.headline)}</p>
      <p class="sb-body">${esc(c.body)}</p>
      <p class="sb-meta"><span class="label">이미지 역할</span> ${esc(c.imageRole)}</p>
      <details class="sb-meta"><summary>그릴 장면</summary>${esc(c.imagePrompt)}</details>
      <div class="sb-meta"><span class="label">출처</span>${c.sources.length
        ? `<ul class="basis">${c.sources.map((s) => `<li>${esc(s.fact)} (${link(s.url)}${s.publishedAt ? ` · 게시 ${esc(s.publishedAt)}` : ''})</li>`).join('')}</ul>`
        : ' <span class="unknown">연결된 확인 사실 없음</span>'}</div>
    </article>`).join('');
  const approval = sb.approvedAt
    ? `<p class="notice">${fmtTime(sb.approvedAt)}에 승인했습니다. 아래에서 이미지 제작 상황을 확인하세요.</p>`
    : `<div class="sb-actions">
        <div class="pre-design">
          <p class="label">카드 디자인 <span class="muted">— 그림은 이 디자인의 크기·색·여백 규칙에 맞춰 그립니다</span></p>
          <div class="pre-design-opts">${Object.keys(DESIGN_LABEL).map((d) => `<label class="option"><input type="radio" name="pre-design" value="${d}" ${(snap.design ?? 'basic') === d ? 'checked' : ''} aria-label="${DESIGN_LABEL[d]}"><span><b>${DESIGN_LABEL[d]}</b><br><span class="desc">${DESIGN_DESC[d]}</span></span></label>`).join('')}</div>
        </div>
        ${snap.project.mock ? '' : `<div class="pre-design pre-tool">
          <p class="label">그림 그리기 도구 <span class="muted">— 모든 카드를 이 도구로 그립니다. 나중에 카드별 "그림 다시 만들기"에서 바꿀 수 있습니다</span></p>
          <div class="pre-design-opts">${[
            ['agy', 'agy (Antigravity)', '사진처럼 사실적인 그림. agy 이미지 사용 한도를 씁니다(한도가 차면 실패한 카드만 Claude CLI로 이어 그릴 수 있음)'],
            ['claude-cli-svg', 'Claude CLI', '도형으로 그린 일러스트(SVG). Claude 사용량을 씁니다'],
          ].map(([v, t, d]) => `<label class="option"><input type="radio" name="pre-tool" value="${v}" ${draft.preTool === v ? 'checked' : ''} aria-label="${t}"><span><b>${t}</b><br><span class="desc">${d}</span></span></label>`).join('')}</div>
        </div>`}
        <button data-act="approve" ${busy ? 'disabled' : ''}>스토리보드 승인 → 이미지 생성 시작</button>
        <p class="muted">승인하기 전에는 이미지를 만들지 않습니다.</p>
        <textarea name="sb-instruction" maxlength="500" placeholder="고칠 점을 구체적으로 적어 주세요. 예: 3번 카드 본문을 한 문장으로 줄여 줘"></textarea>
        <button class="secondary" data-act="revise" ${busy ? 'disabled' : ''}>변경 요청 반영해 다시 만들기</button>
      </div>`;
  return `<section class="card" id="sec-storyboard">
    <h2>스토리보드 v${sb.version} ${sb.mock ? '<span class="tag mock">모의</span>' : ''}</h2>
    <div class="meta"><span>형식 <b>${esc(FORMAT_LABEL[sb.format] ?? sb.format)}</b></span><span>독자 <b>${esc(sb.audience)}</b></span><span>카드 <b>${sb.cards.length}장</b></span></div>
    ${sb.instruction ? `<p class="muted">반영한 변경 요청: ${esc(sb.instruction)}</p>` : ''}
    <p class="why"><b>공통 그림체·색감</b> ${esc(sb.styleGuide)}</p>
    ${sb.warnings.length ? `<div class="warn">${sb.warnings.map((w) => `<p>${esc(w)}</p>`).join('')}<p>승인 전에 확인하고, 필요하면 변경을 요청하세요.</p></div>` : ''}
    <div class="sb-grid">${cards}</div>
    ${approval}
  </section>`;
}

// ----- images -----

const IMAGE_STATUS = { pending: '대기', generating: '생성 중', done: '확인 완료', failed: '실패' };
const TOOL_LABEL = { agy: 'Antigravity agy', 'claude-cli-svg': 'Claude CLI (SVG)', mock: '모의 이미지' };

/** Done pictures composed for another design than the chosen one (B31). */
function misfitPictures(snap) {
  // basic and soft ask for the same composition (empty top 40%), so they fit each other.
  const shape = (d) => (d === 'soft' ? 'basic' : d ?? 'basic');
  const textOnly = (i) => snap.layouts?.find((l) => l.index === i)?.image === false;
  return (snap.images?.cards ?? []).filter((c) => c.status === 'done' && !textOnly(c.index) && shape(c.design) !== shape(snap.design)).map((c) => c.index);
}
const misfitNote = (snap) => {
  const list = misfitPictures(snap);
  return list.length ? `<p class="warn">${list.join(', ')}번 그림은 "${DESIGN_LABEL[snap.images.cards.find((c) => c.index === list[0]).design ?? 'basic']}" 디자인의 구도(크기·여백)로 그려져, 지금 디자인 "${DESIGN_LABEL[snap.design ?? 'basic']}"과 어울리지 않을 수 있습니다. 카드마다 "그림 다시 만들기"를 요청하면 지금 디자인 규칙으로 다시 그립니다.</p>` : '';
};

/** One button for every failed card at once, drawn with Claude CLI (e.g. while agy's quota is used up). */
const failedAll = ({ images, project }, busy) => {
  const failed = images.cards.filter((c) => c.status === 'failed');
  if (project.mock || failed.length < 2) return '';
  const agyDone = images.cards.some((c) => c.status === 'done' && c.tool === 'agy');
  return `<div class="row"><button data-act="retry-image" data-index="failed" data-tool="claude-cli-svg" ${busy ? 'disabled' : ''}>실패한 카드 ${failed.length}장 모두 Claude CLI로 그리기</button>
    ${agyDone ? '<span class="muted">이미 agy로 그린 카드와 그림체가 다를 수 있습니다. 맞추려면 그 카드에 "그림 다시 만들기"(Claude CLI)를 요청하세요.</span>' : ''}</div>`;
};

function renderImages(snap) {
  const { images, storyboard: sb, project, runs } = snap;
  const busy = runs.some(isActive);
  const done = images.cards.filter((c) => c.status === 'done').length;
  const tiles = images.cards.map((c) => {
    const card = sb?.cards.find((x) => x.index === c.index);
    const pic = c.status === 'done'
      ? `<div class="img-frame"><img src="/api/projects/${esc(project.id)}/images/${esc(c.file)}?v=${esc(c.createdAt)}" alt="${c.index}번 카드 설명용 생성 이미지"><span class="title-zone">제목 자리(위쪽 40%)</span></div>`
      : `<div class="img-frame empty">${c.status === 'generating' ? '생성 중…' : c.status === 'failed' ? '실패' : '대기'}</div>`;
    const info = c.status === 'done'
      ? `<p class="sb-meta">${esc(c.file)} · ${esc((c.format ?? '').toUpperCase())} ${c.width}×${c.height} · ${Math.round((c.bytes ?? 0) / 1024)}KB<br>${esc(TOOL_LABEL[c.tool] ?? c.tool)} · ${fmtTime(c.createdAt)} · 설명용 생성 이미지</p>`
      : '';
    const err = c.status === 'failed' && c.error
      ? `<div class="error"><span class="tag err">${esc(ERROR_LABEL[c.error.code] ?? '오류')}</span> ${esc(c.error.message)}<br>${esc(c.error.nextAction)}</div>
         <div class="row"><button data-act="retry-image" data-index="${c.index}" ${busy ? 'disabled' : ''}>이 카드 다시 시도</button>
         ${project.mock || images.tool === 'claude-cli-svg' ? '' : `<button class="secondary" data-act="retry-image" data-index="${c.index}" data-tool="claude-cli-svg" ${busy ? 'disabled' : ''}>Claude CLI로 그리기</button>`}</div>` : '';
    return `<article class="img-card">
      <div class="sb-head"><span class="sb-num">${c.index}</span><span class="tag">${esc(card?.role ?? '')}</span><span class="tag ${c.status === 'failed' ? 'err' : ''}">${esc(IMAGE_STATUS[c.status] ?? c.status)}</span></div>
      ${pic}${info}${err}
      ${c.prompt ? `<details class="sb-meta"><summary>생성 요청 기록</summary><pre>${esc(c.prompt)}</pre></details>` : ''}
    </article>`;
  }).join('');
  return `<section class="card" id="sec-images">
    <h2>카드 이미지 ${done}/${images.cards.length}</h2>
    <p class="muted">이미지에는 글자를 넣지 않았습니다. 제목과 본문은 다음 단계에서 별도로 배치합니다. 생성한 파일이 실제로 있고 형식과 크기가 맞는지 확인한 카드만 "확인 완료"로 표시합니다.</p>
    ${images.fallbackReason ? `<p class="warn">agy 대신 Claude CLI(SVG)로 그렸습니다. 이유: ${esc(images.fallbackReason)}</p>` : ''}
    ${misfitNote(snap)}
    ${failedAll(snap, busy)}
    <div class="sb-grid">${tiles}</div>
  </section>`;
}

// ----- card text layout -----
// The image has no text; title and body are set over it as real text. The same
// 1080×1350 markup is shown scaled in the editor and in a phone-width preview.

const CARD_W = 1080;
const CARD_H = 1350;
const SAFE = 60;             // px kept clear at the card edges
const PHONE_W = 360;         // a common phone width in CSS px
const TEXT_ZONE = 0.4;       // images leave the top 40% empty for text
const LAYOUT_KEYS = ['headline', 'body', 'position', 'align', 'headlineSize', 'bodySize', 'theme', 'panel', 'image', 'textStyle', 'emoji', 'tone'];
const SIZE = { headline: [48, 120], body: [28, 64] };
// Smallest card sizes that stay readable on a phone: 18px title, 12px body.
const READABLE = { headline: Math.ceil((18 * CARD_W) / PHONE_W), body: Math.ceil((12 * CARD_W) / PHONE_W) };
const THEME_RGB = { dark: [29, 29, 31], light: [255, 255, 255] };
const PANEL_RGB = { dark: [255, 255, 255], light: [20, 24, 32] };
const PANEL_ALPHA = { none: 0, soft: 0.78, solid: 0.96 };
const sameLayout = (a, b) => LAYOUT_KEYS.every((k) => a[k] === b[k]);

const imageUrl = (snap, index) => {
  const c = snap.images?.cards.find((x) => x.index === index && x.status === 'done');
  return c ? `/api/projects/${snap.project.id}/images/${c.file}?v=${encodeURIComponent(c.createdAt)}` : null;
};
const currentLayout = (snap, index) => draft.layouts.get(index) ?? snap.layouts.find((l) => l.index === index);

// ----- designs (B28): one look for the whole set, coloured from the storyboard palette -----

const DESIGN_LABEL = { basic: '기본', soft: '소프트', brief: '브리프 포스터', news: '뉴스 다크', photo: '포토 오버레이', cinema: '시네마' };
const DESIGN_DESC = {
  basic: '밝은 그림 위에 글자만 깔끔하게',
  soft: '은은한 색 번짐, 둥근 라벨',
  brief: '크림 바탕, 큰 남색 제목과 주황 선, 오른쪽 아래 작은 그림',
  news: '어두운 바탕, 위 사진·아래 굵은 제목, 브랜드 줄',
  photo: '사진을 카드 전체에 어둡게, 금색 선과 흰 제목',
  cinema: '필름 사진 한 컷, 왼쪽 아래 짧은 흰 문장 2~3줄',
};
/** Designs that place the text themselves (fixed spot, white text, no panel). */
const FIXED_TEXT = new Set(['news', 'photo', 'cinema']);
/** Designs whose text spot and colour the design sets; the brief poster keeps dark text on cream (B40). */
const LOCKED = new Set([...FIXED_TEXT, 'brief']);

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** Ink (darkest) and accent (most saturated) colours from the style guide's hex codes. */
function palette(sb) {
  const hexes = [...new Set((sb?.styleGuide ?? '').match(/#[0-9a-fA-F]{6}\b/g) ?? [])];
  const info = hexes.map((h) => {
    const [r, g, b] = hexRgb(h).map((v) => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    return { h, lum: luminance(hexRgb(h)), sat: max === 0 ? 0 : (max - min) / max };
  });
  const ink = [...info].sort((a, b) => a.lum - b.lum)[0]?.h ?? '#1d1d1f';
  const accent = info.filter((x) => x.lum > 0.08 && x.lum < 0.8).sort((a, b) => b.sat - a.sat)[0]?.h ?? '#2346c9';
  const second = info.filter((x) => x.h !== accent && x.h !== ink && x.lum > 0.08 && x.lum < 0.8).sort((a, b) => b.sat - a.sat)[0]?.h ?? accent;
  return { ink, accent, second };
}

/** `**word**` marks a highlight; without marks the first number in the title is highlighted. */
/** __wavy__ in titles and bodies; ==highlighter== in bodies (B35). */
const wavy = (html) => html.replace(/__(.+?)__/g, '<u class="wv">$1</u>');
function bodyHtml(text) {
  return wavy(esc(text)).replace(/==(.+?)==/g, '<mark class="mk">$1</mark>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}

function headlineHtml(text, design) {
  const safe = wavy(esc(text));
  if (design === 'basic') return safe.replace(/\*\*(.+?)\*\*/g, '$1');
  if (/\*\*(.+?)\*\*/.test(safe)) return safe.replace(/\*\*(.+?)\*\*/g, '<em class="hl">$1</em>');
  // A number with its unit (89개국, 26%, 3배), not the particle after it (으로).
  return safe.replace(/\d[\d,.]*(?:%|[개국원명건배년월일주시분초위만억천조달러]+)?/, (m) => `<em class="hl">${m}</em>`);
}

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** What a face needs besides its layout: design, colours, card role, page, source and brand. */
function faceMeta(snap, index, design = snap.design ?? 'basic') {
  const sb = snap.storyboard;
  const card = sb?.cards.find((c) => c.index === index);
  const sources = [...new Set((card?.sources ?? []).map((s) => host(s.url)).filter(Boolean))];
  return {
    design, index, total: sb?.cards.length ?? 0, role: card?.role ?? '', source: sources.slice(0, 2).join(' · '),
    brand: snap.brand ?? '', topic: snap.project?.topic ?? '', ...palette(sb),
  };
}

// ----- fitting the photo designs to the picture (B49) -----
// News dark shows a 640px band of the picture and cinema lays text over the whole
// picture. A picture drawn for another design (e.g. basic: empty top, subject at the
// bottom) showed only empty paper in the news band and put cinema text over the
// subject. So each picture is measured once: where its detail sits (edge energy by
// row) and how light its top and bottom are. News moves its band to the detail;
// cinema puts the text on the emptier side, in dark ink when that side is light.
const FIT = new Map();      // src -> { focus, energyTop, energyBottom, lumTop, lumBottom, aspect } | null
const FIT_PENDING = new Map();
let FIT_VERSION = 0;

function fitPicture(src) {
  if (!src) return Promise.resolve(null);
  if (FIT.has(src)) return Promise.resolve(FIT.get(src));
  if (!FIT_PENDING.has(src)) {
    FIT_PENDING.set(src, new Promise((resolve) => {
      const img = new Image();
      const done = (v) => { FIT.set(src, v); FIT_VERSION++; resolve(v); };
      img.onload = () => {
        try {
          const w = 216, h = Math.max(1, Math.round((216 * (img.naturalHeight || CARD_H)) / (img.naturalWidth || CARD_W)));
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          const g = cv.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, 0, 0, w, h);
          const d = g.getImageData(0, 0, w, h).data;
          const lum = (x, y) => { const o = (y * w + x) * 4; return (0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]) / 255; };
          const energy = [], light = [];
          for (let y = 0; y < h - 2; y++) {
            let e = 0, L = 0;
            for (let x = 0; x < w - 2; x += 2) {
              const v = lum(x, y);
              e += Math.abs(v - lum(x + 2, y)) + Math.abs(v - lum(x, y + 2));
              L += v;
            }
            const n = Math.ceil((w - 2) / 2);
            energy.push(Math.max(0, e / n - 0.004)); // flat paper and soft gradients count as empty
            light.push(L / n);
          }
          const total = energy.reduce((a, b) => a + b, 0);
          const part = (a, b, arr) => { const s = arr.slice(Math.floor(a * arr.length), Math.ceil(b * arr.length)); return s.reduce((p, q) => p + q, 0) / Math.max(1, s.length); };
          done(total < 1e-6 ? null : {
            focus: energy.reduce((acc, e, y) => acc + e * y, 0) / total / energy.length,
            energyTop: part(0, 0.42, energy), energyBottom: part(0.58, 1, energy),
            lumTop: part(0.08, 0.42, light), lumBottom: part(0.58, 0.92, light),
            aspect: (img.naturalHeight || CARD_H) / (img.naturalWidth || CARD_W),
          });
        } catch { done(null); }
      };
      img.onerror = () => done(null);
      img.src = src;
    }));
  }
  return FIT_PENDING.get(src);
}

/** How a photo design places itself over this picture; null until it is measured. */
function pictureFit(design, src) {
  const f = src ? FIT.get(src) : null;
  if (!f) return null;
  if (design === 'news') {
    // The band is 640px of a picture shown 1080px wide; centre it on the detail.
    const shown = CARD_W * f.aspect;
    if (shown <= 640) return null;
    const offset = Math.min(Math.max(f.focus * shown - 320, 0), shown - 640);
    return { posY: (offset / (shown - 640)) * 100 };
  }
  if (design === 'cinema') {
    const top = f.energyBottom > f.energyTop * 1.2;
    const lum = top ? f.lumTop : f.lumBottom;
    return { cin: top ? 'top' : 'bottom', ink: lum > 0.62 ? 'dark' : 'light' };
  }
  return null;
}

function faceHtml(l, src, width, meta) {
  const s = width / CARD_W;
  const m = meta ?? { design: 'basic', index: l.index, total: 0, role: '', source: '', brand: '', topic: '', ink: '#1d1d1f', accent: '#2346c9', second: '#2346c9' };
  const brief = m.design === 'brief';
  const num = String(m.index).padStart(2, '0');
  const total = String(m.total).padStart(2, '0');
  const fixed = FIXED_TEXT.has(m.design);
  // A text-only card has no picture; each design lays the words out on its own background.
  const textOnly = l.image === false;
  // Text-only cards can take a style of their own (B35).
  const ts = textOnly ? l.textStyle ?? 'plain' : 'plain';
  const tone = { palette: m.accent, blue: '#1E6BFF', orange: '#FF6B2C', green: '#12A87A', pink: '#FF4F8B', black: '#141416' }[l.tone ?? 'palette'] ?? m.accent;
  // The photo designs set the text spot, white text and no panel themselves.
  const fit = l.image === false ? null : pictureFit(m.design, src);
  const pos = fixed || brief ? 'fixed' : l.position;
  const theme = brief || fit?.ink === 'dark' ? 'dark' : fixed ? 'light' : l.theme;
  const panel = fixed || brief ? 'none' : l.panel;
  const eyebrow = {
    soft: `<span class="eb-pill">${esc(m.role || num)}</span>`,
    photo: '<span class="eb-gold"></span>',
  }[m.design];
  // No picture on a text-only card, so no picture credit.
  const credit = [m.source ? `출처 ${esc(m.source)}` : '', textOnly ? '' : 'AI 생성 이미지'].filter(Boolean).join(' · ');
  const plainHead = l.headline.replace(/\*\*|__/g, '');
  const tiles = ts === 'strips' && [...plainHead.replace(/\s/g, '')].length <= 12;
  const headHtml = tiles
    ? `<p class="face-h tiles">${[...plainHead].map((ch, i) => (ch.trim() ? `<span class="tile" style="--r:${[3, -4, 2, -3][i % 4]}deg">${esc(ch)}</span>` : '<span class="tile sp"> </span>')).join('')}</p>`
    : `<p class="face-h">${headlineHtml(l.headline, ts !== 'plain' ? 'soft' : brief ? 'basic' : m.design)}</p>`;
  const lines = (l.body ?? '').includes('\n') ? l.body.split('\n') : (l.body ?? '').split(/(?<=[.!?])\s+/);
  const bodyBlock = !l.body ? ''
    : ts === 'strips' ? `<div class="face-b strips">${lines.filter((t) => t.trim()).map((t, i) => `<p class="strip" style="--r:${[-1.2, 0.8, -0.5, 1.1][i % 4]}deg">${bodyHtml(t.trim())}</p>`).join('')}</div>`
      : `<p class="face-b">${bodyHtml(l.body)}</p>`;
  return `<div class="face-wrap" style="width:${width}px;height:${Math.round(CARD_H * s)}px" data-scale="${s}">
    <div class="face" style="transform:scale(${s});--ink:${m.ink};--accent:${m.accent};--second:${m.second};--tone:${tone}" data-design="${m.design}" data-pos="${pos}" data-align="${l.align}" data-theme="${theme}" data-panel="${panel}"${textOnly ? ` data-noimg="1" data-ts="${ts}"` : ''}${fit?.cin ? ` data-cin="${fit.cin}" data-cink="${fit.ink}"` : ''}>
      ${textOnly ? '' : src ? `<img class="face-img" src="${esc(src)}" alt=""${fit?.posY !== undefined ? ` style="object-position:50% ${fit.posY.toFixed(2)}%"` : ''}>` : '<div class="face-img empty"><span>그림 대기 중</span></div>'}
      ${m.design === 'soft' ? '<div class="face-wash"></div>' : ''}
      ${m.design === 'news' ? '<div class="face-fade"></div>' : ''}
      ${m.design === 'photo' || m.design === 'cinema' ? '<div class="face-shade"></div>' : ''}
      ${m.design === 'cinema' && m.total ? `<div class="face-pill">${num} / ${total}</div>` : ''}
      ${m.design === 'news' ? `<div class="face-brand"><span class="br-mark">//</span>${m.brand ? `<span class="br-name">${esc(m.brand)}</span>` : ''}<span class="br-line"></span><span class="br-num">${num}${m.total ? `<span> / ${total}</span>` : ''}</span></div>` : ''}
      ${brief ? `<div class="face-label">${esc(m.brand || 'CARD NEWS')}${m.role ? ` / ${esc(m.role)}` : ''}</div>` : ''}
      <div class="face-text" style="--hs:${l.headlineSize}px;--bs:${l.bodySize}px">
        ${eyebrow ? `<div class="face-eyebrow">${eyebrow}</div>` : ''}
        ${brief && m.topic ? `<p class="face-kicker">${esc(m.topic)}</p>` : ''}
        ${ts === 'poster' && l.emoji ? `<div class="face-emoji">${esc(l.emoji)}</div>` : ''}
        ${headHtml}${brief ? '<div class="face-bar"></div>' : ''}${bodyBlock}
        ${m.design === 'soft' && m.total && m.source ? `<p class="face-src">출처 ${esc(m.source)}</p>` : ''}
      </div>
      ${m.total && m.design !== 'news' && m.design !== 'cinema' ? `<div class="face-page">${num}<span> / ${total}</span></div>` : ''}
      ${brief ? `<div class="face-foot"><span>${m.source ? `출처 ${esc(m.source)}` : ''}</span><span>${textOnly ? '' : 'AI 생성 이미지'}</span></div>` : ''}
      ${fixed ? `<p class="face-credit">${credit}</p>` : ''}
      ${m.design === 'cinema' && m.brand ? `<p class="face-mark">${esc(m.brand)}</p>` : ''}
    </div>
  </div>`;
}

function renderLayouts(snap) {
  const sb = snap.storyboard;
  const opt = (name, value, pairs) => `<select name="${name}">${pairs.map(([v, t]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  const items = sb.cards.map((card) => {
    const l = currentLayout(snap, card.index);
    return `<article class="lay-card" data-index="${card.index}">
      <div class="sb-head"><span class="sb-num">${card.index}</span><span class="tag">${esc(card.role)}</span><span class="tag lay-state"></span></div>
      <div class="lay-grid">
        <div class="lay-preview">${faceHtml(l, imageUrl(snap, card.index), 300, faceMeta(snap, card.index))}</div>
        <form class="lay-form">
          <label>제목 <textarea name="headline" rows="2" maxlength="60">${esc(l.headline)}</textarea></label>
          <label>본문 <textarea name="body" rows="4" maxlength="240">${esc(l.body)}</textarea></label>
          <p class="lay-orig" hidden>스토리보드 문장과 다릅니다. 확인된 사실 범위 안에서 고쳤는지 확인하세요.<br><span class="muted">원래 제목: ${esc(card.headline)}</span></p>
          <div class="lay-opts">
            <label>위치 ${opt('position', l.position, [['top', '위 (빈 영역)'], ['middle', '가운데'], ['bottom', '아래']])}</label>
            <label>정렬 ${opt('align', l.align, [['left', '왼쪽'], ['center', '가운데']])}</label>
            <label>글자색 ${opt('theme', l.theme, [['dark', '어두운 글자'], ['light', '밝은 글자']])}</label>
            <label>배경 받침 ${opt('panel', l.panel, [['none', '없음'], ['soft', '반투명'], ['solid', '불투명']])}</label>
            <label>제목 크기 <input type="range" name="headlineSize" min="${SIZE.headline[0]}" max="${SIZE.headline[1]}" step="2" value="${l.headlineSize}"><output>${l.headlineSize}</output></label>
            <label>본문 크기 <input type="range" name="bodySize" min="${SIZE.body[0]}" max="${SIZE.body[1]}" step="2" value="${l.bodySize}"><output>${l.bodySize}</output></label>
            <label class="lay-noimg"><input type="checkbox" name="noimage" ${l.image === false ? 'checked' : ''}> 그림 없이 글자만</label>
            <label class="ts-only" ${l.image === false ? '' : 'hidden'}>글자 카드 모양 ${opt('textStyle', l.textStyle ?? 'plain', [['plain', '기본'], ['strips', '키워드 띠'], ['highlight', '형광펜 요약'], ['poster', '포스터']])}</label>
            <label class="ts-only" ${l.image === false ? '' : 'hidden'}>이모지(포스터) <input type="text" name="emoji" maxlength="8" value="${esc(l.emoji ?? '')}" placeholder="예: 🚇"></label>
            <label class="ts-only" ${l.image === false ? '' : 'hidden'}>포스터 색 ${opt('tone', l.tone ?? 'palette', [['palette', '그림 색'], ['blue', '파랑'], ['orange', '주황'], ['green', '초록'], ['pink', '분홍'], ['black', '검정']])}</label>
          </div>
          <ul class="issues"><li class="muted">검사 중…</li></ul>
          <div class="row">
            <button type="button" class="secondary" data-lay="fix">자동으로 고치기</button>
            <button type="button" data-lay="save">저장</button>
            <button type="button" class="secondary" data-lay="discard">편집 취소</button>
            <button type="button" class="secondary" data-lay="reset">기본값으로</button>
          </div>
        </form>
      </div>
      ${revisionBox(snap, card.index)}
    </article>`;
  }).join('');
  const phone = sb.cards.map((card) => `<div class="phone-card" data-index="${card.index}">${faceHtml(currentLayout(snap, card.index), imageUrl(snap, card.index), PHONE_W - 16, faceMeta(snap, card.index))}</div>`).join('');
  return `<section class="card" id="sec-cards">
    <h2>카드 글자 배치</h2>
    <p class="muted">이미지에는 글자를 넣지 않고, 제목과 본문을 그 위에 글자로 얹습니다. 장마다 글자가 카드 밖으로 잘리는지, 아래 그림과 겹쳐 읽기 어려운지, 휴대폰에서 너무 작은지 검사합니다. 고친 내용은 "저장"을 눌러야 남습니다.</p>
    <h3 class="sub">디자인 <span class="muted">— 카드 전체에 같이 적용됩니다. 그림의 색을 가져와 맞춥니다.</span></h3>
    <div class="design-pick">${Object.keys(DESIGN_LABEL).map((d) => {
      const first = sb.cards[0];
      return `<button type="button" class="design-opt" data-design="${d}" aria-pressed="${(snap.design ?? 'basic') === d}">
        ${faceHtml(currentLayout(snap, first.index), imageUrl(snap, first.index), 134, faceMeta(snap, first.index, d))}
        <b>${DESIGN_LABEL[d]}</b><small>${DESIGN_DESC[d]}</small>
      </button>`;
    }).join('')}</div>
    ${snap.design === 'news' || snap.design === 'cinema' || snap.design === 'brief' ? `<div class="row brand-row"><label>브랜드 이름 <input type="text" name="brand" maxlength="20" value="${esc(snap.brand ?? '')}" placeholder="예: 오늘광남"></label><button type="button" class="secondary" data-act="brand">저장</button><span class="muted">${snap.design === 'news' ? '카드 맨 위 왼쪽에 작게 보입니다. 비우면 표시하지 않습니다.' : snap.design === 'brief' ? '카드 맨 위 왼쪽 파란 라벨에 보입니다. 비우면 "CARD NEWS"로 나옵니다.' : '카드 아래 가운데에 작게 보입니다. 비우면 표시하지 않습니다.'}</span></div>` : ''}
    ${LOCKED.has(snap.design) ? `<p class="muted">"${DESIGN_LABEL[snap.design]}"은 글자 위치·글자색·배경 받침을 디자인이 정합니다. 카드별로는 문장과 글자 크기만 바꿀 수 있습니다.</p>` : ''}
    ${misfitNote(snap)}
    <p class="muted">제목에서 강조할 말은 <b>**두 별표**</b>로 감싸세요(예: 광고가 **89개국**으로). 감싸지 않으면 제목의 첫 숫자를 강조합니다. 제목·본문에서 Enter로 줄을 바꾸면 카드에도 그대로 끊어 보입니다. 1장 제목은 피드의 썸네일이니 짧은 구절 2~3줄로 끊어 보세요.</p>
    <div id="lay-summary" class="notice">검사 중…</div>
    <div class="row">
      <button type="button" class="secondary" data-act="phone">${draft.phoneOpen ? '휴대폰 미리보기 닫기' : '휴대폰 미리보기 열기'}</button>
    </div>
    <p class="muted">카드마다 아래 "이 카드만 고쳐 달라고 요청하기"로 글자나 그림을 고칠 수 있습니다. PNG·ZIP은 맨 아래 "최종 승인·내보내기"에서 받습니다.</p>
    <div class="phone-wrap" ${draft.phoneOpen ? '' : 'hidden'}>
      <p class="muted">폭 ${PHONE_W}px 휴대폰 화면에서 보이는 크기입니다. 빨간 테두리는 고칠 곳입니다. 카드를 누르면 아래 편집 칸으로 이동합니다.</p>
      <div class="phone"><div class="phone-screen">${phone}</div></div>
    </div>
    <div class="lay-list">${items}</div>
  </section>`;
}

/**
 * One card alone at full size, from the saved layout. The server opens this page
 * in a hidden browser and pictures it as the card PNG (B27).
 */
async function showRender(id, index) {
  document.body.classList.add('render-mode');
  try {
    const snap = await api('GET', `/api/projects/${id}`);
    const l = snap.layouts?.find((x) => x.index === index);
    const src = imageUrl(snap, index);
    if (!l || (!src && l.image !== false)) throw new Error(`${index}번 카드의 배치나 이미지가 없습니다.`);
    if (l.image !== false) await fitPicture(src);
    $app.innerHTML = `<div id="render-card">${faceHtml(l, src, CARD_W, faceMeta(snap, index))}</div>`;
    const img = $app.querySelector('img.face-img');
    if (img) {
      await new Promise((resolve, reject) => {
        if (img.complete && img.naturalWidth) resolve();
        img.onload = resolve;
        img.onerror = () => reject(new Error('카드 이미지를 불러오지 못했습니다.'));
      });
    }
    const headFont = `800 ${l.headlineSize}px Pretendard`;
    const loaded = await Promise.all([
      document.fonts.load(headFont, l.headline.replace(/\*\*/g, '')),
      l.body ? document.fonts.load(`500 ${l.bodySize}px Pretendard`, l.body) : [true],
    ]);
    await document.fonts.ready;
    window.__renderFont = loaded.every((faces) => faces.length > 0);
    // Where the text actually sits on this page (scale 1, so CSS px = card px),
    // for the export check of clipped text.
    const face = $app.querySelector('.face').getBoundingClientRect();
    const box = $app.querySelector('.face-text').getBoundingClientRect();
    const blocks = [...$app.querySelectorAll('.face-text > *')];
    // Same contrast check as the editor, on the page that becomes the PNG.
    const wrapEl = $app.querySelector('.face-wrap');
    const overlap = checkFace(wrapEl, l, await facePixels(wrapEl, src)).find((i) => i.kind === 'overlap');
    window.__renderMeasure = {
      overlap: overlap ? overlap.text : null,
      top: box.top - face.top, bottom: box.bottom - face.top, left: box.left - face.left, right: box.right - face.left,
      overflowX: blocks.some((b) => b.scrollWidth > b.clientWidth + 1),
      headline: $app.querySelector('.face-h')?.textContent ?? '',
      body: $app.querySelector('.face-b')?.textContent ?? '',
    };
    window.__renderReady = true;
  } catch (err) {
    window.__renderError = err.message || String(err);
  }
}

/** Fetches a file from the server and hands it to the browser as a download. */
async function download(url, fallbackName, btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '만드는 중…';
  try {
    const res = await fetch(url);
    checkVersion(res);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const e = typeof data.error === 'object' && data.error ? data.error
        : { message: `내려받기 실패 (${res.status})`, nextAction: '서버를 다시 켠 뒤 시도해 보세요.' };
      throw Object.assign(new Error(e.message), e);
    }
    const blob = await res.blob();
    const named = res.headers.get('content-disposition')?.match(/filename\*=UTF-8''([^;]+)/);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = named ? decodeURIComponent(named[1]) : fallbackName;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
    if (res.headers.get('x-font-loaded') === 'false') {
      notify('글꼴(Pretendard)을 불러오지 못해 대체 글꼴로 찍혔습니다. 인터넷 연결을 확인한 뒤 다시 내려받으세요.');
    }
  } catch (err) {
    toast(err);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// Image pixels at card size (object-fit: cover), for checking what lies under the text.
const pixelCache = new Map();
function cardPixels(src, w = CARD_W, h = CARD_H, posY = 0.5) {
  if (!src) return Promise.resolve(null);
  const key = `${src}|${w}x${h}|${posY}`;
  if (!pixelCache.has(key)) {
    pixelCache.set(key, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          const g = cv.getContext('2d', { willReadFrequently: true });
          const iw = img.naturalWidth || CARD_W, ih = img.naturalHeight || CARD_H;
          const k = Math.max(w / iw, h / ih);
          g.drawImage(img, (w - iw * k) / 2, (h - ih * k) * posY, iw * k, ih * k);
          resolve({ data: g.getImageData(0, 0, w, h).data, w, h });
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = src;
    }));
  }
  return pixelCache.get(key);
}

/** Pixels of the picture at the size its box has on this face (object-fit: cover). */
function facePixels(wrap, src) {
  const s = Number(wrap.dataset.scale);
  const img = wrap.querySelector('img.face-img');
  if (!img || !src) return Promise.resolve(null);
  const r = img.getBoundingClientRect();
  // Vertical object-position, e.g. the news design's photo band.
  const posY = parseFloat(getComputedStyle(img).objectPosition.split(' ')[1]) / 100;
  return cardPixels(src, Math.max(1, Math.round(r.width / s)), Math.max(1, Math.round(r.height / s)), Number.isFinite(posY) ? posY : 0.5);
}

/**
 * [r, g, b, alpha] from a computed colour: rgb()/rgba(), or color(srgb …) which
 * browsers return for color-mix() (the news background). Missing from the first
 * version, so a navy card read as white and every line was flagged.
 */
function colorOf(css) {
  let m = css?.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  m = css?.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?/);
  if (m) return [Number(m[1]) * 255, Number(m[2]) * 255, Number(m[3]) * 255, m[4] === undefined ? 1 : Number(m[4])];
  return null;
}
const rgbOf = (css) => {
  const c = colorOf(css);
  return c && c[3] > 0 ? c.slice(0, 3) : null;
};
/** How dark the photo design presses the picture (matches .face-shade). */
const SHADE = { photo: 0.5, cinema: 0.5 };

const luminance = ([r, g, b]) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** Measures one rendered face (any scale) and returns its problems. */
function checkFace(wrap, l, pixels) {
  const s = Number(wrap.dataset.scale);
  const face = wrap.querySelector('.face').getBoundingClientRect();
  const toCard = (r) => ({ left: (r.left - face.left) / s, top: (r.top - face.top) / s, right: (r.right - face.left) / s, bottom: (r.bottom - face.top) / s });
  const box = toCard(wrap.querySelector('.face-text').getBoundingClientRect());
  const issues = [];

  if (box.top < SAFE || box.bottom > CARD_H - SAFE) {
    const over = Math.round(Math.max(SAFE - box.top, box.bottom - (CARD_H - SAFE)));
    issues.push({ kind: 'clip', text: `글자가 카드 가장자리를 ${over}px 넘어 잘립니다. 글자를 줄이거나 문장을 짧게 하세요.` });
  }

  {
    // Every few pixels under each text line: contrast between the text's real
    // colour and what is behind it: the picture inside its box (pressed darker by
    // the photo design, blended with a panel if any), the card background outside.
    const faceEl = wrap.querySelector('.face');
    const design = faceEl.dataset.design;
    const imgEl = wrap.querySelector('img.face-img');
    const ib = imgEl ? toCard(imgEl.getBoundingClientRect()) : { left: 0, top: 0 };
    const base = rgbOf(getComputedStyle(faceEl).backgroundColor) ?? [255, 255, 255];
    const shade = SHADE[design] ?? 0;
    const pa = PANEL_ALPHA[faceEl.dataset.panel];
    const pc = PANEL_RGB[faceEl.dataset.theme];
    const behind = (x, y) => {
      const px = Math.floor(x - ib.left), py = Math.floor(y - ib.top);
      let c = base;
      if (pixels && px >= 0 && py >= 0 && px < pixels.w && py < pixels.h) {
        const o = (py * pixels.w + px) * 4;
        c = [0, 1, 2].map((i) => pixels.data[o + i] * (1 - shade));
      }
      return [0, 1, 2].map((i) => c[i] * (1 - pa) + pc[i] * pa);
    };
    // A small overlap still hides letters, so one bad line is enough to report.
    let total = 0, low = 0, worstLine = 0;
    // The source line counts too: it was found sitting on a picture in an export.
    for (const el of wrap.querySelectorAll('.face-h:not(.tiles), .face-b:not(.strips), .face-src, .strip')) {
      const fg = rgbOf(getComputedStyle(el).color) ?? THEME_RGB[l.theme];
      // An opaque box behind this text (strip, poster box) is what it is read against.
      let boxBg = null;
      for (let a = el; a && a !== faceEl; a = a.parentElement) {
        const bg = colorOf(getComputedStyle(a).backgroundColor);
        if (bg && bg[3] >= 0.95) { boxBg = bg.slice(0, 3); break; }
      }
      const range = document.createRange();
      range.selectNodeContents(el);
      for (const r of range.getClientRects()) {
        const c = toCard(r);
        let n = 0, bad = 0;
        for (let y = Math.max(0, Math.floor(c.top)); y < Math.min(CARD_H, c.bottom); y += 4) {
          for (let x = Math.max(0, Math.floor(c.left)); x < Math.min(CARD_W, c.right); x += 4) {
            n++;
            if (contrast(fg, boxBg ?? behind(x, y)) < 3) bad++;
          }
        }
        total += n; low += bad;
        if (n) worstLine = Math.max(worstLine, bad / n);
      }
    }
    const pct = total ? Math.round((low / total) * 100) : 0;
    // 2% of a line is about a thin bar crossing it (measured on card 3's stand).
    if (pct >= 3 || worstLine >= 0.02) {
      issues.push({ kind: 'overlap', text: `글자가 그림과 겹쳐 대비가 부족한 곳이 있습니다(전체의 ${pct}%, 가장 심한 줄 ${Math.round(worstLine * 100)}%). 위치를 옮기거나, 글자색이나 배경 받침을 바꾸세요.` });
    }
  }

  const phoneBody = (l.bodySize * PHONE_W) / CARD_W;
  const phoneHead = (l.headlineSize * PHONE_W) / CARD_W;
  if (l.body && phoneBody < 12) issues.push({ kind: 'small', text: `휴대폰에서 본문이 약 ${phoneBody.toFixed(1)}px로 작습니다(12px 이상 권장).` });
  if (phoneHead < 18) issues.push({ kind: 'small', text: `휴대폰에서 제목이 약 ${phoneHead.toFixed(1)}px로 작습니다(18px 이상 권장).` });

  const placed = wrap.querySelector('.face').dataset;
  if (!issues.some((i) => i.kind === 'overlap') && placed.panel === 'none' && !placed.noimg && placed.pos === 'top' && box.bottom > CARD_H * TEXT_ZONE + 1) {
    issues.push({ kind: 'note', text: '글자가 위쪽 빈 영역(40%) 아래까지 내려오지만, 대비는 충분합니다.' });
  }
  return issues;
}

const ISSUE_LABEL = { clip: '잘림', overlap: '겹침', small: '작음', note: '참고' };

function bindLayouts(el, snap, kick) {
  const sec = el.querySelector('#sec-cards');
  if (!sec) return;
  const pid = snap.project.id;
  const results = new Map();

  const summary = () => {
    const bad = [...results].filter(([, r]) => r.some((i) => i.kind !== 'note'));
    const box = sec.querySelector('#lay-summary');
    if (results.size < snap.layouts.length) { box.textContent = '검사 중…'; return; }
    box.className = bad.length ? 'warn' : 'notice';
    box.innerHTML = bad.length
      ? `고칠 곳이 있는 카드 ${bad.length}장: ${bad.map(([i, r]) => `<a href="javascript:void 0" data-goto="${i}">${i}번(${[...new Set(r.filter((x) => x.kind !== 'note').map((x) => ISSUE_LABEL[x.kind]))].join('·')})</a>`).join(', ')}`
      : `${results.size}장 모두 잘림·겹침·글자 크기 문제가 없습니다.`;
    for (const a of box.querySelectorAll('[data-goto]')) a.addEventListener('click', () => goto(a.dataset.goto));
  };
  const goto = (i) => sec.querySelector(`.lay-card[data-index="${i}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Read the controls themselves: disabled selects (designs that place the text)
  // are left out of FormData, which made saving fail for them.
  const readForm = (form) => {
    const v = (n) => form.elements[n].value;
    return {
      headline: v('headline').trim(), body: v('body').trim(),
      position: v('position'), align: v('align'), theme: v('theme'), panel: v('panel'),
      headlineSize: Number(v('headlineSize')), bodySize: Number(v('bodySize')),
      image: !form.elements.noimage.checked,
      textStyle: v('textStyle'), emoji: v('emoji').trim(), tone: v('tone'),
    };
  };
  const writeForm = (form, l) => {
    for (const k of LAYOUT_KEYS) if (k !== 'image') form.elements[k].value = l[k];
    form.elements.noimage.checked = l.image === false;
    for (const el of form.querySelectorAll('.ts-only')) el.hidden = l.image !== false;
    for (const o of form.querySelectorAll('output')) o.textContent = o.previousElementSibling.value;
  };

  /** Re-draws a card's two previews from `l` and checks them. */
  async function update(index, l) {
    const card = sec.querySelector(`.lay-card[data-index="${index}"]`);
    const src = imageUrl(snap, index);
    card.querySelector('.lay-preview').innerHTML = faceHtml(l, src, 300, faceMeta(snap, index));
    sec.querySelector(`.phone-card[data-index="${index}"]`).innerHTML = faceHtml(l, src, PHONE_W - 16, faceMeta(snap, index));
    const saved = snap.layouts.find((x) => x.index === index);
    const sbCard = snap.storyboard.cards.find((c) => c.index === index);
    const dirty = !sameLayout(l, saved);
    const state = card.querySelector('.lay-state');
    state.textContent = dirty ? '저장 안 한 변경' : saved.saved ? '저장됨' : '기본 배치';
    state.classList.toggle('mock', dirty);
    card.querySelector('.lay-orig').hidden = l.headline === sbCard.headline && l.body === sbCard.body;
    card.querySelector('[data-lay=save]').disabled = !dirty;
    card.querySelector('[data-lay=discard]').disabled = !dirty;
    card.querySelector('[data-lay=reset]').disabled = !saved.saved && !dirty;

    const wrap = card.querySelector('.face-wrap');
    await document.fonts.ready;
    const pixels = await facePixels(wrap, src);
    // A newer edit replaced this preview while waiting; its own check will report.
    if (!wrap.isConnected) return results.get(index) ?? [];
    const issues = checkFace(wrap, l, pixels);
    results.set(index, issues);
    const problems = issues.filter((i) => i.kind !== 'note');
    for (const w of [card, sec.querySelector(`.phone-card[data-index="${index}"]`)]) {
      w.querySelector('.face-text').classList.toggle('bad', problems.length > 0);
    }
    card.querySelector('.issues').innerHTML = issues.length
      ? issues.map((i) => `<li><span class="tag ${i.kind === 'note' ? '' : 'err'}">${ISSUE_LABEL[i.kind]}</span> ${esc(i.text)}</li>`).join('')
      : '<li class="ok">잘림·겹침·글자 크기 문제 없음</li>';
    summary();
    return issues;
  }

  /**
   * Text at least the size a phone can read, smaller (down to that size) for
   * clipping, then colour, then a panel for overlap. Text that still does not
   * fit is left reported: shortening it is the user's call.
   */
  async function autoFix(index, start) {
    let l = { ...start, headlineSize: Math.max(start.headlineSize, READABLE.headline), bodySize: Math.max(start.bodySize, READABLE.body) };
    for (let i = 0; i < 40; i++) {
      const issues = await update(index, l);
      if (issues.some((x) => x.kind === 'clip')) {
        if (l.headlineSize > READABLE.headline || l.bodySize > READABLE.body) {
          l = { ...l, headlineSize: Math.max(READABLE.headline, l.headlineSize - 4), bodySize: Math.max(READABLE.body, l.bodySize - 2) };
          continue;
        }
        if (l.position !== 'middle') { l = { ...l, position: 'middle' }; continue; }
        break;
      }
      if (issues.some((x) => x.kind === 'overlap')) {
        if (l.panel === 'none' && !l.triedTheme) { l = { ...l, theme: l.theme === 'dark' ? 'light' : 'dark', triedTheme: true }; continue; }
        if (l.panel === 'none') { l = { ...l, theme: start.theme, panel: 'soft' }; continue; }
        if (l.panel === 'soft') { l = { ...l, panel: 'solid' }; continue; }
      }
      break;
    }
    delete l.triedTheme;
    return l;
  }

  sec.querySelector('[data-act=phone]').addEventListener('click', (e) => {
    draft.phoneOpen = !draft.phoneOpen;
    sec.querySelector('.phone-wrap').hidden = !draft.phoneOpen;
    e.currentTarget.textContent = draft.phoneOpen ? '휴대폰 미리보기 닫기' : '휴대폰 미리보기 열기';
  });
  for (const pc of sec.querySelectorAll('.phone-card')) pc.addEventListener('click', () => goto(pc.dataset.index));

  for (const b of sec.querySelectorAll('.design-opt')) {
    b.addEventListener('click', (e) => {
      if (b.getAttribute('aria-pressed') === 'true') return;
      act(e.currentTarget, kick, () => api('POST', `/api/projects/${pid}/design`, { design: b.dataset.design, version: snap.project.version, requestId: crypto.randomUUID() }));
    });
  }
  sec.querySelector('[data-act=brand]')?.addEventListener('click', (e) => {
    const brand = sec.querySelector('input[name=brand]').value.trim();
    act(e.currentTarget, kick, () => api('POST', `/api/projects/${pid}/design`, { design: snap.design, brand, version: snap.project.version, requestId: crypto.randomUUID() }));
  });
  // The photo designs place the text themselves.
  if (LOCKED.has(snap.design)) {
    for (const n of ['position', 'theme', 'panel']) for (const sel of sec.querySelectorAll(`.lay-form select[name=${n}]`)) sel.disabled = true;
  }

  const problemsOf = (i) => [...new Set((results.get(i) ?? []).filter((x) => x.kind !== 'note').map((x) => ISSUE_LABEL[x.kind]))];
  bindFinal(el, snap, kick, problemsOf);

  for (const card of sec.querySelectorAll('.lay-card')) {
    const index = Number(card.dataset.index);
    const form = card.querySelector('form');
    const saved = () => snap.layouts.find((x) => x.index === index);
    const keep = (l) => { if (sameLayout(l, saved())) draft.layouts.delete(index); else draft.layouts.set(index, l); };
    form.addEventListener('input', () => {
      for (const o of form.querySelectorAll('output')) o.textContent = o.previousElementSibling.value;
      const l = { ...saved(), ...readForm(form) };
      keep(l);
      update(index, l);
    });
    card.querySelector('[data-lay=fix]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const l = await autoFix(index, { ...saved(), ...readForm(form) });
      writeForm(form, l);
      keep(l);
      await update(index, l);
      btn.disabled = false;
    });
    card.querySelector('[data-lay=discard]').addEventListener('click', () => {
      draft.layouts.delete(index);
      writeForm(form, saved());
      update(index, saved());
    });
    card.querySelector('[data-lay=save]').addEventListener('click', (e) => {
      const l = readForm(form);
      if (!l.headline) { notify('제목을 입력하세요.'); return; }
      act(e.currentTarget, kick, async () => {
        await api('POST', `/api/projects/${pid}/cards/${index}/layout`, { layout: l, version: snap.project.version, requestId: crypto.randomUUID() });
        draft.layouts.delete(index);
      });
    });
    const revText = card.querySelector('.rev-text');
    revText.addEventListener('input', () => draft.revText.set(index, revText.value));
    card.querySelector('[data-lay=revise]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const kind = card.querySelector(`input[name="rev-kind-${index}"]:checked`)?.value;
      const instruction = revText.value.trim();
      if (!instruction) { notify('무엇을 어떻게 고칠지 적어 주세요. 예: 본문이 길어요. 핵심 조건은 유지하고 두 문장으로 줄여 주세요'); return; }
      const notes = [
        kind === 'text' && draft.layouts.has(index) ? '이 카드에 저장하지 않은 편집이 있습니다. 저장된 문장을 기준으로 고치고, 저장하지 않은 편집은 버립니다.' : '',
        kind === 'image' ? `${index}번 카드 그림만 새로 그립니다(${{ agy: 'agy, 사용 한도를 씁니다', 'claude-cli-svg': 'Claude CLI, 사용량이 듭니다', mock: '모의 이미지' }[card.querySelector(`select[name="rev-tool-${index}"]`)?.value ?? snap.images?.tool] ?? snap.images?.tool}). 이전 그림은 보관하고, 실패하면 이전 그림을 그대로 둡니다.` : '',
        snap.final?.valid ? '이미 최종 승인한 카드입니다. 고치면 최종 승인을 다시 받아야 합니다.' : '',
      ].filter(Boolean);
      if (!(await ask(`${index}번 카드에 "${kind === 'text' ? '글자 고치기' : '그림 다시 만들기'}"를 요청할까요?${notes.length ? `\n${notes.join('\n')}` : ''}`, '요청 보내기'))) return;
      act(btn, kick, async () => {
        const tool = kind === 'image' ? card.querySelector(`select[name="rev-tool-${index}"]`)?.value : undefined;
        await api('POST', `/api/projects/${pid}/revisions`, { index, kind, instruction, tool, version: snap.project.version, requestId: crypto.randomUUID() });
        if (kind === 'text') draft.layouts.delete(index);
        draft.revText.delete(index);
      });
    });
    card.querySelector('[data-lay=reset]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (!(await ask(`${index}번 카드를 스토리보드 문장과 기본 배치로 되돌릴까요? 저장한 수정이 지워집니다.`, '되돌리기'))) return;
      act(btn, kick, async () => {
        await api('POST', `/api/projects/${pid}/cards/${index}/layout`, { layout: null, version: snap.project.version, requestId: crypto.randomUUID() });
        draft.layouts.delete(index);
      });
    });
    update(index, currentLayout(snap, index));
  }
}

// ----- card change requests (PRD 6) -----

const REV_STATUS = { running: '진행 중', done: '반영됨', failed: '실패' };

function revisionBox(snap, index) {
  const busy = snap.runs.some(isActive);
  const list = (snap.revisions ?? []).filter((r) => r.index === index).slice().reverse();
  const plain = (t) => esc((t ?? '').replace(/\*\*/g, ''));
  const history = list.map((r) => `<li>
      <span class="tag ${r.status === 'failed' ? 'err' : r.status === 'done' ? 'ok' : ''}">${REV_STATUS[r.status]}</span>
      <b>${r.kind === 'text' ? '글자' : '그림'}</b> <span class="muted">${fmtTime(r.createdAt)}</span> — ${esc(r.instruction)}
      ${r.kind === 'text' && r.after ? `<div class="rev-diff">
        ${r.after.headline !== r.before.headline ? `<div><span class="muted">제목 전</span> ${plain(r.before.headline)}<br><span class="muted">제목 후</span> ${plain(r.after.headline)}</div>` : ''}
        ${r.after.body !== r.before.body ? `<div><span class="muted">본문 전</span> ${plain(r.before.body)}<br><span class="muted">본문 후</span> ${plain(r.after.body)}</div>` : ''}
      </div>` : ''}
      ${r.kind === 'image' && r.status === 'done' ? '<div class="muted">그림만 새로 그렸고, 이전 그림은 보관했습니다.</div>' : ''}
      ${(r.warnings ?? []).map((w) => `<div class="muted">${esc(w)}</div>`).join('')}
      ${r.error ? `<div class="error">${esc(r.error)}</div>` : ''}
    </li>`).join('');
  return `<div class="rev-box">
    <p class="label">이 카드만 고쳐 달라고 요청하기</p>
    <div class="rev-kinds">
      <label class="option"><input type="radio" name="rev-kind-${index}" value="text" checked aria-label="글자 고치기"><span><b>글자 고치기</b><br><span class="desc">그림은 그대로 두고 이 카드의 제목·본문만 고칩니다</span></span></label>
      <label class="option"><input type="radio" name="rev-kind-${index}" value="image" aria-label="그림 다시 만들기"><span><b>그림 다시 만들기</b><br><span class="desc">이 카드 그림만 새로 그립니다. 이전 그림은 보관합니다</span></span></label>
    </div>
    ${snap.project.mock ? '' : `<label class="rev-tool">그림을 다시 만들 때 쓸 도구 <select name="rev-tool-${index}">
      <option value="agy" ${snap.images?.tool === 'agy' || snap.images?.tool === 'claude-cli-svg' && snap.images?.fallbackReason ? 'selected' : ''}>agy (사진 같은 그림, agy 한도 사용)</option>
      <option value="claude-cli-svg" ${snap.images?.tool === 'claude-cli-svg' && !snap.images?.fallbackReason ? 'selected' : ''}>Claude CLI SVG (도형 그림)</option>
    </select></label>`}
    <textarea class="rev-text" maxlength="500" placeholder="예: 본문이 길어요. 핵심 조건은 유지하고 두 문장으로 줄여 주세요">${esc(draft.revText.get(index) ?? '')}</textarea>
    <div class="row"><button type="button" data-lay="revise" ${busy ? 'disabled' : ''}>요청 보내기</button>
      ${busy ? '<span class="muted">다른 작업이 끝나면 보낼 수 있습니다.</span>' : '<span class="muted">다른 카드는 바뀌지 않습니다.</span>'}</div>
    ${history ? `<ul class="rev-history">${history}</ul>` : ''}
  </div>`;
}

// ----- final approval and export (PRD 6) -----

const CHECK_STATUS = { pass: '통과', fail: '실패', unverified: '확인 못 함' };
const FILE_LABEL = { png: 'PNG', zip: '전체 ZIP', record: '출처와 이미지 사용 기록', checks: '검사 결과' };

function renderFinal(snap) {
  const f = snap.final;
  const busy = snap.runs.some(isActive);
  const exp = (snap.exports ?? []).filter((e) => e.current).at(-1);
  const older = (snap.exports ?? []).filter((e) => !e.current).length;
  const changed = f ? (snap.revisions ?? []).filter((r) => r.status === 'done' && r.finishedAt > f.approvedAt).length : 0;
  const status = !f
    ? '<p class="notice">아직 최종 승인 전입니다. 카드를 모두 확인한 뒤 승인하면 카드별 PNG, 전체 ZIP, 출처와 이미지 사용 기록을 만들고 내보낸 파일을 검사합니다.</p>'
    : !f.valid
      ? `<p class="warn">${fmtTime(f.approvedAt)}에 최종 승인한 뒤 카드가 바뀌었습니다${changed ? `(수정 요청 ${changed}건 반영)` : ''}. 다시 최종 승인해야 바뀐 카드로 내보낼 수 있습니다.</p>`
      : `<p class="notice ok">${fmtTime(f.approvedAt)}에 최종 승인했습니다. 지금 카드는 승인한 그대로입니다.</p>`;
  const needApprove = !f || !f.valid || !exp;
  const files = exp ? `<h3 class="sub">내려받기 <span class="muted">— ${fmtTime(exp.createdAt)}에 내보낸 파일</span></h3>
    <div class="export-files">${exp.files.map((x) => `<button type="button" class="${x.kind === 'zip' ? '' : 'secondary'}" data-file="${esc(x.name)}">${x.kind === 'png' ? esc(x.name) : FILE_LABEL[x.kind]} <small>${Math.max(1, Math.round(x.bytes / 1024))}KB</small></button>`).join('')}</div>` : '';
  const checks = exp ? `<h3 class="sub">내보낸 파일 검사</h3>
    <p class="muted">"확인 못 함"은 통과가 아닙니다. 맨 아래 "직접 확인할 것"을 꼭 보세요.</p>
    <table class="checks"><thead><tr><th>항목</th><th>결과</th><th>확인한 방법</th></tr></thead><tbody>
      ${exp.checks.map((c) => `<tr><td>${esc(c.label)}</td><td><span class="tag st-${c.status}">${CHECK_STATUS[c.status]}</span></td><td class="muted">${esc(c.method)}</td></tr>`).join('')}
    </tbody></table>
    ${exp.checks.map((c) => `<details class="check-detail" ${c.status === 'pass' ? '' : 'open'}><summary>${esc(c.label)} 자세히 (${c.details.length}건)</summary><ul>
      ${c.details.map((d) => `<li><span class="tag st-${d.status}">${CHECK_STATUS[d.status]}</span> ${d.index ? `${d.index}번 · ` : ''}${esc(d.message)}</li>`).join('')}</ul></details>`).join('')}
    <h3 class="sub">직접 확인할 것</h3><ul class="review">${exp.toReview.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '';
  return `<section class="card" id="sec-final">
    <h2>최종 승인·내보내기</h2>
    ${status}
    ${needApprove ? `<div class="row"><button type="button" data-act="final" ${busy ? 'disabled' : ''}>${f && f.valid ? '다시 내보내기' : '최종 승인하고 내보내기'}</button>
      <span class="muted">카드 ${snap.storyboard.cards.length}장을 찍고 검사하는 데 30초~1분쯤 걸립니다.</span></div>` : ''}
    ${files}${checks}
    ${older ? `<p class="muted">이전에 내보낸 ${older}건은 지금 카드와 달라 목록에서 뺐습니다(파일은 output/exports 폴더에 남아 있습니다).</p>` : ''}
  </section>`;
}

function bindFinal(el, snap, kick, problemsOf) {
  const sec = el.querySelector('#sec-final');
  if (!sec) return;
  const pid = snap.project.id;
  sec.querySelector('[data-act=final]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const unsaved = [...draft.layouts.keys()];
    const bad = snap.storyboard.cards.map((c) => c.index).filter((i) => problemsOf(i).length);
    const warn = [
      unsaved.length ? `저장하지 않은 편집이 있는 카드(${unsaved.join(', ')}번)는 저장된 상태로 승인됩니다.` : '',
      bad.length ? `편집 화면 검사에서 문제가 남은 카드: ${bad.map((i) => `${i}번(${problemsOf(i).join('·')})`).join(', ')}.` : '',
    ].filter(Boolean);
    const msg = `지금 카드 ${snap.storyboard.cards.length}장을 최종 승인하고 PNG·ZIP·기록을 만들까요?${warn.length ? `\n${warn.join('\n')}` : ''}\n승인한 뒤 카드를 고치면 다시 승인해야 합니다.`;
    if (!(await ask(msg, '최종 승인'))) return;
    act(btn, kick, () => api('POST', `/api/projects/${pid}/approve`, { stage: 'final', version: snap.project.version, requestId: crypto.randomUUID() }));
  });
  const exp = (snap.exports ?? []).filter((x) => x.current).at(-1);
  for (const b of sec.querySelectorAll('[data-file]')) {
    b.addEventListener('click', () => download(`/api/projects/${pid}/exports/${exp.id}/${encodeURIComponent(b.dataset.file)}`, b.dataset.file, b));
  }
}

function bindBody(el, snap, kick) {
  const pid = snap.project.id;
  bindLayouts(el, snap, kick);
  el.querySelector('[data-act=storyboard]')?.addEventListener('click', (e) => act(e.currentTarget, kick, () =>
    api('POST', `/api/projects/${pid}/storyboard`, { version: snap.project.version, requestId: crypto.randomUUID() })));
  for (const r of el.querySelectorAll('input[name=pre-design]')) {
    r.addEventListener('change', () => api('POST', `/api/projects/${pid}/design`, { design: r.value, version: snap.project.version, requestId: crypto.randomUUID() }).then(kick, toast));
  }
  for (const r of el.querySelectorAll('input[name=pre-tool]')) r.addEventListener('change', () => { draft.preTool = r.value; });
  el.querySelector('[data-act=approve]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const tool = snap.project.mock ? null : draft.preTool;
    const toolName = { agy: 'agy', 'claude-cli-svg': 'Claude CLI' }[tool];
    if (!(await ask(`이 스토리보드를 승인하고 이미지 생성을 시작할까요?${toolName ? ` 그림은 ${toolName}로 그립니다.` : ''}`, '승인'))) return;
    act(btn, kick, () => api('POST', `/api/projects/${pid}/approve`, { stage: 'storyboard', version: snap.project.version, requestId: crypto.randomUUID(), ...(tool ? { tool } : {}) }));
  });
  el.querySelector('[data-act=revise]')?.addEventListener('click', (e) => {
    const instruction = el.querySelector('textarea[name=sb-instruction]')?.value.trim();
    if (!instruction) { notify('고칠 점을 입력하세요.'); return; }
    act(e.currentTarget, kick, () => api('POST', `/api/projects/${pid}/storyboard`, { instruction, version: snap.project.version, requestId: crypto.randomUUID() }));
  });
  for (const b of el.querySelectorAll('[data-act=retry-image]')) {
    b.addEventListener('click', (e) => act(e.currentTarget, kick, () =>
      api('POST', `/api/projects/${pid}/images/${b.dataset.index}/retry`, { requestId: crypto.randomUUID(), ...(b.dataset.tool ? { tool: b.dataset.tool } : {}) })));
  }
  el.querySelector('.cands-fold')?.addEventListener('toggle', (e) => { draft.candsOpen = e.currentTarget.open; });
  const { project } = snap;
  const count = el.querySelector('#sel-count');
  const boxes = [...el.querySelectorAll('.cand input[type=checkbox]')];
  const sync = () => {
    if (!count) return;
    count.textContent = `${draft.checked.size}/3개 선택`;
    const full = draft.checked.size >= 3;
    for (const b of boxes) {
      if (!b.checked) b.disabled = full || b.hasAttribute('data-locked');
      b.closest('.cand').classList.toggle('checked', b.checked);
    }
  };
  for (const b of boxes) {
    if (b.disabled) b.setAttribute('data-locked', '');
    b.addEventListener('change', () => {
      if (b.checked) draft.checked.add(b.value); else draft.checked.delete(b.value);
      sync();
    });
  }
  sync();

  el.querySelector('[data-act=proceed]')?.addEventListener('click', (e) => act(e.currentTarget, kick, async () => {
    const ids = [...draft.checked];
    if (ids.length < 1 || ids.length > 3) throw Object.assign(new Error('후보를 1~3개 선택하세요.'), { nextAction: '' });
    const saved = await api('POST', `/api/projects/${project.id}/selection`, {
      candidateIds: ids, version: project.version, requestId: crypto.randomUUID(),
    });
    await api('POST', `/api/projects/${project.id}/deep-research`, { version: saved.version, requestId: crypto.randomUUID() });
  }));
  el.querySelector('[data-act=widen]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!(await ask('기간을 30일로 넓혀 다시 조사할까요? 현재 후보와 선택은 새 결과로 바뀝니다.', '다시 조사'))) return;
    act(btn, kick, () => api('POST', `/api/projects/${project.id}/research`, { periodDays: 30, requestId: crypto.randomUUID() }));
  });
}
