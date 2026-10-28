import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { proxyFetch, callOpenAI, callAnthropic } from './proxy';

const okResponse = (body = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const isProxyCall = (call) => String(call[0]).endsWith('/proxy');

let fetchMock;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('proxyFetch fallback rules', () => {
  it('falls back to the worker only on a CORS/network TypeError', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(okResponse());
    const res = await proxyFetch('https://abs.example/api/libraries', { headers: { Authorization: 'Bearer t' } });
    expect(res._connectionType).toBe('proxy');
    expect(isProxyCall(fetchMock.mock.calls[1])).toBe(true);
  });

  it('does NOT fall back on a timeout/abort', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    fetchMock.mockRejectedValueOnce(abort);
    await expect(proxyFetch('https://abs.example/api/libraries')).rejects.toThrow(/timed out|aborted/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall back on non-TypeError failures', async () => {
    fetchMock.mockRejectedValueOnce(new Error('weird'));
    await expect(proxyFetch('https://abs.example/x')).rejects.toThrow('weird');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never falls back when allowProxyFallback is false', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(proxyFetch('https://llm.example/v1/x', {}, 1000, { allowProxyFallback: false })).rejects.toThrow(/proxy/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('AI calls never go through the CORS worker', () => {
  it('OpenAI-compatible custom base URL: CORS failure is an error, not a proxied retry', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(callOpenAI('sk-x', 'gpt-4o', 's', 'u', 10, 'https://llm.example')).rejects.toThrow();
    expect(fetchMock.mock.calls.some(isProxyCall)).toBe(false);
  });

  it('Anthropic custom base URL: CORS failure is an error, not a proxied retry', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(callAnthropic('k', 'claude-x', 's', 'u', 10, 'https://llm.example')).rejects.toThrow();
    expect(fetchMock.mock.calls.some(isProxyCall)).toBe(false);
  });
});
