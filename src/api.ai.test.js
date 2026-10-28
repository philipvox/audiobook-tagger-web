// AI handlers apply the tag/genre policy to their OWN output (not to ABS data).
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./lib/proxy', () => ({
  absApi: vi.fn(),
  callAI: vi.fn(),
  parseAIJson: (s) => JSON.parse(s),
  proxyFetch: vi.fn(),
}));

import { callBackend } from './api';
import { callAI } from './lib/proxy';

beforeEach(() => { localStorage.clear(); vi.mocked(callAI).mockReset(); });

describe('AI output policy', () => {
  it('classify_books_batch polices AI genres and tags', async () => {
    vi.mocked(callAI).mockResolvedValueOnce(JSON.stringify({ genres: ['Fantasy', 'Epic Fantasy', 'Adventure', 'Romance'], tags: ['a', 'Slow Burn'] }));
    const { results } = await callBackend('classify_books_batch', { books: [{ id: '1', title: 'T' }], dnaEnabled: false });
    expect(results[0].genres.length).toBeLessThanOrEqual(3);
    expect(results[0].tags).toEqual(['slow-burn']);
  });

  it('assign_tags_with_gpt polices AI tags', async () => {
    vi.mocked(callAI).mockResolvedValueOnce(JSON.stringify({ tags: ['a', 'cozy'] }));
    const { results } = await callBackend('assign_tags_with_gpt', { books: [{ id: '1', title: 'T' }] });
    expect(results[0].suggested_tags).toEqual(['cozy']);
  });

  it('cleanup_genres_with_gpt returns the shape the UI reads (changed / cleaned_genres / totals)', async () => {
    vi.mocked(callAI).mockResolvedValueOnce(JSON.stringify({ genres: ['Fantasy'] }));
    vi.mocked(callAI).mockResolvedValueOnce(JSON.stringify({ genres: ['Mystery'] }));
    const r = await callBackend('cleanup_genres_with_gpt', { books: [
      { id: '1', title: 'T', genres: ['fantasy fiction'] },
      { id: '2', title: 'U', genres: ['Mystery'] },
    ] });
    expect(r.results[0]).toMatchObject({ id: '1', success: true, changed: true, cleaned_genres: ['Fantasy'] });
    expect(r.results[1]).toMatchObject({ id: '2', changed: false });
    expect(r).toMatchObject({ total_cleaned: 1, total_unchanged: 1, total_failed: 0 });
  });

  it('resolve_book_age_rating returns age_tags the UI can merge', async () => {
    vi.mocked(callAI).mockResolvedValueOnce(JSON.stringify({ age_rating: { intended_for_kids: false, age_category: 'Adult', content_rating: 'R' } }));
    const r = await callBackend('resolve_book_age_rating', { request: { title: 'T' } });
    expect(r.success).toBe(true);
    expect(r.age_tags).toEqual(expect.arrayContaining(['not-for-kids', 'age-adult', 'rated-r']));
    expect(r.age_category).toBe('Adult');
  });
});
