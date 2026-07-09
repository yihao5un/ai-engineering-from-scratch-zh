/**
 * Gentle "you haven't backed up in a while" nudge.
 *
 * Loaded on every page that includes progress.js (home + lesson pages) so
 * the reminder fires wherever a lesson gets completed.
 * Idempotent: safe to include alongside app.js on the home page.
 */
(function () {
  function ensureToast() {
    var toast = document.getElementById('exportReminder');
    if (toast) return toast;
    toast = document.createElement('div');
    toast.id = 'exportReminder';
    toast.className = 'export-reminder';
    toast.setAttribute('role', 'status');
    toast.innerHTML =
      '<span class="export-reminder-msg"></span>' +
      '<button class="export-reminder-btn" type="button">导出进度</button>' +
      '<button class="export-reminder-later" type="button">稍后</button>';
    document.body.appendChild(toast);
    toast.querySelector('.export-reminder-btn').addEventListener('click', function () {
      if (!window.AIFSProgress) return;
      Promise.resolve(window.AIFSProgress.exportJSON()).then(function (ok) {
        if (ok) hide();
      }).catch(function () {
        window.alert('导出失败，请稍后重试。');
      });
    });
    toast.querySelector('.export-reminder-later').addEventListener('click', function () {
      if (window.AIFSProgress && window.AIFSProgress.dismissReminder) {
        window.AIFSProgress.dismissReminder();
      }
      hide();
    });
    return toast;
  }

  function show() {
    var n = (window.AIFSProgress && window.AIFSProgress.pendingExportCount)
      ? window.AIFSProgress.pendingExportCount() : 0;
    var toast = ensureToast();
    if (!toast) return;
    toast.querySelector('.export-reminder-msg').textContent =
      n <= 1
        ? '有 1 节课程待导出备份，建议导出以防丢失。'
        : '有 ' + n + ' 节课程待导出备份，建议导出以防丢失。';
    toast.classList.add('show');
  }

  function hide() {
    var toast = document.getElementById('exportReminder');
    if (toast) toast.classList.remove('show');
  }

  function maybeShow(src) {
    if (!window.AIFSProgress || !window.AIFSProgress.shouldRemind) return;
    if (window.AIFSProgress.shouldRemind()) {
      show();
    } else {
      hide();
    }
  }

  // Auto-export: if the user has already picked a save location (stored file
  // handle), silently overwrite it a moment after progress changes. No picker
  // or permission prompt ever pops up -- it only runs when the handle already
  // has write access. Debounced so bursts of changes write once.
  var autoExportTimer = null;
  function scheduleAutoExport() {
    if (!window.AIFSProgress || !window.AIFSProgress.exportJSON) return;
    if (autoExportTimer) clearTimeout(autoExportTimer);
    autoExportTimer = setTimeout(function () {
      autoExportTimer = null;
      // silent=true: write only if a stored handle with access exists
      Promise.resolve(window.AIFSProgress.exportJSON(true)).then(function (ok) {
        if (ok) {
          hide(); // exported successfully -> no need to nudge
        }
      }).catch(function () { /* silent: ignore auto-export failures */ });
    }, 2000);
  }

  function init() {
    if (!window.AIFSProgress) return;
    window.AIFSProgress.onChange(function () { maybeShow('onChange'); scheduleAutoExport(); });
    maybeShow('init');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();