import { describe, it, expect } from 'vitest';
import { mergeAiTags, policeAiTags, policeAiGenres } from './tagMerge';

describe('mergeAiTags', () => {
  it('keeps every existing tag (dna:* and user tags) and appends new AI tags', () => {
    const existing = ['dna:pacing:slow', 'favorites', 'owned', 'full-cast', 'cozy'];
    const ai = ['cozy', 'heartwarming', 'dna:pacing:fast'];
    expect(mergeAiTags(existing, ai)).toEqual([
      'dna:pacing:slow', 'favorites', 'owned', 'full-cast', 'cozy', 'heartwarming', 'dna:pacing:fast',
    ]);
  });
  it('handles missing inputs', () => {
    expect(mergeAiTags(undefined, ['a-tag'])).toEqual(['a-tag']);
    expect(mergeAiTags(['x'], undefined)).toEqual(['x']);
  });
  it('dedups case-insensitively', () => {
    expect(mergeAiTags(['Cozy'], ['cozy'])).toEqual(['Cozy']);
  });
});

describe('policeAiTags / policeAiGenres', () => {
  it('applies the approved-tag policy to AI tags, passing dna:* through', () => {
    expect(policeAiTags(['a', 'Slow Burn', 'dna:mood:dark:7', 'made-up-thing'])).toEqual(['slow-burn', 'dna:mood:dark:7']);
  });
  it('enforces genres for AI output when enforcement is on', () => {
    expect(policeAiGenres(['Biography, Memoir', 'History', 'Politics', 'Essays'], { genre_enforcement: true })).toHaveLength(3);
  });
  it('passes AI genres through when enforcement is off', () => {
    expect(policeAiGenres(['Space Westerns', 'Cli-Fi'], { genre_enforcement: false })).toEqual(['Space Westerns', 'Cli-Fi']);
  });
});
