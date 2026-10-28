// Cloudflare Worker — CORS proxy for Audiobook Tagger
// Forwards requests to ABS, OpenAI, Anthropic with CORS headers.
//
// Security:
// - Origin validation: only requests from allowed origins are processed
// - Known API domains whitelisted (OpenAI, Anthropic)
// - User ABS servers allowed only with valid origin
// - Private/local targets blocked: RFC 1918, CGNAT, link-local, loopback,
//   multicast/reserved; decimal/octal/hex IPv4 forms (normalized by the URL
//   parser); IPv6 loopback/unspecified, IPv4-mapped/NAT64 forms, fc00::/7,
//   fe80::/10, multicast; localhost and *.localhost
// - Redirects are never followed automatically: each hop is re-validated
//   (max 3) and credentials are dropped when the origin changes
// - HTTPS-only targets enforced
// - Only safe headers forwarded to targets
// - Per-IP rate limiting (100 req/min)
//
// Environment variables (set in Cloudflare dashboard):
//   ALLOWED_ORIGINS — comma-separated list of allowed origins
//                     e.g. "https://username.github.io,https://my-app.com"
//                     If unset, all origins are allowed (dev mode)

// Only these headers are forwarded to target servers
const SAFE_HEADERS = new Set([
  'content-type',
  'authorization',
  'x-api-key',
  'anthropic-version',
  'accept',
  'accept-language',
]);

const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

// Known API domains that are always allowed as targets
const KNOWN_API_DOMAINS = new Set([
  'api.openai.com',
  'api.anthropic.com',
]);

// ---------------------------------------------------------------------------
// Target validation (SSRF). The WHATWG URL parser already normalizes
// "127.1", "2130706433", "0x7f000001", "017700000001" to dotted IPv4 and
// compresses IPv6, so we check the parsed hostname numerically.
// ---------------------------------------------------------------------------

function parseIPv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every(n => n >= 0 && n <= 255) ? o : null;
}

function isBlockedIPv4([a, b, c]) {
  return a === 0                                  // 0.0.0.0/8 "this network"
    || a === 10                                   // 10/8
    || a === 127                                  // loopback
    || (a === 100 && b >= 64 && b <= 127)         // 100.64/10 CGNAT
    || (a === 169 && b === 254)                   // link-local / metadata
    || (a === 172 && b >= 16 && b <= 31)          // 172.16/12
    || (a === 192 && b === 168)                   // 192.168/16
    || (a === 192 && b === 0 && c === 0)          // 192.0.0/24
    || (a === 198 && (b === 18 || b === 19))      // benchmarking
    || a >= 224;                                  // multicast + reserved + broadcast
}

/** Parse a (bracket-less) IPv6 literal into 8 16-bit groups, or null. */
function parseIPv6(host) {
  if (!host.includes(':')) return null;
  let h = host.toLowerCase();
  // Embedded dotted IPv4 tail (e.g. ::ffff:127.0.0.1) → two hex groups.
  const v4 = h.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) {
    const o = parseIPv4(v4[2]);
    if (!o) return null;
    h = v4[1] + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part) => (part ? part.split(':') : []);
  const left = toGroups(halves[0]);
  const right = halves.length === 2 ? toGroups(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0) return null;
  const groups = [...left, ...Array(fill).fill('0'), ...right];
  if (groups.length !== 8) return null;
  const nums = groups.map(g => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

function embeddedIPv4(g) {
  return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff];
}

function isBlockedIPv6(g) {
  const allZeroPrefix = (n) => g.slice(0, n).every(x => x === 0);
  if (g.every(x => x === 0)) return true;                       // ::
  if (allZeroPrefix(7) && g[7] === 1) return true;              // ::1
  if (allZeroPrefix(5) && g[5] === 0xffff) return true;       // ::ffff:0:0/96 IPv4-mapped (never needed)
  if (allZeroPrefix(6)) return true;                            // ::a.b.c.d (deprecated compat)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return isBlockedIPv4(embeddedIPv4(g)); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true;                  // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true;                  // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true;                  // fec0::/10 site-local
  if ((g[0] & 0xff00) === 0xff00) return true;                  // multicast
  if (g[0] === 0x2002) return isBlockedIPv4([g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff]); // 6to4
  return false;
}

export function isBlockedHostname(hostname) {
  let host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = parseIPv4(host);
  if (v4) return isBlockedIPv4(v4);
  if (host.includes(':')) {
    const v6 = parseIPv6(host);
    return v6 ? isBlockedIPv6(v6) : true; // unparseable IPv6 literal → block
  }
  // A purely numeric/hex-looking host that the URL parser did not normalize
  // to dotted IPv4 is suspicious; block it.
  if (/^[0-9.]+$/.test(host) || /^0x[0-9a-f.]+$/i.test(host)) return true;
  return false;
}

// Simple in-memory rate limiter (per worker instance)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 100;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) return false;
  return true;
}

// Clean up stale rate limit entries inline (no global setInterval allowed)
function cleanupRateLimits() {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(ip);
    }
  }
}

