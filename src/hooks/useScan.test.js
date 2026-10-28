// src/hooks/useScan.test.js
// Tests for the useScan hook against the REAL web api.js handlers (only the
// network layer, lib/proxy, is mocked). Local-folder scanning, folder import
// and file rescans are desktop-only: in the web build callBackend throws
// NotAvailableInWebError for them, so the Tauri-era tests that asserted
// successful scans were replaced by tests that the error surfaces and no
// state is clobbered.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockSetGroups = vi.fn();
vi.mock('../context/AppContext', () => ({
  useApp: () => ({ setGroups: mockSetGroups }),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, callBackend: vi.fn(actual.callBackend), pickPath: vi.fn() };
});
vi.mock('../lib/proxy', () => ({ absApi: vi.fn(), callAI: vi.fn(), parseAIJson: (s) => JSON.parse(s), proxyFetch: vi.fn() }));

import { callBackend, pickPath, NotAvailableInWebError } from '../api';
import { absApi, callAI } from '../lib/proxy';
import { clearImportSnapshots, recordImportSnapshot } from '../lib/absImport';
import { useScan } from './useScan';

const CONFIG_KEY = 'audiobook_tagger_config';

/** Apply the last functional setGroups update to `prev`. */
const applyLastSetGroups = (prev) => {
  const arg = mockSetGroups.mock.calls.at(-1)[0];
  return typeof arg === 'function' ? arg(prev) : arg;
};

