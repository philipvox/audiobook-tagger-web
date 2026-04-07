// Cloudflare Worker — CORS proxy for Audiobook Tagger
// Forwards requests to ABS, OpenAI, Anthropic with CORS headers.
//
// Security:
// - Origin validation: only requests from allowed origins are processed
// - Known API domains whitelisted (OpenAI, Anthropic)
// - User ABS servers allowed only with valid origin
// - Private/local IPs blocked (RFC 1918, link-local, loopback)
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

// Block all private/reserved IP ranges
const BLOCKED_PREFIXES = [
  'localhost', '127.', '0.0.0.0', '::1',
  '169.254.', '10.', '192.168.',
  '172.16.', '172.17.', '172.18.', '172.19.',
  '172.20.', '172.21.', '172.22.', '172.23.',
  '172.24.', '172.25.', '172.26.', '172.27.',
  '172.28.', '172.29.', '172.30.', '172.31.',
  'fc00:', 'fd00:', 'fe80:',
];

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

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, 300_000);

function isAllowedTarget(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;

    // Block private IPs
    if (BLOCKED_PREFIXES.some(b => host.startsWith(b) || host === b)) return false;

    // Must be HTTPS
    if (parsed.protocol !== 'https:') return false;

    return true;
  } catch {
    return false;
  }
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

      const response = await fetch(targetUrl, fetchOpts);

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