export function isAllowedTarget(url) {
  try {
    const parsed = new URL(url);
    // Must be HTTPS
    if (parsed.protocol !== 'https:') return false;
    // No credentials embedded in the URL
    if (parsed.username || parsed.password) return false;
    // Block private / loopback / link-local / reserved targets
    if (isBlockedHostname(parsed.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

const MAX_REDIRECTS = 3;
const CREDENTIAL_HEADERS = ['authorization', 'x-api-key'];

/**
 * fetch() without automatic redirects. Each Location is re-validated with
 * isAllowedTarget; credentials are dropped when the origin changes; 303 (and
 * 301/302 for non-GET) switch to a bodyless GET, like browsers do.
 * Returns { response } or { blocked: true }.
 */
async function fetchWithValidatedRedirects(targetUrl, fetchOpts) {
  let url = targetUrl;
  let opts = { ...fetchOpts, redirect: 'manual' };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(url, opts);
    const location = response.headers.get('Location');
    if (response.status < 300 || response.status >= 400 || !location) {
      return { response };
    }
    if (hop === MAX_REDIRECTS) return { tooMany: true };
    const next = new URL(location, url).toString();
    if (!isAllowedTarget(next)) return { blocked: true };
    const headers = { ...opts.headers };
    if (new URL(next).origin !== new URL(url).origin) {
      for (const k of Object.keys(headers)) {
        if (CREDENTIAL_HEADERS.includes(k.toLowerCase())) delete headers[k];
      }
    }
    const toGet = response.status === 303 || ((response.status === 301 || response.status === 302) && opts.method !== 'GET');
    opts = toGet
      ? { method: 'GET', headers, redirect: 'manual' }
      : { ...opts, headers, redirect: 'manual' };
    url = next;
  }
  return { tooMany: true };
}

function isAllowedOrigin(origin, env) {
  if (!origin) return false;

  const allowedStr = env?.ALLOWED_ORIGINS;
  // If no ALLOWED_ORIGINS configured, allow all (dev mode — deploy with this set!)
  if (!allowedStr) return true;

  const allowed = allowedStr.split(',').map(s => s.trim().toLowerCase());
  return allowed.includes(origin.toLowerCase());
}

function filterHeaders(headers) {
  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SAFE_HEADERS.has(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version',
    'Access-Control-Max-Age': '3600',
  };
}

function jsonResponse(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    cleanupRateLimits();
    const origin = request.headers.get('Origin') || '';

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Health check
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return jsonResponse({ status: 'ok', service: 'audiobook-tagger-proxy' }, 200, origin);
    }

    // Only accept POST to /proxy
    if (url.pathname !== '/proxy' || request.method !== 'POST') {
      return jsonResponse({ error: 'Use POST /proxy' }, 400, origin);
    }

    // Validate origin
    if (!isAllowedOrigin(origin, env)) {
      return jsonResponse({ error: 'Origin not allowed' }, 403, origin);
    }

    // Rate limiting by IP
    const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!checkRateLimit(clientIp)) {
      return jsonResponse({ error: 'Rate limit exceeded. Try again in a minute.' }, 429, origin);
    }

    // Check content length (1MB limit)
    const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
    if (contentLength > 1_048_576) {
      return jsonResponse({ error: 'Request body too large (max 1MB)' }, 413, origin);
    }

    try {
      const req = await request.json();
      const { url: targetUrl, method = 'GET', headers = {}, body = null } = req;

      // Validate target URL
      if (!targetUrl || typeof targetUrl !== 'string') {
        return jsonResponse({ error: 'Missing or invalid url field' }, 400, origin);
      }

      // Validate method
      if (!ALLOWED_METHODS.includes(method.toUpperCase())) {
        return jsonResponse({ error: `Method '${method}' not allowed` }, 400, origin);
      }

      // Check if target is allowed (HTTPS + no private IPs)
      if (!isAllowedTarget(targetUrl)) {
        return jsonResponse({ error: 'Target URL not allowed (private IP or non-HTTPS)' }, 403, origin);
      }

      // Filter headers — only forward safe ones
      const safeHeaders = filterHeaders(headers);

      // Forward the request
      const fetchOpts = { method: method.toUpperCase(), headers: safeHeaders };

      if (body && method !== 'GET' && method !== 'HEAD') {
        fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
      }

      const result = await fetchWithValidatedRedirects(targetUrl, fetchOpts);
      if (result.blocked) {
        return jsonResponse({ error: 'Redirect target not allowed (private IP or non-HTTPS)' }, 403, origin);
      }
      if (result.tooMany) {
        return jsonResponse({ error: 'Too many redirects' }, 502, origin);
      }
      const response = result.response;

      // Return response with CORS headers
      const responseHeaders = new Headers(response.headers);
      for (const [k, v] of Object.entries(corsHeaders(origin))) {
        responseHeaders.set(k, v);
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (err) {
      return jsonResponse({ error: err.message }, 500, origin);
    }
  },
};
