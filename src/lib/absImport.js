// src/lib/absImport.js
// Shared ABS import helpers: pagination, item -> BookGroup conversion,
// series/people parsing, and the per-book "as imported" metadata snapshot
// that pushes diff against (so a push only sends what actually changed).

import { absApi } from './proxy';

// ============================================================================
// PEOPLE (authors / narrators)
// ============================================================================

const NAME_SUFFIX_RE = /^(jr|sr)\.?$|^(ii|iii|iv|v|vi)$|^(phd|ph\.d\.|md|m\.d\.|esq\.?|dds|dvm)$/i;
const UNKNOWN_NAME_RE = /^(unknown|unknown author|unknown narrator|various|n\/a)$/i;

/**
 * Split an ABS-style "A, B & C" people string into individual names.
 * - Name suffixes stay attached: "Martin Luther King, Jr." is ONE name.
 * - A single-author "Last, First" form ("King, Stephen") is not split.
 * - Placeholder names ("Unknown") are dropped.
 * @param {string} value
 * @returns {string[]}
 */
export function splitPeople(value) {
  if (value == null) return [];
  const str = String(value).trim();
  if (!str) return [];

  const raw = str.split(/\s*[,;&]\s*/).map(s => s.trim()).filter(Boolean);
  const merged = [];
  for (const part of raw) {
    if (merged.length > 0 && NAME_SUFFIX_RE.test(part)) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}, ${part}`;
    } else {
      merged.push(part);
    }
  }

  // "Last, First" single-author form: exactly two comma parts, no '&' / ';',
  // and the first part is a single word (a surname).
  if (merged.length === 2 && !/[&;]/.test(str) && !/\s/.test(merged[0]) && !NAME_SUFFIX_RE.test(merged[1])) {
    return UNKNOWN_NAME_RE.test(str) ? [] : [str];
  }

  const seen = new Set();
  return merged.filter(n => {
    if (UNKNOWN_NAME_RE.test(n)) return false;
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ============================================================================
// SERIES
// ============================================================================

/**
 * Parse a minified ABS `seriesName` ("Red Rising #6", or several joined with
 * ", " like "The Plantagenet and Tudor #6, Tudor Court #1") into
 * [{name, sequence}]. Series names that themselves contain ", " are kept
 * intact as long as a "#seq" follows. Trailing parts without a sequence are
 * kept together as one series name.
 * @param {string} seriesName
 * @returns {Array<{name: string, sequence: string|null}>}
 */
export function parseSeriesName(seriesName) {
  if (seriesName == null) return [];
  const str = String(seriesName).trim();
  if (!str) return [];
  const out = [];
  let buf = [];
  for (const piece of str.split(', ')) {
    buf.push(piece);
    const m = piece.match(/^(.*?)\s*#\s*([^\s#]+)\s*$/);
    if (m) {
      const name = [...buf.slice(0, -1), m[1]].join(', ').trim();
      if (name) out.push({ name, sequence: m[2] });
      buf = [];
    }
  }
  if (buf.length > 0) {
    const name = buf.join(', ').trim();
    if (name) out.push({ name, sequence: null });
  }
  return out;
}

// ============================================================================
// IMPORT SNAPSHOTS
// ============================================================================

const SNAPSHOT_FIELDS = [
  'title', 'subtitle', 'description', 'publisher', 'published_year', 'isbn', 'asin',
  'language', 'author', 'narrator', 'genres', 'tags', 'series', 'sequence', 'all_series',
];

const snapshots = new Map();

/** Deep copy of the push-relevant metadata fields. */
export function snapshotMetadata(meta) {
  const snap = {};
  for (const f of SNAPSHOT_FIELDS) {
    const v = meta?.[f];
    snap[f] = v === undefined ? null : JSON.parse(JSON.stringify(v));
  }
  // `year` is what the year-fix sets; the import uses published_year.
  if (meta && meta.year != null && snap.published_year == null) snap.published_year = String(meta.year);
  return snap;
}

export function recordImportSnapshot(absId, meta) {
  if (!absId) return;
  snapshots.set(absId, snapshotMetadata(meta));
}

export function getImportSnapshot(absId) {
  return absId ? (snapshots.get(absId) || null) : null;
}

export function clearImportSnapshots() {
  snapshots.clear();
}

// ============================================================================
// ITEM CONVERSION + PAGINATION
// ============================================================================

/**
 * Convert an ABS library item (minified or expanded) into a BookGroup.
 * The library items list endpoint always returns minified items (it ignores
 * `expanded=1`), so series come from `seriesName` and people from
 * `authorName` / `narratorName`.
 */
export function absItemToBookGroup(item, absBaseUrl, absToken = '') {
  const meta = item.media?.metadata || {};
  const base = String(absBaseUrl || '').replace(/\/$/, '');

  const authorList = Array.isArray(meta.authors) && meta.authors.length > 0
    ? meta.authors.map(a => (typeof a === 'string' ? a : a?.name)).filter(Boolean).join(', ')
    : '';
  const author = meta.authorName || authorList || 'Unknown';

  const narratorList = Array.isArray(meta.narrators) && meta.narrators.length > 0
    ? meta.narrators.map(n => (typeof n === 'string' ? n : n?.name)).filter(Boolean).join(', ')
    : '';
  const narrator = meta.narratorName || narratorList || null;

  let seriesArr;
  if (Array.isArray(meta.series) && meta.series.length > 0) {
    seriesArr = meta.series
      .map(s => (typeof s === 'string'
        ? { name: s, sequence: null }
        : { id: s?.id, name: s?.name, sequence: s?.sequence ?? null }))
      .filter(s => s.name)
      .map(s => ({ ...(s.id ? { id: s.id } : {}), name: s.name, sequence: s.sequence || null, source: 'abs' }));
  } else {
    seriesArr = parseSeriesName(meta.seriesName).map(s => ({ ...s, source: 'abs' }));
  }

  const metadata = {
    title: meta.title || 'Unknown',
    author,
    narrator,
    subtitle: meta.subtitle || null,
    series: seriesArr[0]?.name || null,
    sequence: seriesArr[0]?.sequence || meta.seriesSequence || null,
    all_series: seriesArr,
    genres: Array.isArray(meta.genres) ? [...meta.genres] : [],
    tags: Array.isArray(item.media?.tags) ? [...item.media.tags] : [],
    description: meta.description || null,
    publisher: meta.publisher || null,
    published_year: meta.publishedYear || meta.publishedDate?.substring(0, 4) || null,
    language: meta.language || null,
    isbn: meta.isbn || null,
    asin: meta.asin || null,
    cover_url: item.id && base ? `${base}/api/items/${item.id}/cover?token=${encodeURIComponent(absToken || '')}` : null,
    duration: item.media?.duration || null,
    added_at: item.addedAt || item.createdAt || 0,
  };

  return {
    id: item.id || crypto.randomUUID(),
    abs_id: item.id,
    source: 'abs',
    metadata,
    files: (item.media?.audioFiles || []).map(f => ({
      path: f.metadata?.path || '',
      filename: f.metadata?.filename || '',
      duration: f.duration || 0,
      size: f.metadata?.size || 0,
    })),
  };
}

/**
 * Fetch every item in a library, page by page. Stops on an empty page so a
 * server whose `total` disagrees with what it returns can't loop forever.
 */
export async function fetchAllLibraryItems(baseUrl, token, libraryId, onProgress) {
  const all = [];
  const limit = 100;
  let total = 0;
  for (let page = 0; page < 10000; page++) {
    onProgress?.(all.length, total, `Fetching page ${page + 1}...`);
    const data = await absApi(baseUrl, token, `/api/libraries/${libraryId}/items?limit=${limit}&page=${page}`);
    const items = Array.isArray(data?.results) ? data.results : [];
    total = Number(data?.total) || 0;
    if (items.length === 0) break;
    all.push(...items);
    if (all.length >= total) break;
  }
  return all;
}

/**
 * Import a whole library as BookGroups and record each book's snapshot.
 */
export async function importLibraryGroups(config, onProgress) {
  const { abs_base_url: baseUrl, abs_api_token: token, abs_library_id: libraryId } = config || {};
  if (!baseUrl || !token || !libraryId) {
    throw new Error('Configure ABS URL, token, and library ID in Settings first');
  }
  const items = await fetchAllLibraryItems(baseUrl, token, libraryId, onProgress);
  onProgress?.(items.length, items.length, 'Processing...');
  const groups = items.map(item => absItemToBookGroup(item, baseUrl, token));
  for (const g of groups) recordImportSnapshot(g.abs_id, g.metadata);
  return groups;
}
