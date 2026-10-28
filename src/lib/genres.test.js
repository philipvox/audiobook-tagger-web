import { describe, it, expect } from 'vitest';
import { mapTag, mapGenre, enforceTagPolicy, enforceTagPolicyWithDna } from './genres';

describe('mapTag fuzzy matching', () => {
  it('does not map very short strings to unrelated approved tags', () => {
    expect(mapTag('a')).toBeNull();
    expect(mapTag('po')).toBeNull();
    expect(mapTag('war ')).toBe('war'); // exact still works
  });
  it('does not map unrelated user tags by substring', () => {
    expect(mapTag('favorites')).toBeNull();
    expect(mapTag('owned')).toBeNull();
    expect(mapTag('ice')).toBeNull(); // substring of "police-procedural"
  });
  it('still maps exact, alias, and close token-level variants', () => {
    expect(mapTag('Cozy Mystery')).toBe('cozy-mystery');
    expect(mapTag('slow burn')).toBe('slow-burn');
    expect(mapTag('cozy-mystery-series')).toBe('cozy-mystery');
  });
  it('enforceTagPolicy drops junk instead of inventing tags', () => {
    expect(enforceTagPolicy(['a', 'fast-paced'])).toEqual(['fast-paced']);
    expect(enforceTagPolicyWithDna(['a', 'dna:pacing:fast'])).toEqual(['dna:pacing:fast']);
  });
});

describe('mapGenre fuzzy matching', () => {
  it('does not map very short strings by substring', () => {
    expect(mapGenre('a')).toBeNull();
    expect(mapGenre('art')).toBe('Art');
    expect(mapGenre('fi')).toBeNull();
  });
  it('keeps reasonable partial matches', () => {
    expect(mapGenre('Epic Fantasy')).toBe('Fantasy');
  });
});
