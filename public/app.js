'use strict';
/* global Chart */

const fmtGB = (b) => (b / 1024 ** 3).toFixed(b / 1024 ** 3 >= 10 ? 0 : 1) + ' GB';
const fmtBps = (b) => (b > 1024 * 1024 ? (b / 1024 ** 2).toFixed(1) + ' MB/s' : (b / 1024).toFixed(0) + ' KB/s');
const num = (v) => (typeof v === 'number' ? v : parseFloat(v) || 0);
const statusEl = (id, msg) => { const el = document.getElementById(id); if (el) el.textContent = msg || ''; };

function setGauge(kpiId, barId, noteId, text, pct, note) {
  document.getElementById(kpiId).innerHTML = text;
  const bar = document.getElementById(barId);
  bar.style.width = Math.min(pct, 100) + '%';
  bar.style.background = pct > 80 ? 'var(--bad)' : pct > 60 ? 'var(--warn)' : 'var(--ok)';
  document.getElementById(noteId).textContent = note || '';
}

let statusCache = null;

async function loadStatus() {
  try {
    statusCache = await (await fetch('/api/status')).json();
    statusEl('top-warn', '');
  } catch (e) {
    statusCache = { panels: {}, freeTier: { memoryLimitBytes: 24 * 1024 ** 3, diskLimitBytes: 200 * 1024 ** 3 } };
    statusEl('top-warn', 'Dashboard API unreachable: ' + e.message);
  }
}

// Metrics are fetched server-side from Coolify's MCP server and arrive as
// { current, series } with [timestamp_ms, value] series pairs.
// Older/other shapes are passed through unchanged.
function normalizeMetrics(m) {
  if (!m || !Array.isArray(m.data) || !m.data.length) return m && m.current ? m : null;
  const arr = m.data;
  const ts = (x) => Date.parse(x.timestamp || x.created_at || x.time) || 0;
  const pick = (x, ...names) => { for (const n of names) if (x[n] !== undefined && x[n] !== null) return num(x[n]); return 0; };
  const latest = arr[arr.length - 1];
  const net = [];
  for (let i = 1; i < arr.length; i++) {
    const dt = (ts(arr[i]) - ts(arr[i - 1])) / 1000;
    if (dt <= 0) continue;
    net.push({
      t: ts(arr[i]),
      rx: (pick(arr[i], 'network_received_bytes', 'network_rx_bytes') - pick(arr[i - 1], 'network_received_bytes', 'network_rx_bytes')) / dt,
      tx: (pick(arr[i], 'network_sent_bytes', 'network_tx_bytes') - pick(arr[i - 1], 'network_sent_bytes', 'network_tx_bytes')) / dt,
    });
  }
  return {
    current: {
      cpu_percent: pick(latest, 'cpu_percent'),
      memory_used_bytes: pick(latest, 'memory_used_bytes'),
      memory_total_bytes: pick(latest, 'memory_total_bytes'),
      disk_used_bytes: pick(latest, 'used_disk_bytes'),
      disk_total_bytes: pick(latest, 'total_disk_bytes'),
      load1: pick(latest, 'load1'),
    },
    series: {
      cpu_percent: arr.map((x) => [ts(x), pick(x, 'cpu_percent')]),
      memory_used_bytes: arr.map((x) => [ts(x), pick(x, 'memory_used_bytes')]),
      network_rx_bytes_per_sec: net.map((p) => [p.t, p.rx]),
      network_tx_bytes_per_sec: net.map((p) => [p.t, p.tx]),
    },
  };
}

async function loadCoolify() {
  try {
    const r = await fetch('/api/coolify/resources');
    if (!r.ok) {
      let err = 'HTTP ' + r.status;
      try { err = (await r.json()).error || err; } catch (_) { /* non-JSON body */ }
      statusEl('apps-warn', 'Coolify panel unavailable: ' + err);
      return;
    }
    const { servers, applications } = await r.json();
    statusEl('apps-warn', '');
    const srv = (servers && servers[0]) || {};
    const nm = normalizeMetrics(srv.metrics);
    const cur = nm && nm.current;
    const ft = statusCache.freeTier;

    if (cur) {
      const totalMem = cur.memory_total_bytes || ft.memoryLimitBytes;
      const memPct = (cur.memory_used_bytes / ft.memoryLimitBytes) * 100;
      const diskPct = (cur.disk_used_bytes / ft.diskLimitBytes) * 100;
      setGauge('cpu-kpi', 'cpu-bar', 'cpu-note', `${num(cur.cpu_percent).toFixed(1)}%`, num(cur.cpu_percent),
        `load ${num(cur.load1).toFixed(2)} · Coolify ceiling 100% (free tier: 4 OCPU shared)`);
      setGauge('mem-kpi', 'mem-bar', 'mem-note', `${fmtGB(cur.memory_used_bytes)} <small>of ${fmtGB(totalMem)}</small>`,
        (cur.memory_used_bytes / totalMem) * 100,
        `${memPct.toFixed(0)}% of 24 GB free-tier budget`);
      setGauge('disk-kpi', 'disk-bar', 'disk-note', `${fmtGB(cur.disk_used_bytes)} <small>used</small>`,
        cur.disk_total_bytes ? (cur.disk_used_bytes / cur.disk_total_bytes) * 100 : diskPct,
        `${diskPct.toFixed(0)}% of 200 GB free-tier estimate`);

      const series = nm.series || {};
      const t = (pts) => pts.map((p) => new Date(p[0]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      if (series.cpu_percent && series.cpu_percent.length) drawRes(t(series.cpu_percent), series.cpu_percent.map((p) => p[1]), series.memory_used_bytes.map((p) => (p[1] / totalMem) * 100));
      if (series.network_rx_bytes_per_sec && series.network_rx_bytes_per_sec.length) drawNet(t(series.network_rx_bytes_per_sec), series.network_rx_bytes_per_sec.map((p) => p[1]), series.network_tx_bytes_per_sec.map((p) => p[1]));
    }

    const tbody = document.querySelector('#apps-table tbody');
    tbody.innerHTML = '';
    for (const a of applications || []) {
      const ok = String(a.status).startsWith('running');
      tbody.insertAdjacentHTML('beforeend', `<tr>
        <td>${a.name}</td>
        <td class="note">${(a.fqdn || '').split(',')[0]}</td>
        <td><span class="pill ${ok ? 'running' : 'other'}">${String(a.status).split(':')[0]}</span></td>
      </tr>`);
    }
    if (!applications || !applications.length) statusEl('apps-warn', 'Coolify reachable but no applications were returned.');
  } catch (e) {
    statusEl('apps-warn', 'Coolify panel error: ' + ((e && e.message) || e));
  }
}

function drawRes(labels, cpu, mem) {
  new Chart(document.getElementById('chart-res'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'CPU %', data: cpu, borderColor: '#58a6ff', tension: .3, pointRadius: 0 },
      { label: 'RAM % of total', data: mem, borderColor: '#bc8cff', tension: .3, pointRadius: 0 },
    ]},
    options: { responsive: true, maintainAspectRatio: false, scales: { y: { ticks: { color: '#8b96a5' }, suggestedMax: 100 }, x: { ticks: { color: '#8b96a5', maxTicksLimit: 6 } } }, plugins: { legend: { labels: { color: '#e6ebf2' } } } },
  });
}

