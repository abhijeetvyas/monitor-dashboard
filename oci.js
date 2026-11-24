// OCI request signing (API key auth) — per Oracle's request-signing spec.
const crypto = require('crypto');

function ociConfig() {
  return {
    tenancy: process.env.OCI_TENANCY,
    user: process.env.OCI_USER,
    region: process.env.OCI_REGION,
    fingerprint: process.env.OCI_FINGERPRINT,
    privateKey: (process.env.OCI_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  };
}

function ociConfigured() {
  const c = ociConfig();
  return Boolean(c.tenancy && c.user && c.region && c.fingerprint && c.privateKey.includes('PRIVATE KEY'));
}

// Outbound fetch with a hard timeout and a descriptive error, so hangs and
// connection failures carry the real cause (DNS/TLS/refused) instead of "fetch failed".
async function ociFetch(url, options = {}, timeoutMs = 15000) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const cause = e && e.cause ? ` [${e.cause.code || e.cause}]` : '';
    throw new Error(`fetch ${url} failed: ${e.message}${cause}`);
  }
}

// Usage API is region-scoped; override with OCI_USAGE_REGION if the tenancy's
// home region differs from the server's region.
function usageHost() {
  const region = process.env.OCI_USAGE_REGION || (process.env.OCI_REGION || '').trim();
  return `usageapi.${region}.oci.oraclecloud.com`;
}

// Telemetry (monitoring) API — same signing, different service per region.
function telemetryHost() {
  const region = process.env.OCI_METRICS_REGION || (process.env.OCI_REGION || '').trim();
  return `telemetry.${region}.oci.oraclecloud.com`;
}

