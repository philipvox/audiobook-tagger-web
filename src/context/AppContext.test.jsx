// src/context/AppContext.test.jsx
// Tests for the AppContext

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { AppProvider, useApp } from './AppContext';

// The web build has no Tauri: AppContext talks to src/api.js, whose config
// handlers read/write browser localStorage. Use the REAL handlers, wrapped in
// spies so calls can be asserted.
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    callBackend: vi.fn(actual.callBackend),
    subscribe: vi.fn(actual.subscribe),
  };
});
vi.mock('../lib/proxy', () => ({ absApi: vi.fn(), callAI: vi.fn(), parseAIJson: JSON.parse, proxyFetch: vi.fn() }));

import { callBackend, subscribe } from '../api';

const CONFIG_KEY = 'audiobook_tagger_config';

describe('AppContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    localStorage.clear();
    localStorage.setItem(CONFIG_KEY, JSON.stringify({
      abs_base_url: 'http://localhost:13378',
      abs_api_token: 'test-token',
    }));
  });

  describe('AppProvider', () => {
    it('should show loading state while fetching config', async () => {
      render(
        <AppProvider>
          <div>Children</div>
        </AppProvider>
      );

      // Config loading no longer blocks children - context is always provided
      // with isLoadingConfig flag. The loading UI is in App.jsx.
      expect(screen.getByText('Children')).toBeInTheDocument();
    });

    it('should render children after config loads', async () => {
      render(
        <AppProvider>
          <div>Test Content</div>
        </AppProvider>
      );

      await waitFor(() => {
        expect(screen.getByText('Test Content')).toBeInTheDocument();
      });
    });

    it('should call get_config on mount', async () => {
      render(
        <AppProvider>
          <div>Test</div>
        </AppProvider>
      );

      await waitFor(() => {
        expect(callBackend).toHaveBeenCalledWith('get_config');
      });
    });
  });

  describe('useApp hook', () => {
    const wrapper = ({ children }) => (
      <AppProvider>{children}</AppProvider>
    );

    it('should throw error when used outside provider', () => {
      // Suppress console.error for this test
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        renderHook(() => useApp());
      }).toThrow('useApp must be used within AppProvider');

      consoleSpy.mockRestore();
    });

    it('should provide config after loading', async () => {
      const { result } = renderHook(() => useApp(), { wrapper });

      await waitFor(() => {
        expect(result.current.config).not.toBe(null);
      });

      expect(result.current.config.abs_base_url).toBe('http://localhost:13378');
    });

    it('should provide setGroups function', async () => {
      const { result } = renderHook(() => useApp(), { wrapper });

      await waitFor(() => {
        expect(typeof result.current.setGroups).toBe('function');
      });
    });

    it('should update groups when setGroups is called', async () => {
      const { result } = renderHook(() => useApp(), { wrapper });

      await waitFor(() => {
        expect(result.current.config).not.toBe(null);
      });

      const testGroups = [{ id: '1', name: 'Test' }];

      act(() => {
        result.current.setGroups(testGroups);
      });

      expect(result.current.groups).toEqual(testGroups);
    });
  });

  describe('saveConfig', () => {
    const wrapper = ({ children }) => (
      <AppProvider>{children}</AppProvider>
    );

    it('should call save_config, persist to localStorage and update state', async () => {
      const { result } = renderHook(() => useApp(), { wrapper });

      await waitFor(() => {
        expect(result.current.config).not.toBe(null);
      });

      const newConfig = { abs_base_url: 'https://new-url' };

      let saveResult;
      await act(async () => {
        saveResult = await result.current.saveConfig(newConfig);
      });

      expect(saveResult.success).toBe(true);
      expect(callBackend).toHaveBeenCalledWith('save_config', { config: newConfig });
      expect(JSON.parse(localStorage.getItem(CONFIG_KEY))).toEqual(newConfig);
      expect(result.current.config).toEqual(newConfig);
    });

    it('should handle save errors (e.g. browser storage full)', async () => {
      const { result } = renderHook(() => useApp(), { wrapper });

      await waitFor(() => {
        expect(result.current.config).not.toBe(null);
      });

      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e;
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});

      let saveResult;
      await act(async () => {
        saveResult = await result.current.saveConfig({ abs_base_url: 'new' });
      });

      expect(saveResult.success).toBe(false);
      expect(saveResult.error).toContain('Browser storage is full');
    });
  });

  describe('file statuses', () => {
    const wrapper = ({ children }) => (
      <AppProvider>{children}</AppProvider>
    );

    it('should update single file status', async () => {
      const { result } = renderHook(() => useApp(), { wrapper });

      await waitFor(() => {
        expect(result.current.config).not.toBe(null);
      });

      act(() => {
        result.current.updateFileStatus('file1', 'writing');
      });

      expect(result.current.fileStatuses['file1']).toBe('writing');
    });

    it('should update multiple file statuses', async () => {
      const { result } = renderHook(() => useApp(), { wrapper });

      await waitFor(() => {
        expect(result.current.config).not.toBe(null);
      });

      act(() => {
        result.current.updateFileStatuses({
          'file1': 'done',
          'file2': 'error',
        });
      });

      expect(result.current.fileStatuses['file1']).toBe('done');
      expect(result.current.fileStatuses['file2']).toBe('error');
    });

    it('should clear all file statuses', async () => {
      const { result } = renderHook(() => useApp(), { wrapper });

      await waitFor(() => {
        expect(result.current.config).not.toBe(null);
      });

      act(() => {
        result.current.updateFileStatus('file1', 'writing');
        result.current.clearFileStatuses();
      });

      expect(result.current.fileStatuses).toEqual({});
    });
  });

  describe('global progress', () => {
    const wrapper = ({ children }) => (
      <AppProvider>{children}</AppProvider>
    );

    it('should start global progress', async () => {
      const { result } = renderHook(() => useApp(), { wrapper });

      await waitFor(() => {
        expect(result.current.config).not.toBe(null);
      });

      act(() => {
        result.current.startGlobalProgress({
          message: 'Processing...',
          total: 100,
          canCancel: true,
          type: 'info',
        });
      });

      expect(result.current.globalProgress.active).toBe(true);
      expect(result.current.globalProgress.message).toBe('Processing...');
      expect(result.current.globalProgress.total).toBe(100);
      expect(result.current.globalProgress.canCancel).toBe(true);
    });

    it('should update global progress', async () => {
      const { result } = renderHook(() => useApp(), { wrapper });

      await waitFor(() => {
        expect(result.current.config).not.toBe(null);
      });

      act(() => {
        result.current.startGlobalProgress({
          message: 'Processing...',
          total: 100,
        });
      });

      act(() => {
        result.current.updateGlobalProgress({
          current: 50,
          detail: 'Half done',
        });
      });

      expect(result.current.globalProgress.current).toBe(50);
      expect(result.current.globalProgress.detail).toBe('Half done');
    });

    it('should end global progress', async () => {
      const { result } = renderHook(() => useApp(), { wrapper });

      await waitFor(() => {
        expect(result.current.config).not.toBe(null);
      });

      act(() => {
        result.current.startGlobalProgress({
          message: 'Processing...',
          total: 100,
        });
      });

      expect(result.current.globalProgress.active).toBe(true);

      act(() => {
        result.current.endGlobalProgress();
      });

      expect(result.current.globalProgress.active).toBe(false);
      expect(result.current.globalProgress.message).toBe('');
    });

    it('should call cancel function when canceling', async () => {
      const cancelFn = vi.fn();
      const { result } = renderHook(() => useApp(), { wrapper });

      await waitFor(() => {
        expect(result.current.config).not.toBe(null);
      });

      act(() => {
        result.current.startGlobalProgress({
          message: 'Processing...',
          total: 100,
          canCancel: true,
          cancelFn,
        });
      });

      act(() => {
        result.current.cancelGlobalProgress();
      });

      expect(cancelFn).toHaveBeenCalled();
      expect(result.current.globalProgress.active).toBe(false);
    });
  });

  describe('write progress event listener', () => {
    it('should set up write_progress listener on mount', async () => {
      render(
        <AppProvider>
          <div>Test</div>
        </AppProvider>
      );

      await waitFor(() => {
        expect(subscribe).toHaveBeenCalledWith('write_progress', expect.any(Function));
      });
    });
  });
});
