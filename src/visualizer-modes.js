export function createInlineVisualizerController() {
  let indexFrame = 0;

  function indexWidgets() {
    indexFrame = 0;
    const trackLinesByEditor = new Map();
    document.querySelectorAll('.cm-content canvas[id^="_widget"]').forEach((canvas) => {
      const content = canvas.closest('.cm-content');
      const containingLine = canvas.closest('.cm-line[data-track]');
      let previousTrackLine = canvas.previousElementSibling;
      while (previousTrackLine && !previousTrackLine.matches?.('.cm-line[data-track]')) {
        previousTrackLine = previousTrackLine.previousElementSibling;
      }
      let anchor = containingLine || previousTrackLine;
      if (!anchor && content) {
        let lines = trackLinesByEditor.get(content);
        if (!lines) {
          lines = [...content.querySelectorAll('.cm-line[data-track]')]
            .map((line) => ({ line, top: line.offsetTop }));
          trackLinesByEditor.set(content, lines);
        }
        const canvasTop = canvas.offsetTop;
        for (const entry of lines) {
          if (entry.top > canvasTop) break;
          anchor = entry.line;
        }
      }
      if (anchor) {
        canvas.dataset.track = anchor.dataset.track;
      } else {
        delete canvas.dataset.track;
      }
    });
  }

  function containsWidget(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.matches?.('canvas[id^="_widget"]')) return true;
    return Boolean(node.querySelector?.('.cm-content canvas[id^="_widget"], canvas[id^="_widget"]'));
  }

  function scheduleIndex(records) {
    const widgetsChanged = records.some((record) =>
      [...record.addedNodes, ...record.removedNodes].some(containsWidget));
    if (widgetsChanged && !indexFrame) indexFrame = requestAnimationFrame(indexWidgets);
  }

  const observer = new MutationObserver(scheduleIndex);
  observer.observe(document.getElementById('editors-container'), { childList: true, subtree: true });
  indexWidgets();
  return {
    refresh: () => {
      if (!indexFrame) indexFrame = requestAnimationFrame(indexWidgets);
    },
    destroy: () => {
      observer.disconnect();
      if (indexFrame) cancelAnimationFrame(indexFrame);
    },
  };
}