function ociRequest(host, method, path_, body) {
  const c = ociConfig();
  const url = `https://${host}${path_}`;
  const date = new Date().toUTCString();
  const payload = body ? JSON.stringify(body) : '';
  const sha256 = crypto.createHash('sha256').update(payload).digest('base64');
  const target = `${method.toLowerCase()} ${path_}`;
  const headers = ['date (request-target)', 'host', ...(payload ? ['x-content-sha256', 'content-type', 'content-length'] : [])];
  const signingString = [
    `date: ${date}`,
    `(request-target): ${target}`,
    `host: ${host}`,
    ...(payload
      ? [`x-content-sha256: ${sha256}`, `content-type: application/json`, `content-length: ${Buffer.byteLength(payload)}`]
      : []),
  ].join('\n');
  const signature = crypto.createSign('RSA-SHA256').update(signingString).sign(c.privateKey, 'base64');
  const authorization = `Signature version="1",keyId="${c.tenancy}/${c.user}/${c.fingerprint}",algorithm="rsa-sha256",headers="${headers.join(' ')}",signature="${signature}"`;

  return ociFetch(url, {
    method,
    headers: {
      date,
      host,
      authorization,
      ...(payload ? { 'x-content-sha256': sha256, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
    },
    body: payload || undefined,
  });
}

// Month-to-date OCI spend. Primary: the classic /usage endpoint
// (RequestSummarizedUsages). Fallback: /actions/runQuery (older action).
async function ociMonthCost(hostOverride) {
  const c = ociConfig();
  const host = hostOverride || usageHost();
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(Date.now() + 24 * 3600 * 1000); // usage API needs the day boundary
  const common = {
    tenantId: c.tenancy,
    timeUsageStarted: start.toISOString(),
    timeUsageEnded: end.toISOString(),
    granularity: 'DAILY',
  };

  const parse = (items) => {
    const arr = Array.isArray(items) ? items : [];
    return {
      currency: (arr[0] && arr[0].currency) || 'USD',
      days: arr.map((i) => ({
        date: String((i.dimensions && (i.dimensions.timeUsageStarted || i.dimensions.time_usagestarted)) || i.timeUsageStarted || '').slice(0, 10),
        cost: Number(i.computedAmount ?? i.computedamount ?? i.unblendedCost ?? 0),
      })),
      total: arr.reduce((a, i) => a + Number(i.computedAmount ?? i.computedamount ?? i.unblendedCost ?? 0), 0),
    };
  };

  let usageErr = null;
  try {
    const res = await ociRequest(host, 'POST', '/20200107/usage', { ...common, queryType: ['COST'] });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`OCI /usage ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
    if (Array.isArray(body.items)) return parse(body.items);
    throw new Error(`OCI /usage unexpected body ${JSON.stringify(body).slice(0, 200)}`);
  } catch (e) {
    usageErr = e;
  }

  try {
    const res = await ociRequest(host, 'POST', '/20200107/actions/runQuery', {
      queryType: 'COST',
      ...common,
      filter: { tags: [], compartmentFilters: [], dimensions: [], freeformTagFilters: [] },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`OCI runQuery ${res.status} ${body.code || ''}: ${body.message || 'no message'}`.trim());
    return parse(body.items);
  } catch (e) {
    throw new Error(`${usageErr.message}; ${e.message}`);
  }
}

// Direct-from-Oracle compute metrics via the Telemetry API (oci_computeagent
// namespace — same API key as everything else, no extra credentials).
// Returns per-metric series of [timestampMs, value] averaged across dimension
// streams (the only instance in this tenancy, so streams usually collapse).
async function ociComputeMetrics(minutes = 180) {
  const c = ociConfig();
  const host = telemetryHost();
  const end = new Date();
  const start = new Date(Date.now() - minutes * 60 * 1000);
  const base = {
    compartmentId: process.env.OCI_COMPARTMENT || c.tenancy,
    namespace: 'oci_computeagent',
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  };
  const seriesFor = (metadata, metric) => {
    const streams = (Array.isArray(metadata) ? metadata : []).map((sd) =>
      (sd.aggregatedDatapoints || []).map((p) => [Date.parse(p.timestamp), p.value])
    );
    // Merge streams by timestamp (mean) so multi-dimension responses stay a single series.
    const byTs = new Map();
    for (const stream of streams) {
      for (const [ts, v] of stream) {
        const acc = byTs.get(ts) || { sum: 0, n: 0 };
        acc.sum += v; acc.n += 1;
        byTs.set(ts, acc);
      }
    }
    return [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([ts, acc]) => [ts, acc.sum / acc.n]);
  };

  const grab = async (metric) => {
    const res = await ociRequest(host, 'POST', '/20180401/metrics', { ...base, name: metric });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Telemetry ${metric} ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
    return seriesFor(body, metric);
  };
  const [cpu, memory, filesystem] = await Promise.all([grab('CpuUtilization'), grab('MemoryUtilization'), grab('FilesystemCapacityUtilization')]);
  return {
    minutes,
    host: host,
    cpu,
    memory,
    filesystem,
  };
}

// Diagnostic: config sanity + endpoint reachability + a real signed runQuery.
async function ociProbe() {
  const c = ociConfig();
  const host = usageHost();
  const k = c.privateKey;
  const keyLines = k.split('\n');
  const keyShape = {
    totalLength: k.length,
    lineCount: keyLines.length,
    lineLengths: keyLines.map((l) => l.length).slice(0, 40),
    firstLine: keyLines[0] || '',   // should be exactly "-----BEGIN PRIVATE KEY-----" or RSA variant
    lastLine: keyLines[keyLines.length - 1] || (keyLines[keyLines.length - 2] || ''),
    hasWhitespaceInsideBase64: /[^A-Za-z0-9+/=\n-]/.test(k.replace(/-----(BEGIN|END)[^-]*-----/g, '')),
    endsWithNewline: /\n$/.test(k),
  };
  const steps = [];
  const t0 = Date.now();
  try {
    const r = await ociFetch(`https://${host}/`, {}, 8000);
    steps.push({ step: 'reachability GET /', ok: r.status < 500, status: r.status, ms: Date.now() - t0, bodyPreview: (await r.text()).slice(0, 120) });
  } catch (e) {
    steps.push({ step: 'reachability GET /', ok: false, ms: Date.now() - t0, error: e.message });
  }
  try {
    const cost = await ociMonthCost();
    steps.push({ step: 'signed runQuery (month cost)', ok: true, summary: { total: cost.total, currency: cost.currency, days: cost.days.length } });
  } catch (e) {
    steps.push({ step: 'signed runQuery (month cost)', ok: false, error: e.message });
  }
  // Credential self-test: signed GET on the tenancy record validates the user
  // OCID + fingerprint + private key independently of the Usage API.
  try {
    const idHost = `identity.${c.region}.oci.oraclecloud.com`;
    const r = await ociRequest(idHost, 'GET', `/20160918/tenancies/${c.tenancy}`, null);
    const body = await r.json().catch(() => ({}));
    steps.push({
      step: 'signed GET identity tenancy (credential check)',
      ok: r.ok,
      status: r.status,
      name: body.name,
      homeRegion: body.homeRegion || body.home_region, // Identity API returns camelCase
      bodyPreview: r.ok ? undefined : JSON.stringify(body).slice(0, 200),
    });
  } catch (e) {
    steps.push({ step: 'signed GET identity tenancy (credential check)', ok: false, error: e.message });
  }
  // IAM visibility: if the signature is valid but the user can't even LIST
  // compartments, the IAM user has no useful grants — policies are the problem.
  {
    const t0 = Date.now();
    try {
      const r = await ociRequest(`identity.${c.region}.oci.oraclecloud.com`, 'GET', '/20160918/compartments', null);
      const body = await r.json().catch(() => ({}));
      steps.push({
        step: 'GET identity compartments (IAM visibility)',
        ok: r.ok,
        status: r.status,
        ms: Date.now() - t0,
        count: Array.isArray(body) ? body.length : undefined,
        bodyPreview: r.ok ? undefined : JSON.stringify(body).slice(0, 150),
      });
    } catch (e) {
      steps.push({ step: 'GET identity compartments (IAM visibility)', ok: false, ms: Date.now() - t0, error: e.message });
    }
  }
  // POST-signature sanity: a deliberate missing-fields body to the cost
  // endpoint. Signature/auth OK => 400 InvalidParameter; broken => 401/404
  // auth-style errors. Separates "signing code bug" from "IAM policy".
  {
    const t0 = Date.now();
    try {
      const r = await ociRequest(host, 'POST', '/20200107/usage', { probe: true });
      const body = await r.json().catch(() => ({}));
      steps.push({
        step: 'POST /20200107/usage bad-body (POST-signature probe)',
        ok: r.status === 400 || r.status === 422 || r.status === 200,
        status: r.status,
        ms: Date.now() - t0,
        bodyPreview: JSON.stringify(body).slice(0, 200),
      });
    } catch (e) {
      steps.push({ step: 'POST /20200107/usage bad-body (POST-signature probe)', ok: false, ms: Date.now() - t0, error: e.message });
    }
  }
  // Direct-from-Oracle compute metrics: proves the IAM user can read monitoring
  // data (different service + policy from the Usage API).
  try {
    const t = await ociComputeMetrics(60);
    steps.push({
      step: 'telemetry oci_computeagent (1h)',
      ok: t.cpu.length > 0 || t.memory.length > 0,
      datapoints: { cpu: t.cpu.length, memory: t.memory.length, filesystem: t.filesystem.length },
    });
  } catch (e) {
    steps.push({ step: 'telemetry oci_computeagent (1h)', ok: false, error: e.message.slice(0, 250) });
  }
  // Cost: the classic RequestSummarizedUsages endpoint — a different resource
  // from /actions/runQuery, with different IAM requirements.
  {
    const t0 = Date.now();
    try {
      const start = new Date();
      start.setUTCDate(1);
      start.setUTCHours(0, 0, 0, 0);
      const end = new Date(Date.now() + 24 * 3600 * 1000);
      const res = await ociRequest(host, 'POST', '/20200107/usage', {
        tenantId: c.tenancy,
        queryType: ['COST'],
        granularity: 'DAILY',
        timeUsageStarted: start.toISOString(),
        timeUsageEnded: end.toISOString(),
      });
      const body = await res.json().catch(() => ({}));
      steps.push({
        step: 'POST /20200107/usage (RequestSummarizedUsages)',
        ok: res.ok,
        status: res.status,
        ms: Date.now() - t0,
        items: Array.isArray(body.items) ? body.items.length : undefined,
        bodyPreview: res.ok ? undefined : JSON.stringify(body).slice(0, 200),
      });
    } catch (e) {
      steps.push({ step: 'POST /20200107/usage (RequestSummarizedUsages)', ok: false, ms: Date.now() - t0, error: e.message });
    }
  }
  // Region matrix: sign the identical runQuery against other region endpoints.
  // If these succeed, the stockholm endpoint rejects the query itself (service
  // gating/region scope); if they 404 too, the problem is the query/IAM, not the region.
  const altHosts = ['usageapi.eu-frankfurt-1.oci.oraclecloud.com', 'usageapi.us-ashburn-1.oci.oraclecloud.com'];
  for (const alt of altHosts.filter((h) => h !== host)) {
    const t0 = Date.now();
    try {
      const cost = await ociMonthCost(alt);
      steps.push({ step: `runQuery vs ${alt}`, ok: true, ms: Date.now() - t0, summary: { total: cost.total, days: cost.days.length } });
    } catch (e) {
      steps.push({ step: `runQuery vs ${alt}`, ok: false, ms: Date.now() - t0, error: e.message });
    }
  }
  return {
    region: c.region,
    usageHost: host,
    keyLooksLikePem: k.includes('PRIVATE KEY'),
    keyShape,
    steps,
  };
}

module.exports = { ociConfigured, ociMonthCost, ociComputeMetrics, ociProbe };
