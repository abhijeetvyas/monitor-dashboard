'use strict';
/* global Chart */

// ---------------------------------------------------------------------------
// Formatting (decimal GB / KB to match Coolify's units)
// ---------------------------------------------------------------------------
const GB = 1e9;
const num = (v) => (typeof v === 'number' ? v : parseFloat(v) || 0);
const fmtGB = (b) => (b / GB).toFixed(b >= 10 * GB ? 1 : 2) + ' GB';
const fmtBps = (v) =>
  v >= 1e6 ? (v / 1e6).toFixed(1) + ' MB/s'
  : v >= 1e5 ? (v / 1e3).toFixed(0) + ' KB/s'
  : v >= 1e3 ? (v / 1e3).toFixed(1) + ' KB/s'
  : v.toFixed(0) + ' B/s';
const fmtPct = (v) => (Math.round(v * 10) / 10) + '%';

// Round a chart's top gridline up to a tidy value (Coolify-style auto scale).
function niceCeil(v) {
  if (!(v > 0)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / e;
  for (const s of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (n <= s) return s * e;
  return 10 * e;
}

const $ = (id) => document.getElementById(id);
const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };

// ---------------------------------------------------------------------------
// Chart helpers
// ---------------------------------------------------------------------------
const chartRegistry = new Map();

// Chart.js throws "Canvas is already in use" if a live chart is attached to a
// canvas: Chart.getChart() finds any chart (even one created out-of-band),
// so destroy both it and anything stale in our own registry before drawing.
function drawChart(canvasId, config) {
  const canvas = $(canvasId);
  if (!canvas || typeof Chart === 'undefined') return;
  let existing = null;
  try { existing = Chart.getChart(canvas); } catch (_) { /* detached canvas */ }
  if (existing) { try { existing.destroy(); } catch (_) {} }
  const reg = chartRegistry.get(canvasId);
  if (reg && reg !== existing) { try { reg.destroy(); } catch (_) {} }
  chartRegistry.set(canvasId, new Chart(canvas, config));
}

if (typeof Chart !== 'undefined') {
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 11;
  Chart.defaults.color = '#8e8e96';
  Chart.defaults.animation = false;
}

const TOOLTIP = {
  backgroundColor: '#17171b',
  borderColor: 'rgba(255,255,255,.1)',
  borderWidth: 1,
  titleColor: '#f4f4f5',
  bodyColor: '#c9c9cf',
  padding: 10,
  boxWidth: 8,
  boxHeight: 8,
  usePointStyle: true,
};

// Line-chart config with a dynamically scaled Y axis: the top gridline sits at
// a tidy value just above the data peak instead of a fixed 0–100 range, so a
// 5% CPU line is visible rather than flat against the floor.
function lineCfg(labels, datasets, yFmt) {
  const maxV = Math.max(
    0,
    ...datasets.flatMap((d) => d.data.filter((v) => typeof v === 'number' && !Number.isNaN(v)))
  );
  return {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: TOOLTIP,
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: { maxTicksLimit: 8, maxRotation: 0, autoSkip: true, padding: 6 },
        },
        y: {
          beginAtZero: true,
          suggestedMax: niceCeil(maxV * 1.15),
          border: { display: false },
          grid: { color: 'rgba(255,255,255,.045)' },
          ticks: { maxTicksLimit: 5, padding: 8, callback: yFmt },
        },
      },
      elements: {
        point: { radius: 0, hitRadius: 10, hoverRadius: 3 },
        line: { borderWidth: 1.8, tension: 0.3 },
      },
    },
  };
}

