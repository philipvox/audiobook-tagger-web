// Tests for the Cloudflare CORS-proxy worker (worker/index.js).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker, { isAllowedTarget } from '../worker/index.js';

describe('worker isAllowedTarget', () => {
  it.each([
    'https://localhost/', 'https://foo.localhost/',
    'https://127.0.0.1/', 'https://127.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://017700000001/', 'https://0x7f.0.0.1/',
    'https://10.0.0.5/', 'https://172.16.3.4/', 'https://192.168.1.1/', 'https://169.254.169.254/', 'https://0.0.0.0/', 'https://100.64.0.1/',
    'https://[::1]/', 'https://[::]/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:7f00:1]/', 'https://[::ffff:10.0.0.1]/',
    'https://[fc00::1]/', 'https://[fd12:3456::1]/', 'https://[fe80::1]/', 'https://[febf::1]/', 'https://[64:ff9b::7f00:1]/',
    'http://abs.example.com/', 'ftp://abs.example.com/', 'not a url',
  ])('blocks %s', (url) => {
    expect(isAllowedTarget(url)).toBe(false);
  });

  it.each([
    'https://secretlibrary.org/api/libraries', 'https://api.openai.com/v1/x', 'https://8.8.8.8/',
    'https://[2606:4700::1111]/', 'https://172.32.0.1/', 'https://fc00.example.com/',
  ])('allows %s', (url) => {
    expect(isAllowedTarget(url)).toBe(true);
  });
});

describe('worker redirect handling', () => {
  let fetchMock;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  const proxyReq = (target) => new Request('https://worker.example/proxy', {
    method: 'POST',
    headers: { Origin: 'https://tagger.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: target, method: 'GET', headers: { Authorization: 'Bearer t' } }),
  });

  it('does not let fetch follow redirects automatically', async () => {
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await worker.fetch(proxyReq('https://abs.example.com/api'), {});
    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');
  });

  it('refuses a redirect to a private address', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/admin' } }));
    const res = await worker.fetch(proxyReq('https://abs.example.com/api'), {});
    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows a safe redirect, dropping credentials when the origin changes', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://cdn.example.net/file' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await worker.fetch(proxyReq('https://abs.example.com/api'), {});
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[1][0]).toBe('https://cdn.example.net/file');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBeUndefined();
  });
});
