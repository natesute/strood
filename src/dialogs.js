import { trapFocus } from './ui.js';

let activeDialog = null;

function closeActive(value = null) {
  activeDialog?.finish(value);
}

function createDialog({ title, message, fields = [], actions }) {
  closeActive(null);
  const previousFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'app-dialog-backdrop';
  const panel = document.createElement('form');
  panel.className = 'app-dialog';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', title);

  const heading = document.createElement('h2');
  heading.textContent = title;
  panel.appendChild(heading);
  if (message) {
    const copy = document.createElement('p');
    copy.textContent = message;
    panel.appendChild(copy);
  }

  const inputs = {};
  fields.forEach((field) => {
    const label = document.createElement('label');
    label.textContent = field.label;
    const input = field.type === 'select' ? document.createElement('select') : document.createElement('input');
    input.name = field.name;
    input.value = field.value ?? '';
    if (field.placeholder) input.placeholder = field.placeholder;
    if (field.type === 'select') {
      field.options.forEach((option) => {
        const element = document.createElement('option');
        element.value = option.value;
        element.textContent = option.label;
        input.appendChild(element);
      });
    } else {
      input.type = field.type || 'text';
      if (field.min != null) input.min = field.min;
      if (field.max != null) input.max = field.max;
      if (field.step != null) input.step = field.step;
    }
    label.appendChild(input);
    inputs[field.name] = input;
    panel.appendChild(label);
  });

  const footer = document.createElement('div');
  footer.className = 'app-dialog-actions';
  actions.forEach((action) => {
    const button = document.createElement('button');
    button.type = action.submit ? 'submit' : 'button';
    button.className = `control${action.primary ? ' control-primary' : ''}${action.danger ? ' danger' : ''}`;
    button.textContent = action.label;
    button.addEventListener('click', (event) => {
      if (action.submit) return;
      event.preventDefault();
      finish(action.value);
    });
    footer.appendChild(button);
  });
  panel.appendChild(footer);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  let resolver;
  const promise = new Promise((resolve) => { resolver = resolve; });
  function finish(value) {
    overlay.remove();
    activeDialog = null;
    if (previousFocus?.isConnected) previousFocus.focus();
    resolver(value);
  }
  activeDialog = { finish };

  panel.addEventListener('keydown', (event) => {
    trapFocus(panel, event);
    if (event.key === 'Escape') finish(null);
  });
  panel.addEventListener('submit', (event) => {
    event.preventDefault();
    finish(Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.value])));
  });
  overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) finish(null); });
  requestAnimationFrame(() => (Object.values(inputs)[0] || footer.querySelector('button'))?.focus());
  return promise;
}

export function confirmDialog({ title, message, confirmLabel = 'Continue', danger = false }) {
  return createDialog({
    title,
    message,
    actions: [
      { label: 'Cancel', value: false },
      { label: confirmLabel, value: true, primary: !danger, danger },
    ],
  });
}

export async function promptDialog({ title, message = '', label, value = '', placeholder = '', confirmLabel = 'Save' }) {
  const result = await createDialog({
    title,
    message,
    fields: [{ name: 'value', label, value, placeholder }],
    actions: [{ label: 'Cancel', value: null }, { label: confirmLabel, submit: true, primary: true }],
  });
  return result?.value?.trim() || null;
}

export function choiceDialog({ title, message, choices }) {
  return createDialog({ title, message, actions: choices });
}

export async function formDialog({ title, message = '', fields, confirmLabel = 'Add' }) {
  return createDialog({
    title,
    message,
    fields,
    actions: [{ label: 'Cancel', value: null }, { label: confirmLabel, submit: true, primary: true }],
  });
}

