// Issue #2: "don't touch series name/number — it likes to create a new series for each book."
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./lib/proxy', () => ({
  absApi: vi.fn(),
  callAI: vi.fn(),
  parseAIJson: (s) => JSON.parse(s),
  proxyFetch: vi.fn(),
}));

import { buildAbsPayload, normalizeSeriesName, findLibrarySeries, callBackend } from './api';
import { absApi, callAI } from './lib/proxy';
import { clearImportSnapshots } from './lib/absImport';

const CONFIG_KEY = 'audiobook_tagger_config';
const setConfig = (cfg) => localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));

const library = [
  { id: 'ser-1', name: 'The Stormlight Archive' },
  { id: 'ser-2', name: 'Discworld' },
  { id: 'ser-3', name: "Ender's Saga" },
];

beforeEach(() => {
  localStorage.clear();
  clearImportSnapshots();
  vi.mocked(absApi).mockReset();
  vi.mocked(callAI).mockReset();
});

describe('normalizeSeriesName', () => {
  it('ignores case, whitespace, leading "The", trailing Series/Saga/Trilogy/Cycle, punctuation', () => {
    expect(normalizeSeriesName('  The Stormlight Archive Series ')).toBe('stormlight archive');
    expect(normalizeSeriesName('stormlight archive')).toBe('stormlight archive');
    expect(normalizeSeriesName("Ender's Saga")).toBe(normalizeSeriesName('Enders'));
    expect(normalizeSeriesName('Discworld Cycle')).toBe('discworld');
    expect(normalizeSeriesName(null)).toBe('');
  });
  it('findLibrarySeries returns the existing library entry', () => {
    expect(findLibrarySeries('Stormlight Archive Series', library)).toEqual(library[0]);
    expect(findLibrarySeries('Unknown', library)).toBeNull();
  });
});

describe('buildAbsPayload series handling', () => {
  const base = { title: 'Book', author: 'Someone' };

  it('preserve_series defaults to ON and omits the series key', () => {
    const p = buildAbsPayload({ ...base, series: 'AI Guess', sequence: '2', all_series: [{ name: 'Real', sequence: '1' }] });
    expect(p.metadata).not.toHaveProperty('series');
  });

  it('preserve_series ON via config omits the series key', () => {
    setConfig({ preserve_series: true });
    const p = buildAbsPayload({ ...base, series: 'AI Guess' }, { librarySeries: library });
    expect(p.metadata).not.toHaveProperty('series');
  });

  it('OFF + existing all_series → sent unchanged', () => {
    const p = buildAbsPayload(
      { ...base, series: 'Different AI Name', sequence: '9', all_series: [{ name: 'Discworld', sequence: '3', source: 'abs' }, { name: 'Rincewind', sequence: null }] },
      { preserveSeries: false, librarySeries: library },
    );
    expect(p.metadata.series).toEqual([{ name: 'Discworld', sequence: '3' }, { name: 'Rincewind' }]);
  });

  it('OFF + no existing series + AI name matching a library series by normalization → existing id/name', () => {
    const p = buildAbsPayload(
      { ...base, series: 'stormlight archive series', sequence: 4, all_series: [] },
      { preserveSeries: false, librarySeries: library },
    );
    expect(p.metadata.series).toEqual([{ id: 'ser-1', name: 'The Stormlight Archive', sequence: '4' }]);
  });

  it('OFF + unmatched name → name only (with sequence when known)', () => {
    const p = buildAbsPayload({ ...base, series: 'Brand New', sequence: '1' }, { preserveSeries: false, librarySeries: library });
    expect(p.metadata.series).toEqual([{ name: 'Brand New', sequence: '1' }]);
  });

  it('never emits series: [] in any mode', () => {
    for (const preserveSeries of [true, false]) {
      for (const meta of [base, { ...base, series: null, all_series: [] }, { ...base, series: '', all_series: [{ name: '' }] }]) {
        const p = buildAbsPayload(meta, { preserveSeries, librarySeries: library });
        expect(p.metadata).not.toHaveProperty('series');
      }
    }
  });
});

describe('push_abs_updates', () => {
  it('OFF: fetches library series once per push and reuses the existing id', async () => {
    setConfig({ preserve_series: false, abs_base_url: 'https://abs', abs_api_token: 't', abs_library_id: 'lib1' });
    vi.mocked(absApi).mockImplementation(async (_b, _t, path) => {
      if (path.startsWith('/api/libraries/lib1/series')) return { results: library, total: library.length };
      return {};
    });
    const res = await callBackend('push_abs_updates', {
      items: [
        { abs_id: 'a', metadata: { title: 'A', series: 'Discworld', sequence: '1' } },
        { abs_id: 'b', metadata: { title: 'B', series: 'the discworld series', sequence: '2' } },
      ],
    });
    expect(res.success).toBe(2);
    const seriesCalls = vi.mocked(absApi).mock.calls.filter(c => c[2].includes('/series'));
    expect(seriesCalls).toHaveLength(1);
    const patches = vi.mocked(absApi).mock.calls.filter(c => c[3]?.method === 'PATCH');
    expect(patches.map(c => c[3].body.metadata.series)).toEqual([
      [{ id: 'ser-2', name: 'Discworld', sequence: '1' }],
      [{ id: 'ser-2', name: 'Discworld', sequence: '2' }],
    ]);
  });

  it('ON: does not fetch library series and sends no series', async () => {
    setConfig({ abs_base_url: 'https://abs', abs_api_token: 't', abs_library_id: 'lib1' });
    vi.mocked(absApi).mockResolvedValue({});
    await callBackend('push_abs_updates', { items: [{ abs_id: 'a', metadata: { title: 'A', series: 'X' } }] });
    expect(vi.mocked(absApi).mock.calls.some(c => c[2].includes('/series'))).toBe(false);
    const patch = vi.mocked(absApi).mock.calls.find(c => c[3]?.method === 'PATCH');
    expect(patch[3].body.metadata).not.toHaveProperty('series');
  });
});

describe('resolve_metadata_batch series guards', () => {
  const book = { id: '1', current_title: 'T', current_author: 'A', current_series: 'Real', current_sequence: '2' };

  it('ON: AI series/sequence are ignored', async () => {
    vi.mocked(callAI).mockResolvedValue(JSON.stringify({ title: 'T', author: 'A', series: 'AI Guess', sequence: '7' }));
    const { results } = await callBackend('resolve_metadata_batch', { books: [book] });
    expect(results[0]).toMatchObject({ series: 'Real', sequence: '2' });
  });

  it('OFF: an AI null never clears the series (CR-4b)', async () => {
    setConfig({ preserve_series: false });
    vi.mocked(callAI).mockResolvedValue(JSON.stringify({ title: 'T', author: 'A', series: null, sequence: null }));
    const { results } = await callBackend('resolve_metadata_batch', { books: [book] });
    expect(results[0]).toMatchObject({ series: 'Real', sequence: '2' });
  });
});
