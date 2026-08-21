const MODE_KEY = 'strood_visualizer_mode_v1';
const MODES = new Set(['inline', 'dock', 'hidden']);

export function createVisualizerModeController(select) {
  let mode = localStorage.getItem(MODE_KEY) || 'inline';
  if (!MODES.has(mode)) mode = 'inline';

  function indexWidgets() {
    document.querySelectorAll('.cm-content > canvas[id^="_widget"]').forEach((canvas, index) => {
      canvas.style.setProperty('--viz-index', index);
    });
  }

  function apply(next) {
    mode = MODES.has(next) ? next : 'inline';
    document.body.dataset.visualizers = mode;
    select.value = mode;
    localStorage.setItem(MODE_KEY, mode);
    indexWidgets();
  }

  const observer = new MutationObserver(indexWidgets);
  observer.observe(document.getElementById('editors-container'), { childList: true, subtree: true });
  select.addEventListener('change', () => apply(select.value));
  apply(mode);
  return { get mode() { return mode; }, setMode: apply, destroy: () => observer.disconnect() };
}

