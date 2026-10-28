// src/api.js
// Transport adapter — 100% client-side. No backend server needed.
// ABS calls go direct (CORS-worker fallback only if the browser blocks them);
// AI calls never use the worker (see lib/proxy.js).
// Config lives in browser localStorage.

import { absApi, callAI, parseAIJson, proxyFetch } from './lib/proxy';
import { buildMetadataPrompt, buildClassificationPrompt, buildDescriptionPrompt, buildDnaPrompt, BOOK_DNA_SYSTEM_PROMPT, SYSTEM_PROMPT, DEFAULT_TAG_INSTRUCTIONS } from './lib/prompts';
import { toTitleCase, removeJunkSuffixes, cleanAuthorName, cleanNarratorName } from './lib/normalize';
import { APPROVED_GENRES, APPROVED_TAGS, GENRE_ALIASES, mapGenre, enforceGenrePolicyWithSplit, enforceTagPolicyWithDna } from './lib/genres';
import { mergeAiTags, policeAiTags, policeAiGenres } from './lib/tagMerge';
import { splitPeople, importLibraryGroups, getImportSnapshot, recordImportSnapshot } from './lib/absImport';

/** Safely serialize a value for AI prompts (escapes quotes/newlines). */
function safe(value) {
  if (value === null || value === undefined) return 'null';
  return JSON.stringify(String(value));
}

/** Missing (undefined), explicit null, and empty string all count as "no value". */
function hasValue(v) {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

/** Get the effective system prompt (custom override or default). */
function getSystemPrompt(config) {
  return config?.custom_system_prompt?.trim() || SYSTEM_PROMPT;
}

/** Get the effective DNA system prompt (custom override or default). */
function getDnaSystemPrompt(config) {
  return config?.custom_dna_prompt?.trim() || BOOK_DNA_SYSTEM_PROMPT;
}

// ============================================================================
// LOCAL CONFIG (browser localStorage)
// ============================================================================

const CONFIG_KEY = 'audiobook_tagger_config';

const DEFAULT_CONFIG = {
  abs_base_url: import.meta.env.VITE_ABS_URL || '',
  abs_api_token: import.meta.env.VITE_ABS_TOKEN || '',
  abs_library_id: '',
  openai_api_key: import.meta.env.VITE_OPENAI_KEY || null,
  anthropic_api_key: import.meta.env.VITE_ANTHROPIC_KEY || null,
  backup_tags: true,
  genre_enforcement: true,
  // #2: never touch ABS series name/number on push or during AI metadata
  // resolution. AI-guessed series names vary per book and ABS creates a new
  // series for every name it doesn't already know.
  preserve_series: true,
  performance_preset: 'balanced',
  ai_provider: 'openai',
  ai_model: 'gpt-5-nano',
  openai_base_url: 'https://api.openai.com',
  anthropic_base_url: 'https://api.anthropic.com',
  use_local_ai: false,
  ollama_model: null,
  custom_providers: [],
};

export function getLocalConfig() {
  try {
    const stored = localStorage.getItem(CONFIG_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Legacy configs have no ai_provider. Derive it from the model, or the
      // ai_provider default ('openai') would route saved Claude models to OpenAI.
      if (!parsed.ai_provider && parsed.ai_model) {
        parsed.ai_provider = parsed.ai_model.startsWith('claude') ? 'anthropic' : 'openai';
      }
      // Migrate legacy ai_base_url → openai_base_url. The old model picker set
      // ai_base_url to the Anthropic URL for Claude models; that must not
      // become the OpenAI base URL.
      if (parsed.ai_base_url && !parsed.openai_base_url
          && parsed.ai_base_url !== 'https://api.anthropic.com') {
        parsed.openai_base_url = parsed.ai_base_url;
      }
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch (e) {
    console.warn('Failed to load config:', e);
  }
  return { ...DEFAULT_CONFIG };
}

export function saveLocalConfig(config) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      throw new Error('Browser storage is full. Clear some data in Settings or use a different browser.');
    }
    console.warn('Failed to save config:', e);
    throw new Error('Failed to save settings: ' + e.message);
  }
}

// ============================================================================
// callBackend() — main dispatch function
// Routes commands to client-side handlers or CORS proxy.
// All existing component code calls this — we just changed what's under the hood.
// ============================================================================

/** Thrown for desktop-only commands. Callers must not treat it as success. */
export class NotAvailableInWebError extends Error {
  constructor(cmd) {
    super(`'${cmd}' is not available in the web version.`);
    this.name = 'NotAvailableInWebError';
    this.code = 'NOT_AVAILABLE_IN_WEB';
    this.cmd = cmd;
  }
}

export async function callBackend(cmd, args = {}) {
  const handler = HANDLERS[cmd];
  if (handler) {
    return handler(args);
  }

  // Desktop-only command (file tagging, local scans, chapters, export, ...).
  // Throw so no caller can report success, and emit an event so the app shows
  // a toast even where a caller only logs the error.
  const err = new NotAvailableInWebError(cmd);
  console.warn(err.message);
  emitEvent('backend_unavailable', { cmd, message: err.message });
  throw err;
}

/** Age/content tags derived from an AI age_rating (object or numeric age). */
function buildAgeTags(ageRating) {
  const age_tags = [];
  if (ageRating && typeof ageRating === 'object') {
    if (ageRating.intended_for_kids === true) age_tags.push('for-kids');
    else age_tags.push('not-for-kids');
    const catMap = { "Children's 0-2": 'age-childrens', "Children's 3-5": 'age-childrens', "Children's 6-8": 'age-childrens', "Children's 9-12": 'age-childrens', 'Teen 13-17': 'age-teens', 'Young Adult': 'age-young-adult', 'Adult': 'age-adult', 'Middle Grade': 'age-middle-grade' };
    if (catMap[ageRating.age_category]) age_tags.push(catMap[ageRating.age_category]);
    const ratingMap = { 'G': 'rated-g', 'PG': 'rated-pg', 'PG-13': 'rated-pg13', 'R': 'rated-r', 'X': 'rated-x' };
    if (ratingMap[ageRating.content_rating]) age_tags.push(ratingMap[ageRating.content_rating]);
    const recMap = { "Children's 0-2": 'age-rec-0', "Children's 3-5": 'age-rec-3', "Children's 6-8": 'age-rec-6', "Children's 9-12": 'age-rec-10', 'Teen 13-17': 'age-rec-14', 'Young Adult': 'age-rec-16', 'Adult': 'age-rec-18', 'Middle Grade': 'age-rec-8' };
    if (recMap[ageRating.age_category]) age_tags.push(recMap[ageRating.age_category]);
  } else if (typeof ageRating === 'number') {
    if (ageRating <= 6) { age_tags.push('age-childrens', 'for-kids', 'rated-g', 'age-rec-0'); }
    else if (ageRating <= 9) { age_tags.push('age-childrens', 'for-kids', 'rated-g', 'age-rec-6'); }
    else if (ageRating <= 12) { age_tags.push('age-middle-grade', 'for-kids', 'rated-pg', 'age-rec-10'); }
    else if (ageRating <= 15) { age_tags.push('age-teens', 'for-teens', 'rated-pg13', 'age-rec-14'); }
    else if (ageRating <= 17) { age_tags.push('age-young-adult', 'for-ya', 'rated-pg13', 'age-rec-16'); }
    else { age_tags.push('age-adult', 'not-for-kids', 'rated-r', 'age-rec-18'); }
  }
  return age_tags;
}

