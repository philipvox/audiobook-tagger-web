// Push semantics: only send what changed since import; never run existing
// ABS tags/genres through the AI tag/genre policy; never wipe with [].
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./lib/proxy', () => ({
  absApi: vi.fn(),
  callAI: vi.fn(),
  parseAIJson: (s) => JSON.parse(s),
  proxyFetch: vi.fn(),
}));

import { buildAbsPayload, callBackend } from './api';
import { absApi } from './lib/proxy';
import { snapshotMetadata, recordImportSnapshot, clearImportSnapshots, getImportSnapshot } from './lib/absImport';

const CONFIG_KEY = 'audiobook_tagger_config';
const setConfig = (cfg) => localStorage.setItem(CONFIG_KEY, JSON.stringify({ abs_base_url: 'https://abs.example', abs_api_token: 't', ...cfg }));

const imported = {
  title: 'Strength to Love',
  author: 'Martin Luther King, Jr.',
  narrator: 'Someone',
  description: 'Sermons.',
  genres: ['Biography, Memoir', 'Religion & Spirituality', 'History', 'Politics'],
  tags: ['dna:pacing:slow', 'dna:theme:faith', 'favorites', 'owned', 'full-cast', 'a'],
  series: null, sequence: null, all_series: [],
  published_year: '1963',
};

beforeEach(() => {
  localStorage.clear();
  clearImportSnapshots();
  vi.mocked(absApi).mockReset();
});

describe('buildAbsPayload with an import snapshot (diff mode)', () => {
  const original = snapshotMetadata(imported);

  it('a title-only edit sends only the title', () => {
    const p = buildAbsPayload({ ...imported, title: 'Strength To Love' }, { original });
    expect(p).toEqual({ metadata: { title: 'Strength To Love' } });
  });

  it('an unchanged book sends nothing', () => {
    const p = buildAbsPayload({ ...imported }, { original });
    expect(p).toEqual({ metadata: {} });
  });

  it('existing tags are never policy-filtered, capped or fuzzy-mapped', () => {
    const p = buildAbsPayload({ ...imported, tags: [...imported.tags, 'cozy'] }, { original });
    expect(p.tags).toEqual([...imported.tags, 'cozy']);
  });

  it('genres are sent as-is when changed (no cap, no splitting)', () => {
    const genres = [...imported.genres, 'Essays'];
    const p = buildAbsPayload({ ...imported, genres }, { original });
    expect(p.metadata.genres).toEqual(genres);
    expect(p.metadata).not.toHaveProperty('authors');
  });

  it('reordering tags/genres is not a change', () => {
    const p = buildAbsPayload({ ...imported, tags: [...imported.tags].reverse(), genres: [...imported.genres].reverse() }, { original });
    expect(p).toEqual({ metadata: {} });
  });

  it('explicitly clearing all tags (diff to empty) sends []', () => {
    const p = buildAbsPayload({ ...imported, tags: [] }, { original });
    expect(p.tags).toEqual([]);
  });

  it('a changed author keeps "Jr." attached', () => {
    const p = buildAbsPayload({ ...imported, author: 'Martin Luther King, Jr. & Coretta Scott King' }, { original });
    expect(p.metadata.authors.map(a => a.name)).toEqual(['Martin Luther King, Jr.', 'Coretta Scott King']);
  });

  it('year-fix (meta.year) is sent as publishedYear when it changed', () => {
    const p = buildAbsPayload({ ...imported, year: '1964' }, { original });
    expect(p.metadata).toEqual({ publishedYear: '1964' });
  });
});

describe('buildAbsPayload without a snapshot (fallback, non-destructive)', () => {
  it('does not policy-filter, cap or fuzzy-map tags', () => {
    const p = buildAbsPayload({ ...imported });
    expect(p.tags).toEqual(imported.tags);
  });
  it('does not cap or split genres, even with genre_enforcement on', () => {
    setConfig({ genre_enforcement: true });
    const p = buildAbsPayload({ ...imported });
    expect(p.metadata.genres).toEqual(imported.genres);
  });
  it('never sends empty genres/tags', () => {
    const p = buildAbsPayload({ title: 'X', author: 'Y', genres: [], tags: [] });
    expect(p.metadata).not.toHaveProperty('genres');
    expect(p).not.toHaveProperty('tags');
  });
  it('does not split "Martin Luther King, Jr." into two authors', () => {
    const p = buildAbsPayload({ title: 'X', author: 'Martin Luther King, Jr.' });
    expect(p.metadata.authors).toEqual([{ id: 'new-1', name: 'Martin Luther King, Jr.' }]);
  });
  it('omits authors for authorless ("Unknown") books', () => {
    const p = buildAbsPayload({ title: 'X', author: 'Unknown' });
    expect(p.metadata).not.toHaveProperty('authors');
  });
});

describe('push_abs_imports', () => {
  it('diffs against the recorded import snapshot and skips unchanged books', async () => {
    setConfig({});
    recordImportSnapshot('b1', imported);
    recordImportSnapshot('b2', imported);
    vi.mocked(absApi).mockResolvedValue({});
    const res = await callBackend('push_abs_imports', { request: { items: [
      { id: 'b1', metadata: { ...imported, title: 'New Title' } },
      { id: 'b2', metadata: { ...imported } },
    ] } });
    expect(absApi).toHaveBeenCalledTimes(1);
    expect(vi.mocked(absApi).mock.calls[0][3].body).toEqual({ metadata: { title: 'New Title' } });
    expect(res).toMatchObject({ updated: 1, unchanged: 1, failed: 0 });
    // snapshot advances to what was pushed
    expect(getImportSnapshot('b1').title).toBe('New Title');
  });

  it('reports failures with the error message', async () => {
    setConfig({});
    vi.mocked(absApi).mockRejectedValue(new Error('ABS API error 500: boom'));
    const res = await callBackend('push_abs_imports', { request: { items: [{ id: 'b1', metadata: { title: 'T' } }] } });
    expect(res.updated).toBe(0);
    expect(res.failed).toBe(1);
    expect(res.errors[0]).toContain('boom');
  });
});