function drawNet(labels, rx, tx) {
  new Chart(document.getElementById('chart-net'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'In', data: rx.map(fmtBps), borderColor: '#3fb950', tension: .3, pointRadius: 0 },
      { label: 'Out', data: tx.map(fmtBps), borderColor: '#d29922', tension: .3, pointRadius: 0 },
    ]},
    options: { responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { color: '#8b96a5', maxTicksLimit: 6 } } }, plugins: { legend: { labels: { color: '#e6ebf2' } } } },
  });
}

async function loadTraffic() {
  if (!statusCache.panels.cloudflare) return;
  try {
    const r = await fetch('/api/cloudflare/traffic');
    const body = document.getElementById('cf-body');
    if (!r.ok) {
      let err = 'HTTP ' + r.status;
      try { err = (await r.json()).error || err; } catch (_) { /* non-JSON body */ }
      body.innerHTML = `<div class="warn">${err}</div>`;
      return;
    }
    const { zones } = await r.json();
    body.innerHTML = '';
    for (const z of zones) {
      const groups = (z.data && z.data.httpRequests1hGroups) || [];
      const tot = groups.reduce((a, g) => a + (g.sum ? g.sum.requests : 0), 0);
      const bytes = groups.reduce((a, g) => a + (g.sum ? g.sum.bytes : 0), 0);
      const uniq = groups.reduce((a, g) => a + (g.uniq ? g.uniq.uniques : 0), 0);
      body.insertAdjacentHTML('beforeend', `
        <div class="kpi">${tot.toLocaleString()} <small>requests / 24h</small></div>
        <div class="note">${bytes ? fmtGB(bytes) + ' bandwidth · ' : ''}${uniq.toLocaleString()} unique visitors</div>`);
    }
  } catch (e) {
    document.getElementById('cf-body').innerHTML = `<div class="warn">${(e && e.message) || e}</div>`;
  }
}

async function loadCost() {
  if (!statusCache.panels.oci) return;
  try {
    const r = await fetch('/api/oci/cost');
    const body = document.getElementById('oci-body');
    if (!r.ok) {
      let err = 'HTTP ' + r.status;
      try { err = (await r.json()).error || err; } catch (_) { /* non-JSON body */ }
      body.innerHTML = `<div class="warn">Cost panel: ${err}</div>`;
      return;
    }
    const data = await r.json();
    const cur = data.currency === 'USD' ? '$' : data.currency + ' ';
    const dayLabels = data.days.map((d) => d.date.slice(8) + '/' + d.date.slice(5, 7));
    body.innerHTML = `
      <div class="kpi">${cur}${num(data.total).toFixed(2)} <small>month-to-date</small></div>
      <div class="note">${data.days.map((d) => (d.date || '?') + ': ' + cur + num(d.cost).toFixed(2)).slice(-5).join('<br>')}</div>
      <div class="chart-wrap"><canvas id="chart-cost"></canvas></div>`;
    new Chart(document.getElementById('chart-cost'), {
      type: 'bar',
      data: { labels: dayLabels, datasets: [{ label: 'Daily cost', data: data.days.map((d) => num(d.cost)), backgroundColor: '#58a6ff' }] },
      options: { responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { color: '#8b96a5' } }, y: { ticks: { color: '#8b96a5' } } }, plugins: { legend: { display: false } } },
    });
  } catch (e) {
    document.getElementById('oci-body').innerHTML = `<div class="warn">Cost panel: ${(e && e.message) || e}</div>`;
  }
}

(async () => {
  await loadStatus();
  await Promise.allSettled([loadCoolify(), loadTraffic(), loadCost()]);
  setInterval(loadCoolify, 60_000);
})();
