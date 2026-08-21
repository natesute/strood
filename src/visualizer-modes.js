const MODE_KEY = 'strood_visualizer_mode_v1';
const MODES = new Set(['inline', 'dock', 'hidden']);

export function createVisualizerModeController(select) {
  let mode = localStorage.getItem(MODE_KEY) || 'inline';
  let indexFrame = 0;
  if (!MODES.has(mode)) mode = 'inline';

  function indexWidgets() {
    indexFrame = 0;
    document.querySelectorAll('.cm-content > canvas[id^="_widget"]').forEach((canvas, index) => {
      canvas.style.setProperty('--viz-index', index);
    });
  }

  function containsWidget(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.matches?.('canvas[id^="_widget"]')) return true;
    return Boolean(node.querySelector?.('.cm-content > canvas[id^="_widget"], canvas[id^="_widget"]'));
  }

  function scheduleIndex(records) {
    const widgetsChanged = records.some((record) =>
      [...record.addedNodes, ...record.removedNodes].some(containsWidget));
    if (widgetsChanged && !indexFrame) indexFrame = requestAnimationFrame(indexWidgets);
  }

  function apply(next) {
    mode = MODES.has(next) ? next : 'inline';
    document.body.dataset.visualizers = mode;
    select.value = mode;
    localStorage.setItem(MODE_KEY, mode);
    indexWidgets();
  }

  const observer = new MutationObserver(scheduleIndex);
  observer.observe(document.getElementById('editors-container'), { childList: true, subtree: true });
  select.addEventListener('change', () => apply(select.value));
  apply(mode);
  return {
    get mode() { return mode; },
    setMode: apply,
    destroy: () => {
      observer.disconnect();
      if (indexFrame) cancelAnimationFrame(indexFrame);
    },
  };
}
