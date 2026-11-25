// Lightweight infra dashboard for Oracle (OCI) server hosting via Coolify.
// Panels degrade gracefully: each data source is gated by its env-var credentials:
//   COOLIFY_TOKEN + COOLIFY_BASE_URL  -> resources & health panels
//   CF_API_TOKEN + CF_ZONE_IDS        -> traffic panel
//   OCI_* (signing key env config)    -> cost panel
'use strict';

const express = require('express');
const path = require('path');
const { ociConfigured, ociMonthCost, ociComputeMetrics, ociProbe } = require('./oci');

const app = express();
const PORT = process.env.PORT || 3000;

// Free-tier budget: shown as reference lines on the charts (OCI Always Free allotment).
const FREE_TIER = {
  cpuPercent: 400 / 4, // ~4 OCPUs; Coolify reports % of total capacity, so ceiling = 100
  memoryLimitBytes: 24 * 1024 * 1024 * 1024,
  diskLimitBytes: 200 * 1024 * 1024 * 1024, // OCI Always Free block storage (adjust to actual)
};

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Coolify (resources + health)
// ---------------------------------------------------------------------------
function coolifyConfigured() {
  return Boolean(process.env.COOLIFY_TOKEN && process.env.COOLIFY_BASE_URL);
}

// Outbound fetch with a hard timeout and a descriptive error, so a hang or a
// connection failure surfaces as the app's own JSON error instead of a proxy 502.
async function timedFetch(url, options = {}, timeoutMs = 10000) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const cause = e && e.cause ? ` [${e.cause.code || e.cause}]` : '';
    throw new Error(`fetch ${url} failed: ${e.message}${cause}`);
  }
}

function coolifyBase() {
  // Trim trailing slash so paths like /api/v1/... don't double up.
  return (process.env.COOLIFY_BASE_URL || '').replace(/\/+$/, '');
}

