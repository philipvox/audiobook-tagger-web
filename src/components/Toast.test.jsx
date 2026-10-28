import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

vi.mock('../lib/proxy', () => ({ absApi: vi.fn(), callAI: vi.fn(), parseAIJson: JSON.parse, proxyFetch: vi.fn() }));

import { ToastProvider } from './Toast';
import { callBackend } from '../api';

describe('ToastProvider', () => {
  it('shows a toast when a desktop-only command is called, even if the caller swallows the error', async () => {
    render(<ToastProvider><div>app</div></ToastProvider>);
    await act(async () => { await callBackend('rescan_abs_imports', {}).catch(() => {}); });
    expect(screen.getByText('Not available in the web version')).toBeInTheDocument();
    expect(screen.getByText(/rescan_abs_imports/)).toBeInTheDocument();
  });
});
