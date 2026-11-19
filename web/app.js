// Membrane Console — 零依赖前端（原生 fetch + DOM），与后端 REST 通信。
const $ = (id) => document.getElementById(id);
const API = '';

const KIND_COLORS = { fact: '#7aa2ff', episode: '#b18cff', preference: '#5ee6c0', procedure: '#f5c26b' };
const KINDS = ['fact', 'episode', 'preference', 'procedure'];

// Token 三模式：召回返回的详细度 + 默认条数。存在 localStorage，刷新后保持。
const MODES = {
  ultra: { label: '省 Token', detail: 'ultra', limit: 3, hint: '只返回 id + 内容 + 分数，最省 token' },
  brief: { label: '平衡', detail: 'brief', limit: 8, hint: '加 kind / subject / 时间 / 证据数，日常推荐' },
  full:  { label: '完整', detail: 'full', limit: 8, hint: '完整 why + 五路分数明细，排查用（贵约 4 倍）' },
};
const state = {
  mode: localStorage.getItem('membrane.mode') || 'brief',
  detailId: null,
  detailRecord: null,
};

async function api(path, opts = {}) {
  const r = await fetch(API + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
  return data;
}

// ---- 视图切换 ----
const TITLES = { overview: 'Overview', ingest: 'Ingest Pipeline', recall: 'Hybrid Recall', ledger: 'Memory Ledger', audit: 'Audit Trail', ops: 'Ops / Admin' };
function showView(v) {
  if (!TITLES[v]) v = 'overview';
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('.view').forEach(s => s.classList.add('hidden'));
  $('view-' + v).classList.remove('hidden');
  $('view-title').textContent = TITLES[v];
  if (v !== 'ops' && state.logTimer) { clearInterval(state.logTimer); state.logTimer = null; $('log-auto').checked = false; }
  if (v === 'overview') loadStats();
  if (v === 'ledger') loadLedger();
  if (v === 'ops') loadOps();
  history.replaceState(null, '', '#' + v);
}
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

// ---- Token 模式 ----
function applyMode(mode) {
  if (!MODES[mode]) mode = 'brief';
  state.mode = mode;
  localStorage.setItem('membrane.mode', mode);
  document.querySelectorAll('#mode-switch button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('rc-limit').value = MODES[mode].limit;
  $('recall-mode-hint').textContent = `FTS5 BM25 + RRF + temporal decay · ${MODES[mode].label}模式：${MODES[mode].hint}`;
}
document.querySelectorAll('#mode-switch button').forEach(b => {
  b.addEventListener('click', () => applyMode(b.dataset.mode));
});

// ---- Overview ----
async function loadStats() {
  try {
    const h = await api('/api/health');
    $('health-chip').textContent = '● healthy';
    $('health-chip').classList.remove('err');
    $('db-path').textContent = h.db || 'local';
    if (h.version) $('version-chip').textContent = 'v' + h.version;
  } catch (e) {
    $('health-chip').textContent = '● offline';
    $('health-chip').classList.add('err');
    return;
  }
  const s = await api('/api/stats');
  $('s-total').textContent = s.total;
  $('s-current').textContent = s.current;
  $('s-superseded').textContent = s.superseded;
  $('s-deleted').textContent = s.deleted;
  $('s-entities').textContent = s.entities ?? '—';
  $('s-relations').textContent = s.relations ?? '—';
  const max = Math.max(1, ...KINDS.map(k => s.byKind[k] || 0));
  $('kind-bars').innerHTML = KINDS.map(k => {
    const n = s.byKind[k] || 0;
    const pct = (n / max) * 100;
    return `<div class="kind-row"><div class="kind-name">${k}</div><div class="kind-track"><div class="kind-fill" style="width:${pct}%;background:${KIND_COLORS[k]}"></div></div><div class="kind-count">${n}</div></div>`;
  }).join('');
}

// ---- Ingest ----
$('btn-ingest').addEventListener('click', async () => {
  const body = {
    content: $('in-content').value.trim(),
    kind: $('in-kind').value,
    subject: $('in-subject').value.trim() || undefined,
    namespace: $('in-namespace').value.trim() || undefined,
    tags: $('in-tags').value.split(',').map(s => s.trim()).filter(Boolean),
    confidence: Number($('in-conf').value),
    pin: $('in-pin').checked,
  };
  const box = $('ingest-result');
  box.classList.remove('hidden');
  if (!body.content) { box.innerHTML = '<span class="err">content required</span>'; return; }
  try {
    const r = await api('/api/memories', { method: 'POST', body });
    const sup = (r.superseded || []).map(m => `<div>↳ superseded: ${esc(m.id)} (${esc(m.content)})</div>`).join('');
    box.innerHTML = `<div class="status-tag">${esc(r.status.toUpperCase())}</div><div>${esc(r.note)}</div><div style="margin-top:6px;color:var(--violet)">id: ${esc(r.memory.id)}</div>${sup}`;
    loadStats();
  } catch (e) { box.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
});

// ---- Recall ----
$('rc-asof-toggle').addEventListener('change', e => $('rc-asof-wrap').classList.toggle('hidden', !e.target.checked));
async function doRecall() {
  const mode = MODES[state.mode];
  const body = {
    query: $('rc-query').value.trim(),
    limit: Number($('rc-limit').value) || mode.limit,
    detail: mode.detail,
  };
  if ($('rc-kind').value) body.kind = $('rc-kind').value;
  if ($('rc-namespace').value.trim()) body.namespace = $('rc-namespace').value.trim();
  if ($('rc-asof-toggle').checked && $('rc-asof').value) body.asOf = Number($('rc-asof').value);
  const box = $('recall-results');
  if (!body.query) { box.innerHTML = '<div class="empty">enter a query to begin</div>'; return; }
  box.innerHTML = `<div class="empty">running ${mode.label} recall…</div>`;
  try {
    const r = await api('/api/recall', { method: 'POST', body });
    if (!r.results.length) { box.innerHTML = '<div class="empty">no matching memories</div>'; return; }
    box.innerHTML = r.results.map((h, i) => renderHit(h, i)).join('');
  } catch (e) { box.innerHTML = `<div class="empty err">${esc(e.message)}</div>`; }
}

function renderHit(h, i) {
  // ultra 只有 id/content/score；brief 是扁平的 id/kind/content/subject/score；full 才有 memory/why/breakdown
  const m = h.memory || { id: h.id, content: h.content, kind: h.kind || '—', subject: h.subject || null };
  const b = h.breakdown;
  const actions = `<div class="hit-actions"><button class="btn tiny" data-detail="${esc(m.id)}">详情</button></div>`;
  const meta = h.memory || h.kind
    ? `<span class="hit-kind">${esc(m.kind)}</span><span class="hit-subject">${esc(m.subject || '—')}</span>`
    : `<span class="hit-kind">ultra</span>`;
  const why = h.why ? `<div class="hit-why">why: ${esc(h.why)}</div>` : '';
  const bd = b ? `<div class="breakdown">
      <span class="bd-item">RRF<sub>text</sub> <b>${b.rrfText.toFixed(4)}</b></span>
      <span class="bd-item">vec <b>${b.rrfVec.toFixed(3)}</b></span>
      <span class="bd-item">graph <b>${b.rrfGraph.toFixed(3)}</b></span>
      <span class="bd-item">freshness <b>${b.freshness.toFixed(4)}</b></span>
      <span class="bd-item">age <b>${b.ageDays}d</b></span>
      <span class="bd-item">half-life <b>${b.halfLifeDays}d</b></span>
      <span class="bd-item">confidence <b>${b.confidence}</b></span>
      <span class="bd-item">weights <b>${b.weights.text}/${b.weights.vec}/${b.weights.time}/${b.weights.conf}/${b.weights.graph}</b></span>
    </div>` : '';
  return `<div class="hit">
    <div class="hit-top"><span class="hit-score">#${i + 1} · ${Number(h.score).toFixed(4)}</span>${meta}${actions}</div>
    <div class="hit-content">${esc(m.content)}</div>
    ${why}${bd}
  </div>`;
}
$('btn-recall').addEventListener('click', doRecall);
$('rc-query').addEventListener('keydown', e => { if (e.key === 'Enter') doRecall(); });

// ---- Ledger ----
async function loadLedger() {
  const params = new URLSearchParams({ validity: $('ld-all').checked ? 'all' : 'current', limit: '200' });
  if ($('ld-kind').value) params.set('kind', $('ld-kind').value);
  if ($('ld-namespace').value.trim()) params.set('namespace', $('ld-namespace').value.trim());
  const tbody = document.querySelector('#ledger-table tbody');
  tbody.innerHTML = '<tr><td colspan="8" class="empty">loading…</td></tr>';
  try {
    const rows = await api('/api/memories?' + params.toString());
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty">no records</td></tr>'; return; }
    tbody.innerHTML = rows.map(m => {
      let status = '<span class="badge active">ACTIVE</span>';
      if (m.deleted) status = '<span class="badge del">TOMBSTONE</span>';
      else if (m.validTo) status = '<span class="badge sup">SUPERSEDED</span>';
      const date = new Date(m.validFrom).toISOString().replace('T', ' ').slice(0, 16);
      return `<tr>
        <td class="mono">${esc(m.id.slice(0, 12))}…</td>
        <td>${esc(m.kind)}</td>
        <td class="content-cell">${esc(m.content)}</td>
        <td>${esc(m.subject || '—')}</td>
        <td>${m.confidence}</td>
        <td class="mono">${date}</td>
        <td>${status}</td>
        <td class="row-actions">
          <button class="btn tiny" data-detail="${esc(m.id)}">详情</button>
          <button class="btn tiny" data-edit="${esc(m.id)}" ${m.deleted || m.validTo ? 'disabled' : ''}>编辑</button>
          <button class="btn tiny danger" data-forget="${esc(m.id)}" ${m.deleted ? 'disabled' : ''}>遗忘</button>
        </td></tr>`;
    }).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty err">${esc(e.message)}</td></tr>`;
  }
}
$('ld-all').addEventListener('change', loadLedger);
$('btn-ld-refresh').addEventListener('click', loadLedger);
$('ld-kind').addEventListener('change', loadLedger);
$('ld-namespace').addEventListener('keydown', e => { if (e.key === 'Enter') loadLedger(); });

// ---- Audit ----
$('btn-audit').addEventListener('click', async () => {
  const id = $('au-id').value.trim();
  const box = $('audit-results');
  if (!id) { box.innerHTML = '<div class="empty">enter a memory id</div>'; return; }
  try {
    const entries = await api(`/api/memories/${encodeURIComponent(id)}/history`);
    if (!entries.length) { box.innerHTML = '<div class="empty">no audit entries</div>'; return; }
    box.innerHTML = renderHistory(entries);
  } catch (e) { box.innerHTML = `<div class="empty err">${esc(e.message)}</div>`; }
});

function renderHistory(entries) {
  return '<div class="timeline">' + entries.map(e => {
    const time = new Date(e.at).toISOString().replace('T', ' ').slice(0, 19);
    return `<div class="tl-item"><span class="tl-op">${esc(e.op.toUpperCase())}</span><span class="tl-time">${time} · seq ${e.seq}</span><div class="tl-detail">${esc(e.detail || '')}</div></div>`;
  }).join('') + '</div>';
}

// ---- 详情 / 编辑 / 遗忘 ----
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-detail],[data-edit],[data-forget],[data-close]');
  if (!t) return;
  if (t.dataset.close) return closeModal(t.dataset.close);
  if (t.dataset.detail) return openDetail(t.dataset.detail);
  if (t.dataset.edit) return openEdit(t.dataset.edit);
  if (t.dataset.forget) return forgetMemory(t.dataset.forget);
});
document.querySelectorAll('.modal').forEach(overlay => {
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.add('hidden'); });
});

