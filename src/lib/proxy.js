// src/lib/proxy.js
// Smart fetch — ABS requests go direct first and fall back to the CORS proxy
// worker only when the browser blocks them (CORS/network TypeError). AI
// requests never use the worker: official OpenAI/Anthropic go through the
// same-origin /api/* reverse proxy of the host serving the app, custom base
// URLs go direct only.

const PROXY_URL = import.meta.env.VITE_PROXY_URL || 'https://audiobook-tagger-proxy.philipvox.workers.dev';

/**
 * Fetch with an AbortController timeout.
 * @param {string} url
 * @param {object} options - standard fetch options
 * @param {number} timeoutMs - timeout in milliseconds
 * @returns {Promise<Response>}
 */
function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

function isAbortError(err) {
  return err?.name === 'AbortError' || err?.name === 'TimeoutError';
}

/**
 * Fetch a URL directly; fall back to the CORS proxy worker ONLY when the
 * direct request failed with a genuine CORS/network error (fetch rejects with
 * a TypeError). Timeouts/aborts and other errors are thrown as-is — retrying
 * them through the worker would send the credentials to a third party and,
 * for AI calls, bill the request twice.
 *
 * @param {string} targetUrl - The actual API URL to call
 * @param {object} options - { method, headers, body }
 * @param {number} timeoutMs - timeout in milliseconds (default 30000)
 * @param {object} [opts]
 * @param {boolean} [opts.allowProxyFallback=true] - false = never use the worker
 * @returns {Promise<Response>} - The response
 */
export async function proxyFetch(targetUrl, options = {}, timeoutMs = 30000, { allowProxyFallback = true } = {}) {
  const { method = 'GET', headers = {}, body = null } = options;

  // Try direct fetch first (works same-origin or if server allows CORS)
  try {
    const directOpts = { method, headers: { ...headers }, credentials: 'omit' };
    if (body && method !== 'GET' && method !== 'HEAD') {
      directOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetchWithTimeout(targetUrl, directOpts, timeoutMs);
    res._connectionType = 'direct';
    return res;
  } catch (directError) {
    if (isAbortError(directError)) {
      throw new Error(`Request to ${safeHost(targetUrl)} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    if (!(directError instanceof TypeError)) throw directError;
    if (!allowProxyFallback) {
      throw new Error(`Could not reach ${safeHost(targetUrl)} directly (CORS or network error). `
        + 'This request is never sent through the CORS proxy; enable CORS on that server.');
    }
    // Genuine CORS/network failure — fall through to the proxy.
  }

  // Fall back to CORS proxy
  const res = await fetchWithTimeout(`${PROXY_URL}/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: targetUrl,
      method,
      headers,
      body,
    }),
  }, timeoutMs);

  res._connectionType = 'proxy';
  return res;
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return 'server'; }
}

/** Direct request only — used for AI endpoints. */
function directOnly(url, options, timeoutMs) {
  return proxyFetch(url, options, timeoutMs, { allowProxyFallback: false });
}

/**
 * Test whether a direct connection to the ABS server works (no proxy).
 * Returns { direct: true/false, proxy: true/false, error?: string }
 */