// Tiny inline-SVG sparkline for the overview cards.
function sparkSVG(points, color) {
  const pts = points.filter((p) => typeof p[1] === 'number');
  if (pts.length < 2) return '';
  const vals = pts.map((p) => p[1]);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const W = 100, H = 28, P = 2;
  const xy = pts.map((p, i) => [
    (i / (pts.length - 1)) * (W - 2 * P) + P,
    (H - P) - ((p[1] - min) / span) * (H - 2 * P),
  ]);
  const line = xy.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const area = `${xy[0][0].toFixed(1)},${H - P} L` + line.replace(/ /g, ' L') + ` L${xy[xy.length - 1][0].toFixed(1)},${H - P} Z`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="M${area}" fill="${color}" opacity=".13"/>
    <polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

const timeLabel = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// ---------------------------------------------------------------------------
// Status / panel gating
// ---------------------------------------------------------------------------
let statusCache = null;
let lastGoodMetrics = null;
let lastGoodApps = null;
const sourceState = { coolify: 'off', cost: 'off', cf: 'off' };

async function loadStatus() {
  try {
    statusCache = await (await fetch('/api/status')).json();
  } catch (e) {
    statusCache = { panels: {}, freeTier: { memoryLimitBytes: 24 * GB, diskLimitBytes: 200 * GB } };
  }
  sourceState.cf = statusCache.panels.cloudflare ? 'ok' : 'off';
  $('src-cf-note').textContent = statusCache.panels.cloudflare ? '' : '(not configured)';
  if (!statusCache.panels.cloudflare) setText('src-cf-note', '(not configured)');
}

// ---------------------------------------------------------------------------
// Overview stat cards — bars use the metric's real denominator:
//   CPU % of host capacity, Memory used / installed RAM,
//   Disk used / boot-volume size (NOT the 200 GB billing pool — that share is
//   only a footnote), load1 / vCPUs.
// ---------------------------------------------------------------------------
function barColor(pct) {
  return pct > 80 ? 'var(--red)' : pct > 55 ? 'var(--orange)' : 'var(--green)';
}

function setStat(name, { value, unit, pct, color, spark, note }) {
  setText(`stat-${name}-val`, value);
  const val = $(`stat-${name}-val`);
  if (unit) val.insertAdjacentHTML('beforeend', `<small>${unit}</small>`);
  if (pct !== undefined) {
    const bar = $(`stat-${name}-bar`);
    bar.style.width = Math.max(1, Math.min(pct, 100)) + '%';
    bar.style.background = color || barColor(pct);
  }
  if (spark !== undefined) $(`stat-${name}-spark`).innerHTML = spark || '';
  setText(`stat-${name}-note`, note || '');
}

function renderStats(m) {
  const cur = m.current || {};
  const S = m.series || {};
  const lastOf = (s) => (Array.isArray(s) && s.length ? s[s.length - 1][1] : null);
  const last3h = (s) => (Array.isArray(s) ? s.filter((p) => p[0] >= Date.now() - 3 * 3600e3) : []);
  const stats = (s) => {
    const v = (Array.isArray(s) ? s : []).map((p) => p[1]).filter((v) => typeof v === 'number');
    if (!v.length) return null;
    return { avg: v.reduce((a, b) => a + b, 0) / v.length, min: Math.min(...v), max: Math.max(...v), last: v[v.length - 1] };
  };

  // CPU
  const cpu = cur.cpu_percent != null ? num(cur.cpu_percent) : null;
  const cpuS = stats(S.cpu_percent);
  if (cpu !== null) {
    setStat('cpu', {
      value: cpu.toFixed(1), unit: '%', pct: cpu,
      spark: sparkSVG(last3h(S.cpu_percent), '#4f8ef7'),
      note: cpuS ? `24h avg ${fmtPct(cpuS.avg)} · peak ${fmtPct(cpuS.max)}` : '',
    });
    setText('lg-cpu', fmtPct(cpu));
  }

  // Memory — used / actually installed RAM (matches Coolify's 6%)
  const memUsed = cur.memory_used_bytes != null ? num(cur.memory_used_bytes) : null;
  const memTotal = cur.memory_total_bytes ? num(cur.memory_total_bytes) : 0;
  if (memUsed !== null) {
    const pctOf = memTotal ? (memUsed / memTotal) * 100 : 0;
    setStat('mem', {
      value: fmtGB(memUsed), unit: '', pct: pctOf,
      color: barColor(pctOf),
      spark: sparkSVG(last3h(S.memory_used_bytes), '#a78bfa'),
      note: `of ${fmtGB(memTotal)} · ${(Math.round(pctOf * 10) / 10).toFixed(1)}% of host RAM`,
    });
    setText('lg-mem', fmtGB(memUsed));
  }

  // Disk — bar % is used / boot-volume size (same math as Coolify); the 200 GB
  // free-tier pool share is a footnote only, so numbers stay honest.
  const diskUsed = cur.disk_used_bytes != null ? num(cur.disk_used_bytes) : null;
  const diskTotal = num(cur.disk_total_bytes) || 0;
  const diskPct = cur.disk_used_percent != null ? num(cur.disk_used_percent) : diskTotal ? (diskUsed / diskTotal) * 100 : null;
  if (diskPct !== null && diskUsed !== null) {
    setStat('disk', {
      value: fmtGB(diskUsed), unit: 'used', pct: diskPct,
      color: barColor(diskPct),
      spark: sparkSVG(last3h(S.disk_used_percent), '#ef4444'),
      note: `of ${fmtGB(diskTotal)} volume · ${(diskPct).toFixed(1)}% full · ${(diskUsed / (200 * GB) * 100).toFixed(1)}% of 200 GB pool`,
    });
    setText('lg-disk', fmtPct(diskPct));
  }

  // Network — Sentinel already reports bytes/sec (rx/tx)
  const rx = cur.network_rx_bytes_per_sec != null ? num(cur.network_rx_bytes_per_sec) : null;
  const tx = cur.network_tx_bytes_per_sec != null ? num(cur.network_tx_bytes_per_sec) : null;
  if (rx !== null && tx !== null) {
    let peak = 0;
    const srx = S.network_rx_bytes_per_sec || [], stx = S.network_tx_bytes_per_sec || [];
    for (let i = 0; i < Math.min(srx.length, stx.length); i++) peak = Math.max(peak, num(srx[i][1]) + num(stx[i][1]));
    const sparkPts = last3h(srx).map((p, i) => [p[0], p[1] + (stx[i] ? stx[i][1] : 0)]);
    setStat('net', {
      value: fmtBps(rx + tx), unit: 'now',
      spark: sparkSVG(sparkPts, '#10b981'),
      note: `rx ${fmtBps(rx)} · tx ${fmtBps(tx)} · 24h peak ${fmtBps(peak)}`,
    });
    setText('lg-rx', fmtBps(rx));
    setText('lg-tx', fmtBps(tx));
  }

  // Load — bar = load1 / vCPUs
  const load1 = cur.load1 != null ? num(cur.load1) : null;
  if (load1 !== null) {
    const VCPU = 4;
    const pct = (load1 / VCPU) * 100;
    const loadS = stats(S.load1);
    setStat('load', {
      value: load1.toFixed(2), pct, color: barColor(pct),
      spark: sparkSVG(last3h(S.load1), '#14b8a6'),
      note: `${Math.round(pct)}% of ${VCPU} vCPU${loadS ? ` · 24h peak ${loadS.max.toFixed(2)}` : ''}`,
    });
    setText('lg-load', load1.toFixed(2));
  }
}

// ---------------------------------------------------------------------------
// Charts — same Sentinel series Coolify renders, 24h window
// ---------------------------------------------------------------------------
function renderCharts(m) {
  const S = m.series || {};
  const labels = (pts) => (pts || []).map((p) => timeLabel(p[0]));
  const vals = (pts) => (pts || []).map((p) => p[1]);
  const hideIfEmpty = (cardId, s) => {
    const c = $(cardId);
    if (c) c.style.display = Array.isArray(s) && s.length > 1 ? '' : 'none';
  };

  hideIfEmpty('card-cpu', S.cpu_percent);
  if (S.cpu_percent && S.cpu_percent.length > 1) {
    drawChart('chart-cpu', lineCfg(labels(S.cpu_percent), [
      { label: 'CPU %', data: vals(S.cpu_percent), borderColor: '#4f8ef7', backgroundColor: 'rgba(79,142,247,.09)', fill: true },
    ], (v) => fmtPct(v)));
  }

  hideIfEmpty('card-mem', S.memory_used_bytes);
  if (S.memory_used_bytes && S.memory_used_bytes.length > 1) {
    drawChart('chart-mem', lineCfg(labels(S.memory_used_bytes), [
      { label: 'Memory used', data: vals(S.memory_used_bytes), borderColor: '#a78bfa', backgroundColor: 'rgba(167,139,250,.09)', fill: true },
    ], (v) => fmtGB(v)));
  }

  hideIfEmpty('card-net', S.network_rx_bytes_per_sec);
  if (S.network_rx_bytes_per_sec && S.network_rx_bytes_per_sec.length > 1) {
    drawChart('chart-net', lineCfg(labels(S.network_rx_bytes_per_sec), [
      { label: 'RX', data: vals(S.network_rx_bytes_per_sec), borderColor: '#10b981' },
      { label: 'TX', data: vals(S.network_tx_bytes_per_sec) || [], borderColor: '#f59e0b' },
    ], (v) => fmtBps(v)));
  }

  hideIfEmpty('card-load', S.load1);
  if (S.load1 && S.load1.length > 1) {
    drawChart('chart-load', lineCfg(labels(S.load1), [
      { label: 'load1', data: vals(S.load1), borderColor: '#14b8a6', backgroundColor: 'rgba(20,184,166,.09)', fill: true },
    ], (v) => v.toFixed(1)));
  }

  hideIfEmpty('card-disk', S.disk_used_percent);
  if (S.disk_used_percent && S.disk_used_percent.length > 1) {
    drawChart('chart-disk', lineCfg(labels(S.disk_used_percent), [
      { label: 'Disk used %', data: vals(S.disk_used_percent), borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,.08)', fill: true },
    ], (v) => fmtPct(v)));
  }
}

// ---------------------------------------------------------------------------
// Applications table — real status per Coolify API
// ---------------------------------------------------------------------------
function statusPill(status) {
  const s = String(status || 'unknown').toLowerCase();
  const base = s.split(':')[0];
  const cls = base === 'running' ? 'ok' : (base === 'restarting' || base === 'starting' || base === 'queued') ? 'warn' : 'bad';
  return `<span class="pill ${cls}">${base}</span>`;
}

function renderApps(applications) {
  const tbody = document.querySelector('#apps-table tbody');
  const n = (applications || []).length;
  const running = (applications || []).filter((a) => String(a.status).startsWith('running')).length;
  $('lg-apps').innerHTML = `<b>${running}/${n}</b>&nbsp;running`;
  if (!n) {
    tbody.innerHTML = `<tr><td colspan="3"><div class="warn-inline">Coolify returned no applications.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = (applications || []).map((a) => {
    const dom = String(a.fqdn || '').split(',')[0];
    return `<tr>
      <td><b>${a.name}</b></td>
      <td>${dom ? `<a class="dom" href="https://${dom}" target="_blank" rel="noopener">${dom}</a>` : '<span class="dom">—</span>'}</td>
      <td style="text-align:right">${statusPill(a.status)}</td>
    </tr>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------
async function loadCoolify() {
  try {
    const r = await fetch('/api/coolify/resources');
    if (!r.ok) {
      let err = 'HTTP ' + r.status;
      try { err = (await r.json()).error || err; } catch (_) {}
      throw new Error(err);
    }
    const { metrics, applications } = pickFirstServer(await r.json());
    if (metrics && metrics.current) { lastGoodMetrics = metrics; renderStats(metrics); renderCharts(metrics); }
    if (applications) { lastGoodApps = applications; renderApps(applications); }
    sourceState.coolify = 'ok';
  } catch (e) {
    sourceState.coolify = 'err';
    // Keep last good data on screen; surface the failure in the apps legend.
    if (lastGoodMetrics && !$('stat-cpu-val').textContent.length) { renderStats(lastGoodMetrics); }
    $('lg-apps').innerHTML = '';
    document.querySelector('#apps-table tbody').innerHTML =
      `<tr><td colspan="3"><div class="warn-inline">Coolify unreachable: ${e.message}</div></td></tr>`;
  }
}

// Server payload: { servers: [ { server, metrics: {current, series}, resources } ], applications }
function pickFirstServer(body) {
  const srv = (body.servers && body.servers[0]) || {};
  const metricsRaw = srv.metrics || {};
  const metrics = metricsRaw.current ? metricsRaw : null;
  return { metrics, applications: body.applications };
}

async function loadCost() {
  const card = $('card-cost');
  if (!statusCache.panels.oci) { card.style.display = 'none'; sourceState.cost = 'off'; return; }
  try {
    const r = await fetch('/api/oci/cost');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const sym = data.currency === 'USD' ? '$' : data.currency === 'EUR' ? '€' : data.currency + ' ';
    const days = data.days || [];
    const total = num(data.total);
    $('cost-kpi').innerHTML = `${sym}${total.toFixed(2)} <small>month-to-date</small>`;
    setText('lg-cost', sym + total.toFixed(2));
    const dayOfMonth = days.length ? Number(days[days.length - 1].date.slice(8)) : 0;
    const proj = total > 0 && dayOfMonth ? (total / dayOfMonth) * 30 : 0;
    $('cost-note').textContent = days.length
      ? `${days.length} day${days.length > 1 ? 's' : ''} tracked${total > 0 ? ` · projected ${sym}${proj.toFixed(2)} by month end` : ' · all clear'}`
      : '';
    if (days.length) {
      drawChart('chart-cost', {
        type: 'bar',
        data: {
          labels: days.map((d) => d.date.slice(8) + '/' + d.date.slice(5, 7)),
          datasets: [{
            label: 'Daily cost', data: days.map((d) => num(d.cost)),
            backgroundColor: 'rgba(79,142,247,.75)', hoverBackgroundColor: '#4f8ef7',
            borderRadius: 3, maxBarThickness: 26,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: TOOLTIP },
          scales: {
            x: { grid: { display: false }, border: { display: false }, ticks: { maxRotation: 0, padding: 4 } },
            y: { beginAtZero: true, suggestedMax: niceCeil(Math.max(0.5, total)), border: { display: false }, grid: { color: 'rgba(255,255,255,.045)' }, ticks: { maxTicksLimit: 4, callback: (v) => sym + v } },
          },
        },
      });
    }
    card.style.display = '';
    $('src-cost').className = 'on';
    sourceState.cost = 'ok';
  } catch (e) {
    card.style.display = 'none';
    $('src-cost').className = 'off';
    sourceState.cost = 'err';
  }
}

// ---------------------------------------------------------------------------
// Live indicator + refresh loop (single-flight: never overlap cycles)
// ---------------------------------------------------------------------------
function renderLive() {
  const el = $('live');
  const t = new Date().toLocaleTimeString();
  if (sourceState.coolify === 'err' && sourceState.cost === 'err') {
    el.className = 'live down'; setText('live-text', 'offline · ' + t);
  } else if (sourceState.coolify === 'err' || sourceState.cost === 'err') {
    el.className = 'live degraded'; setText('live-text', 'partial · ' + t);
  } else {
    el.className = 'live ok'; setText('live-text', 'live · ' + t);
  }
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    if (!statusCache) await loadStatus();
    await Promise.allSettled([loadCoolify(), loadCost()]);
    renderLive();
  } finally {
    refreshing = false;
  }
}

(async () => {
  await loadStatus();
  await refresh();
  setInterval(refresh, 60_000);
})();
