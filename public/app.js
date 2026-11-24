'use strict';
/* global Chart */

const fmtGB = (b) => (b / 1024 ** 3).toFixed(b / 1024 ** 3 >= 10 ? 0 : 1) + ' GB';
const fmtBps = (b) => (b > 1024 * 1024 ? (b / 1024 ** 2).toFixed(1) + ' MB/s' : (b / 1024).toFixed(0) + ' KB/s');

function setGauge(kpiId, barId, noteId, text, pct, note) {
  document.getElementById(kpiId).innerHTML = text;
  const bar = document.getElementById(barId);
  bar.style.width = Math.min(pct, 100) + '%';
  bar.style.background = pct > 80 ? 'var(--bad)' : pct > 60 ? 'var(--warn)' : 'var(--ok)';
  document.getElementById(noteId).textContent = note || '';
}

let statusCache = null;

async function loadStatus() {
  statusCache = await (await fetch('/api/status')).json();
}

async function loadCoolify() {
  const r = await fetch('/api/coolify/resources');
  if (!r.ok) {
    document.getElementById('apps-warn').textContent = 'Coolify panel unavailable: ' + (await r.json()).error;
    return;
  }
  const { servers, applications } = await r.json();
  const srv = (servers && servers[0]) || {};
  const cur = srv.metrics && srv.metrics.current;
  const ft = statusCache.freeTier;

  if (cur) {
    const memPct = (cur.memory_used_bytes / ft.memoryLimitBytes) * 100;
    const diskPct = (cur.disk_used_bytes / ft.diskLimitBytes) * 100;
    const totalMem = cur.memory_total_bytes;
    setGauge('cpu-kpi', 'cpu-bar', 'cpu-note', `${cur.cpu_percent.toFixed(1)}%`, cur.cpu_percent,
      `load ${cur.load1} · Coolify ceiling 100% (free tier: 4 OCPU shared)`);
    setGauge('mem-kpi', 'mem-bar', 'mem-note', `${fmtGB(cur.memory_used_bytes)} <small>of ${fmtGB(totalMem)}</small>`,
      (cur.memory_used_bytes / totalMem) * 100,
      `${memPct.toFixed(0)}% of 24 GB free-tier budget`);
    setGauge('disk-kpi', 'disk-bar', 'disk-note', `${fmtGB(cur.disk_used_bytes)} <small>used</small>`,
      cur.disk_used_percent, `${diskPct.toFixed(0)}% of 200 GB free-tier estimate`);

    const series = srv.metrics.series || {};
    const t = (pts) => pts.map((p) => new Date(p[0]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    if (series.cpu_percent) drawRes(t(series.cpu_percent), series.cpu_percent.map((p) => p[1]), series.memory_used_bytes.map((p) => (p[1] / totalMem) * 100));
    if (series.network_rx_bytes_per_sec) drawNet(t(series.network_rx_bytes_per_sec), series.network_rx_bytes_per_sec.map((p) => p[1]), series.network_tx_bytes_per_sec.map((p) => p[1]));
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
  const r = await fetch('/api/cloudflare/traffic');
  const body = document.getElementById('cf-body');
  if (!r.ok) { body.innerHTML = `<div class="warn">${(await r.json()).error}</div>`; return; }
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
}

async function loadCost() {
  if (!statusCache.panels.oci) return;
  const r = await fetch('/api/oci/cost');
  const body = document.getElementById('oci-body');
  if (!r.ok) { body.innerHTML = `<div class="warn">Cost panel: ${(await r.json()).error}</div>`; return; }
  const data = await r.json();
  const cur = data.currency === 'USD' ? '$' : data.currency + ' ';
  const dayLabels = data.days.map((d) => d.date.slice(8) + '/' + d.date.slice(5, 7));
  body.innerHTML = `
    <div class="kpi">${cur}${data.total.toFixed(2)} <small>month-to-date</small></div>
    <div class="note">${data.days.map((d) => (d.date || '?') + ': ' + cur + d.cost.toFixed(2)).slice(-5).join('<br>')}</div>
    <div class="chart-wrap"><canvas id="chart-cost"></canvas></div>`;
  new Chart(document.getElementById('chart-cost'), {
    type: 'bar',
    data: { labels: dayLabels, datasets: [{ label: 'Daily cost', data: data.days.map((d) => d.cost), backgroundColor: '#58a6ff' }] },
    options: { responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { color: '#8b96a5' } }, y: { ticks: { color: '#8b96a5' } } }, plugins: { legend: { display: false } } },
  });
}

(async () => {
  await loadStatus();
  await Promise.allSettled([loadCoolify(), loadTraffic(), loadCost()]);
  setInterval(loadCoolify, 60_000);
})();
