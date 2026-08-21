export function showToast(message, duration = 2400) {
  const region = document.getElementById('toast-region');
  if (!region) return;
  region.replaceChildren();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  region.appendChild(toast);
  window.setTimeout(() => toast.remove(), duration);
}

export function describeError(error) {
  const raw = error?.message || String(error || 'Unknown error');
  return raw.replace(/^Error:\s*/i, '').replace(/\s+at\s.+$/s, '').trim();
}

export function inferErrorLine(error) {
  const text = `${error?.message || ''}\n${error?.stack || ''}`;
  const matches = [
    text.match(/(?:line|<anonymous>):?(\d+)(?::(\d+))?/i),
    text.match(/:(\d+):(\d+)\)?(?:\n|$)/),
  ];
  for (const match of matches) {
    if (match) return { line: Number(match[1]), column: Number(match[2] || 1) };
  }
  return null;
}

export function trapFocus(container, event) {
  if (event.key !== 'Tab') return;
  const focusable = [...container.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.disabled && !element.hidden && element.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
