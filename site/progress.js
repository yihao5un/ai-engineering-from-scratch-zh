/**
 * Local-only progress tracker.
 *
 * Stores everything in the user's own browser (localStorage). No network,
 * no account, no server. Data never leaves the device.
 *
 * Schema (versioned so we can migrate later without nuking users):
 *
 *   aifs:progress:v1 = {
 *     lessons: {
 *       "<lesson-path>": {
 *         answers: { "<qid>": { picked: number, correct: boolean, t: number } },
 *         completedAt: number | null,
 *         visitedAt: number
 *       }
 *     },
 *     updatedAt: number
 *   }
 *
 * "<lesson-path>" matches the path used in lesson.html?path=... and in
 * data.js urls (e.g. "phases/00-setup-and-tooling/01-dev-environment").
 *
 * "<qid>" is "<stage>-q<index>" e.g. "pre-q0", to match the quiz renderer.
 */
(function () {
  var STORAGE_KEY = 'aifs:progress:v1';
  var listeners = [];

  function emptyState() {
    return { lessons: {}, updatedAt: 0 };
  }

  function read() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyState();
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.lessons) return emptyState();
      return parsed;
    } catch (e) {
      return emptyState();
    }
  }

  function write(state) {
    state.updatedAt = Date.now();
    var saved = false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      saved = true;
    } catch (e) {
      // quota or disabled storage; fail silently
    }
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](state); } catch (_) {}
    }
    return saved;
  }

  function ensureLesson(state, path) {
    if (!state.lessons[path]) {
      state.lessons[path] = { answers: {}, completedAt: null, visitedAt: 0 };
    }
    return state.lessons[path];
  }

  function recordVisit(path) {
    if (!path) return;
    var state = read();
    var lesson = ensureLesson(state, path);
    lesson.visitedAt = Date.now();
    write(state);
  }

  function recordAnswer(path, qid, picked, correct) {
    if (!path || !qid) return;
    var state = read();
    var lesson = ensureLesson(state, path);
    lesson.answers[qid] = { picked: picked, correct: !!correct, t: Date.now() };
    write(state);
  }

  function markLessonComplete(path) {
    if (!path) return;
    var state = read();
    var lesson = ensureLesson(state, path);
    if (!lesson.completedAt) {
      lesson.completedAt = Date.now();
      write(state);
    }
  }

  function unmarkLessonComplete(path) {
    if (!path) return;
    var state = read();
    var lesson = state.lessons[path];
    if (lesson && lesson.completedAt) {
      delete lesson.completedAt;
      // 若该课再无任何学习痕迹，整个条目也没必要留着
      if (!lesson.visitedAt && (!lesson.answers || Object.keys(lesson.answers).length === 0)) {
        delete state.lessons[path];
      }
      write(state);
    }
  }

  function getLessonProgress(path) {
    if (!path) return null;
    var state = read();
    return state.lessons[path] || { answers: {}, completedAt: null, visitedAt: 0 };
  }

  function isLessonComplete(path) {
    var lp = getLessonProgress(path);
    return !!(lp && lp.completedAt);
  }

  /**
   * Given a list of lesson urls (full GitHub urls from data.js), count how
   * many the user has completed. Match by the trailing "phases/.../..." path.
   */
  function countCompletedFromUrls(urls) {
    var state = read();
    var n = 0;
    for (var i = 0; i < urls.length; i++) {
      var path = extractPath(urls[i]);
      if (path && state.lessons[path] && state.lessons[path].completedAt) n++;
    }
    return n;
  }

  function extractPath(url) {
    if (!url) return '';
    var m = String(url).match(/(phases\/[^/]+\/[^/]+)\/?/);
    return m ? m[1] : '';
  }

  function totalCompleted() {
    var state = read();
    var n = 0;
    for (var k in state.lessons) {
      if (state.lessons[k].completedAt) n++;
    }
    return n;
  }

  function reset() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](emptyState()); } catch (_) {}
    }
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  // Cross-tab sync: if user clears or updates progress in another tab,
  // refresh listeners here too.
  window.addEventListener('storage', function (e) {
    if (e.key !== STORAGE_KEY) return;
    var state = read();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](state); } catch (_) {}
    }
  });

  /**
   * Merge a remote state into the local state using per-lesson timestamps.
   * - completedAt: once non-null on either side, stays non-null (completion is irreversible).
   *   If both sides completed, keep the earlier timestamp (first completion time).
   * - answers: per qid, keep the entry with the larger t (later answer wins).
   * - visitedAt: keep the larger value.
   */
  function mergeStates(local, remote) {
    var merged = { lessons: {}, updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0) };
    var allPaths = {};
    for (var k in local.lessons) allPaths[k] = true;
    for (var k in remote.lessons) allPaths[k] = true;
    for (var path in allPaths) {
      var l = local.lessons[path] || {};
      var r = remote.lessons[path] || {};
      var mergedAnswers = {};
      var allQids = {};
      var lAnswers = l.answers || {};
      var rAnswers = r.answers || {};
      for (var q in lAnswers) allQids[q] = true;
      for (var q in rAnswers) allQids[q] = true;
      for (var qid in allQids) {
        var la = lAnswers[qid], ra = rAnswers[qid];
        if (!la) { mergedAnswers[qid] = ra; continue; }
        if (!ra) { mergedAnswers[qid] = la; continue; }
        mergedAnswers[qid] = (la.t || 0) >= (ra.t || 0) ? la : ra;
      }
      var completedAt = null;
      if (l.completedAt && r.completedAt) {
        completedAt = Math.min(l.completedAt, r.completedAt);
      } else {
        completedAt = l.completedAt || r.completedAt;
      }
      merged.lessons[path] = {
        answers: mergedAnswers,
        completedAt: completedAt,
        visitedAt: Math.max(l.visitedAt || 0, r.visitedAt || 0)
      };
    }
    return merged;
  }

  // --- File System Access API: remember a save location across sessions ---
  // On Chrome/Edge the user picks a save file once; the handle is persisted
  // in IndexedDB so later exports overwrite the same file without re-prompting.
  var FS_DB = 'aifs:fs';
  var FS_STORE = 'handles';
  var FS_KEY = 'progress-export';

  function openFSDB() {
    return new Promise(function (resolve) {
      if (!window.indexedDB) { resolve(null); return; }
      try {
        var req = indexedDB.open(FS_DB, 1);
        req.onupgradeneeded = function () {
          if (!req.result.objectStoreNames.contains(FS_STORE)) {
            req.result.createObjectStore(FS_STORE);
          }
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }

  function getStoredHandle() {
    return openFSDB().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(FS_STORE, 'readonly');
          var req = tx.objectStore(FS_STORE).get(FS_KEY);
          req.onsuccess = function () { resolve(req.result || null); };
          req.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    });
  }

  function setStoredHandle(handle) {
    return openFSDB().then(function (db) {
      if (!db) return;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(FS_STORE, 'readwrite');
          tx.objectStore(FS_STORE).put(handle, FS_KEY);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { resolve(); };
        } catch (e) { resolve(); }
      });
    });
  }

  async function canAutoExport() {
    if (!window.showSaveFilePicker) return false;
    try {
      var handle = await getStoredHandle();
      if (!handle) return false;
      if (!handle.queryPermission) return false;
      return await handle.queryPermission({ mode: 'readwrite' }) === 'granted';
    } catch (e) {
      return false;
    }
  }

  async function writeHandle(handle, text) {
    var writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  }

  var SCHEMA_VERSION = 1;

  function dateStamp() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // Wrap the raw localStorage state with schema metadata for export.
  function buildExportPayload(state) {
    return {
      schema: 'aifs:progress',
      version: SCHEMA_VERSION,
      exportedAt: Date.now(),
      lessons: state.lessons,
      updatedAt: state.updatedAt
    };
  }
  function legacyDownload(json) {
    try {
      var blob = new Blob([json], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'aifs-progress-' + dateStamp() + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Export progress as JSON. Returns a Promise<boolean>.
   * On Chrome/Edge uses the File System Access API so the user can pick a
   * save location; the chosen file handle is remembered in IndexedDB and
   * overwritten on later exports. Falls back to a normal download where the
   * API is unavailable. Returns false if the user cancels the picker.
   */
  async function exportJSON(silent, forcePicker) {
    var state = read();
    var payload = buildExportPayload(state);
    var json = JSON.stringify(payload, null, 2);

    if (window.showSaveFilePicker) {
      try {
        var handle = forcePicker ? null : await getStoredHandle();
        if (handle) {
          var perm = handle.queryPermission
            ? await handle.queryPermission({ mode: 'readwrite' })
            : 'prompt';
          if (perm === 'granted') {
            await writeHandle(handle, json);
            return true;
          }
          if (!silent && perm === 'prompt' && handle.requestPermission) {
            var granted = await handle.requestPermission({ mode: 'readwrite' });
            if (granted === 'granted') {
              await writeHandle(handle, json);
              return true;
            }
            // denied -> fall through to picker
          } else if (silent) {
            // Silent mode: have a handle but permission not granted -> skip.
            return false;
          }
        }
        if (silent) return false; // no stored handle in silent mode -> skip
        handle = await window.showSaveFilePicker({
          suggestedName: 'aifs-progress-' + dateStamp() + '.json',
          types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
        });
        await writeHandle(handle, json);
        await setStoredHandle(handle);
        return true;
      } catch (e) {
        if (e && e.name === 'AbortError') return false; // user cancelled
        // other error -> fall through to legacy download
      }
    }

    var ok = legacyDownload(json);
    return ok;
  }

  /**
   * Parse an imported JSON string and merge it into local state.
   * Returns true on success, false if the input is invalid.
   */
  // Returns { ok: true } on success, or { ok: false, error: '...' } on failure.
  function importJSON(text) {
    var remote;
    try {
      remote = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: 'JSON 解析失败：文件内容不是有效的 JSON。' };
    }
    if (!remote || typeof remote !== 'object') {
      return { ok: false, error: '文件结构不正确：缺少 lessons 对象。' };
    }
    // Accept both wrapped (with schema/version) and raw localStorage dumps.
    var version = remote.version;
    var lessons = remote.lessons;
    if (!lessons && remote.schema === 'aifs:progress') {
      // Wrapped payload but missing lessons -> corrupt
      return { ok: false, error: '文件已损坏：缺少 lessons 对象。' };
    }
    if (!lessons) {
      return { ok: false, error: '文件结构不正确：缺少 lessons 对象。' };
    }
    if (version != null && version !== SCHEMA_VERSION) {
      return { ok: false, error: '版本不匹配：文件版本为 v' + version + '，当前支持 v' + SCHEMA_VERSION + '。' };
    }
    if (typeof lessons !== 'object' || Array.isArray(lessons)) {
      return { ok: false, error: '文件结构不正确：lessons 必须是对象。' };
    }
    try {
      var local = read();
      var merged = mergeStates(local, { lessons: lessons, updatedAt: remote.updatedAt || 0 });
      if (!write(merged)) {
        return { ok: false, error: '导入失败：浏览器无法保存进度。' };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: '导入失败：无法合并或保存进度。' };
    }
  }
  window.AIFSProgress = {
    recordVisit: recordVisit,
    recordAnswer: recordAnswer,
    markLessonComplete: markLessonComplete,
    unmarkLessonComplete: unmarkLessonComplete,
    getLessonProgress: getLessonProgress,
    isLessonComplete: isLessonComplete,
    countCompletedFromUrls: countCompletedFromUrls,
    extractPath: extractPath,
    totalCompleted: totalCompleted,
    reset: reset,
    exportJSON: exportJSON,
    canAutoExport: canAutoExport,
    importJSON: importJSON,
    mergeStates: mergeStates,
    onChange: onChange,
  };
})();
