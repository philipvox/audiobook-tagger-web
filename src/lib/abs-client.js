// src/lib/abs-client.js
// AudiobookShelf API client — runs in the browser, calls ABS through the CORS proxy.

import { absApi } from './proxy';
import { importLibraryGroups } from './absImport';

/**
 * Test connection to an ABS instance.
 */
export async function testConnection(absBaseUrl, absToken) {
  if (!absBaseUrl) return { success: false, message: 'No URL configured' };
  if (!absToken) return { success: false, message: 'No API token configured' };

  try {
    await absApi(absBaseUrl, absToken, '/api/libraries');
    return { success: true, message: `Connected to ${absBaseUrl}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Fetch all libraries.
 */
export async function getLibraries(absBaseUrl, absToken) {
  const data = await absApi(absBaseUrl, absToken, '/api/libraries');
  return data.libraries || [];
}

/**
 * Import all books from an ABS library.
 * @param {object} config - App config with abs_base_url, abs_api_token, abs_library_id
 * @param {function} onProgress - Optional callback (current, total, message)
 * @returns {Array} Array of book groups
 */
export async function importLibrary(config, onProgress) {
  // Shared with import_from_abs: paginates safely (stops on an empty page),
  // parses minified seriesName/authorName, and records import snapshots.
  return importLibraryGroups(config, onProgress);
}

// Pushing lives in api.js (push_abs_imports / push_abs_updates), which diffs
// against the import snapshot. The old unused pushUpdates() here sent raw
// metadata and was removed so nothing can bypass that.

/**
 * Get chapters for a book.
 */
export async function getChapters(config, absId) {
  const data = await absApi(config.abs_base_url, config.abs_api_token, `/api/items/${absId}`);
  return data.media?.chapters || [];
}
