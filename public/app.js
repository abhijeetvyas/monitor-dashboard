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

// Round a chart's top gridline up to a tidy value above the data peak.
function niceCeil(v) {
  if (!(v > 0)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / e;
  for (const s of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (n <= s) return s * e;
  return 10 * e;
}

// ---------------------------------------------------------------------------
// Limits & thresholds. "Max allowed" per metric; series turns red at 80%.
// ---------------------------------------------------------------------------
const APP_VCPU = 4;                          // OCI Always Free: 4 OCPU / 24 GB
const RAM_BUDGET = 24 * GB;
const POOL_BUDGET = 200 * GB;                // block storage pool (billing view)
const EGRESS_MONTH = 10 * 1e12;              // free egress allowance, 10 TB/month
const EGRESS_SUSTAINED = EGRESS_MONTH / (30 * 86400); // ≈ 3.9 MB/s sustained
const WARN = 0.8;                            // alert floor: 80% of the limit
const THRESH = {
  cpu: WARN * 100,                      // % of host capacity
  memBytes: WARN * RAM_BUDGET,          // 19.2 GB of the 24 GB budget
  disk: WARN * 100,                     // % of boot volume
  load: WARN * APP_VCPU,                // 3.2
  net: WARN * EGRESS_SUSTAINED,         // ≈ 3.1 MB/s sustained
};

const $ = (id) => document.getElementById(id);
const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };

// ---------------------------------------------------------------------------
// Chart plumbing
// ---------------------------------------------------------------------------
const chartRegistry = new Map();

// Chart.js throws "Canvas is already in use" if a live chart is attached to a
// canvas: Chart.getChart() finds any chart, so destroy both it and anything
// stale in our own registry before drawing.
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
  backgroundColor: '#1a1a1d',
  borderColor: 'rgba(255,255,255,.12)',
  borderWidth: 1,
  titleColor: '#f4f4f5',
  bodyColor: '#c9c9cf',
  padding: 10,
  boxWidth: 8,
  boxHeight: 8,
  usePointStyle: true,
};