// ============================================================================
// DNA-TO-TAGS CONVERTER — converts BookDNA JSON to dna: prefixed tags
// ============================================================================

function convertDnaToTags(dna) {
  const tags = [];
  if (dna.length) tags.push(`dna:length:${dna.length}`);
  if (dna.pacing) tags.push(`dna:pacing:${dna.pacing}`);
  if (dna.structure) tags.push(`dna:structure:${dna.structure}`);
  if (dna.pov) tags.push(`dna:pov:${dna.pov}`);
  if (dna.series_position) tags.push(`dna:series-position:${dna.series_position}`);
  if (dna.pub_era) tags.push(`dna:pub-era:${dna.pub_era}`);
  if (dna.setting) tags.push(`dna:setting:${dna.setting}`);
  if (dna.ending_type) tags.push(`dna:ending:${dna.ending_type}`);
  if (dna.opening_energy) tags.push(`dna:opening-energy:${dna.opening_energy}`);
  if (dna.ending_energy) tags.push(`dna:ending-energy:${dna.ending_energy}`);
  if (dna.humor_type) tags.push(`dna:humor:${dna.humor_type}`);
  if (dna.stakes_level) tags.push(`dna:stakes:${dna.stakes_level}`);
  if (dna.protagonist_count) tags.push(`dna:protagonist:${dna.protagonist_count}`);
  if (dna.prose_style) tags.push(`dna:prose:${dna.prose_style}`);
  if (dna.series_dependency) tags.push(`dna:series-dependency:${dna.series_dependency}`);
  if (dna.production) tags.push(`dna:production:${dna.production}`);
  if (dna.narrator_performance) {
    const perfs = Array.isArray(dna.narrator_performance) ? dna.narrator_performance : [dna.narrator_performance];
    perfs.forEach(p => tags.push(`dna:narrator-performance:${p}`));
  }
  if (dna.audio_friendliness != null) tags.push(`dna:audio-friendliness:${dna.audio_friendliness}`);
  if (dna.re_listen_value != null) tags.push(`dna:re-listen-value:${dna.re_listen_value}`);
  if (dna.violence_level != null) tags.push(`dna:violence-level:${dna.violence_level}`);
  if (dna.intimacy_level != null) tags.push(`dna:intimacy-level:${dna.intimacy_level}`);
  if (dna.tropes) dna.tropes.forEach(t => tags.push(`dna:trope:${t}`));
  if (dna.themes) dna.themes.forEach(t => tags.push(`dna:theme:${t}`));
  if (dna.relationship_focus) {
    const rels = Array.isArray(dna.relationship_focus) ? dna.relationship_focus : [dna.relationship_focus];
    rels.forEach(r => tags.push(`dna:relationship:${r}`));
  }
  if (dna.shelves) {
    const shelves = Array.isArray(dna.shelves) ? dna.shelves : [dna.shelves];
    shelves.forEach(s => tags.push(`dna:shelf:${s}`));
  }
  if (dna.comp_authors) {
    const authors = Array.isArray(dna.comp_authors) ? dna.comp_authors : [dna.comp_authors];
    authors.forEach(a => tags.push(`dna:comp-author:${a}`));
  }
  if (dna.comp_vibes) {
    const vibes = Array.isArray(dna.comp_vibes) ? dna.comp_vibes : [dna.comp_vibes];
    vibes.forEach(v => tags.push(`dna:comp-vibe:${v}`));
  }
  if (dna.spectrums) {
    const specs = Array.isArray(dna.spectrums) ? dna.spectrums : [];
    specs.forEach(s => { if (s.dimension != null && s.value != null) tags.push(`dna:spectrum:${s.dimension}:${s.value}`); });
  }
  if (dna.moods) {
    const moods = Array.isArray(dna.moods) ? dna.moods : [];
    moods.forEach(m => { if (m.mood && m.intensity != null) tags.push(`dna:mood:${m.mood}:${m.intensity}`); });
  }
  return tags;
}

// ============================================================================
// ABS PAYLOAD BUILDER — matches desktop build_update_payload() exactly
// ============================================================================

// ============================================================================
// SERIES HELPERS (#2)
// ============================================================================

/**
 * Normalize a series name for matching against the library's existing series:
 * case-insensitive, trimmed, leading "The " and trailing " Series"/" Saga"/
 * " Trilogy"/" Cycle" removed, punctuation stripped, whitespace collapsed.
 */
