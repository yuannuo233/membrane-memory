// Membrane Console — 零依赖前端（原生 fetch + DOM），与后端 REST 通信。
const $ = (id) => document.getElementById(id);
const API = '';

const KIND_COLORS = { fact: '#7aa2ff', episode: '#b18cff', preference: '#5ee6c0', procedure: '#f5c26b' };
const KINDS = ['fact', 'episode', 'preference', 'procedure'];

async function api(path, opts = {}) {
  const r = await fetch(API + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// ---- 视图切换 ----
const TITLES = { overview: 'Overview', ingest: 'Ingest Pipeline', recall: 'Hybrid Recall', ledger: 'Memory Ledger', audit: 'Audit Trail' };
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    const v = btn.dataset.view;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.view').forEach(s => s.classList.add('hidden'));
    $('view-' + v).classList.remove('hidden');
    $('view-title').textContent = TITLES[v];
    if (v === 'overview') loadStats();
    if (v === 'ledger') loadLedger();
  });
});

// ---- Overview ----
async function loadStats() {
  try {
    const h = await api('/api/health');
    $('health-chip').textContent = '● healthy';
    $('db-path').textContent = h.db || 'local';
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
    tags: $('in-tags').value.split(',').map(s => s.trim()).filter(Boolean),
    confidence: Number($('in-conf').value),
    pin: $('in-pin').checked,
  };
  const box = $('ingest-result');
  box.classList.remove('hidden');
  if (!body.content) { box.innerHTML = '<span class="err">content required</span>'; return; }
  try {
    const r = await api('/api/memories', { method: 'POST', body });
    const sup = (r.superseded || []).map(m => `<div>↳ superseded: ${m.id} (${m.content})</div>`).join('');
    box.innerHTML = `<div class="status-tag">${r.status.toUpperCase()}</div><div>${r.note}</div><div style="margin-top:6px;color:var(--violet)">id: ${r.memory.id}</div>${sup}`;
  } catch (e) { box.innerHTML = `<span class="err">${e.message}</span>`; }
});

// ---- Recall ----
$('rc-asof-toggle').addEventListener('change', e => $('rc-asof-wrap').classList.toggle('hidden', !e.target.checked));
async function doRecall() {
  const body = { query: $('rc-query').value.trim(), limit: Number($('rc-limit').value) || 8 };
  if ($('rc-kind').value) body.kind = $('rc-kind').value;
  if ($('rc-asof-toggle').checked && $('rc-asof').value) body.asOf = Number($('rc-asof').value);
  const box = $('recall-results');
  if (!body.query) { box.innerHTML = '<div class="empty">enter a query to begin</div>'; return; }
  box.innerHTML = '<div class="empty">running hybrid retrieval…</div>';
  try {
    const r = await api('/api/recall', { method: 'POST', body });
    if (!r.results.length) { box.innerHTML = '<div class="empty">no matching memories</div>'; return; }
    box.innerHTML = r.results.map((h, i) => {
      const b = h.breakdown;
      return `<div class="hit">
        <div class="hit-top"><span class="hit-score">#${i + 1} · ${h.score.toFixed(4)}</span><span class="hit-kind">${h.memory.kind}</span></div>
        <div class="hit-content">${esc(h.memory.content)}</div>
        <div class="hit-why">why: ${esc(h.why)}</div>
        <div class="breakdown">
          <span class="bd-item">RRF<sub>text</sub> <b>${b.rrfText.toFixed(4)}</b></span>
          <span class="bd-item">rank <b>${b.textRank ?? '—'}</b></span>
          <span class="bd-item">freshness <b>${b.freshness.toFixed(4)}</b></span>
          <span class="bd-item">age <b>${b.ageDays}d</b></span>
          <span class="bd-item">half-life <b>${b.halfLifeDays}d</b></span>
          <span class="bd-item">confidence <b>${b.confidence}</b></span>
          <span class="bd-item">w(text/vec/time/conf) <b>${b.weights.text}/${b.weights.vec}/${b.weights.time}/${b.weights.conf}</b></span>
        </div></div>`;
    }).join('');
  } catch (e) { box.innerHTML = `<div class="empty err">${e.message}</div>`; }
}
$('btn-recall').addEventListener('click', doRecall);
$('rc-query').addEventListener('keydown', e => { if (e.key === 'Enter') doRecall(); });

// ---- Ledger ----
async function loadLedger() {
  const all = $('ld-all').checked;
  const rows = await api('/api/memories?validity=' + (all ? 'all' : 'current') + '&limit=200');
  const tbody = document.querySelector('#ledger-table tbody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">no records</td></tr>'; return; }
  tbody.innerHTML = rows.map(m => {
    let status = '<span class="badge active">ACTIVE</span>';
    if (m.deleted) status = '<span class="badge del">TOMBSTONE</span>';
    else if (m.validTo) status = '<span class="badge sup">SUPERSEDED</span>';
    const date = new Date(m.validFrom).toISOString().replace('T', ' ').slice(0, 16);
    return `<tr><td>${m.id.slice(0, 12)}…</td><td>${m.kind}</td><td>${esc(m.content)}</td><td>${m.subject || '—'}</td><td>${m.confidence}</td><td>${date}</td><td>${status}</td></tr>`;
  }).join('');
}
$('ld-all').addEventListener('change', loadLedger);

// ---- Audit ----
$('btn-audit').addEventListener('click', async () => {
  const id = $('au-id').value.trim();
  const box = $('audit-results');
  if (!id) { box.innerHTML = '<div class="empty">enter a memory id</div>'; return; }
  try {
    const entries = await api(`/api/memories/${encodeURIComponent(id)}/history`);
    if (!entries.length) { box.innerHTML = '<div class="empty">no audit entries</div>'; return; }
    box.innerHTML = '<div class="timeline">' + entries.map(e => {
      const time = new Date(e.at).toISOString().replace('T', ' ').slice(0, 19);
      return `<div class="tl-item"><span class="tl-op">${e.op.toUpperCase()}</span><span class="tl-time">${time} · seq ${e.seq}</span><div class="tl-detail">${esc(e.detail || '')}</div></div>`;
    }).join('') + '</div>';
  } catch (e) { box.innerHTML = `<div class="empty err">${e.message}</div>`; }
});

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---- boot ----
loadStats();
