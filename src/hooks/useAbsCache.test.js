// src/hooks/useAbsCache.test.js
// Tests for the useAbsCache hook against the REAL web api.js handlers.
// The web build has no local library cache: status is "not loaded / stale",
// list getters return empty, and per-item cache lookups are desktop-only
// (callBackend throws NotAvailableInWebError, which the hook turns into
// null / []). Tauri-era tests that asserted a populated cache were removed —
// that behavior does not exist in the web build.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, callBackend: vi.fn(actual.callBackend) };
});
vi.mock('../lib/proxy', () => ({ absApi: vi.fn(), callAI: vi.fn(), parseAIJson: JSON.parse, proxyFetch: vi.fn() }));

import { callBackend } from '../api';
import { useAbsCache } from './useAbsCache';

describe('useAbsCache hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  describe('initial state', () => {
    it('should initialize with correct default state', async () => {
      const { result } = renderHook(() => useAbsCache());

      await waitFor(() => {
        expect(callBackend).toHaveBeenCalledWith('get_abs_cache_status');
      });

      expect(result.current.refreshing).toBe(false);
      expect(result.current.refreshProgress).toBe(null);
    });

    it('maps the web status fields (is_loaded / is_stale) on mount', async () => {
      const { result } = renderHook(() => useAbsCache());

      await waitFor(() => {
        expect(callBackend).toHaveBeenCalledWith('get_abs_cache_status');
      });

      expect(result.current.cacheStatus.isLoaded).toBe(false);
      expect(result.current.cacheStatus.isStale).toBe(true);
      expect(result.current.cacheStatus.stats).toEqual({ total_items: 0 });
    });
  });

  describe('checkCacheStatus', () => {
    it('should return cache status from the web handler', async () => {
      const { result } = renderHook(() => useAbsCache());

      let status;
      await act(async () => {
        status = await result.current.checkCacheStatus();
      });

      expect(status).toMatchObject({ is_loaded: false, is_stale: true });
    });

    it('accepts the legacy `stale` field', async () => {
      vi.mocked(callBackend).mockResolvedValueOnce({ stale: false, is_loaded: true, stats: { total_items: 3 } });
      const { result } = renderHook(() => useAbsCache());

      await waitFor(() => {
        expect(result.current.cacheStatus.isLoaded).toBe(true);
      });
      expect(result.current.cacheStatus.isStale).toBe(false);
    });

    it('should handle errors gracefully', async () => {
      const { result } = renderHook(() => useAbsCache());
      await waitFor(() => expect(callBackend).toHaveBeenCalled());

      vi.mocked(callBackend).mockRejectedValueOnce(new Error('boom'));
      let status;
      await act(async () => {
        status = await result.current.checkCacheStatus();
      });

      expect(status).toBe(null);
    });
  });

  describe('refreshCache', () => {
    it('resolves and clears the refreshing state', async () => {
      const { result } = renderHook(() => useAbsCache());

      await act(async () => {
        await result.current.refreshCache();
      });

      expect(callBackend).toHaveBeenCalledWith('refresh_abs_cache');
      expect(result.current.refreshing).toBe(false);
      expect(result.current.refreshProgress).toBe(null);
    });

    it('should throw on refresh error', async () => {
      const { result } = renderHook(() => useAbsCache());
      await waitFor(() => expect(callBackend).toHaveBeenCalled());
      vi.mocked(callBackend).mockRejectedValueOnce(new Error('Refresh failed'));

      await expect(act(async () => {
        await result.current.refreshCache();
      })).rejects.toThrow('Refresh failed');
      expect(result.current.refreshing).toBe(false);
    });
  });

  describe('getCachedItems', () => {
    it('returns an empty list in the web build', async () => {
      const { result } = renderHook(() => useAbsCache());

      let items;
      await act(async () => {
        items = await result.current.getCachedItems();
      });

      expect(items).toEqual([]);
    });
  });

  describe('desktop-only cache lookups', () => {
    it('getCachedItem returns null (command not available in web)', async () => {
      const { result } = renderHook(() => useAbsCache());

      let item;
      await act(async () => {
        item = await result.current.getCachedItem('item-1');
      });

      expect(callBackend).toHaveBeenCalledWith('get_cached_item', { id: 'item-1' });
      expect(item).toBe(null);
    });

    it('searchCachedItems returns [] (command not available in web)', async () => {
      const { result } = renderHook(() => useAbsCache());

      let items;
      await act(async () => {
        items = await result.current.searchCachedItems('dune');
      });

      expect(callBackend).toHaveBeenCalledWith('search_cached_items', { query: 'dune' });
      expect(items).toEqual([]);
    });
  });

  describe('clearCache', () => {
    it('should clear cache and reset status', async () => {
      const { result } = renderHook(() => useAbsCache());

      await act(async () => {
        await result.current.clearCache();
      });

      expect(callBackend).toHaveBeenCalledWith('clear_abs_full_cache');
      expect(result.current.cacheStatus).toEqual({ isLoaded: false, isStale: true, stats: null });
    });
  });

  describe('formatDuration', () => {
    it('should format null as dash', () => {
      const { result } = renderHook(() => useAbsCache());

      expect(result.current.formatDuration(null)).toBe('-');
      expect(result.current.formatDuration(undefined)).toBe('-');
      expect(result.current.formatDuration(0)).toBe('-');
    });

    it('should format minutes correctly', () => {
      const { result } = renderHook(() => useAbsCache());

      expect(result.current.formatDuration(60)).toBe('1m');
      expect(result.current.formatDuration(300)).toBe('5m');
      expect(result.current.formatDuration(1800)).toBe('30m');
    });

    it('should format hours and minutes', () => {
      const { result } = renderHook(() => useAbsCache());

      expect(result.current.formatDuration(3600)).toBe('1h 0m');
      expect(result.current.formatDuration(3660)).toBe('1h 1m');
      expect(result.current.formatDuration(7200)).toBe('2h 0m');
      expect(result.current.formatDuration(36000)).toBe('10h 0m');
    });
  });

  describe('formatBytes', () => {
    it('should format null as dash', () => {
      const { result } = renderHook(() => useAbsCache());

      expect(result.current.formatBytes(null)).toBe('-');
      expect(result.current.formatBytes(undefined)).toBe('-');
      expect(result.current.formatBytes(0)).toBe('-');
    });

    it('should format KB correctly', () => {
      const { result } = renderHook(() => useAbsCache());

      expect(result.current.formatBytes(1024)).toBe('1 KB');
      expect(result.current.formatBytes(500 * 1024)).toBe('500 KB');
    });

    it('should format MB correctly', () => {
      const { result } = renderHook(() => useAbsCache());

      const mb = 1024 * 1024;
      expect(result.current.formatBytes(mb)).toBe('1.0 MB');
      expect(result.current.formatBytes(500 * mb)).toBe('500.0 MB');
    });

    it('should format GB correctly', () => {
      const { result } = renderHook(() => useAbsCache());

      const gb = 1024 * 1024 * 1024;
      expect(result.current.formatBytes(gb)).toBe('1.00 GB');
      expect(result.current.formatBytes(2.5 * gb)).toBe('2.50 GB');
    });
  });

  describe('formatCacheAge', () => {
    it('should format null as Never', () => {
      const { result } = renderHook(() => useAbsCache());

      expect(result.current.formatCacheAge(null)).toBe('Never');
      expect(result.current.formatCacheAge(undefined)).toBe('Never');
      expect(result.current.formatCacheAge(0)).toBe('Never');
    });

    it('should format recent times as Just now', () => {
      const { result } = renderHook(() => useAbsCache());

      expect(result.current.formatCacheAge(30)).toBe('Just now');
      expect(result.current.formatCacheAge(59)).toBe('Just now');
    });

    it('should format minutes correctly', () => {
      const { result } = renderHook(() => useAbsCache());

      expect(result.current.formatCacheAge(60)).toBe('1m ago');
      expect(result.current.formatCacheAge(300)).toBe('5m ago');
      expect(result.current.formatCacheAge(3540)).toBe('59m ago');
    });

    it('should format hours correctly', () => {
      const { result } = renderHook(() => useAbsCache());

      expect(result.current.formatCacheAge(3600)).toBe('1h ago');
      expect(result.current.formatCacheAge(7200)).toBe('2h ago');
    });

    it('should format days correctly', () => {
      const { result } = renderHook(() => useAbsCache());

      expect(result.current.formatCacheAge(86400)).toBe('1d ago');
      expect(result.current.formatCacheAge(172800)).toBe('2d ago');
    });
  });
});