export function normalizeSeriesName(name) {
  if (name == null) return '';
  let n = String(name).toLowerCase().trim();
  n = n.replace(/['\u2018\u2019`]/g, ''); // apostrophes join: "Ender's" -> "enders"
  n = n.replace(/&/g, ' and ');
  n = n.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  n = n.replace(/^the\s+/, '');
  n = n.replace(/\s+(series|saga|trilogy|cycle)$/, '');
  return n.trim();
}

/** Find an existing library series ({id, name}) whose normalized name matches. */
export function findLibrarySeries(name, librarySeries) {
  const key = normalizeSeriesName(name);
  if (!key || !Array.isArray(librarySeries)) return null;
  return librarySeries.find(s => s && s.name && normalizeSeriesName(s.name) === key) || null;
}

/** Fetch every series in an ABS library as [{id, name}] (paginated). */
export async function fetchLibrarySeries(baseUrl, token, libraryId) {
  const out = [];
  const limit = 500;
  for (let page = 0; page < 200; page++) {
    const data = await absApi(baseUrl, token, `/api/libraries/${libraryId}/series?limit=${limit}&page=${page}`);
    const results = data?.results || [];
    for (const s of results) if (s?.id && s?.name) out.push({ id: s.id, name: s.name });
    const total = data?.total ?? out.length;
    if (results.length === 0 || out.length >= total) break;
  }
  return out;
}

/** True if a push of these items will need the library series list. */
/**
 * Fetch the library's series once per push, only when preserve_series is OFF
 * and some item actually needs a name matched. Failure falls back to [] (name
 * only; ABS still dedups exact case-insensitive names).
 */
async function loadLibrarySeriesForPush(config, items) {
  if (config.preserve_series !== false) return [];
  if (!config.abs_library_id || !needsLibrarySeries(items)) return [];
  try {
    return await fetchLibrarySeries(config.abs_base_url, config.abs_api_token, config.abs_library_id);
  } catch (err) {
    console.warn('[series] Could not fetch library series; sending names unmatched:', err);
    return [];
  }
}

function needsLibrarySeries(items) {
  return items.some(item => {
    const meta = item.metadata || item;
    return !(meta.all_series && meta.all_series.length > 0) && !!meta.series;
  });
}

// ---- diff helpers ----
const PLACEHOLDER_RE = /^unknown$/i;
function scalar(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}
function list(v) {
  return Array.isArray(v) ? v.filter(x => x != null && String(x).trim() !== '').map(x => String(x).trim()) : [];
}
function sameSet(a, b) {
  const A = list(a), B = list(b);
  if (A.length !== B.length) return false;
  const sb = new Set(B);
  return A.every(x => sb.has(x));
}
function seriesKey(meta) {
  const all = Array.isArray(meta?.all_series) ? meta.all_series : [];
  return JSON.stringify({
    s: scalar(meta?.series), q: scalar(meta?.sequence),
    a: all.filter(s => s && s.name).map(s => [scalar(s.name), scalar(s.sequence)]),
  });
}
function yearOf(meta) {
  return meta?.year ?? meta?.published_year ?? meta?.publishedYear ?? null;
}

/**
 * Build ABS-formatted PATCH payload from internal metadata.
 *
 * Diff mode (opts.original = the book's metadata as imported from ABS):
 * only fields whose value differs from the import are sent. Tags/genres are
 * compared as sets; a change is sent verbatim. An empty list is sent only if
 * the import had values (i.e. they were cleared in this session).
 *
 * Fallback (no snapshot): every non-empty field is sent, but never an empty
 * genres/tags list.
 *
 * In BOTH modes, tags/genres are sent as-is: the tag/genre policy (approved
 * list, caps, fuzzy mapping) is applied where AI produces values, never here,
 * so existing ABS tags (dna:*, favorites, owned, ...) survive a push.
 *
 * - Authors/narrators: split with splitPeople ("King, Jr." stays one name,
 *   "Unknown" is dropped — an authorless book omits `authors`).
 * - Tags: top level (not inside metadata).
 *
 * Series (#2): ABS creates a new series for any name it doesn't know exactly
 * and REMOVES any series missing from the array, so:
 * - preserve_series ON (default): the `series` key is omitted entirely.
 * - preserve_series OFF: existing all_series is sent unchanged; a book with no existing series
 *   gets its (AI/user) series name, reusing the library's existing series
 *   {id, name} when a normalized name matches. In diff mode nothing is sent
 *   if the series info is unchanged.
 * - `series: []` is never sent (CR-4a) — no info means omit the key.
 *
 * @param {object} meta
 * @param {object} [opts]
 * @param {object|null} [opts.original] import snapshot to diff against
 * @param {boolean} [opts.preserveSeries] defaults to config.preserve_series !== false
 * @param {Array<{id,name}>} [opts.librarySeries] existing series in the library
 */
export function buildAbsPayload(meta, opts = {}) {
  const config = getLocalConfig();
  const preserveSeries = opts.preserveSeries ?? (config.preserve_series !== false);
  const original = opts.original || null;
  const metadata = {};

  const changed = (cur, orig) => !original || scalar(cur) !== scalar(orig);

  const scalars = [
    ['title', meta.title, original?.title],
    ['subtitle', meta.subtitle, original?.subtitle],
    ['description', meta.description, original?.description],
    ['publisher', meta.publisher, original?.publisher],
    ['publishedYear', yearOf(meta), yearOf(original)],
    ['isbn', meta.isbn, original?.isbn],
    ['asin', meta.asin, original?.asin],
    ['language', meta.language, original?.language],
  ];
  for (const [key, cur, orig] of scalars) {
    if (hasValue(cur) && !(key === 'title' && PLACEHOLDER_RE.test(scalar(cur))) && changed(cur, orig)) {
      metadata[key] = cur;
    }
  }

  if (changed(meta.author, original?.author)) {
    const names = splitPeople(meta.author);
    if (names.length > 0) metadata.authors = names.map((name, i) => ({ id: `new-${i + 1}`, name }));
  }

  if (changed(meta.narrator, original?.narrator)) {
    const names = splitPeople(meta.narrator);
    if (names.length > 0) metadata.narrators = names;
  }

  const curGenres = list(meta.genres);
  if (!original) {
    if (curGenres.length > 0) metadata.genres = curGenres;
  } else if (!sameSet(curGenres, original.genres)) {
    metadata.genres = curGenres; // may be [] only when import had genres
  }

  const hasSeq = (v) => v !== undefined && v !== null && String(v).trim() !== '';
  const seriesUnchanged = original && seriesKey(meta) === seriesKey(original);
  if (!preserveSeries && !seriesUnchanged) {
    if (meta.all_series && meta.all_series.length > 0) {
      // Book already has series in ABS: send them back unchanged.
      // (Series parsed from a minified seriesName carry no id; ABS matches
      // exact names to the existing series.)
      const out = meta.all_series.filter(s => s && s.name).map(s => {
        const obj = {};
        if (s.id) obj.id = s.id;
        obj.name = s.name;
        if (hasSeq(s.sequence)) obj.sequence = String(s.sequence);
        return obj;
      });
      if (out.length > 0) metadata.series = out;
    } else if (meta.series && String(meta.series).trim()) {
      // Book has no series yet: fill it, reusing an existing library series.
      const match = findLibrarySeries(meta.series, opts.librarySeries);
      const obj = match ? { id: match.id, name: match.name } : { name: String(meta.series).trim() };
      if (hasSeq(meta.sequence)) obj.sequence = String(meta.sequence);
      metadata.series = [obj];
    }
    // else: no series info — omit the key (never send [], it wipes series).
  }

  // Tags: TOP LEVEL (not inside metadata), sent verbatim.
  const payload = { metadata };
  const curTags = list(meta.tags);
  if (!original) {
    if (curTags.length > 0) payload.tags = curTags;
  } else if (!sameSet(curTags, original.tags)) {
    payload.tags = curTags; // may be [] only when import had tags
  }

  return payload;
}

/** True if a payload from buildAbsPayload would change nothing. */
export function isEmptyPayload(payload) {
  return Object.keys(payload.metadata || {}).length === 0 && !('tags' in payload);
}


// ============================================================================
// COMMAND HANDLERS — client-side implementations
// ============================================================================

const HANDLERS = {
  // === Config (localStorage) ===
  get_config: () => getLocalConfig(),
  save_config: (args) => { saveLocalConfig(args.config || args); return {}; },

  // === ABS Connection ===
  test_abs_connection: async (args) => {
    const config = args.config || getLocalConfig();
    if (!config.abs_base_url) return { success: false, message: 'No URL configured' };
    try {
      await absApi(config.abs_base_url, config.abs_api_token, '/api/libraries');
      return { success: true, message: `Connected to ${config.abs_base_url}` };
    } catch (err) {
      return { success: false, message: err.message };
    }
  },

  // === ABS Import ===
  import_from_abs: async () => {
    const config = getLocalConfig();
    // The items list endpoint always returns minified items (it ignores
    // expanded=1); series are parsed from seriesName. Each book's metadata is
    // snapshotted so a later push only sends what changed.
    const groups = await importLibraryGroups(config, (current, total, message) =>
      emitEvent('import_progress', { current, total, message }));
    return { groups, total: groups.length, total_imported: groups.length };
  },

  // === ABS Push ===
  // Both push commands share pushItemsToAbs. Each item is diffed against its
  // import snapshot; unchanged books are not PATCHed at all.
  push_abs_updates: async (args) => {
    const items = args.request?.items || args.items || [];
    const r = await pushItemsToAbs(items);
    return { ...r, success: r.updated };
  },

  push_abs_imports: async (args) => {
    const items = args.request?.items || args.items || [];
    return pushItemsToAbs(items);
  },

  // === ABS Chapters ===
  get_abs_chapters: async (args) => {
    const config = getLocalConfig();
    const data = await absApi(config.abs_base_url, config.abs_api_token, `/api/items/${args.absId}`);
    return { chapters: data.media?.chapters || [] };
  },

  // === Full Pipeline (matching desktop process_with_pipeline) ===
  process_with_pipeline: async (args) => {
    const config = getLocalConfig();
    const request = args.request || {};
    const books = request.books || [];
    const results = [];
    let processed = 0, failed = 0;

    for (let i = 0; i < books.length; i++) {
      const book = books[i];
      try {
        emitEvent('pipeline_progress', { current: i + 1, total: books.length, phase: 'classifying', message: `Classifying ${book.title}...` });

        // Step 1: Classification (genres, tags, age, themes, tropes)
        const classifyPrompt = buildClassificationPrompt(book, null, config.custom_classification_rules || null);
        const classifyResponse = await callAI(config, getSystemPrompt(config), classifyPrompt, 2000);
        const classify = parseAIJson(classifyResponse);

        // Step 2: DNA generation
        let dna_tags = [];
        try {
          emitEvent('pipeline_progress', { current: i + 1, total: books.length, phase: 'dna', message: `DNA for ${book.title}...` });
          const dnaPrompt = buildDnaPrompt(book);
          const dnaResponse = await callAI(config, getDnaSystemPrompt(config), dnaPrompt, 3000);
          dna_tags = convertDnaToTags(parseAIJson(dnaResponse));
        } catch (e) { console.warn('DNA failed:', e.message); }

        // Step 3: Description
        let description = book.description;
        let description_changed = false;
        try {
          emitEvent('pipeline_progress', { current: i + 1, total: books.length, phase: 'description', message: `Description for ${book.title}...` });
          const descPrompt = buildDescriptionPrompt(book, config.custom_description_validate_rules || null, config.custom_description_generate_rules || null);
          const descResponse = await callAI(config, getSystemPrompt(config), descPrompt, 800);
          const desc = parseAIJson(descResponse);
          if (desc.description) { description = desc.description; description_changed = true; }
        } catch (e) { console.warn('Description failed:', e.message); }

        const age_tags = buildAgeTags(classify.age_rating);

        // Merge all tags
        // AI-produced tags only, policed; the caller MERGES them into the
        // book's existing tags (see useScan.handlePipelineRescan).
        const allTags = policeAiTags([...new Set([...(classify.tags || []), ...age_tags, ...dna_tags])]);

        results.push({
          abs_id: book.abs_id,
          success: true,
          metadata: {
            genres: policeAiGenres(classify.genres, config),
            tags: allTags,
            themes: classify.themes || [],
            tropes: classify.tropes || [],
            description,
          },
        });
        processed++;
      } catch (err) {
        results.push({ abs_id: book.abs_id, success: false, error: err.message });
        failed++;
      }
    }
    return { books: results, processed, failed };
  },

  // === ABS Cache (client-side in-memory) ===
  // No local library cache in the web build.
  get_abs_cache_status: () => ({ is_loaded: false, is_stale: true, stale: true, stats: { total_items: 0 } }),
  refresh_abs_cache: async () => ({ refreshed: true, stats: { total_items: 0 } }),
  get_cached_items: () => [],
  clear_abs_full_cache: () => 'Cache cleared',
  clear_abs_library_cache: () => 'Cache cleared',

  // === External Data Gathering (stub — desktop-only feature, calls Audible/Goodreads via Rust) ===
  gather_external_data: async (args) => {
    // Web can't call these APIs directly (no CORS). Return empty results.
    // handleRunAll catches this gracefully and continues without gathered data.
    const books = args.books || [];
    return { results: books.map(b => ({ id: b.id, gathered: false })) };
  },
  get_unprocessed_abs_items: async () => ({ items: [] }),

  // === GPT: Metadata Resolution (batch) ===
  resolve_metadata_batch: async (args) => {
    const config = getLocalConfig();
    const books = args.books || [];
    const CONCURRENCY = 5;
    const results = [];

    const processBook = async (book) => {
      try {
        const prompt = buildMetadataPrompt(book);
        const response = await callAI(config, SYSTEM_PROMPT, prompt, 1500);
        const parsed = parseAIJson(response);
        const title = parsed.title || book.current_title;
        const author = parsed.author || book.current_author;
        const subtitle = parsed.subtitle || null;
        // CR-4b: a missing/null series or sequence from the AI falls back to the
        // book's current value — an AI response can never clear a series.
        // #2: with preserve_series ON the AI never changes series/sequence.
        const preserveSeries = config.preserve_series !== false;
        const series = (!preserveSeries && hasValue(parsed.series)) ? parsed.series : (book.current_series ?? null);
        const sequence = (!preserveSeries && hasValue(parsed.sequence)) ? parsed.sequence : (book.current_sequence ?? null);
        const narrator = parsed.narrator || null;
        const changed = title !== book.current_title || author !== book.current_author
          || subtitle !== (book.current_subtitle || null)
          || (series ?? '') !== (book.current_series ?? '')
          || String(sequence ?? '') !== String(book.current_sequence ?? '');
        return { id: book.id, title, author, subtitle, series, sequence, narrator, confidence: parsed.confidence || 75, changed };
      } catch (err) {
        return { id: book.id, error: err.message, changed: false };
      }
    };

    for (let i = 0; i < books.length; i += CONCURRENCY) {
      const chunk = books.slice(i, i + CONCURRENCY);
      results.push(...await Promise.all(chunk.map(processBook)));
    }
    const total_processed = results.filter(r => !r.error).length;
    const total_failed = results.filter(r => r.error).length;
    return { results, total_processed, total_failed };
  },

  // === GPT: Metadata Resolution (single) ===
  resolve_title: async (args) => {
    const config = getLocalConfig();
    const input = args.request || args;
    const prompt = buildMetadataPrompt(input);
    const response = await callAI(config, SYSTEM_PROMPT, prompt, 1500);
    const parsed = parseAIJson(response);
    return {
      title: parsed.title || input.current_title,
      author: parsed.author || input.current_author,
      subtitle: parsed.subtitle || null,
      // CR-4b / #2: never clear a series; never change it when preserve_series is ON.
      series: (config.preserve_series === false && hasValue(parsed.series)) ? parsed.series : (input.current_series ?? null),
      sequence: (config.preserve_series === false && hasValue(parsed.sequence)) ? parsed.sequence : (input.current_sequence ?? null),
      narrator: parsed.narrator || null,
      confidence: parsed.confidence || 75,
      notes: parsed.notes || null,
    };
  },

  // === GPT: Series Resolution ===
  resolve_series: async (args) => {
    const config = getLocalConfig();
    const input = args.request || args;
    const prompt = `Find the series for this audiobook:
Title: ${safe(input.title)}
Author: ${safe(input.author)}
${input.current_series ? `Current series: ${safe(input.current_series)}` : ''}

Return JSON: {"series":null,"sequence":null,"confidence":0,"source":"gpt"}
If it's part of a series, fill in the name and book number. If standalone, use null.`;
    const response = await callAI(config, SYSTEM_PROMPT, prompt, 500);
    return parseAIJson(response);
  },

  // === GPT: Classification (genres + tags + age + DNA + themes/tropes — matching desktop classify_book) ===
  classify_books_batch: async (args) => {
    const config = getLocalConfig();
    const books = args.books || [];
    const dnaEnabled = args.dnaEnabled !== false;
    const CONCURRENCY = 5; // Process 5 books in parallel
    const results = [];

    // Process a single book (classification + DNA in parallel)
    const processBook = async (book) => {
      try {
        const classifyPromise = callAI(config, getSystemPrompt(config),
          buildClassificationPrompt(book, null, config.custom_classification_rules || null), 2000);
        const dnaPromise = dnaEnabled
          ? callAI(config, getDnaSystemPrompt(config), buildDnaPrompt(book), 1500).catch(() => null)
          : Promise.resolve(null);

        const [response, dnaResponse] = await Promise.all([classifyPromise, dnaPromise]);
        const parsed = parseAIJson(response);

        const ageRating = parsed.age_rating;
        const age_tags = buildAgeTags(ageRating);

        let dna_tags = [];
        if (dnaResponse) {
          try { dna_tags = convertDnaToTags(parseAIJson(dnaResponse)); } catch {}
        }

        return {
          id: book.id, success: true,
          // Policy applies to AI output only (never to existing ABS tags).
          genres: policeAiGenres(parsed.genres, config), tags: policeAiTags(parsed.tags),
          age_tags, dna_tags,
          themes: parsed.themes || [], tropes: parsed.tropes || [],
          age_category: ageRating?.age_category || null,
          content_rating: ageRating?.content_rating || null,
          intended_for_kids: ageRating?.intended_for_kids || false,
        };
      } catch (err) {
        return { id: book.id, success: false, error: err.message };
      }
    };

    // Process in batches of CONCURRENCY
    for (let i = 0; i < books.length; i += CONCURRENCY) {
      const chunk = books.slice(i, i + CONCURRENCY);
      const chunkResults = await Promise.all(chunk.map(processBook));
      results.push(...chunkResults);
    }

    const total_processed = results.filter(r => r.success).length;
    const total_failed = results.filter(r => !r.success).length;
    return { results, total_processed, total_failed };
  },

  // === GPT: Description Processing ===
  fix_descriptions_with_gpt: async (args) => {
    const config = getLocalConfig();
    const books = args.books || [];
    const CONCURRENCY = 5;
    const results = [];

    const processBook = async (book) => {
      try {
        const prompt = buildDescriptionPrompt(book, config.custom_description_validate_rules || null, config.custom_description_generate_rules || null);
        const response = await callAI(config, getSystemPrompt(config), prompt, 800);
        const parsed = parseAIJson(response);
        const action = parsed.action || 'kept';
        return { id: book.id, success: true, fixed: action === 'rewritten' || action === 'generated', new_description: parsed.description || null, action, reason: parsed.reason || null };
      } catch (err) {
        return { id: book.id, success: false, error: err.message };
      }
    };

    for (let i = 0; i < books.length; i += CONCURRENCY) {
      const chunk = books.slice(i, i + CONCURRENCY);
      results.push(...await Promise.all(chunk.map(processBook)));
    }
    return { results };
  },

  // === Description Processing (pipeline alias) ===
  process_descriptions_batch: async (args) => {
    const config = getLocalConfig();
    const books = args.books || args.request?.books || [];
    const CONCURRENCY = 5;
    const results = [];

    const processBook = async (book) => {
      try {
        const prompt = buildDescriptionPrompt(book, config.custom_description_validate_rules || null, config.custom_description_generate_rules || null);
        const response = await callAI(config, getSystemPrompt(config), prompt, 800);
        const parsed = parseAIJson(response);
        const action = parsed.action || 'kept';
        return { id: book.id, success: true, changed: action === 'rewritten' || action === 'generated', description: parsed.description || null, action, reason: parsed.reason || null };
      } catch (err) {
        return { id: book.id, success: false, error: err.message };
      }
    };

    for (let i = 0; i < books.length; i += CONCURRENCY) {
      const chunk = books.slice(i, i + CONCURRENCY);
      results.push(...await Promise.all(chunk.map(processBook)));
    }
    const total_processed = results.filter(r => r.success && r.changed).length;
    const total_failed = results.filter(r => !r.success).length;
    return { results, total_processed, total_failed };
  },

  // === GPT: Genre Cleanup ===
  cleanup_genres_with_gpt: async (args) => {
    const config = getLocalConfig();
    const books = args.books || [];
    const results = [];

    for (const book of books) {
      try {
        const prompt = `Classify the genres for this audiobook. Return 1-3 genres from the APPROVED LIST ONLY.

Title: ${safe(book.title)}
Author: ${safe(book.author)}
Current genres: ${(book.genres || []).join(', ') || 'none'}
${book.description ? `Description: ${safe(book.description.substring(0, 300))}` : ''}

APPROVED GENRES (use ONLY these exact names):
Literary Fiction, Contemporary Fiction, Historical Fiction, Classics, Mystery, Thriller, Crime, Horror, Romance, Fantasy, Science Fiction, Western, Adventure, Humor, Satire, Women's Fiction, LGBTQ+ Fiction, Short Stories, Anthology, Biography, Autobiography, Memoir, History, True Crime, Science, Popular Science, Psychology, Self-Help, Business, Personal Finance, Health & Wellness, Philosophy, Religion & Spirituality, Politics, Essays, Journalism, Travel, Food & Cooking, Nature, Sports, Music, Art, Education, Parenting & Family, Relationships, Non-Fiction, Young Adult, Middle Grade, Children's, New Adult, Adult, Children's 0-2, Children's 3-5, Children's 6-8, Children's 9-12, Teen 13-17, Audiobook Original, Full Cast Production, Dramatized, Podcast Fiction

RULES:
- Max 3 genres. Specific first, broad last.
- "Young Adult" only for books published in the YA section. Adult books with young protagonists are NOT YA.
- Do NOT invent genres not on this list.

Return JSON: {"genres":["Genre1","Genre2"]}`;
        const response = await callAI(config, SYSTEM_PROMPT, prompt, 500);
        const parsed = parseAIJson(response);
        // Enforce genre policy on AI output if enabled
        const genres = policeAiGenres(parsed.genres, config);
        const original = book.genres || [];
        const changed = genres.length > 0 && JSON.stringify(genres) !== JSON.stringify(original);
        results.push({ id: book.id, success: true, changed, genres, cleaned_genres: changed ? genres : original, original_genres: original });
      } catch (err) {
        results.push({ id: book.id, success: false, changed: false, error: err.message });
      }
    }
    return {
      results,
      total_cleaned: results.filter(r => r.changed).length,
      total_unchanged: results.filter(r => r.success && !r.changed).length,
      total_failed: results.filter(r => !r.success).length,
    };
  },

  // === GPT: Tag Assignment (standard tags + DNA, matching desktop classify_book) ===
  assign_tags_with_gpt: async (args) => {
    const config = getLocalConfig();
    const books = args.books || [];
    const dnaEnabled = args.dnaEnabled === true; // default OFF for web
    const results = [];

    for (const book of books) {
      try {
        // Accept duration in seconds (book.duration) or minutes (book.duration_minutes)
        const durationSec = book.duration || (book.duration_minutes ? book.duration_minutes * 60 : null);
        const durationStr = durationSec ? `${Math.floor(durationSec / 3600)}h ${Math.floor((durationSec % 3600) / 60)}m` : null;

        // --- STEP 1: Standard tags ---
        const tagInstructions = config.custom_tag_instructions || DEFAULT_TAG_INSTRUCTIONS;
        const prompt = `Assign comprehensive tags for this audiobook. Select ONLY from the approved tag list below.

Title: ${safe(book.title)}
Author: ${safe(book.author)}
Genres: ${(book.genres || []).join(', ') || 'unknown'}
${book.series ? `Series: ${safe(book.series)}` : ''}
${book.narrator ? `Narrator: ${safe(book.narrator)}` : ''}
${durationStr ? `Duration: ${durationStr}` : ''}
${book.description ? `Description: ${safe(book.description.substring(0, 500))}` : ''}

${tagInstructions}

Return ONLY valid JSON:
{"tags":["tag-1","tag-2","tag-3"]}`;
        const response = await callAI(config, getSystemPrompt(config), prompt, 1000);
        const parsed = parseAIJson(response);
        // Policy applies to AI output only; the UI merges these into existing tags.
        let standardTags = policeAiTags((parsed.tags || []).filter(t => !String(t).startsWith('dna:')));

        // --- STEP 2: Generate DNA tags (skip if disabled) ---
        let dnaTags = [];
        if (dnaEnabled) {
          try {
            const dnaPrompt = buildDnaPrompt(book);
            const dnaResponse = await callAI(config, getDnaSystemPrompt(config), dnaPrompt, 3000);
            const dna = parseAIJson(dnaResponse);
            dnaTags = convertDnaToTags(dna);
          } catch (dnaErr) {
            console.warn(`DNA generation failed for ${book.title}:`, dnaErr.message);
          }
        }

        // Merge standard + DNA tags
        const allTags = [...standardTags, ...dnaTags];
        results.push({ id: book.id, success: true, tags: standardTags, suggested_tags: allTags, dna_tags: dnaTags });
      } catch (err) {
        results.push({ id: book.id, success: false, tags: [], suggested_tags: [], error: err.message });
      }
    }
    const total_success = results.filter(r => r.success).length;
    const total_failed = results.filter(r => !r.success).length;
    return { results, total_success, total_failed };
  },

  // === GPT: Subtitle Fix ===
  fix_subtitles_batch: async (args) => {
    const config = getLocalConfig();
    const books = args.books || [];
    const results = [];

    for (const book of books) {
      try {
        const prompt = `Find the official subtitle for this audiobook, if one exists.

Title: ${safe(book.title)}
Author: ${safe(book.author)}
${book.series ? `Series: ${safe(book.series)}` : ''}

Return JSON: {"subtitle":null}
If the book has a well-known subtitle (e.g., "Dune: The Desert Planet"), include it. Otherwise null.`;
        const response = await callAI(config, SYSTEM_PROMPT, prompt, 300);
        const parsed = parseAIJson(response);
        results.push({ id: book.id, success: true, subtitle: parsed.subtitle || null });
      } catch (err) {
        results.push({ id: book.id, success: false, error: err.message });
      }
    }
    return { results };
  },

  // === GPT: Author Fix ===
  fix_authors_batch: async (args) => {
    const config = getLocalConfig();
    const books = args.books || [];
    const results = [];

    for (const book of books) {
      try {
        const cleaned = cleanAuthorName(book.author || '');
        results.push({ id: book.id, success: true, author: cleaned || book.author });
      } catch (err) {
        results.push({ id: book.id, success: false, error: err.message });
      }
    }
    return { results };
  },

  // === GPT: Year Fix ===
  fix_years_batch: async (args) => {
    const config = getLocalConfig();
    const books = args.books || [];
    const force = args.force || false;
    const results = [];
    let total_fixed = 0, total_skipped = 0, total_failed = 0;

    const isValidYear = (y) => {
      const n = parseInt(y, 10);
      return !isNaN(n) && n >= 1000 && n <= new Date().getFullYear() + 2;
    };

    for (const book of books) {
      // Skip books with valid years unless forcing
      if (!force && book.current_year && isValidYear(book.current_year)) {
        const date = `${book.current_year}-01-01`;
        results.push({ id: book.id, year: book.current_year, pub_date: date, pub_tag: `pub-${date}`, source: 'existing', fixed: false, skipped: true });
        total_skipped++;
        continue;
      }

      try {
        const descSnippet = book.description ? `Description: ${safe(book.description.slice(0, 200))}\n` : '';
        const prompt = `You are a librarian. Find the ORIGINAL FIRST publication year for this book.

Title: ${safe(book.title)}
Author: ${safe(book.author)}
${book.series ? `Series: ${safe(book.series)}\n` : ''}${descSnippet}
Return the ORIGINAL first publication year, NOT audiobook release, reprint, or new edition date.
Return JSON: {"year":"2005"}`;
        const response = await callAI(config, SYSTEM_PROMPT, prompt, 200);
        const parsed = parseAIJson(response);
        const year = parsed.year ? String(parsed.year) : null;
        if (year && isValidYear(year)) {
          const date = `${year}-01-01`;
          results.push({ id: book.id, year, pub_date: date, pub_tag: `pub-${date}`, source: 'ai', fixed: true });
          total_fixed++;
        } else {
          results.push({ id: book.id, year: null, fixed: false, error: 'Invalid year from AI' });
          total_failed++;
        }
      } catch (err) {
        results.push({ id: book.id, year: null, fixed: false, error: err.message });
        total_failed++;
      }
    }
    return { results, total_fixed, total_skipped, total_failed };
  },

  // === BookDNA Generation ===
  generate_book_dna_batch: async (args) => {
    const config = getLocalConfig();
    const items = args.request?.items || args.items || [];
    const results = [];

    for (const item of items) {
      try {
        const prompt = buildDnaPrompt(item);
        const response = await callAI(config, getDnaSystemPrompt(config), prompt, 3000);
        const parsed = parseAIJson(response);
        const dnaTags = convertDnaToTags(parsed);

        // Merge with existing tags (preserve non-DNA tags, replace DNA ones)
        const existingNonDna = (item.tags || []).filter(t => !t.startsWith('dna:'));
        const mergedTags = [...existingNonDna, ...dnaTags];

        results.push({ id: item.id, success: true, dna_tags: dnaTags, merged_tags: mergedTags });
      } catch (err) {
        results.push({ id: item.id, success: false, dna_tags: [], merged_tags: item.tags || [], error: err.message });
      }
    }
    return { results, total_processed: results.filter(r => r.success).length, total_failed: results.filter(r => !r.success).length };
  },

  generate_book_dna: async (args) => {
    const result = await HANDLERS.generate_book_dna_batch({ items: [args.request || args] });
    return result.results[0] || { success: false, error: 'No result' };
  },

  // === Age Rating Resolution ===
  resolve_book_age_rating: async (args) => {
    const config = getLocalConfig();
    const book = args.request || args;
    try {
      const prompt = buildClassificationPrompt(book);
      const response = await callAI(config, SYSTEM_PROMPT, prompt, 1000);
      const parsed = parseAIJson(response);
      const ar = parsed.age_rating;
      return {
        success: true,
        age_rating: ar,
        age_rating_reason: parsed.age_rating_reason,
        age_tags: policeAiTags(buildAgeTags(ar)),
        age_category: ar && typeof ar === 'object' ? ar.age_category || null : null,
        content_rating: ar && typeof ar === 'object' ? ar.content_rating || null : null,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },

  // === Genre Cleanup (local, no AI) ===
  cleanup_genres: (args) => {
    const config = getLocalConfig();
    const request = args.request || args;
    const groups = request.groups || [];
    let totalCleaned = 0, totalUnchanged = 0;
    const results = groups.map(g => {
      const originalGenres = g.genres || [];
      const cleanedGenres = config.genre_enforcement !== false
        ? enforceGenrePolicyWithSplit(originalGenres)
        : originalGenres;
      const changed = JSON.stringify(cleanedGenres) !== JSON.stringify(originalGenres);
      if (changed) totalCleaned++; else totalUnchanged++;
      return { id: g.id, changed, cleaned_genres: cleanedGenres, original_genres: originalGenres };
    });
    return { results, total_cleaned: totalCleaned, total_unchanged: totalUnchanged };
  },

  // === Metadata Providers ===
  get_available_providers: () => [
    { id: 'goodreads', name: 'Goodreads', enabled: true },
    { id: 'hardcover', name: 'Hardcover', enabled: true },
    { id: 'storytel/language:en', name: 'Storytel', enabled: true },
    { id: 'graphicaudio', name: 'Graphic Audio', enabled: true },
    { id: 'bigfinish', name: 'Big Finish', enabled: true },
    { id: 'librivox', name: 'LibriVox', enabled: false },
  ],
  get_custom_providers: () => {
    const config = getLocalConfig();
    return config.custom_providers || [];
  },
  toggle_provider: (args) => {
    const config = getLocalConfig();
    const providers = config.custom_providers || [];
    const idx = providers.findIndex(p => p.provider_id === args.providerId);
    if (idx >= 0) {
      providers[idx].enabled = args.enabled;
      saveLocalConfig({ ...config, custom_providers: providers });
    }
    return {};
  },
  remove_custom_provider: (args) => {
    const config = getLocalConfig();
    const providers = (config.custom_providers || []).filter(p => p.provider_id !== args.providerId);
    saveLocalConfig({ ...config, custom_providers: providers });
    return {};
  },
  add_abs_agg_provider: (args) => {
    const config = getLocalConfig();
    const providers = config.custom_providers || [];
    if (!providers.some(p => p.provider_id === args.providerId)) {
      providers.push({
        name: args.providerId,
        provider_id: args.providerId,
        base_url: 'https://provider.vito0912.de',
        auth_token: 'abs',
        enabled: true,
        priority: 50,
      });
      saveLocalConfig({ ...config, custom_providers: providers });
    }
    return {};
  },
  test_provider: async (args) => {
    try {
      const res = await proxyFetch(
        `https://provider.vito0912.de/search/${args.providerId}?query=${encodeURIComponent(args.title || 'test')}&author=${encodeURIComponent(args.author || '')}`,
        { method: 'GET', headers: { Authorization: 'abs' } }
      );
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      return { success: true, results: data.length || 0 };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
  reset_providers_to_defaults: () => {
    const config = getLocalConfig();
    saveLocalConfig({ ...config, custom_providers: DEFAULT_CONFIG.custom_providers });
    return {};
  },

  // === Cover Search ===
  search_cover_options: async (args) => {
    const config = getLocalConfig();
    const covers = [];
    // Search ABS for cover
    if (config.abs_base_url && args.title) {
      try {
        const data = await absApi(config.abs_base_url, config.abs_api_token,
          `/api/search/covers?title=${encodeURIComponent(args.title)}&author=${encodeURIComponent(args.author || '')}`);
        if (data?.covers) covers.push(...data.covers);
      } catch {}
    }
    return covers;
  },
  get_cover_for_group: async (args) => {
    const config = getLocalConfig();
    if (!config.abs_base_url || !args.groupId) return null;
    const base = config.abs_base_url.replace(/\/$/, '');
    const url = `${base}/api/items/${args.groupId}/cover?token=${encodeURIComponent(config.abs_api_token)}`;
    try {
      const res = await proxyFetch(url, { method: 'GET' });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (!blob.size) return null;
      return { blobUrl: URL.createObjectURL(blob), size_kb: Math.round(blob.size / 1024) };
    } catch {
      return null;
    }
  },
  proxy_image: async (args) => {
    try {
      const res = await proxyFetch(args.url, { method: 'GET' });
      if (!res.ok) return null;
      const blob = await res.blob();
      const reader = new FileReader();
      return new Promise(resolve => {
        reader.onloadend = () => resolve({ data: reader.result, mime_type: blob.type });
        reader.readAsDataURL(blob);
      });
    } catch { return null; }
  },

  // === Validation (client-side) ===
  scan_metadata_errors: (args) => {
    const groups = args.groups || [];
    const results = [];
    for (const group of groups) {
      const issues = [];
      const m = group.metadata;
      if (!m.title || m.title === 'Unknown') issues.push({ field: 'title', severity: 'error', message: 'Missing title' });
      if (!m.author || m.author === 'Unknown') issues.push({ field: 'author', severity: 'error', message: 'Missing author' });
      if (!m.genres || m.genres.length === 0) issues.push({ field: 'genres', severity: 'warning', message: 'No genres' });
      if (!m.description) issues.push({ field: 'description', severity: 'warning', message: 'No description' });
      if (issues.length > 0) results.push({ id: group.id, title: m.title, issues });
    }
    return { results, total_issues: results.reduce((a, r) => a + r.issues.length, 0), books: results, total_scanned: groups.length, books_with_errors: results.length };
  },
  analyze_authors: (args) => {
    const groups = args.groups || [];
    const authorMap = {};
    for (const g of groups) {
      const author = g.metadata?.author;
      if (author) {
        if (!authorMap[author]) authorMap[author] = [];
        authorMap[author].push(g.id);
      }
    }
    return { authors: Object.entries(authorMap).map(([name, ids]) => ({ name, book_count: ids.length })) };
  },

  // === Authors (ABS API) ===
  get_abs_authors: async () => {
    const config = getLocalConfig();
    const data = await absApi(config.abs_base_url, config.abs_api_token, `/api/libraries/${config.abs_library_id}/authors`);
    return data.authors || [];
  },
  get_abs_author_detail: async (args) => {
    const config = getLocalConfig();
    return absApi(config.abs_base_url, config.abs_api_token, `/api/authors/${args.authorId}?include=items`);
  },
  merge_abs_authors: async (args) => {
    const config = getLocalConfig();
    return absApi(config.abs_base_url, config.abs_api_token, `/api/authors/${args.primaryId}/merge`, {
      method: 'POST',
      body: { toMergeAuthorIds: args.secondaryIds },
    });
  },
  get_abs_author_image: async (args) => {
    const config = getLocalConfig();
    try {
      const res = await proxyFetch(
        `${config.abs_base_url}/api/authors/${args.authorId}/image`,
        { method: 'GET', headers: { Authorization: `Bearer ${config.abs_api_token}` } }
      );
      if (!res.ok) return null;
      const blob = await res.blob();
      const reader = new FileReader();
      return new Promise(resolve => {
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    } catch { return null; }
  },

  // === ISBN/ASIN Lookup (via Caddy proxy to Audible + Open Library) ===
  lookup_book_isbn: async (args) => {
    const { title, author } = args.request || args;
    if (!title) return { success: false, error: 'No title' };

    let isbn = null;
    let asin = null;

    // ASIN via Audible public catalog API (proxied through Caddy)
    try {
      const titleParam = encodeURIComponent(title);
      const authorParam = encodeURIComponent(author || '');
      const audibleRes = await fetch(`/api/audible/1.0/catalog/products?title=${titleParam}&author=${authorParam}&num_results=3&response_groups=product_desc`);
      if (audibleRes.ok) {
        const data = await audibleRes.json();
        const products = data.products || [];
        if (products.length > 0) {
          const titleLower = title.toLowerCase();
          const match = products.find(p => p.title?.toLowerCase() === titleLower) || products[0];
          asin = match.asin;
        }
      }
    } catch {}

    // ISBN via Open Library (proxied through Caddy)
    try {
      const query = encodeURIComponent(`${title} ${author || ''}`);
      const olRes = await fetch(`/api/openlibrary/search.json?q=${query}&limit=5&fields=isbn,title,author_name`);
      if (olRes.ok) {
        const data = await olRes.json();
        for (const doc of (data.docs || [])) {
          if (doc.isbn?.length > 0) {
            isbn = doc.isbn.find(i => i.length === 13) || doc.isbn[0];
            break;
          }
        }
      }
    } catch {}

    if (isbn || asin) {
      return { success: true, isbn, asin };
    }
    return { success: false, error: 'Not found' };
  },

  // === Maintenance ===
  clear_cache: () => 'Cache cleared',
  get_cache_stats: () => ({ genre_cache_size: 0, response_cache_size: 0 }),
  get_genre_stats: () => 'No server-side genre stats in web mode',
  normalize_genres: () => 'Genre normalization runs client-side in web mode',

  // === Scan progress (no-op in client mode) ===
  get_scan_progress: () => ({ scanning: false, current: 0, total: 0 }),
  cancel_scan: () => ({ cancelled: false }),
  // Series analysis isn't available in web, so there is never one to cancel.
  cancel_series_scan: () => ({ cancelled: false }),

  // === Undo (client-side) ===
  get_undo_status: () => ({ has_undo: false }),
  clear_undo_state: () => {},

  // === Ollama (disabled in web mode) ===
  ollama_get_status: () => ({ installed: false, running: false, models: [] }),
  ollama_get_model_presets: () => [],
  ollama_get_disk_usage: () => 0,
};

// ============================================================================
// ABS PUSH (shared by push_abs_updates / push_abs_imports)
// ============================================================================

/**
 * PATCH each item's changes to ABS.
 * @returns {{updated:number, unchanged:number, failed:number, errors:string[], results:Array}}
 */
async function pushItemsToAbs(items) {
  const config = getLocalConfig();
  const { abs_base_url: baseUrl, abs_api_token: token } = config;
  let updated = 0, unchanged = 0, failed = 0;
  const errors = [];
  const results = [];

  const librarySeries = await loadLibrarySeriesForPush(config, items);

  for (const item of items) {
    const absId = item.abs_id || item.id;
    const label = item.metadata?.title || absId || 'unknown';
    if (!absId) {
      failed++;
      errors.push(`${label}: missing ABS item ID`);
      results.push({ id: null, success: false, error: 'Missing item ID' });
      continue;
    }
    try {
      const meta = item.metadata || item;
      const original = item.original_metadata || getImportSnapshot(absId);
      const payload = buildAbsPayload(meta, { librarySeries, original });
      if (isEmptyPayload(payload)) {
        unchanged++;
        results.push({ id: absId, success: true, unchanged: true });
        continue;
      }
      await absApi(baseUrl, token, `/api/items/${absId}/media`, { method: 'PATCH', body: payload });
      // ABS now holds this state: future pushes diff against it.
      recordImportSnapshot(absId, { ...(original || {}), ...meta });
      updated++;
      results.push({ id: absId, success: true });
    } catch (err) {
      failed++;
      const msg = err?.message || String(err);
      errors.push(`${label}: ${msg}`);
      results.push({ id: absId, success: false, error: msg });
    }
  }
  return { updated, unchanged, failed, errors, results };
}

// ============================================================================
// EVENT SUBSCRIPTION (SSE — only needed if using Axum backend, otherwise no-op)
// ============================================================================

const eventHandlers = new Map();

/**
 * Subscribe to progress events.
 * In client-side mode, this is mostly unused since operations run synchronously.
 * Kept for API compatibility with components that call subscribe().
 */
export function subscribe(eventType, handler) {
  if (!eventHandlers.has(eventType)) eventHandlers.set(eventType, new Set());
  eventHandlers.get(eventType).add(handler);
  return () => eventHandlers.get(eventType)?.delete(handler);
}

/** Emit a local event (for client-side progress tracking) */
export function emitEvent(eventType, data) {
  const handlers = eventHandlers.get(eventType);
  if (handlers) {
    for (const h of handlers) {
      try { h(data); } catch (err) { console.error(`Event handler error for '${eventType}':`, err); }
    }
  }
}

export function closeEventSource() {
  // No-op in client-side mode
}

// ============================================================================
// FILE PICKER (server-side file browser — kept for API compatibility)
// ============================================================================

let fileBrowserResolver = null;
let fileBrowserOptions = null;

export function pickPath(options = {}) {
  if (options.directory) {
    return new Promise((resolve) => {
      fileBrowserResolver = resolve;
      fileBrowserOptions = options;
      window.dispatchEvent(new CustomEvent('open-file-browser', { detail: options }));
    });
  }
  if (options.save) {
    return new Promise((resolve) => {
      const path = prompt('Enter save path:', options.defaultPath || '');
      resolve(path || null);
    });
  }
  // File upload
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = options.multiple || false;
    if (options.filters) {
      input.accept = options.filters.flatMap(f => f.extensions || []).map(ext => `.${ext}`).join(',');
    }
    input.onchange = (e) => {
      const files = Array.from(e.target.files);
      resolve(files.length === 0 ? null : options.multiple ? files : files[0]);
    };
    input.click();
  });
}

export function resolveFileBrowser(path) {
  if (fileBrowserResolver) { fileBrowserResolver(path); fileBrowserResolver = null; fileBrowserOptions = null; }
}
export function getFileBrowserOptions() { return fileBrowserOptions; }
