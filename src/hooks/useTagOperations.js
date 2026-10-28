import { useState, useCallback } from 'react';
import { callBackend } from '../api';
import { useApp } from '../context/AppContext';

export function useTagOperations() {
  const { config, groups, updateFileStatuses, setWriteProgress } = useApp();
  const [writing, setWriting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const writeSelectedTags = useCallback(async (selectedFiles, shouldBackup) => {
    try {
      setWriting(true);
      
      // ✅ Set initial progress
      setWriteProgress({ current: 0, total: selectedFiles.size });

      const filesMap = {};
      groups.forEach(group => {
        group.files.forEach(file => {
          filesMap[file.id] = {
            path: file.path,
            changes: file.changes
          };
        });
      });
      
      const result = await callBackend('write_tags', { 
        request: {
          file_ids: Array.from(selectedFiles),
          files: filesMap,
          backup: shouldBackup  // ✅ Use passed parameter instead of config
        }
      });

      const newStatuses = {};
      Array.from(selectedFiles).forEach(fileId => {
        const hasError = result.errors.some(e => e.file_id === fileId);
        newStatuses[fileId] = hasError ? 'failed' : 'success';
      });
      updateFileStatuses(newStatuses);
      
      // ✅ Keep progress visible for 1 second before clearing
      setTimeout(() => {
        setWriteProgress({ current: 0, total: 0 });
        setWriting(false);
      }, 1000);
      
      return result;
    } catch (error) {
      console.error('Write failed:', error);
      setWriteProgress({ current: 0, total: 0 });
      setWriting(false);
      throw error;
    }
  }, [groups, updateFileStatuses, setWriteProgress]);  // ✅ Remove config dependency
  const renameFiles = useCallback(async (selectedFiles) => {
    try {
      setWriting(true);

      const filePairs = [];
      groups.forEach(group => {
        group.files.forEach(file => {
          if (selectedFiles.has(file.id)) {
            filePairs.push([file.path, group.metadata]);
          }
        });
      });

      const result = await callBackend('rename_files', { files: filePairs });
      
      setWriting(false);
      return result;
    } catch (error) {
      console.error('Rename failed:', error);
      setWriting(false);
      throw error;
    }
  }, [groups]);

  const previewRename = useCallback(async (filePath, metadata) => {
    try {
      const preview = await callBackend('preview_rename', {
        filePath,
        metadata,
      });
      return preview;
    } catch (error) {
      console.error('Preview error:', error);
      throw error;
    }
  }, []);

 // Helper function at TOP of file
function chunkArray(array, chunkSize) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}
// src/hooks/useTagOperations.js - OPTIMIZED VERSION
// Only send ONE file per book group

const pushToAudiobookShelf = useCallback(async (selectedFiles) => {
  setPushing(true);
  try {
    // One item per book, identified by its ABS id (push_abs_updates needs it).
    const bookMap = new Map();
    groups.forEach(group => {
      if (!group.files.some(f => selectedFiles.has(f.id))) return;
      if (bookMap.has(group.id)) return;
      bookMap.set(group.id, {
        id: group.abs_id || group.id,
        abs_id: group.abs_id || group.id,
        path: group.files[0]?.path,
        metadata: group.metadata,
        group_id: group.id,
      });
    });
    const allItems = Array.from(bookMap.values());

    const CHUNK_SIZE = 50;
    let updated = 0, unchanged = 0, failed = 0;
    const errors = [];

    for (let i = 0; i < allItems.length; i += CHUNK_SIZE) {
      const chunk = allItems.slice(i, i + CHUNK_SIZE);
      try {
        const result = await callBackend('push_abs_updates', { request: { items: chunk } });
        updated += result?.updated ?? result?.success ?? 0;
        unchanged += result?.unchanged || 0;
        failed += Number(result?.failed) || 0;
        errors.push(...(result?.errors || []).map(e => (typeof e === 'string' ? e : (e?.error || JSON.stringify(e)))));
      } catch (error) {
        console.error('Push chunk failed:', error);
        failed += chunk.length;
        errors.push(error?.message || String(error));
      }
    }

    return { success: failed === 0, updated, unchanged, failed, errors };
  } finally {
    setPushing(false);
  }
}, [groups]);
  return {
    writing,
    pushing,
    writeSelectedTags,
    renameFiles,
    previewRename,
    pushToAudiobookShelf
  };
}