// Vertical gradient under a line, Coolify-style: colour fading to transparent
// towards the X axis. Grey by default, red when the series is over threshold.
function gradientFill(chart, rgb, topOpacity) {
  const area = chart.chartArea;
  if (!area) return `rgba(${rgb},0.08)`;
  const g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
  g.addColorStop(0, `rgba(${rgb},${topOpacity})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  return g;
}

// Line-chart config: dynamically scaled Y axis whose top sits above both the
// data peak and the threshold guide; optional dashed threshold line; tooltips
// with full absolute values via the labelFns option.
function lineCfg(tsArr, datasets, { yFmt, limit, labelFns, extraBody } = {}) {
  const maxData = Math.max(
    0,
    ...datasets.flatMap((d) => d.data.filter((v) => typeof v === 'number' && !Number.isNaN(v)))
  );
  const datasetsForChart = datasets.slice();
  // Threshold guide: draw the dashed limit line only when it stays within view
  // (<= 4x the data peak) — otherwise it squashes the data flat; the red
  // over-threshold colouring and the legend still carry the alert.
  const dataTop = maxData * 1.15 || 1;
  if (limit > 0 && limit <= dataTop * 4) {
    datasetsForChart.push({
      data: tsArr.map(() => limit),
      borderColor: 'rgba(239,68,68,.32)',
      borderDash: [5, 5],
      borderWidth: 1,
      pointRadius: 0,
      fill: false,
      label: 'threshold',
    });
  }
  const fullTs = (i) => (tsArr[i] != null ? new Date(tsArr[i]) : null);
  return {
    type: 'line',
    data: { labels: tsArr.map((t) => timeLabel(t)), datasets: datasetsForChart },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...TOOLTIP,
          filter: (item) => !item.dataset.label.startsWith('threshold'),
          title: (items) => {
            if (!items.length) return '';
            const d = fullTs(items[0].dataIndex);
            return d ? d.toLocaleString([], { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
          },
          label: (item) => {
            const v = item.parsed.y;
            const ds = item.dataset;
            if (labelFns && labelFns[ds.label]) return ' ' + labelFns[ds.label](v);
            return ` ${ds.label} ${typeof v === 'number' ? v.toFixed(2) : v}`;
          },
          afterBody: extraBody,
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: { maxTicksLimit: 8, maxRotation: 0, autoSkip: true, padding: 6 },
        },
        y: {
          beginAtZero: true,
          suggestedMax: niceCeil(limit > 0 && limit <= maxData * 1.15 * 4 ? Math.max(maxData, limit) : maxData * 1.15),
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
function sparkSVG(points, greyA) {
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
  const area = `M${xy[0][0].toFixed(1)},${H - P} L` + line.replace(/ /g, ' L') + ` L${xy[xy.length - 1][0].toFixed(1)},${H - P} Z`;
  const stroke = greyA ? '#e4e4e7' : '#8e8e96';
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${area}" fill="${stroke}" opacity=".12"/>
    <polyline points="${line}" fill="none" stroke="${stroke}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

const timeLabel = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let statusCache = null;
let lastGoodMetrics = null;
const RANGE_LABELS = { 60: 'hour', 360: '6 hours', 1440: '24 hours', 10080: '7 days', 20160: '14 days' };
let rangeMinutes = 1440;
const sourceState = { coolify: 'off', cost: 'off', cf: 'off' };

async function loadStatus() {
  try {
    statusCache = await (await fetch('/api/status')).json();
  } catch (e) {
    statusCache = { panels: {}, freeTier: { memoryLimitBytes: RAM_BUDGET, diskLimitBytes: POOL_BUDGET } };
  }
  sourceState.cf = statusCache.panels.cloudflare ? 'ok' : 'off';
  setText('src-cf-note', statusCache.panels.cloudflare ? '' : '(not configured)');
}

// ---------------------------------------------------------------------------
// Overview stat cards
// ---------------------------------------------------------------------------
function renderStats(m) {
  const cur = m.current || {};
  const S = m.series || {};
  const lastOf = (key) => (S[key] && S[key].length ? num(S[key][S[key].length - 1][1]) : null);
  const last3h = (key) => (S[key] || []).filter((p) => p[0] >= Date.now() - 3 * 3600e3);
  const stats = (key) => {
    const v = (S[key] || []).map((p) => p[1]).filter((v) => typeof v === 'number');
    if (!v.length) return null;
    return { avg: v.reduce((a, b) => a + b, 0) / v.length, max: Math.max(...v) };
  };
  const rl = RANGE_LABELS[rangeMinutes] || `${rangeMinutes} min`;

  // CPU
  const cpu = cur.cpu_percent != null ? num(cur.cpu_percent) : null;
  const cpuS = stats('cpu_percent');
  if (cpu !== null) {
    setStat('cpu', {
      value: cpu.toFixed(1), unit: '%', pct: cpu, thresh: cpu >= THRESH.cpu,
      spark: sparkSVG(last3h('cpu_percent'), true),
      note: `${rl} avg ${fmtPct(cpuS ? cpuS.avg : cpu)} · peak ${fmtPct(cpuS ? cpuS.max : cpu)} of 100%`,
    });
    setLegend('lg-cpu', fmtPct(cpu), cpu >= THRESH.cpu);
    setText('lg-cpu-lim', '80%');
  }

  // Memory
  const memUsed = cur.memory_used_bytes != null ? num(cur.memory_used_bytes) : null;
  const memTotal = cur.memory_total_bytes ? num(cur.memory_total_bytes) : 0;
  if (memUsed !== null) {
    const pctOf = memTotal ? (memUsed / memTotal) * 100 : 0;
    const over = memUsed >= THRESH.memBytes;
    setStat('mem', {
      value: fmtGB(memUsed), pct: (memUsed / RAM_BUDGET) * 100, thresh: over,
      spark: sparkSVG(last3h('memory_used_bytes'), true),
      note: `${fmtPct(pctOf)} of ${fmtGB(memTotal)} host RAM · budget note: 24 GB free tier`,
    });
    setLegend('lg-mem', fmtGB(memUsed), over);
    setText('lg-mem-lim', fmtGB(THRESH.memBytes));
  }

  // Disk — % is used / boot volume (same math as Coolify)
  const diskUsed = cur.disk_used_bytes != null ? num(cur.disk_used_bytes) : null;
  const diskTotal = num(cur.disk_total_bytes) || 0;
  const diskPct = cur.disk_used_percent != null ? num(cur.disk_used_percent) : diskTotal ? (diskUsed / diskTotal) * 100 : null;
  if (diskPct !== null && diskUsed !== null) {
    setStat('disk', {
      value: fmtGB(diskUsed), unit: 'used', pct: diskPct, thresh: diskPct >= THRESH.disk,
      spark: sparkSVG(last3h('disk_used_percent'), true),
      note: `${fmtPct(diskPct)} of ${fmtGB(diskTotal)} volume · ${fmtGB(POOL_BUDGET - diskUsed)} free · pool share ${fmtPct((diskUsed / POOL_BUDGET) * 100)} of 200 GB`,
    });
    setLegend('lg-disk', fmtPct(diskPct), diskPct >= THRESH.disk);
    setText('lg-disk-lim', '80%');
  }

  // Network — Sentinel already reports bytes/sec (rx/tx)
  const rx = cur.network_rx_bytes_per_sec != null ? num(cur.network_rx_bytes_per_sec) : null;
  const tx = cur.network_tx_bytes_per_sec != null ? num(cur.network_tx_bytes_per_sec) : null;
  if (rx !== null && tx !== null) {
    const nowBps = rx + tx;
    const pctSustained = (nowBps / EGRESS_SUSTAINED) * 100;
    const over = nowBps >= THRESH.net;
    setStat('net', {
      value: fmtBps(nowBps), unit: 'now', pct: pctSustained, thresh: over,
      spark: sparkSVG(last3h('network_rx_bytes_per_sec').map((p, i) => [
        p[0],
        p[1] + (S.network_tx_bytes_per_sec && S.network_tx_bytes_per_sec[i] ? num(S.network_tx_bytes_per_sec[i][1]) : 0),
      ]), true),
      note: `rx ${fmtBps(rx)} · tx ${fmtBps(tx)} · ${fmtPct(pctSustained)} of 3.9 MB/s egress share (10 TB/mo)`,
    });
    setLegend('lg-rx', fmtBps(rx), over);
    setLegend('lg-tx', fmtBps(tx), over);
  }

  // Load — load1 = runnable+uninterruptible tasks, 1.00 = one core fully busy
  const load1 = cur.load1 != null ? num(cur.load1) : null;
  if (load1 !== null) {
    const pct = (load1 / APP_VCPU) * 100;
    const loadS = stats('load1');
    setStat('load', {
      value: load1.toFixed(2), pct, thresh: load1 >= THRESH.load,
      spark: sparkSVG(last3h('load1'), true),
      note: `1.00 = one core busy · ${Math.round(pct)}% of ${APP_VCPU} vCPU${loadS ? ` · ${rl} peak ${loadS.max.toFixed(2)}` : ''}`,
    });
    setLegend('lg-load', load1.toFixed(2), load1 >= THRESH.load);
    setText('lg-load-lim', THRESH.load.toFixed(1));
  }
}

function setStat(name, { value, unit, pct, thresh, spark, note }) {
  const val = $(`stat-${name}-val`);
  setText(`stat-${name}-val`, value);
  val.className = 'stat-value' + (thresh ? ' over' : '');
  if (unit) val.insertAdjacentHTML('beforeend', `<small>${unit}</small>`);
  if (pct !== undefined) {
    const bar = $(`stat-${name}-bar`);
    bar.style.width = Math.max(1, Math.min(pct, 100)) + '%';
    bar.className = thresh ? 'over' : '';
  }
  if (spark !== undefined) {
    const slot = $(`stat-${name}-spark`);
    slot.innerHTML = spark || '';
    const svg = slot.firstElementChild;
    if (svg) svg.setAttribute('class', 'spark' + (thresh ? ' over' : '')); // SVG className is read-only
  }
  const noteEl = $(`stat-${name}-note`);
  setText(`stat-${name}-note`, note || '');
  noteEl.className = 'stat-note' + (thresh ? ' over' : '');
  noteEl.title = note || ''; // hover shows the full, untruncated text
}

function setLegend(id, text, over) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = over ? 'over' : '';
}

// ---------------------------------------------------------------------------
// Charts — one per metric, monochrome lines, threshold guides, absolute tooltips
// ---------------------------------------------------------------------------
function renderCharts(m) {
  const S = m.series || {};
  const cur = m.current || {};
  const memTotal = cur.memory_total_bytes ? num(cur.memory_total_bytes) : 0;
  const diskTotal = num(cur.disk_total_bytes) || 0;
  const line = (label, pts, over) => ({
    label,
    data: pts.map((p) => p[1]),
    borderColor: over ? '#ef4444' : '#e4e4e7',
    backgroundColor: (c) => gradientFill(c.chart, over ? '239,68,68' : '228,228,231', over ? 0.16 : 0.13),
    fill: true,
  });
  const hideIfEmpty = (cardId, s) => {
    const c = $(cardId);
    if (c) c.style.display = Array.isArray(s) && s.length > 1 ? '' : 'none';
  };
  const lineSecondary = (label, pts) => ({ label, data: pts.map((p) => p[1]), borderColor: '#8e8e96', fill: false });

  hideIfEmpty('card-cpu', S.cpu_percent);
  if (S.cpu_percent && S.cpu_percent.length > 1) {
    const over = Math.max(...S.cpu_percent.map((p) => p[1])) >= THRESH.cpu;
    drawChart('chart-cpu', lineCfg(
      S.cpu_percent.map((p) => p[0]),
      [line('CPU %', S.cpu_percent, over)],
      {
        yFmt: (v) => fmtPct(v), limit: THRESH.cpu,
        labelFns: { 'CPU %': (v) => `${fmtPct(v)} of 100% · ${(v / 100 * APP_VCPU).toFixed(2)} of ${APP_VCPU} vCPU` },
      }
    ));
  }

  hideIfEmpty('card-mem', S.memory_used_bytes);
  if (S.memory_used_bytes && S.memory_used_bytes.length > 1) {
    const over = Math.max(...S.memory_used_bytes.map((p) => p[1])) >= THRESH.memBytes;
    drawChart('chart-mem', lineCfg(
      S.memory_used_bytes.map((p) => p[0]),
      [line('RAM', S.memory_used_bytes, over)],
      {
        yFmt: (v) => fmtGB(v), limit: THRESH.memBytes,
        labelFns: { RAM: (v) => `${fmtGB(v)} used${memTotal ? ` of ${fmtGB(memTotal)} (${fmtPct(v / memTotal * 100)})` : ''}` },
      }
    ));
    setText('lg-mem-lim', `${fmtGB(THRESH.memBytes)} · 80% of 24 GB budget`);
  }

  hideIfEmpty('card-net', S.network_rx_bytes_per_sec);
  if (S.network_rx_bytes_per_sec && S.network_rx_bytes_per_sec.length > 1) {
    const peak = Math.max(
      ...S.network_rx_bytes_per_sec.map((p, i) => num(p[1]) + num((S.network_tx_bytes_per_sec || [])[i] ? S.network_tx_bytes_per_sec[i][1] : 0))
    );
    const over = peak >= THRESH.net;
    drawChart('chart-net', lineCfg(
      S.network_rx_bytes_per_sec.map((p) => p[0]),
      [line('RX', S.network_rx_bytes_per_sec, over), lineSecondary('TX', S.network_tx_bytes_per_sec || [])],
      {
        yFmt: (v) => fmtBps(v), limit: THRESH.net,
        labelFns: {
          RX: (v) => `${fmtBps(v)} in · ${(v / EGRESS_SUSTAINED * 100).toFixed(2)}% of egress share`,
          TX: (v) => `${fmtBps(v)} out · ${(v / EGRESS_SUSTAINED * 100).toFixed(2)}% of egress share`,
        },
      }
    ));
  }

  hideIfEmpty('card-load', S.load1);
  if (S.load1 && S.load1.length > 1) {
    const over = Math.max(...S.load1.map((p) => p[1])) >= THRESH.load;
    drawChart('chart-load', lineCfg(
      S.load1.map((p) => p[0]),
      [line('load1', S.load1, over)],
      {
        yFmt: (v) => v.toFixed(1), limit: THRESH.load,
        labelFns: { load1: (v) => `${v.toFixed(2)} · 1.00 = one core busy · ${fmtPct(v / APP_VCPU * 100)} of ${APP_VCPU} vCPU` },
      }
    ));
  }

  hideIfEmpty('card-disk', S.disk_used_percent);
  if (S.disk_used_percent && S.disk_used_percent.length > 1) {
    const over = Math.max(...S.disk_used_percent.map((p) => p[1])) >= THRESH.disk;
    drawChart('chart-disk', lineCfg(
      S.disk_used_percent.map((p) => p[0]),
      [line('used %', S.disk_used_percent, over)],
      {
        yFmt: (v) => fmtPct(v), limit: THRESH.disk,
        labelFns: { 'used %': (v) => `${fmtPct(v)} of ${fmtGB(diskTotal)} · ${fmtGB(v / 100 * diskTotal)} absolute` },
      }
    ));
  }
}

// Absolute-values reference card: every allowance with its current usage.
function renderLimits(m, cost) {
  const cur = m.current || {};
  const rows = [];
  const add = (label, value, small, over) => {
    rows.push(`<div class="lrow"><span class="lk"><i></i>${label}</span>
      <span class="lv${over ? ' over' : ''}">${value}<small>${small || ''}</small></span></div>`);
  };
  const load1 = num(cur.load1);
  const memUsed = num(cur.memory_used_bytes);
  const memTotal = num(cur.memory_total_bytes) || RAM_BUDGET;
  const diskUsed = num(cur.disk_used_bytes);
  const diskTotal = num(cur.disk_total_bytes) || 0;
  const netBps = num(cur.network_rx_bytes_per_sec) + num(cur.network_tx_bytes_per_sec);

  add('vCPU', `${APP_VCPU} cores`, `load1 ${load1.toFixed(2)}`);
  add('RAM — free-tier budget', `${fmtGB(memUsed)} / 24 GB`, fmtPct((memUsed / RAM_BUDGET) * 100), memUsed >= THRESH.memBytes);
  add('RAM — installed', `${fmtGB(memUsed)} / ${fmtGB(memTotal)}`, fmtPct((memUsed / memTotal) * 100));
  add('Disk — boot volume', `${fmtGB(diskUsed)} / ${fmtGB(diskTotal)}`, fmtPct(diskTotal ? (diskUsed / diskTotal) * 100 : 0), diskTotal ? (diskUsed / diskTotal) >= (THRESH.disk / 100) : false);
  add('Disk — 200 GB pool', `${fmtGB(diskUsed)} / 200 GB`, fmtPct((diskUsed / POOL_BUDGET) * 100));
  add('Network — free egress', `10 TB / mo`, `≈ ${fmtBps(EGRESS_SUSTAINED)} sustained · now ${fmtBps(netBps)} (${fmtPct((netBps / EGRESS_SUSTAINED) * 100)})`);
  if (cost) add('Cost — Oracle', `${cost.currency === 'USD' ? '$' : cost.currency === 'EUR' ? '€' : cost.currency + ' '}${num(cost.total).toFixed(2)} MTD`, `${(cost.days || []).length} days tracked`);

  if (!rows.length) {
    $('limits-body').innerHTML = '<div class="warn-inline">Waiting for data (metrics and cost unavailable).</div>';
    return;
  }
  $('limits-body').innerHTML = rows.join('');
}

// ---------------------------------------------------------------------------
// Applications table — real status per Coolify API
// ---------------------------------------------------------------------------
function statusPill(status) {
  const s = String(status || 'unknown').toLowerCase();
  const base = s.split(':')[0];
  const detail = s.split(':')[1] || '';
  const cls = base === 'running' ? (detail === 'healthy' || !detail ? 'ok' : 'warn') : (base === 'restarting' || base === 'starting' || base === 'queued') ? 'warn' : 'bad';
  return `<span class="pill ${cls}" title="${s}">${base}</span>`;
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
      <td title="${a.name}"><b>${a.name}</b></td>
      <td>${dom ? `<a class="dom" href="https://${dom}" target="_blank" rel="noopener" title="https://${dom}">${dom}</a>` : '<span class="dom">—</span>'}</td>
      <td style="text-align:right">${statusPill(a.status)}</td>
    </tr>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------
async function loadCoolify() {
  const appsError = (e) => {
    $('lg-apps').innerHTML = '';
    document.querySelector('#apps-table tbody').innerHTML =
      `<tr><td colspan="3"><div class="warn-inline">Coolify unreachable: ${e.message}</div></td></tr>`;
  };
  try {
    const r = await fetch(`/api/coolify/resources?minutes=${rangeMinutes}`);
    if (!r.ok) {
      let err = 'HTTP ' + r.status;
      try { err = (await r.json()).error || err; } catch (_) {}
      throw new Error(err);
    }
    const body = await r.json();
    const srv = (body.servers && body.servers[0]) || {};
    const metrics = srv.metrics && srv.metrics.current ? srv.metrics : null;
    if (metrics) {
      lastGoodMetrics = metrics;
      try { renderStats(metrics); } catch (e) { console.error('renderStats:', e); }
      try { renderCharts(metrics); } catch (e) { console.error('renderCharts:', e); }
    }
    if (body.applications) {
      try { renderApps(body.applications); } catch (e) { appsError(e); }
    }
    sourceState.coolify = 'ok';
  } catch (e) {
    sourceState.coolify = 'err';
    if (lastGoodMetrics && $('stat-cpu-val').textContent === '–') {
      try { renderStats(lastGoodMetrics); } catch (err) { console.error('renderStats:', err); }
    }
    appsError(e);
  }
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
    const note = days.length
      ? `Oracle Usage API · ${days.length} day${days.length > 1 ? 's' : ''} tracked${total > 0 ? ` · projected ${sym}${proj.toFixed(2)} by month end` : ' · all clear (billing lag possible)'}`
      : '';
    setText('cost-note', note);
    $('cost-note').title = days.map((d) => `${d.date}: ${sym}${num(d.cost).toFixed(2)}`).join('\n');
    if (days.length) {
      drawChart('chart-cost', {
        type: 'bar',
        data: {
          labels: days.map((d) => d.date.slice(8) + '/' + d.date.slice(5, 7)),
          datasets: [{
            label: 'Daily cost', data: days.map((d) => num(d.cost)),
            backgroundColor: 'rgba(228,228,231,.6)', hoverBackgroundColor: '#f4f4f5',
            borderRadius: 3, maxBarThickness: 26,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              ...TOOLTIP,
              label: (item) => ` ${sym}${num(item.parsed.y).toFixed(2)} on ${data.days[item.dataIndex].date}`,
            },
          },
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
    return data;
  } catch (e) {
    card.style.display = 'none';
    $('src-cost').className = '';
    sourceState.cost = 'err';
    return null;
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
    const [costRes] = await Promise.allSettled([loadCost(), loadCoolify()]);
    const costData = costRes.status === 'fulfilled' ? costRes.value : null;
    renderLimits(lastGoodMetrics, costData);
    renderLive();
  } finally {
    refreshing = false;
  }
}

// Range switcher: re-fetch with the new window; default stays 24h.
document.addEventListener('DOMContentLoaded', () => {
  const tabs = $('range-tabs');
  if (!tabs) return;
  tabs.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-min]');
    if (!btn) return;
    rangeMinutes = Number(btn.dataset.min) || 1440;
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    setText('range-title', `all charts · ${RANGE_LABELS[rangeMinutes] || rangeMinutes + ' min'}`);
    refresh();
  });
});

(async () => {
  await loadStatus();
  await refresh();
  setInterval(refresh, 60_000);
})();
