// Lightweight infra dashboard for Oracle (OCI) server hosting via Coolify.
// Panels degrade gracefully: each data source is gated by its env-var credentials:
//   COOLIFY_TOKEN + COOLIFY_BASE_URL  -> resources & health panels
//   CF_API_TOKEN + CF_ZONE_IDS        -> traffic panel
//   OCI_* (signing key env config)    -> cost panel
'use strict';

const express = require('express');
const path = require('path');
const { ociConfigured, ociMonthCost, ociProbe } = require('./oci');

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

app.get('/api/coolify/resources', async (_req, res) => {
  if (!coolifyConfigured()) return res.status(503).json({ error: 'COOLIFY_TOKEN / COOLIFY_BASE_URL not set' });
  try {
    const servers = await coolify('/api/v1/servers');
    const out = [];
    for (const s of servers.data || []) {
      const now = Math.floor(Date.now() / 1000);
      const [metrics, resources] = await Promise.all([
        coolify(`/api/v1/servers/${s.uuid}/metrics?from=${now - 3600}&to=${now}`).catch(() => null),
        coolify(`/api/v1/servers/${s.uuid}/resources`).catch(() => null),
      ]);
      out.push({ server: s, metrics, resources });
    }
    const apps = await coolify('/api/v1/applications').catch(() => null);
    res.json({ servers: out, applications: apps && apps.data });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

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
  // The metrics call is a prime suspect for hangs — test it with the exact range the panel uses.
  for (const u of serverUuids.slice(0, 2)) {
    const now = Math.floor(Date.now() / 1000);
    await stepFetch(`GET /servers/${u}/metrics (auth)`, `/api/v1/servers/${u}/metrics?from=${now - 3600}&to=${now}`, true);
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
// ---------------------------------------------------------------------------
app.get('/api/oci/cost', async (_req, res) => {
  if (!ociConfigured()) return res.status(503).json({ error: 'OCI_* env vars not set or private key missing' });
  try {
    res.json(await ociMonthCost());
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