function closeModal(id) { $(id).classList.add('hidden'); }
function toast(msg, isErr) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2600);
}

async function openDetail(id) {
  state.detailId = id;
  const body = $('detail-body');
  body.innerHTML = '<div class="empty">loading…</div>';
  $('detail-modal').classList.remove('hidden');
  try {
    const m = await api(`/api/memories/${encodeURIComponent(id)}`);
    if (!m) { body.innerHTML = '<div class="empty">not found</div>'; return; }
    state.detailRecord = m;
    const [history, evidence, entities] = await Promise.all([
      api(`/api/memories/${encodeURIComponent(id)}/history`).catch(() => []),
      api(`/api/memories/${encodeURIComponent(id)}/evidence`).catch(() => []),
      api(`/api/entities?memoryId=${encodeURIComponent(id)}`).then(x => x.entities).catch(() => []),
    ]);
    let relations = [];
    if (m.subject) {
      relations = await api(`/api/relations?a=${encodeURIComponent(m.subject)}&limit=20`)
        .then(x => x.relations).catch(() => []);
    }
    const status = m.deleted ? '<span class="badge del">TOMBSTONE</span>'
      : m.validTo ? '<span class="badge sup">SUPERSEDED</span>' : '<span class="badge active">ACTIVE</span>';
    const tags = (m.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join(' ') || '—';
    const entChips = entities.map(x => `<span class="tag">${esc(x.name)} <em>${esc(x.type)}</em></span>`).join(' ') || '—';
    const relList = relations.map(r => `<div class="mini-row">${esc(r.sentence)} <span class="muted">${esc(r.fromType)} → ${esc(r.toType)}</span></div>`).join('') || '<div class="muted">—</div>';
    const evList = evidence.map(x => `<div class="mini-row">“${esc(x.quote)}” <span class="muted">${new Date(x.at).toISOString().slice(0, 19).replace('T', ' ')}</span></div>`).join('') || '<div class="muted">—</div>';
    body.innerHTML = `
      <div class="detail-status">${status}<span class="mono muted">${esc(m.id)}</span></div>
      <div class="detail-content">${esc(m.content)}</div>
      <div class="detail-grid">
        <div><span class="k">kind</span><b>${esc(m.kind)}</b></div>
        <div><span class="k">subject</span><b>${esc(m.subject || '—')}</b></div>
        <div><span class="k">namespace</span><b>${esc(m.namespace || 'default')}</b></div>
        <div><span class="k">confidence</span><b>${m.confidence}</b></div>
        <div><span class="k">valid from</span><b>${new Date(m.validFrom).toISOString().slice(0, 19).replace('T', ' ')}</b></div>
        <div><span class="k">valid to</span><b>${m.validTo ? new Date(m.validTo).toISOString().slice(0, 19).replace('T', ' ') : '—'}</b></div>
        <div><span class="k">pin</span><b>${m.pin ? 'yes' : 'no'}</b></div>
        <div><span class="k">superseded by</span><b class="mono">${esc(m.supersededBy || '—')}</b></div>
      </div>
      <div class="detail-section"><h3>Tags</h3><div>${tags}</div></div>
      <div class="detail-section"><h3>Entities</h3><div>${entChips}</div></div>
      <div class="detail-section"><h3>Relations</h3>${relList}</div>
      <div class="detail-section"><h3>Evidence</h3>${evList}</div>
      <div class="detail-section"><h3>Audit chain</h3>${history.length ? renderHistory(history) : '<div class="muted">—</div>'}</div>`;
    $('btn-detail-edit').disabled = !!m.deleted || !!m.validTo;
    $('btn-detail-forget').disabled = !!m.deleted;
  } catch (e) {
    body.innerHTML = `<div class="empty err">${esc(e.message)}</div>`;
  }
}

$('btn-detail-copy').addEventListener('click', async () => {
  if (!state.detailId) return;
  try { await navigator.clipboard.writeText(state.detailId); toast('id copied'); }
  catch { toast('copy failed — select it manually', true); }
});

async function openEdit(id) {
  try {
    const m = state.detailRecord && state.detailRecord.id === id
      ? state.detailRecord
      : await api(`/api/memories/${encodeURIComponent(id)}`);
    if (!m || m.deleted || m.validTo) { toast('只能编辑现行版本', true); return; }
    state.detailId = id;
    state.detailRecord = m;
    $('ed-content').value = m.content;
    $('ed-kind').value = m.kind;
    $('ed-subject').value = m.subject || '';
    $('ed-conf').value = m.confidence;
    $('ed-tags').value = (m.tags || []).join(', ');
    $('ed-pin').checked = !!m.pin;
    $('edit-result').classList.add('hidden');
    closeModal('detail-modal');
    $('edit-modal').classList.remove('hidden');
  } catch (e) { toast(e.message, true); }
}
$('btn-detail-edit').addEventListener('click', () => state.detailId && openEdit(state.detailId));

$('btn-edit-save').addEventListener('click', async () => {
  if (!state.detailId) return;
  const body = {
    content: $('ed-content').value.trim(),
    kind: $('ed-kind').value,
    subject: $('ed-subject').value.trim() || null,
    confidence: Number($('ed-conf').value),
    tags: $('ed-tags').value.split(',').map(s => s.trim()).filter(Boolean),
    pin: $('ed-pin').checked,
  };
  const box = $('edit-result');
  box.classList.remove('hidden');
  if (!body.content) { box.innerHTML = '<span class="err">content required</span>'; return; }
  box.innerHTML = '<span class="muted">saving new version…</span>';
  try {
    const r = await api(`/api/memories/${encodeURIComponent(state.detailId)}`, { method: 'PATCH', body });
    toast(r.status === 'duplicate' ? '内容没变化，未创建新版本' : '已保存新版本，旧版本进入历史');
    closeModal('edit-modal');
    loadLedger();
    loadStats();
    if (r.memory) openDetail(r.memory.id);
  } catch (e) { box.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
});

async function forgetMemory(id) {
  if (!confirm('确定遗忘这条记忆？会软删除，历史仍可 asOf 查到。')) return;
  try {
    await api(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
    closeModal('detail-modal');
    toast('已遗忘（软删除）');
    loadLedger();
    loadStats();
  } catch (e) { toast(e.message, true); }
}
$('btn-detail-forget').addEventListener('click', () => state.detailId && forgetMemory(state.detailId));

// ---- 导出备份 ----
$('btn-export').addEventListener('click', async () => {
  try {
    const bundle = await api('/api/export');
    const text = JSON.stringify(bundle, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `membrane-backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`已导出 ${bundle.memories.length} 条记忆 / ${bundle.relations.length} 条关系`);
  } catch (e) { toast(e.message, true); }
});

// ---- 工具 ----
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---- Ops / Admin ----
function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const min = Math.floor(s / 60);
  if (min < 60) return min + 'm ' + (s % 60) + 's';
  return Math.floor(min / 60) + 'h ' + (min % 60) + 'm';
}

async function loadOps() {
  await Promise.all([loadDiagnostics(), loadLogs()]);
}
async function loadDiagnostics() {
  const box = $('ops-diag');
  try {
    const d = await api('/api/admin/diagnostics');
    const caps = d.capabilities || {};
    box.innerHTML = `
      <div class="diag-cell"><span class="diag-k">VERSION</span><b>${esc(d.version)}</b></div>
      <div class="diag-cell"><span class="diag-k">UPTIME</span><b>${fmtDuration(d.uptimeMs)}</b></div>
      <div class="diag-cell"><span class="diag-k">NODE</span><b>${esc(d.node)}</b></div>
      <div class="diag-cell"><span class="diag-k">PLATFORM</span><b>${esc(d.platform)}</b></div>
      <div class="diag-cell"><span class="diag-k">SCHEMA</span><b>v${d.db?.schemaVersion ?? '—'}</b></div>
      <div class="diag-cell"><span class="diag-k">DB SIZE</span><b>${fmtBytes(d.db?.bytes)}</b></div>
      <div class="diag-cell"><span class="diag-k">MEMORIES</span><b>${d.stats?.total ?? '—'} <small>${d.stats?.current ?? '—'} active</small></b></div>
      <div class="diag-cell"><span class="diag-k">GRAPH</span><b>${d.stats?.entities ?? '—'} entities / ${d.stats?.relations ?? '—'} edges</b></div>
      <div class="diag-cell"><span class="diag-k">LLM</span><b>${caps.llmConfigured ? esc(caps.extractionModel || 'on') : 'off (pure FTS)'}</b></div>
      <div class="diag-cell"><span class="diag-k">EMBEDDING</span><b>${caps.embeddingConfigured ? esc(caps.embeddingModel || 'on') : 'off'}</b></div>
      <div class="diag-cell"><span class="diag-k">BIND</span><b>${esc(d.security?.host || '—')}:${esc(d.security?.port ?? '—')}</b></div>
      <div class="diag-cell"><span class="diag-k">AUTH</span><b>${d.security?.tokenConfigured ? 'Bearer token on' : 'local only'}</b></div>
      <div class="diag-cell wide"><span class="diag-k">DB PATH</span><b class="mono">${esc(d.db?.path || '—')}</b></div>
      <div class="diag-cell wide"><span class="diag-k">LOG FILE</span><b class="mono">${esc(d.logging?.path || 'memory only')}</b>${d.logging?.fileError ? ` <span class="err">${esc(d.logging.fileError)}</span>` : ''}</div>`;
  } catch (e) { box.innerHTML = `<div class="empty err">${esc(e.message)}</div>`; }
}

async function loadLogs() {
  const tbody = document.querySelector('#log-table tbody');
  const level = $('log-level').value;
  const limit = Math.max(1, Math.min(500, Number($('log-limit').value) || 100));
  const q = new URLSearchParams({ limit: String(limit) });
  if (level) q.set('level', level);
  tbody.innerHTML = '<tr><td colspan="8" class="empty">loading…</td></tr>';
  try {
    const r = await api('/api/admin/logs?' + q.toString());
    if (!r.entries.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">no log entries yet</td></tr>';
      $('log-meta').textContent = r.logging?.path ? `log file: ${r.logging.path}` : 'memory-only logging';
      return;
    }
    tbody.innerHTML = r.entries.slice().reverse().map(e => {
      const time = new Date(e.ts).toLocaleTimeString();
      const detail = Object.entries(e)
        .filter(([k]) => !['ts', 'level', 'event', 'method', 'path', 'status', 'ms'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ');
      const levelClass = e.level === 'error' ? 'del' : e.level === 'warn' ? 'sup' : 'active';
      return `<tr>
        <td class="mono">${esc(time)}</td>
        <td><span class="badge ${levelClass}">${esc(e.level)}</span></td>
        <td class="mono">${esc(e.event)}</td>
        <td class="mono">${esc(e.method || '—')}</td>
        <td class="mono content-cell" title="${esc(e.path || '')}">${esc(e.path || '—')}</td>
        <td class="mono">${esc(e.status ?? '—')}</td>
        <td class="mono">${esc(e.ms ?? '—')}</td>
        <td class="muted" title="${esc(detail)}">${esc(detail)}</td>
      </tr>`;
    }).join('');
    const lg = r.logging || {};
    $('log-meta').textContent = `showing ${r.count} · buffered ${lg.buffered ?? '—'} · written ${lg.written ?? '—'}` +
      (lg.fileError ? ` · file error: ${lg.fileError}` : '') + (lg.path ? ` · ${lg.path}` : ' · memory only');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty err">${esc(e.message)}</td></tr>`;
  }
}

async function runIsolationProbe() {
  const box = $('ops-isolation');
  box.innerHTML = '<div class="empty">running in-memory probe…</div>';
  try {
    const r = await api('/api/admin/isolation-check');
    const shared = r.sharedNamespace;
    const sep = r.separatedNamespaces;
    box.innerHTML = `
      <div class="iso-row ${shared.mixed ? 'iso-warn' : 'iso-ok'}">
        <div class="iso-head">同一 namespace（默认用法）</div>
        <div>命中 ${shared.hits} 条，涉及任务：${shared.tasks.map(t => `<span class="tag">${esc(t)}</span>`).join(' ') || '—'}</div>
        <div class="iso-verdict">${shared.mixed ? '⚠️ 两个任务的记忆会互相召回 → 有串扰风险' : '未发生串扰'}</div>
      </div>
      <div class="iso-row ${sep.pass ? 'iso-ok' : 'iso-warn'}">
        <div class="iso-head">每个任务独立 namespace</div>
        <div>任务A 命中 ${sep.taskA.hits} 条（${esc(sep.taskA.tasks.join(', ') || '—')}）；任务B 命中 ${sep.taskB.hits} 条（${esc(sep.taskB.tasks.join(', ') || '—')}）</div>
        <div class="iso-verdict">${sep.pass ? '✅ 串扰 0 条（隔离成立）' : `❌ 串扰 ${sep.leakage} 条`}</div>
      </div>
      <div class="hint">${esc(r.note)}</div>`;
  } catch (e) { box.innerHTML = `<div class="empty err">${esc(e.message)}</div>`; }
}

$('btn-log-refresh').addEventListener('click', loadLogs);
$('log-level').addEventListener('change', loadLogs);
$('log-limit').addEventListener('keydown', e => { if (e.key === 'Enter') loadLogs(); });
$('log-auto').addEventListener('change', e => {
  if (state.logTimer) { clearInterval(state.logTimer); state.logTimer = null; }
  if (e.target.checked) state.logTimer = setInterval(loadLogs, 5000);
});
$('btn-isolation').addEventListener('click', runIsolationProbe);

// ---- boot ----
applyMode(state.mode);
const initialView = location.hash.slice(1);
const initialBtn = initialView ? document.querySelector(`.nav-item[data-view="${initialView}"]`) : null;
if (initialBtn) initialBtn.click();
else loadStats();
