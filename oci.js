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

  return fetch(url, {
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
  const items = body.items || body || [];
  return {
    currency: (items[0] && items[0].currency) || 'USD',
    days: items.map((i) => ({
      date: String((i.dimensions && (i.dimensions.timeUsageStarted || i.dimensions.time_usagestarted)) || i.timeUsageStarted || '').slice(0, 10),
      cost: Number(i.computedAmount ?? i.computedamount ?? i.unblendedCost ?? 0),
    })),
    total: items.reduce((a, i) => a + Number(i.computedAmount ?? i.computedamount ?? i.unblendedCost ?? 0), 0),
  };
}

module.exports = { ociConfigured, ociMonthCost };
