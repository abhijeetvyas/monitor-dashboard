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

// Month-to-date OCI spend, from the Usage API (Cost query, daily granularity).
async function ociMonthCost() {
  const c = ociConfig();
  const host = `usageapi.${c.region}.oci.oracle.com`;
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(Date.now() + 24 * 3600 * 1000); // usage API needs the day boundary
  const res = await ociRequest(host, 'POST', '/20200107/actions/runQuery', {
    queryType: 'usage',
    tenantId: c.tenancy,
    timeUsageStarted: start.toISOString(),
    timeUsageEnded: end.toISOString(),
    granularity: 'DAILY',
    queryType: 'COST',
    filter: { tags: [], compartmentFilters: [], dimensions: [], freeformTagFilters: [] },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `OCI Usage API ${res.status}`);
  const items = Array.isArray(body.items) ? body.items : (Array.isArray(body) ? body : []);
  return {
    currency: (items[0] && items[0].currency) || 'USD',
    days: items.map((i) => ({
      date: String((i.dimensions && (i.dimensions.timeUsageStarted || i.dimensions.time_usagestarted)) || i.timeUsageStarted || '').slice(0, 10),
      cost: Number(i.computedAmount ?? i.computedamount ?? i.unblendedCost ?? 0),
    })),
    total: items.reduce((a, i) => a + Number(i.computedAmount ?? i.computedamount ?? i.unblendedCost ?? 0), 0),
  };
}

// Diagnostic: config sanity + endpoint reachability + a real signed runQuery.
async function ociProbe() {
  const c = ociConfig();
  const host = `usageapi.${c.region}.oci.oracle.com`;
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
  return {
    region: c.region,
    keyLooksLikePem: c.privateKey.includes('PRIVATE KEY'),
    keyLineCount: c.privateKey.split('\n').length,
    steps,
  };
}

module.exports = { ociConfigured, ociMonthCost, ociProbe };
