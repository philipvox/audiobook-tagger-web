import { describe, it, expect, vi } from 'vitest';

vi.mock('./lib/proxy', () => ({
  absApi: vi.fn(), callAI: vi.fn(), parseAIJson: (s) => JSON.parse(s), proxyFetch: vi.fn(),
}));

import { callBackend, subscribe, NotAvailableInWebError } from './api';

describe('callBackend for commands the web build does not implement', () => {
  it('rejects with a clear error instead of returning a fake-success stub', async () => {
    await expect(callBackend('write_tags', {})).rejects.toThrow(/not available in the web version/i);
    await expect(callBackend('write_tags', {})).rejects.toBeInstanceOf(NotAvailableInWebError);
  });

  it('emits backend_unavailable so the UI can toast even if a caller swallows the error', async () => {
    const seen = [];
    const off = subscribe('backend_unavailable', (d) => seen.push(d));
    await callBackend('export_to_csv', {}).catch(() => {});
    off();
    expect(seen).toEqual([expect.objectContaining({ cmd: 'export_to_csv' })]);
  });

  it('cancel_series_scan is a harmless no-op (nothing to cancel in web)', async () => {
    await expect(callBackend('cancel_series_scan')).resolves.toBeDefined();
  });
});

describe('get_abs_cache_status', () => {
  it('returns the fields useAbsCache reads', async () => {
    const s = await callBackend('get_abs_cache_status');
    expect(s).toMatchObject({ is_loaded: false, is_stale: true });
  });
});
