import { StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { parseTracks } from './tracks.js';

const NUMBER = '-?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const CALL_PARAMETERS = {
  gain: { min: 0, max: 1.5, step: 0.01, drag: 0.005 },
  velocity: { min: 0, max: 1.5, step: 0.01, drag: 0.005 },
  pan: { min: 0, max: 1, step: 0.01, drag: 0.005 },
  lpf: { min: 20, max: 20000, step: 10, drag: 20 },
  hpf: { min: 20, max: 20000, step: 10, drag: 20 },
  room: { min: 0, max: 1, step: 0.01, drag: 0.005 },
  size: { min: 0, max: 10, step: 0.1, drag: 0.025 },
  shape: { min: 0, max: 1, step: 0.01, drag: 0.005 },
  release: { min: 0, max: 10, step: 0.01, drag: 0.01 },
  attack: { min: 0, max: 10, step: 0.01, drag: 0.01 },
  clip: { min: 0, max: 1, step: 0.01, drag: 0.005 },
  postgain: { min: 0, max: 2, step: 0.01, drag: 0.005 },
  lpq: { min: 0, max: 20, step: 0.1, drag: 0.025 },
  orbit: { min: 1, max: 16, step: 1, drag: 0.08 },
};

const PROPERTY_PARAMETERS = {
  gain: CALL_PARAMETERS.gain,
  pan: CALL_PARAMETERS.pan,
};

const SOUND_CHOICES = [
  'sine', 'triangle', 'square', 'sawtooth', 'supersaw',
  'white', 'pink', 'brown', 'crackle',
  'vox', 'acid', 'lush', 'glitch', 'piano',
];
const COLOR_CHOICES = [
  'white', 'red', 'orange', 'yellow', 'lime', 'green', 'cyan',
  'dodgerblue', 'blue', 'magenta', 'purple', 'pink',
];

function addNumberControl(controls, match, name, value, relativeOffset, config) {
  const from = match.index + relativeOffset;
  controls.push({ type: 'number', name, value, from, to: from + value.length, ...config });
}