export async function testConnection(absBaseUrl, absToken) {
  const url = `${absBaseUrl.replace(/\/$/, '')}/api/libraries`;
  const headers = {
    'Authorization': `Bearer ${absToken}`,
    'Content-Type': 'application/json',
  };
  const result = { direct: false, proxy: false };

  // Test direct
  let corsBlocked = false;
  try {
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers,
      credentials: 'omit',
    }, 10000);
    if (res.ok) result.direct = true;
  } catch (e) {
    // Only a CORS/network TypeError justifies trying the proxy (not a timeout).
    corsBlocked = e instanceof TypeError;
    if (!corsBlocked) result.error = isAbortError(e) ? 'Timed out connecting to ABS' : e.message;
  }

  // Test proxy (only if the browser blocked the direct request)
  if (!result.direct && corsBlocked) {
    try {
      const res = await fetchWithTimeout(`${PROXY_URL}/proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, method: 'GET', headers }),
      }, 10000);
      if (res.ok) result.proxy = true;
    } catch (e) {
      result.error = e.message;
    }
  }

  return result;
}

/**
 * Call an ABS API endpoint through the proxy.
 * @param {string} absBaseUrl - e.g., 'https://my-abs.com'
 * @param {string} absToken - ABS API token
 * @param {string} path - e.g., '/api/libraries'
 * @param {object} options - { method, body }
 */
export async function absApi(absBaseUrl, absToken, path, options = {}) {
  const { method = 'GET', body = null } = options;
  const url = `${absBaseUrl.replace(/\/$/, '')}${path}`;

  const res = await proxyFetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${absToken}`,
      'Content-Type': 'application/json',
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ABS API error ${res.status}: ${text}`);
  }

  return res.json();
}

/**
 * Call OpenAI API through the proxy.
 * @param {string} apiKey - OpenAI API key
 * @param {string} model - e.g., 'gpt-5.4-nano'
 * @param {string} systemPrompt - System message
 * @param {string} userPrompt - User message
 * @param {number} maxTokens - Max output tokens
 * @param {string} baseUrl - API base URL (default: https://api.openai.com)
 */
export async function callOpenAI(apiKey, model, systemPrompt, userPrompt, maxTokens = 2000, baseUrl = 'https://api.openai.com') {
  const isGpt5 = model.startsWith('gpt-5');
  const useResponsesApi = isGpt5;

  // Route through Caddy proxy if on same origin, otherwise use proxyFetch
  const useLocalProxy = typeof window !== 'undefined' && baseUrl === 'https://api.openai.com';
  const apiBase = useLocalProxy ? '/api/openai' : baseUrl;

  let endpoint, body;

  if (useResponsesApi) {
    endpoint = `${apiBase}/v1/responses`;
    body = {
      model,
      input: [
        { role: 'developer', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_output_tokens: maxTokens,
      text: { format: { type: 'json_object' } },
      reasoning: { effort: 'minimal' },
    };
  } else {
    endpoint = `${apiBase}/v1/chat/completions`;
    body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: maxTokens,
    };
  }

  // AI requests are never retried through the CORS worker (keys + billing).
  const fetchFn = useLocalProxy ? fetchWithTimeout : directOnly;
  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }, 90000);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${text}`);
  }

  const data = await res.json();

  // Parse response based on API type
  if (useResponsesApi) {
    if (data.output_text) return data.output_text.trim();
    const text = data.output
      ?.find(item => item.type === 'message')
      ?.content?.find(c => c.type === 'output_text' || c.type === 'text')
      ?.text;
    if (text) return text.trim();
    throw new Error('No text in OpenAI Responses API response');
  } else {
    const content = data.choices?.[0]?.message?.content;
    if (content) return content.trim();
    throw new Error('No content in OpenAI Chat response');
  }
}

/**
 * Call Anthropic Claude API through the proxy.
 * @param {string} apiKey - Anthropic API key
 * @param {string} model - e.g., 'claude-haiku-4-5-20251001'
 * @param {string} systemPrompt - System message
 * @param {string} userPrompt - User message
 * @param {number} maxTokens - Max output tokens
 */
export async function callAnthropic(apiKey, model, systemPrompt, userPrompt, maxTokens = 2000, baseUrl = 'https://api.anthropic.com') {
  // Route through Caddy local proxy only when hitting the official Anthropic URL.
  // Custom base URLs (in-house LLM proxies) go direct only — no CORS-worker fallback.
  const isOfficial = baseUrl === 'https://api.anthropic.com';
  const useLocalProxy = typeof window !== 'undefined' && isOfficial;
  const endpoint = useLocalProxy
    ? '/api/anthropic/v1/messages'
    : `${baseUrl.replace(/\/$/, '')}/v1/messages`;
  // AI requests are never retried through the CORS worker (keys + billing).
  const fetchFn = useLocalProxy ? fetchWithTimeout : directOnly;

  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  }, 90000);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const text = data.content?.find(c => c.type === 'text')?.text;
  if (text) return text.trim();
  throw new Error('No text in Anthropic response');
}

/**
 * Call the configured AI provider (OpenAI or Anthropic).
 * Auto-detects based on model name.
 * @param {object} config - App config with api keys and model settings
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {number} maxTokens
 */
export async function callAI(config, systemPrompt, userPrompt, maxTokens = 2000) {
  const model = config.ai_model || 'gpt-5-nano';
  // Explicit provider takes precedence; fall back to model-name heuristic for legacy configs.
  const provider = config.ai_provider
    || (model.startsWith('claude') ? 'anthropic' : 'openai');

  if (provider === 'anthropic') {
    const key = config.anthropic_api_key;
    if (!key) throw new Error('No Anthropic API key configured. Add one in Settings.');
    const baseUrl = config.anthropic_base_url || 'https://api.anthropic.com';
    return callAnthropic(key, model, systemPrompt, userPrompt, maxTokens, baseUrl);
  } else {
    const key = config.openai_api_key;
    if (!key) throw new Error('No OpenAI API key configured. Add one in Settings.');
    const baseUrl = config.openai_base_url || config.ai_base_url || 'https://api.openai.com';
    return callOpenAI(key, model, systemPrompt, userPrompt, maxTokens, baseUrl);
  }
}

/**
 * Parse a JSON response from AI, handling markdown code blocks.
 */
export function parseAIJson(text) {
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Failed to parse AI response as JSON: ${e.message}\nResponse was: ${cleaned.substring(0, 200)}`);
  }
}