async function coolify(path_) {
  const res = await timedFetch(`${coolifyBase()}${path_}`, {
    headers: { Authorization: `Bearer ${process.env.COOLIFY_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Coolify API ${res.status} for ${path_}`);
  return res.json();
}

// Metrics via Coolify's built-in MCP server (/mcp): the REST route
// /api/v1/servers/{uuid}/metrics was removed from Coolify's API, but the same
// Bearer token works on /mcp. Streamable HTTP: initialize -> initialized ->
// tools/call get_server_metrics.
async function coolifyMcpMetrics(uuid, minutes = 60) {
  const url = `${coolifyBase()}/mcp`;
  const headers = {
    Authorization: `Bearer ${process.env.COOLIFY_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const init = await timedFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'monitor-dashboard', version: '1.0.0' } },
    }),
  });
  if (!init.ok) throw new Error(`MCP initialize ${init.status}`);
  const sessionId = init.headers.get('mcp-session-id');
  const sessionHeaders = sessionId ? { ...headers, 'mcp-session-id': sessionId } : headers;
  await init.text().catch(() => '');
  // The session report (no response expected) and the initialize SSE stream are
  // both optional in this flow — failures here shouldn't sink the metrics call.
  await timedFetch(url, {
    method: 'POST',
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }).catch(() => {});

  const call = await timedFetch(url, {
    method: 'POST',
    headers: sessionHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_server_metrics', arguments: { server_uuid: uuid, minutes } },
    }),
  });
  if (!call.ok) throw new Error(`MCP tools/call ${call.status}`);
  const contentType = call.headers.get('content-type') || '';
  let payload;
  if (contentType.includes('text/event-stream')) {
    const text = await call.text();
    // Result is the last complete SSE data line of the stream.
    const lines = text.split('\n').filter((l) => l.startsWith('data:'));
    if (!lines.length) throw new Error('MCP tools/call returned an empty event stream');
    payload = JSON.parse(lines[lines.length - 1].slice(5).trim());
  } else {
    payload = await call.json();
  }
  if (payload.error) throw new Error(`MCP error ${payload.error.code}: ${payload.error.message}`);
  const result = payload.result || {};
  if (result.isError) {
    const msg = (result.content || []).map((c) => c.text).filter(Boolean).join(' ');
    throw new Error(`MCP tool error: ${msg || 'unknown'}`);
  }
  if (result.structuredContent) return result.structuredContent;
  const textItem = (result.content || []).find((c) => c.type === 'text');
  if (textItem && textItem.text) return JSON.parse(textItem.text);
  return result;
}

app.get('/api/status', (_req, res) => {
  res.json({
    panels: {
      coolify: coolifyConfigured(),
      cloudflare: Boolean(process.env.CF_API_TOKEN && process.env.CF_ZONE_IDS),
      oci: ociConfigured(),
    },
    freeTier: FREE_TIER,
  });
});

app.get('/api/coolify/resources', async (req, res) => {
  if (!coolifyConfigured()) return res.status(503).json({ error: 'COOLIFY_TOKEN / COOLIFY_BASE_URL not set' });
  try {
    // Optional time window for Sentinel history (?minutes=60..43200, default 24h).
    const minutes = Math.min(43200, Math.max(60, parseInt(req.query.minutes, 10) || 1440));
    const serversBody = await coolify('/api/v1/servers');
    // Coolify v4 returns bare arrays for list endpoints (no { data } envelope).
    const serverList = Array.isArray(serversBody) ? serversBody : serversBody.data || [];
    const out = [];
    for (const s of serverList) {
      const [metricsRaw, resources] = await Promise.all([
        getCachedMetrics(s.uuid, minutes).catch((e) => {
          console.error('[coolify metrics]', s.name, e.message);
          return null;
        }),
        coolify(`/api/v1/servers/${s.uuid}/resources`).catch(() => null),
      ]);
      // MCP wraps the payload as { data: { current, series } }; unwrap so the
      // client sees the { current, series } shape directly.
      const metrics = metricsRaw && metricsRaw.data && metricsRaw.data.current ? metricsRaw.data : metricsRaw;
      out.push({ server: s, metrics, resources });
    }
    const appsBody = await coolify('/api/v1/applications').catch(() => null);
    const applications = Array.isArray(appsBody) ? appsBody : appsBody && appsBody.data;
    res.json({ servers: out, applications });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Sentinel metrics cache: keyed per (server, window), 60s TTL — the dashboard
// refresh loop (and multiple tabs) reuse one MCP handshake instead of renewing
// it per request.
const METRICS_TTL_MS = 60_000;
const metricsCache = new Map(); // `${uuid}:${minutes}` -> { t, data }
async function getCachedMetrics(uuid, minutes = 1440) {
  const key = `${uuid}:${minutes}`;
  const hit = metricsCache.get(key);
  if (hit && Date.now() - hit.t < METRICS_TTL_MS) return hit.data;
  const data = await coolifyMcpMetrics(uuid, minutes);
  metricsCache.set(key, { t: Date.now(), data });
  // Keep the map bounded: drop entries for other windows beyond 8 distinct keys.
  if (metricsCache.size > 8) {
    const oldest = [...metricsCache.entries()].sort((a, b) => a[1].t - b[1].t)[0];
    metricsCache.delete(oldest[0]);
  }
  return data;
}

// Diagnostic: run the Coolify calls the dashboard makes, report status/timing/
// raw body preview per step. No secrets echoed (token and base URL are not).
app.get('/api/debug/coolify', async (_req, res) => {
  if (!coolifyConfigured()) return res.status(503).json({ error: 'COOLIFY_TOKEN / COOLIFY_BASE_URL not set' });
  let baseHost = null;
  try { baseHost = new URL(coolifyBase()).host; } catch (e) { baseHost = 'unparseable: ' + e.message; }
  // Token shape diagnostics (no secret content — lengths and charset only).
  const tok = process.env.COOLIFY_TOKEN || '';
  const tokenShape = {
    length: tok.length,
    hasWhitespace: /\s/.test(tok),
    printableAsciiOnly: /^[\x21-\x7e]+$/.test(tok),
    hasPipe: tok.includes('|'),
  };
  const steps = [];
  async function stepFetch(name, path_, authed) {
    const t0 = Date.now();
    try {
      const r = await timedFetch(
        `${coolifyBase()}${path_}`,
        authed ? { headers: { Authorization: `Bearer ${process.env.COOLIFY_TOKEN}` } } : {},
        8000
      );
      const text = await r.text();
      steps.push({ step: name, ok: r.ok, status: r.status, ms: Date.now() - t0, bodyPreview: text.slice(0, 200) });
    } catch (e) {
      steps.push({ step: name, ok: false, status: null, ms: Date.now() - t0, error: e.message });
    }
  }
  await stepFetch('GET /api/v1/servers (auth)', '/api/v1/servers', true);
  await stepFetch('GET /api/v1/applications (auth)', '/api/v1/applications', true);
  const serversBody = (steps.find((s) => /servers/.test(s.step)) || {}).bodyPreview || '';
  // Preview is truncated, so pull uuids by regex rather than parsing the JSON.
  const serverUuids = [...serversBody.matchAll(/"uuid":"([a-z0-9]+)"/g)].map((m) => m[1]);
  // Metrics come from the MCP server (/mcp) — verify the full handshake here.
  for (const u of serverUuids.slice(0, 1)) {
    const t0 = Date.now();
    try {
      const m = await coolifyMcpMetrics(u);
      const unwrapped = m && m.data && m.data.current ? m.data : m;
      steps.push({
        step: `MCP get_server_metrics (${u})`,
        ok: Boolean(unwrapped && unwrapped.current),
        ms: Date.now() - t0,
        online: unwrapped && unwrapped.online,
        seriesKeys: unwrapped && unwrapped.series ? Object.keys(unwrapped.series) : [],
      });
    } catch (e) {
      steps.push({ step: `MCP get_server_metrics (${u})`, ok: false, ms: Date.now() - t0, error: e.message });
    }
  }
  res.json({ baseHost, tokenShape, steps, serverUuids });
});

// ---------------------------------------------------------------------------
// Cloudflare zone traffic
// ---------------------------------------------------------------------------
const CF_ZONE_IDS = () => (process.env.CF_ZONE_IDS || '').split(',').map((z) => z.trim()).filter(Boolean);

app.get('/api/cloudflare/traffic', async (_req, res) => {
  if (!process.env.CF_API_TOKEN || !CF_ZONE_IDS().length) {
    return res.status(503).json({ error: 'CF_API_TOKEN / CF_ZONE_IDS not set' });
  }
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const query = `
    query ($zone: String!, $since: Time!) {
      viewer { zones(filter: { zoneTag: $zone }) {
        httpRequests1hGroups(limit: 24, filter: { datetime_geq: $since }, orderBy: [datetimeMinute_ASC]) {
          dimensions { datetime }
          sum { requests bytes cachedRequests }
          uniq { uniques }
        }
      } }
    }`;
  try {
    const zones = await Promise.all(CF_ZONE_IDS().map(async (tag) => {
      const r = await timedFetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { zone: tag, since } }),
      });
      const body = await r.json();
      if (body.errors) throw new Error(`Cloudflare: ${body.errors[0].message}`);
      return { tag, data: body.data.viewer.zones[0] };
    }));
    res.json({ zones });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// OCI — month-to-date cost vs free-tier (target: 0, only overage costs money)
// Cached 5 min: the Usage API throttles per-user (429 TooManyRequests observed)
// and the 60s frontend loop would otherwise hammer it.
// ---------------------------------------------------------------------------
let costCache = { t: 0, data: null };
app.get('/api/oci/cost', async (_req, res) => {
  if (!ociConfigured()) return res.status(503).json({ error: 'OCI_* env vars not set or private key missing' });
  if (costCache.data && Date.now() - costCache.t < 5 * 60_000) return res.json(costCache.data);
  try {
    const data = await ociMonthCost();
    costCache = { t: Date.now(), data };
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Direct-from-Oracle compute metrics (Telemetry API, oci_computeagent):
// CPU / memory / filesystem utilization series — not proxied via Coolify.
app.get('/api/oci/metrics', async (_req, res) => {
  if (!ociConfigured()) return res.status(503).json({ error: 'OCI_* env vars not set or private key missing' });
  try {
    res.json(await ociComputeMetrics(180));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Diagnostic for the OCI cost pipeline: config sanity + endpoint reachability +
// a real signed runQuery, per-step detail.
app.get('/api/debug/oci', async (_req, res) => {
  if (!ociConfigured()) return res.status(503).json({ error: 'OCI_* env vars not set or private key missing' });
  try {
    res.json(await ociProbe());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Keep unexpected async failures visible in container logs instead of dying silently.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && (e.stack || e.message || e)));

app.listen(PORT, () => {
  console.log(`monitor-dashboard listening on :${PORT}`);
});