export function findInlineControls(code) {
  const controls = [];
  const callNames = Object.keys(CALL_PARAMETERS).join('|');
  const calls = new RegExp(`\\.(${callNames})\\(\\s*(${NUMBER})\\s*\\)`, 'g');
  for (const match of code.matchAll(calls)) {
    const offset = match[0].indexOf(match[2], match[0].indexOf('('));
    addNumberControl(controls, match, match[1], match[2], offset, CALL_PARAMETERS[match[1]]);
  }

  const properties = new RegExp(`\\b(${Object.keys(PROPERTY_PARAMETERS).join('|')})\\s*:\\s*(${NUMBER})`, 'g');
  for (const match of code.matchAll(properties)) {
    const offset = match[0].lastIndexOf(match[2]);
    addNumberControl(controls, match, match[1], match[2], offset, PROPERTY_PARAMETERS[match[1]]);
  }

  const master = new RegExp(`\\bconst\\s+master\\s*=\\s*(${NUMBER})`, 'g');
  for (const match of code.matchAll(master)) {
    const offset = match[0].lastIndexOf(match[1]);
    addNumberControl(controls, match, 'master', match[1], offset, CALL_PARAMETERS.gain);
  }

  const choices = /\.(sound|color)\(\s*(["'])([A-Za-z0-9_-]+)\2\s*\)/g;
  for (const match of code.matchAll(choices)) {
    const quoted = `${match[2]}${match[3]}${match[2]}`;
    const from = match.index + match[0].indexOf(quoted);
    controls.push({
      type: 'choice',
      name: match[1],
      value: match[3],
      quote: match[2],
      from,
      to: from + quoted.length,
      options: match[1] === 'sound' ? SOUND_CHOICES : COLOR_CHOICES,
    });
  }

  const solo = /\bconst\s+solo\s*=\s*(["'])([A-Za-z0-9_-]+)\1/g;
  for (const match of code.matchAll(solo)) {
    const quoted = `${match[1]}${match[2]}${match[1]}`;
    const from = match.index + match[0].indexOf(quoted);
    controls.push({
      type: 'choice',
      name: 'solo',
      value: match[2],
      quote: match[1],
      from,
      to: from + quoted.length,
      options: ['all', ...parseTracks(code).map((track) => track.key)],
    });
  }

  const booleans = /\b(mute|enabled|bypass)\s*:\s*(true|false)\b/g;
  for (const match of code.matchAll(booleans)) {
    const from = match.index + match[0].lastIndexOf(match[2]);
    controls.push({ type: 'boolean', name: match[1], value: match[2], from, to: from + match[2].length });
  }

  return controls.sort((a, b) => a.from - b.from || a.to - b.to);
}

function uniqueOptions(current, options) {
  return [...new Set([current, ...options])];
}

function announceCommit(view) {
  view.dom.dispatchEvent(new CustomEvent('strood:inline-control-commit', { bubbles: true }));
}

class ChoiceWidget extends WidgetType {
  constructor(control) {
    super();
    Object.assign(this, control);
  }

  eq(other) {
    return this.from === other.from && this.to === other.to && this.value === other.value
      && this.name === other.name && this.options.join('|') === other.options.join('|');
  }

  toDOM(view) {
    const select = document.createElement('select');
    select.className = 'cm-inline-choice';
    select.setAttribute('aria-label', this.name === 'solo' ? 'Solo track' : `Choose ${this.name}`);
    select.title = `Choose ${this.name}`;
    for (const option of uniqueOptions(this.value, this.options)) {
      const element = document.createElement('option');
      element.value = option;
      element.textContent = option;
      element.selected = option === this.value;
      select.appendChild(element);
    }
    select.addEventListener('change', () => {
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: `${this.quote}${select.value}${this.quote}` },
      });
      announceCommit(view);
      view.focus();
    });
    return select;
  }

  ignoreEvent() { return true; }
}

function buildDecorations(state) {
  const controls = findInlineControls(state.doc.toString());
  const ranges = controls.map((control) => {
    if (control.type === 'choice') {
      return Decoration.widget({ widget: new ChoiceWidget(control), side: 1 }).range(control.to);
    }
    if (control.type === 'boolean') {
      const muted = control.name === 'mute' && control.value === 'true';
      return Decoration.mark({
        class: `cm-smart-boolean${muted ? ' is-muted' : ''}`,
        attributes: {
          title: control.name === 'mute'
            ? `Click to ${muted ? 'unmute' : 'mute'}`
            : `Click to toggle ${control.name}`,
          'data-smart-name': control.name,
          'data-smart-from': String(control.from),
          'data-smart-to': String(control.to),
          'data-smart-value': control.value,
        },
      }).range(control.from, control.to);
    }
    return Decoration.mark({
      class: 'cm-smart-number',
      attributes: {
        title: `Drag to adjust ${control.name}; click to edit`,
        'data-smart-name': control.name,
        'data-smart-from': String(control.from),
        'data-smart-to': String(control.to),
        'data-smart-min': String(control.min),
        'data-smart-max': String(control.max),
        'data-smart-step': String(control.step),
        'data-smart-drag': String(control.drag),
      },
    }).range(control.from, control.to);
  });
  return Decoration.set(ranges, true);
}

const smartControlField = StateField.define({
  create: buildDecorations,
  update(decorations, transaction) {
    return transaction.docChanged ? buildDecorations(transaction.state) : decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function decimalsForStep(step) {
  const text = String(step);
  return text.includes('.') ? text.length - text.indexOf('.') - 1 : 0;
}

export function formatInlineNumber(value, step, original = '') {
  const decimals = decimalsForStep(step);
  let text = Number(value.toFixed(decimals)).toString();
  if (original.startsWith('.') && value > 0 && value < 1) text = text.replace(/^0/, '');
  if (original.startsWith('-.') && value < 0 && value > -1) text = text.replace(/^-0/, '-');
  return text;
}

const numberScrubbing = EditorView.domEventHandlers({
  pointerdown(event, view) {
    if (event.button !== 0 || !(event.target instanceof Element)) return false;
    const target = event.target.closest('.cm-smart-number');
    if (!target || !view.dom.contains(target)) return false;

    const from = Number(target.dataset.smartFrom);
    let to = Number(target.dataset.smartTo);
    const min = Number(target.dataset.smartMin);
    const max = Number(target.dataset.smartMax);
    const step = Number(target.dataset.smartStep);
    const drag = Number(target.dataset.smartDrag);
    const original = view.state.doc.sliceString(from, to);
    const initial = Number(original);
    const startX = event.clientX;
    let moved = false;
    let current = original;

    const apply = (moveEvent) => {
      const distance = moveEvent.clientX - startX;
      if (Math.abs(distance) < 3 && !moved) return;
      moved = true;
      const fine = moveEvent.shiftKey ? 0.2 : 1;
      const raw = Math.max(min, Math.min(max, initial + distance * drag * fine));
      const stepped = Math.round(raw / step) * step;
      const next = formatInlineNumber(stepped, step, original);
      if (next === current) return;
      view.dispatch({ changes: { from, to, insert: next } });
      to = from + next.length;
      current = next;
    };

    const finish = (upEvent) => {
      window.removeEventListener('pointermove', apply);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      if (upEvent.type === 'pointerup') apply(upEvent);
      if (!moved) view.dispatch({ selection: { anchor: from, head: to } });
      if (moved) announceCommit(view);
      view.focus();
    };

    event.preventDefault();
    window.addEventListener('pointermove', apply);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    return true;
  },
});

const booleanToggling = EditorView.domEventHandlers({
  click(event, view) {
    if (!(event.target instanceof Element)) return false;
    const target = event.target.closest('.cm-smart-boolean');
    if (!target || !view.dom.contains(target)) return false;
    const from = Number(target.dataset.smartFrom);
    const to = Number(target.dataset.smartTo);
    const next = target.dataset.smartValue === 'true' ? 'false' : 'true';
    event.preventDefault();
    view.dispatch({
      changes: { from, to, insert: next },
      selection: { anchor: from, head: from + next.length },
    });
    announceCommit(view);
    view.focus();
    return true;
  },
});

export const inlineControlExtensions = [smartControlField, numberScrubbing, booleanToggling];
