// src/lib/tagMerge.js
// How AI-produced tags/genres are combined with what a book already has.
//
// Rules (kept identical to the desktop app):
// - The tag/genre policy (approved list, caps, fuzzy mapping) applies ONLY to
//   values the AI produced in this session — never to tags/genres that came
//   from ABS.
// - AI tag results are MERGED into the existing tags; existing tags
//   (especially dna:* and user tags like favorites/owned/full-cast) are kept.

import { enforceTagPolicyWithDna, enforceGenrePolicyWithSplit } from './genres';

/** Union of existing + AI tags; existing order first, case-insensitive dedup. */
export function mergeAiTags(existing, aiTags) {
  const out = [];
  const seen = new Set();
  for (const t of [...(existing || []), ...(aiTags || [])]) {
    if (t == null) continue;
    const s = String(t).trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/** Apply the approved-tag policy to AI-produced tags (dna:* pass through). */
export function policeAiTags(tags) {
  return enforceTagPolicyWithDna((tags || []).filter(t => typeof t === 'string'));
}

/** Apply the genre policy to AI-produced genres when enforcement is on. */
export function policeAiGenres(genres, config) {
  const list = (genres || []).filter(g => typeof g === 'string' && g.trim());
  return config?.genre_enforcement !== false ? enforceGenrePolicyWithSplit(list) : list;
}
