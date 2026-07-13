/**
 * Progress widget: a compact progress popup shown briefly after progress
 * changes, then auto-dismisses once the save settles. Counts only the user's
 * own completed lessons (author-side "complete" status is ignored here).
 */
(function () {
  var widget = null;
  var hideTimer = null;

  function ensureWidget() {
    if (widget) return widget;
    widget = document.createElement('div');
    widget.id = 'progressWidget';
    widget.className = 'progress-widget';
    widget.setAttribute('role', 'status');
    widget.innerHTML =
      '<span class="progress-widget-save" id="progressWidgetSave"></span>' +
      '<span class="progress-widget-text" id="progressWidgetText">0 / 0</span>' +
      '<div class="progress-widget-bar"><div class="progress-widget-fill" id="progressWidgetFill"></div></div>' +
      '<span class="progress-widget-pct" id="progressWidgetPct">0%</span>';
    document.body.appendChild(widget);
    return widget;
  }

  function computeTotals() {
    if (!window.AIFSProgress) return { done: 0, total: 0, pct: 0 };
    var total = 0;
    var done = 0;
    if (typeof PHASES !== 'undefined' && PHASES && PHASES.length) {
      for (var i = 0; i < PHASES.length; i++) {
        var lessons = PHASES[i].lessons || [];
        total += lessons.length;
        for (var j = 0; j < lessons.length; j++) {
          if (lessons[j].url) {
            var lp = window.AIFSProgress.extractPath(lessons[j].url);
            if (lp && window.AIFSProgress.isLessonComplete(lp)) done++;
          }
        }
      }
    }
    var pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return { done: done, total: total, pct: pct };
  }

  function setSaveState(state) {
    var el = document.getElementById('progressWidgetSave');
    if (!el) return;
    if (state === 'saving') {
      el.textContent = '正在保存…';
      el.className = 'progress-widget-save saving';
    } else if (state === 'saved') {
      el.textContent = '已自动保存';
      el.className = 'progress-widget-save saved';
    } else {
      el.textContent = '';
      el.className = 'progress-widget-save';
    }
  }

  function render() {
    var t = computeTotals();
    ensureWidget();
    var fill = document.getElementById('progressWidgetFill');
    var text = document.getElementById('progressWidgetText');
    var pctEl = document.getElementById('progressWidgetPct');
    if (fill) fill.style.width = t.pct + '%';
    if (text) text.textContent = t.done + ' / ' + t.total;
    if (pctEl) pctEl.textContent = t.pct + '%';
  }

  function show() {
    render();
    ensureWidget().classList.add('show');
    if (hideTimer) clearTimeout(hideTimer);
  }

  function scheduleHide(delay) {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      var el = document.getElementById('progressWidget');
      if (el) el.classList.remove('show');
    }, delay);
  }

  // Auto-export: silently overwrite the stored save file a moment after
  // progress changes. Only runs when a file handle with write access already
  // exists -- never pops a picker. Debounced so bursts of changes write once.
  var autoExportTimer = null;
  var autoExportRequest = 0;
  var exportInFlight = false;
  var queuedExportRequest = 0;

  function runAutoExport(request) {
    if (exportInFlight) {
      queuedExportRequest = Math.max(queuedExportRequest, request);
      return;
    }
    exportInFlight = true;
    Promise.resolve(window.AIFSProgress.exportJSON(true)).then(function (ok) {
      exportInFlight = false;
      if (queuedExportRequest) {
        var queued = queuedExportRequest;
        queuedExportRequest = 0;
        runAutoExport(queued);
        return;
      }
      if (request !== autoExportRequest) return;
      setSaveState(ok ? 'saved' : 'idle');
      scheduleHide(ok ? 1800 : 600);
    }).catch(function () {
      exportInFlight = false;
      if (queuedExportRequest) {
        var queued = queuedExportRequest;
        queuedExportRequest = 0;
        runAutoExport(queued);
        return;
      }
      if (request !== autoExportRequest) return;
      setSaveState('idle');
      scheduleHide(600);
    });
  }

  function scheduleAutoExport() {
    if (!window.AIFSProgress || !window.AIFSProgress.exportJSON || !window.AIFSProgress.canAutoExport) return;
    if (autoExportTimer) clearTimeout(autoExportTimer);
    var request = ++autoExportRequest;
    show();
    setSaveState('idle');
    Promise.resolve(window.AIFSProgress.canAutoExport()).then(function (canExport) {
      if (request !== autoExportRequest) return;
      if (!canExport) {
        scheduleHide(2400);
        return;
      }
      setSaveState('saving');
      autoExportTimer = setTimeout(function () {
        autoExportTimer = null;
        runAutoExport(request);
      }, 2000);
    }).catch(function () {
      if (request === autoExportRequest) scheduleHide(2400);
    });
  }

  function init() {
    if (!window.AIFSProgress) return;
    var completed = window.AIFSProgress.totalCompleted();
    window.AIFSProgress.onChange(function () {
      var nextCompleted = window.AIFSProgress.totalCompleted();
      if (nextCompleted === completed) return;
      completed = nextCompleted;
      scheduleAutoExport();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