describe('useScan hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ abs_base_url: 'https://abs.example', abs_api_token: 't', abs_library_id: 'lib1' }));
    clearImportSnapshots();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('initial state', () => {
    it('should initialize with scanning false', () => {
      const { result } = renderHook(() => useScan());

      expect(result.current.scanning).toBe(false);
    });

    it('should initialize with empty scan progress', () => {
      const { result } = renderHook(() => useScan());

      expect(result.current.scanProgress.current).toBe(0);
      expect(result.current.scanProgress.total).toBe(0);
      expect(result.current.scanProgress.currentFile).toBe('');
      expect(result.current.scanProgress.filesPerSecond).toBe(0);
      expect(result.current.scanProgress.covers_found).toBe(0);
    });

    it('should provide all expected functions', () => {
      const { result } = renderHook(() => useScan());

      expect(typeof result.current.handleScan).toBe('function');
      expect(typeof result.current.handleImport).toBe('function');
      expect(typeof result.current.handleRescan).toBe('function');
      expect(typeof result.current.handleImportFromAbs).toBe('function');
      expect(typeof result.current.handlePipelineRescan).toBe('function');
      expect(typeof result.current.cancelScan).toBe('function');
      expect(typeof result.current.calculateETA).toBe('function');
    });
  });

  describe('calculateETA', () => {
    it('should return "Calculating..." when no start time', () => {
      const { result } = renderHook(() => useScan());

      expect(result.current.calculateETA()).toBe('Calculating...');
    });

    it('should calculate seconds remaining', () => {
      const { result } = renderHook(() => useScan());

      // Simulate progress with specific values
      act(() => {
        result.current.scanProgress = {
          current: 10,
          total: 100,
          startTime: Date.now() - 10000, // 10 seconds ago
          filesPerSecond: 1,
          currentFile: '',
          covers_found: 0,
        };
      });

      // Note: calculateETA is a callback that depends on scanProgress state
      // In a real implementation, we'd need to update the state properly
    });
  });


  describe('handleScan / handleImport (desktop-only in web)', () => {
    it('does nothing if no folder is picked', async () => {
      vi.mocked(pickPath).mockResolvedValue(null);
      const { result } = renderHook(() => useScan());
      await act(async () => { await result.current.handleScan(); });
      expect(callBackend).not.toHaveBeenCalledWith('scan_library', expect.anything());
      expect(result.current.scanning).toBe(false);
    });

    it('handleScan rejects with NotAvailableInWebError and resets scanning', async () => {
      vi.mocked(pickPath).mockResolvedValue(['/books']);
      const { result } = renderHook(() => useScan());
      let err;
      await act(async () => { await result.current.handleScan().catch(e => { err = e; }); });
      expect(err).toBeInstanceOf(NotAvailableInWebError);
      expect(result.current.scanning).toBe(false);
      expect(mockSetGroups).not.toHaveBeenCalled();
    });

    it('handleImport rejects with NotAvailableInWebError', async () => {
      vi.mocked(pickPath).mockResolvedValue('/books');
      const { result } = renderHook(() => useScan());
      let err;
      await act(async () => { await result.current.handleImport().catch(e => { err = e; }); });
      expect(err).toBeInstanceOf(NotAvailableInWebError);
      expect(mockSetGroups).not.toHaveBeenCalled();
    });
  });

  describe('handleRescan', () => {
    it('should return early if no files selected', async () => {
      const { result } = renderHook(() => useScan());
      let res;
      await act(async () => { res = await result.current.handleRescan(new Set(), []); });
      expect(res).toEqual({ success: false, count: 0 });
    });

    it('does not report success or drop the selected books when the rescan fails', async () => {
      const groups = [{ id: 'g1', files: [{ id: 'f1', path: '/books/A/a.m4b' }], metadata: {} }];
      const { result } = renderHook(() => useScan());
      let err;
      await act(async () => {
        await result.current.handleRescan(new Set(['f1']), groups).catch(e => { err = e; });
      });
      expect(err).toBeInstanceOf(NotAvailableInWebError);
      expect(mockSetGroups).not.toHaveBeenCalled();
      expect(result.current.scanning).toBe(false);
    });
  });

  describe('handleImportFromAbs', () => {
    it('imports from ABS via the web handler and sets groups (series parsed)', async () => {
      vi.mocked(absApi).mockResolvedValueOnce({
        results: [{ id: 'b1', media: { metadata: { title: 'Light Bringer', authorName: 'Pierce Brown', seriesName: 'Red Rising #6' }, tags: ['dna:pacing:fast'] } }],
        total: 1,
      });
      const { result } = renderHook(() => useScan());
      let res;
      await act(async () => { res = await result.current.handleImportFromAbs(); });

      expect(res).toEqual({ success: true, count: 1 });
      const groups = mockSetGroups.mock.calls[0][0];
      expect(groups[0]).toMatchObject({ id: 'b1', abs_id: 'b1' });
      expect(groups[0].metadata).toMatchObject({ series: 'Red Rising', sequence: '6', tags: ['dna:pacing:fast'] });
    });

    it('propagates ABS errors', async () => {
      vi.mocked(absApi).mockRejectedValueOnce(new Error('ABS API error 401: nope'));
      const { result } = renderHook(() => useScan());
      let err;
      await act(async () => { await result.current.handleImportFromAbs().catch(e => { err = e; }); });
      expect(err.message).toContain('401');
      expect(result.current.scanning).toBe(false);
    });
  });

  describe('handlePushAbsImports', () => {
    const meta = { title: 'T', author: 'A', tags: ['dna:pacing:fast', 'favorites'], genres: ['Fantasy'] };

    it('returns success:false with counts and errors when any item failed', async () => {
      recordImportSnapshot('b1', meta);
      recordImportSnapshot('b2', meta);
      vi.mocked(absApi)
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('ABS API error 500: boom'));
      const { result } = renderHook(() => useScan());
      let res;
      await act(async () => {
        res = await result.current.handlePushAbsImports([
          { id: 'b1', metadata: { ...meta, title: 'T1' } },
          { id: 'b2', metadata: { ...meta, title: 'T2' } },
        ]);
      });
      expect(res).toMatchObject({ success: false, updated: 1, failed: 1 });
      expect(res.errors[0]).toContain('boom');
    });

    it('only sends changed fields (title edit does not touch tags/genres)', async () => {
      recordImportSnapshot('b1', meta);
      vi.mocked(absApi).mockResolvedValue({});
      const { result } = renderHook(() => useScan());
      let res;
      await act(async () => {
        res = await result.current.handlePushAbsImports([{ id: 'b1', metadata: { ...meta, title: 'New' } }]);
      });
      expect(res).toMatchObject({ success: true, updated: 1, failed: 0 });
      expect(vi.mocked(absApi).mock.calls[0][3].body).toEqual({ metadata: { title: 'New' } });
    });
  });

  describe('cancelScan', () => {
    it('should call cancel_scan and reset state', async () => {
      const { result } = renderHook(() => useScan());
      await act(async () => { await result.current.cancelScan(); });
      expect(callBackend).toHaveBeenCalledWith('cancel_scan');
      expect(result.current.scanning).toBe(false);
    });
  });

  describe('handlePipelineRescan', () => {
    it('should return early if no groups selected', async () => {
      const { result } = renderHook(() => useScan());
      let res;
      await act(async () => { res = await result.current.handlePipelineRescan([]); });
      expect(res).toEqual({ success: false, count: 0 });
    });

    it('merges AI tags into existing tags (dna:* and user tags kept) and keeps genres when AI returns none', async () => {
      vi.mocked(callAI)
        .mockResolvedValueOnce(JSON.stringify({ genres: [], tags: ['cozy', 'a'] })) // classify
        .mockResolvedValueOnce(JSON.stringify({ pacing: 'slow' }))                 // dna
        .mockResolvedValueOnce(JSON.stringify({ action: 'kept' }));                // description
      const group = { id: 'b1', metadata: { title: 'T', author: 'A', genres: ['Mystery'], tags: ['dna:theme:faith', 'favorites'] } };
      const { result } = renderHook(() => useScan());
      await act(async () => { await result.current.handlePipelineRescan([group]); });

      const [updated] = applyLastSetGroups([group]);
      expect(updated.metadata.genres).toEqual(['Mystery']);
      expect(updated.metadata.tags).toEqual(['dna:theme:faith', 'favorites', 'cozy', 'dna:pacing:slow']);
    });
  });
});
