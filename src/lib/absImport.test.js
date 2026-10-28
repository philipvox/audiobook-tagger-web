import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./proxy', () => ({ absApi: vi.fn() }));

import { absApi } from './proxy';
import {
  splitPeople, parseSeriesName, absItemToBookGroup, fetchAllLibraryItems,
  importLibraryGroups, getImportSnapshot, clearImportSnapshots,
} from './absImport';

beforeEach(() => { vi.mocked(absApi).mockReset(); clearImportSnapshots(); });

describe('splitPeople', () => {
  it('keeps Jr./Sr./II/III attached to the name', () => {
    expect(splitPeople('Martin Luther King, Jr.')).toEqual(['Martin Luther King, Jr.']);
    expect(splitPeople('Harry Connick, Sr., Jane Doe')).toEqual(['Harry Connick, Sr.', 'Jane Doe']);
    expect(splitPeople('John Smith, III & Ann Lee')).toEqual(['John Smith, III', 'Ann Lee']);
  });
  it('does not split a single "Last, First" author', () => {
    expect(splitPeople('King, Stephen')).toEqual(['King, Stephen']);
    expect(splitPeople('Tolkien, J. R. R.')).toEqual(['Tolkien, J. R. R.']);
  });
  it('splits real multi-author strings', () => {
    expect(splitPeople('Neil Gaiman, Terry Pratchett')).toEqual(['Neil Gaiman', 'Terry Pratchett']);
    expect(splitPeople('Stephen King & Peter Straub')).toEqual(['Stephen King', 'Peter Straub']);
  });
  it('drops Unknown placeholders and empties', () => {
    expect(splitPeople('Unknown')).toEqual([]);
    expect(splitPeople('')).toEqual([]);
    expect(splitPeople(null)).toEqual([]);
  });
});

describe('parseSeriesName', () => {
  it('parses "Name #seq"', () => {
    expect(parseSeriesName('Red Rising #6')).toEqual([{ name: 'Red Rising', sequence: '6' }]);
    expect(parseSeriesName('Discworld #1.5')).toEqual([{ name: 'Discworld', sequence: '1.5' }]);
  });
  it('parses comma-separated multiple series', () => {
    expect(parseSeriesName('The Plantagenet and Tudor #6, Tudor Court #1')).toEqual([
      { name: 'The Plantagenet and Tudor', sequence: '6' },
      { name: 'Tudor Court', sequence: '1' },
    ]);
  });
  it('handles names without a sequence and names containing commas', () => {
    expect(parseSeriesName('The First Law')).toEqual([{ name: 'The First Law', sequence: null }]);
    expect(parseSeriesName('Love, Inspired #3')).toEqual([{ name: 'Love, Inspired', sequence: '3' }]);
    expect(parseSeriesName('')).toEqual([]);
  });
});

describe('absItemToBookGroup (minified ABS items)', () => {
  const minified = {
    id: 'li-1',
    media: {
      metadata: { title: 'Light Bringer', authorName: 'Pierce Brown', narratorName: 'Tim Gerard Reynolds', seriesName: 'Red Rising #6', genres: ['Science Fiction'] },
      tags: ['dna:pacing:fast', 'favorites'],
    },
  };
  it('fills series and all_series from seriesName', () => {
    const g = absItemToBookGroup(minified, 'https://abs.example', 'tok');
    expect(g.metadata.series).toBe('Red Rising');
    expect(g.metadata.sequence).toBe('6');
    expect(g.metadata.all_series).toEqual([{ name: 'Red Rising', sequence: '6', source: 'abs' }]);
    expect(g.metadata.author).toBe('Pierce Brown');
    expect(g.metadata.tags).toEqual(['dna:pacing:fast', 'favorites']);
  });
  it('prefers expanded series objects (with ids) when present', () => {
    const g = absItemToBookGroup({ id: 'x', media: { metadata: { title: 't', series: [{ id: 's1', name: 'Dune', sequence: '2' }] } } }, 'https://a');
    expect(g.metadata.all_series).toEqual([{ id: 's1', name: 'Dune', sequence: '2', source: 'abs' }]);
  });
});

describe('fetchAllLibraryItems', () => {
  it('stops on an empty page even if total says there are more', async () => {
    vi.mocked(absApi)
      .mockResolvedValueOnce({ results: [{ id: 'a' }], total: 5 })
      .mockResolvedValueOnce({ results: [], total: 5 })
      .mockResolvedValue({ results: [{ id: 'never' }], total: 5 });
    const items = await fetchAllLibraryItems('https://a', 't', 'lib');
    expect(items).toEqual([{ id: 'a' }]);
    expect(absApi).toHaveBeenCalledTimes(2);
  });
  it('fetches every page until total reached', async () => {
    vi.mocked(absApi)
      .mockResolvedValueOnce({ results: Array(100).fill({ id: 'p0' }), total: 150 })
      .mockResolvedValueOnce({ results: Array(50).fill({ id: 'p1' }), total: 150 });
    const items = await fetchAllLibraryItems('https://a', 't', 'lib');
    expect(items).toHaveLength(150);
    expect(vi.mocked(absApi).mock.calls[0][2]).not.toContain('expanded');
  });
});

describe('importLibraryGroups', () => {
  it('records an import snapshot per book', async () => {
    vi.mocked(absApi).mockResolvedValueOnce({ results: [{ id: 'b1', media: { metadata: { title: 'T', authorName: 'A' }, tags: ['owned'] } }], total: 1 });
    const groups = await importLibraryGroups({ abs_base_url: 'https://a', abs_api_token: 't', abs_library_id: 'l' });
    expect(groups).toHaveLength(1);
    expect(getImportSnapshot('b1')).toMatchObject({ title: 'T', author: 'A', tags: ['owned'] });
    groups[0].metadata.tags.push('mutated');
    expect(getImportSnapshot('b1').tags).toEqual(['owned']);
  });
});
