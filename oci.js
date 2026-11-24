// Month-day UTC string (no fraction): the Usage API demands hours/min/sec = 0.
function dayIso(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

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
// Reader host differs between realms: telemetry.<r>.oci.oraclecloud.com vs
// monitoring.<r>.oraclecloud.com (some regions route telemetry.* POSTs to the
// ingestion service instead). OCI_METRICS_REGION / OCI_TELEMETRY_HOST override.
function telemetryHosts() {
  const region = process.env.OCI_METRICS_REGION || (process.env.OCI_REGION || '').trim();
  const hosts = [
    `telemetry.${region}.oci.oraclecloud.com`,
    `monitoring.${region}.oraclecloud.com`,
    `telemetry.${region}.oraclecloud.com`,
    `monitoring.${region}.oci.oraclecloud.com`,
  ];
  if (process.env.OCI_TELEMETRY_HOST) hosts.unshift(process.env.OCI_TELEMETRY_HOST);
  return hosts;
}
let telemetryHostCache = null;

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
  // The Usage API validates full-day UTC precision: hours/min/sec/none must be
  // zero. Month start → first midnight after "now" (tomorrow, per its docs).
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(Date.now());
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() + 1);
  const common = {
    tenantId: c.tenancy,
    timeUsageStarted: dayIso(start),
    timeUsageEnded: dayIso(end),
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

  // Auth is proven; the only variable is the request body shape.
  const variants = [
    { name: 'queryType string', body: { ...common, queryType: 'COST' } },
    { name: 'queryType array', body: { ...common, queryType: ['COST'] } },
  ];
  const errors = [];
  for (const v of variants) {
    try {
      const res = await ociRequest(host, 'POST', '/20200107/usage', v.body);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`OCI /usage (${v.name}) ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
      if (Array.isArray(body.items)) return parse(body.items);
      throw new Error(`OCI /usage (${v.name}) unexpected body ${JSON.stringify(body).slice(0, 200)}`);
    } catch (e) {
      errors.push(e.message);
    }
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
    throw new Error(`${errors.join('; ')}; ${e.message}`);
  }
}

// Direct-from-Oracle compute metrics via the Telemetry API (oci_computeagent
// namespace — same API key as everything else, no extra credentials).
// Returns per-metric series of [timestampMs, value] averaged across dimension
// streams (the only instance in this tenancy, so streams usually collapse).
async function ociComputeMetrics(minutes = 180) {
  const c = ociConfig();
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

  // Discover the reader host via listMetrics: only the monitoring READ service
  // serves /20180401/metrics/actions/listMetrics, so a 200 identifies the
  // reader unambiguously (POST /20180401/metrics alone is ambiguous — it is
  // also the ingestion route and some realms route it to ingestion).
  const ensureTelemetryHost = async () => {
    if (telemetryHostCache) return telemetryHostCache;
    const hosts = telemetryHosts();
    const attempts = [];
    for (const h of hosts) {
      const t0 = Date.now();
      try {
        const res = await ociRequest(h, 'POST', '/20180401/metrics/actions/listMetrics', {
          compartmentId: base.compartmentId,
          namespace: base.namespace,
        });
        const body = await res.json().catch(() => ({}));
        const info = errCode(body) || body;
        attempts.push({ h, s: res.status, ms: Date.now() - t0, body: typeof info === 'object' && info.code ? { code: info.code, message: String(info.message || '').slice(0, 80) } : info });
        if (res.ok) {
          telemetryHostCache = h;
          return h;
        }
      } catch (e) {
        attempts.push({ h, ms: Date.now() - t0, error: e.message });
      }
    }
    throw new Error(`No telemetry reader host: ${JSON.stringify(attempts.slice(0, 4))}`);
  };

  const summarize = async (metric) => {
    const h = await ensureTelemetryHost();
    const res = await ociRequest(h, 'POST', '/20180401/metrics', { ...base, name: metric });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const info = errCode(body) || body;
      throw new Error(`Telemetry ${metric} ${res.status} ${JSON.stringify(errCode(info) || info).slice(0, 200)}`);
    }
    return body;
  };
  // Discover the reader host with one cheap metric first, then query the rest
  // only against the winner (keeps call count + rate-limit exposure low).
  const cpuBody = await summarize('CpuUtilization');
  const [memory, filesystem] = await Promise.all([summarize('MemoryUtilization'), summarize('FilesystemCapacityUtilization')]);
  return {
    minutes,
    host: telemetryHostCache,
    cpu: seriesFor(cpuBody, 'CpuUtilization'),
    memory: seriesFor(memory, 'MemoryUtilization'),
    filesystem: seriesFor(filesystem, 'FilesystemCapacityUtilization'),
  };
}

// Short "code: message" pair from an OCI error body, for compact error strings.
function errCode(body) {
  return body && body.code ? { code: body.code, message: body.message } : body;
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
      // compartmentId is a required query param on this route (its 400 told us
      // auth was fine — this was a probe bug, not an IAM signal).
      const r = await ociRequest(`identity.${c.region}.oci.oraclecloud.com`, 'GET', `/20160918/compartments?compartmentId=${encodeURIComponent(c.tenancy)}`, null);
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
  // Direct-from-Oracle compute metrics: proves the IAM user can read monitoring
  // data (different service + policy from the Usage API).
  try {
    const t = await ociComputeMetrics(60);
    steps.push({
      step: 'telemetry oci_computeagent (1h)',
      ok: t.cpu.length > 0 || t.memory.length > 0,
      host: t.host,
      datapoints: { cpu: t.cpu.length, memory: t.memory.length, filesystem: t.filesystem.length },
    });
  } catch (e) {
    steps.push({ step: 'telemetry oci_computeagent (1h)', ok: false, error: e.message.slice(0, 1000) });
  }
  // Region matrix: the /usage query against other region endpoints. Answers
  // "region-locked?" vs "query wrong?" for the cost panel debugging history.
  // (Cross-region auth was rejected with 401 on 2026-11-24 — kept as one call
  // per host for regression evidence, without the retry variants to stay under
  // the Usage API's rate limit.)
  const dayNow = new Date();
  const startDay = new Date(dayNow);
  startDay.setUTCDate(1); startDay.setUTCHours(0, 0, 0, 0);
  const endDay = new Date(dayNow);
  endDay.setUTCHours(0, 0, 0, 0);
  endDay.setUTCDate(endDay.getUTCDate() + 1);
  const altHosts = ['usageapi.eu-frankfurt-1.oci.oraclecloud.com', 'usageapi.us-ashburn-1.oci.oraclecloud.com'];
  for (const alt of altHosts.filter((h) => h !== host)) {
    const t0 = Date.now();
    try {
      const r = await ociRequest(alt, 'POST', '/20200107/usage', {
        tenantId: c.tenancy,
        queryType: 'COST',
        granularity: 'DAILY',
        timeUsageStarted: dayIso(startDay),
        timeUsageEnded: dayIso(endDay),
      });
      const body = await r.json().catch(() => ({}));
      steps.push({ step: `/usage vs ${alt}`, ok: r.ok, status: r.status, ms: Date.now() - t0, bodyPreview: r.ok ? undefined : JSON.stringify({ code: body.code, message: body.message }).slice(0, 150) });
    } catch (e) {
      steps.push({ step: `/usage vs ${alt}`, ok: false, ms: Date.now() - t0, error: e.message });
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
