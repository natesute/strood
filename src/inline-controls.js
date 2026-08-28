import { Prec, StateField } from '@codemirror/state';
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
  cycles: { min: 1, max: 64, step: 1, drag: 0.08 },
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

const METHOD_HELP = {
  sound: 'Choose the instrument or sample source.',
  gain: 'Set this pattern’s level.',
  velocity: 'Set how strongly each note is played.',
  pan: 'Place the sound between the left and right channels.',
  lpf: 'Remove frequencies above this cutoff.',
  hpf: 'Remove frequencies below this cutoff.',
  lpq: 'Set the low-pass filter resonance.',
  room: 'Add room reverb.',
  size: 'Set the size of the virtual room.',
  delay: 'Add a repeating echo.',
  release: 'Set how long the sound fades after each trigger.',
  attack: 'Set how quickly the sound reaches full level.',
  clip: 'Apply soft clipping for density and bite.',
  shape: 'Add waveshaping distortion.',
  postgain: 'Set the level after distortion.',
  orbit: 'Route the track through its own audio channel.',
  color: 'Set the colour used by linked visualisers.',
  bank: 'Choose the sample bank.',
  struct: 'Apply a rhythm of hits and rests.',
  slow: 'Stretch the pattern in time.',
  fast: 'Compress the pattern in time.',
  vib: 'Add vibrato to the pitch.',
  superimpose: 'Layer a transformed copy over the original pattern.',
  add: 'Shift notes or values by this amount.',
  range: 'Map a control pattern between two values.',
  _scope: 'Draw this track’s waveform on the following line.',
  _spiral: 'Draw this track’s events around a spiral.',
  _lissajous: 'Draw the interval relationship as a Lissajous curve.',
  _tonnetz: 'Map sounding notes onto a lattice of thirds and fifths.',
  _cymatics: 'Ripple a plate pattern from the sounding notes.',
  _harmonics: 'Show the strength of each harmonic as it plays.',
  _helix: 'Wind pitch around a rising helix, one turn per octave.',
  _epicycles: 'Redraw the waveform with stacked rotating circles.',
  _orbit: 'Draw this rhythm around a circular beat map.',
  _phase: 'Trace the real audio signal against a delayed copy of itself.',
  _interference: 'Sum ripples from each sounding note into one wave field.',
  _overtones: 'Show each note’s overtone series and where they align or beat.',
  _pendulum: 'Swing pendulums that realign with the bar, pumped by onsets.',
  _resonance: 'Let orbiting notes draw the geometry of their frequency ratio.',
};

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

  const namedSounds = /\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*(?:Synth|Sound))\s*=\s*(["'])([A-Za-z0-9_-]+)\2/g;
  for (const match of code.matchAll(namedSounds)) {
    const quoted = `${match[2]}${match[3]}${match[2]}`;
    const from = match.index + match[0].lastIndexOf(quoted);
    controls.push({
      type: 'choice',
      name: match[1],
      value: match[3],
      quote: match[2],
      from,
      to: from + quoted.length,
      options: SOUND_CHOICES,
    });
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

export function findMethodHelp(code) {
  const methods = [];
  const calls = /\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  for (const match of code.matchAll(calls)) {
    const description = METHOD_HELP[match[1]];
    if (!description) continue;
    const from = match.index + 1;
    methods.push({ name: match[1], description, from, to: from + match[1].length });
  }
  return methods;
}

function compactNumber(value) {
  return Number(Number(value).toFixed(2)).toString();
}

function formatPan(number) {
  if (Math.abs(number - 0.5) < 0.005) return 'centre';
  const direction = number < 0.5 ? 'left' : 'right';
  return `${Math.round(Math.abs(number - 0.5) * 200)}% ${direction}`;
}

const hertz = (number) => `${Math.round(number)} Hz`;
const percentOf = (label) => (number) => `${Math.round(number * 100)}% ${label}`;
const level = (number) => `${compactNumber(number)}× level`;
const seconds = (number) => (number < 1
  ? `${Math.round(number * 1000)} ms`
  : `${compactNumber(number)} s`);

const CONTEXTUAL_FORMATS = {
  lpf: hertz,
  hpf: hertz,
  pan: formatPan,
  master: percentOf('master'),
  room: percentOf('room'),
  clip: percentOf('clip'),
  shape: percentOf('shape'),
  release: seconds,
  attack: seconds,
  gain: level,
  velocity: level,
  postgain: level,
  size: (number) => `room size ${compactNumber(number)}`,
  lpq: (number) => `Q ${compactNumber(number)}`,
  orbit: (number) => `orbit ${Math.round(number)}`,
  cycles: (number) => `${Math.round(number)} cycle${Math.round(number) === 1 ? '' : 's'}`,
};

export function formatContextualValue(name, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  const format = Object.hasOwn(CONTEXTUAL_FORMATS, name) ? CONTEXTUAL_FORMATS[name] : null;
  return format ? format(number) : compactNumber(number);
}

function uniqueOptions(current, options) {
  return [...new Set([current, ...options])];
}

function announceCommit(view) {
  view.dom.dispatchEvent(new CustomEvent('strood:inline-control-commit', { bubbles: true }));
}

function readableName(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').toLowerCase();
}

let activeChoiceStrip = null;

function closeChoiceStrip({ restoreFocus = false } = {}) {
  if (!activeChoiceStrip) return;
  const { strip, button, onDocumentPointer, onDocumentKey } = activeChoiceStrip;
  document.removeEventListener('pointerdown', onDocumentPointer, true);
  document.removeEventListener('keydown', onDocumentKey, true);
  strip.remove();
  activeChoiceStrip = null;
  if (restoreFocus && button.isConnected) button.focus();
}

function soundChoice(name) {
  return name === 'sound' || /(?:Synth|Sound)$/.test(name);
}

class ChoiceWidget extends WidgetType {
  constructor(control) {
    super();
    Object.assign(this, control);
  }

  eq(other) {
    return this.from === other.from && this.to === other.to && this.value === other.value
      && this.name === other.name && this.quote === other.quote
      && this.options.join('|') === other.options.join('|');
  }

  toDOM(view) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-inline-choice';
    button.dataset.smartName = this.name;
    button.dataset.smartValue = this.value;
    button.style.setProperty('--choice-width', `${Math.max(6, this.value.length + 4)}ch`);
    const label = this.name === 'solo' ? 'Solo track' : `Choose ${readableName(this.name)}`;
    button.setAttribute('aria-label', `${label}, current ${this.value}`);
    button.setAttribute('aria-haspopup', 'listbox');
    button.title = `${label}; use arrows or scroll to cycle`;
    button.textContent = `${this.quote}${this.value}${this.quote}`;
    const options = uniqueOptions(this.value, this.options);

    const commit = (value) => {
      closeChoiceStrip();
      view.dispatch({
        changes: { from: this.from, to: this.to, insert: `${this.quote}${value}${this.quote}` },
      });
      announceCommit(view);
      view.focus();
    };

    const step = (direction) => {
      const index = options.indexOf(this.value);
      commit(options[(index + direction + options.length) % options.length]);
    };

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeChoiceStrip();

      const strip = document.createElement('div');
      strip.className = 'cm-choice-strip';
      strip.setAttribute('role', 'listbox');
      strip.setAttribute('aria-label', label);
      for (const option of options) {
        const optionButton = document.createElement('button');
        optionButton.type = 'button';
        optionButton.className = 'cm-choice-option';
        optionButton.setAttribute('role', 'option');
        optionButton.setAttribute('aria-selected', String(option === this.value));
        optionButton.textContent = option;
        optionButton.addEventListener('click', () => commit(option));
        strip.appendChild(optionButton);
      }
      document.body.appendChild(strip);
      const rect = button.getBoundingClientRect();
      const stripRect = strip.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - stripRect.width - 8));
      const top = rect.top > stripRect.height + 12
        ? rect.top - stripRect.height - 6
        : rect.bottom + 6;
      strip.style.left = `${left}px`;
      strip.style.top = `${top}px`;

      const onDocumentPointer = (pointerEvent) => {
        if (!strip.contains(pointerEvent.target) && pointerEvent.target !== button) closeChoiceStrip();
      };
      const onDocumentKey = (keyEvent) => {
        if (keyEvent.key === 'Escape') {
          keyEvent.preventDefault();
          closeChoiceStrip({ restoreFocus: true });
        }
      };
      activeChoiceStrip = { strip, button, onDocumentPointer, onDocumentKey };
      document.addEventListener('pointerdown', onDocumentPointer, true);
      document.addEventListener('keydown', onDocumentKey, true);
      strip.querySelector('[aria-selected="true"]')?.focus();
    });

    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      event.stopPropagation();
      step(event.key === 'ArrowRight' ? 1 : -1);
    });
    button.addEventListener('wheel', (event) => {
      event.preventDefault();
      event.stopPropagation();
      step(event.deltaY > 0 ? 1 : -1);
    }, { passive: false });

    if (soundChoice(this.name)) {
      button.addEventListener('pointerenter', () => {
        document.dispatchEvent(new CustomEvent('strood:source-sound-focus', { detail: { sound: this.value } }));
      });
      button.addEventListener('pointerleave', () => {
        document.dispatchEvent(new CustomEvent('strood:source-sound-focus', { detail: { sound: null } }));
      });
    }
    return button;
  }

  ignoreEvent() { return true; }
}

function buildDecorations(state) {
  const controls = findInlineControls(state.doc.toString());
  const ranges = controls.map((control) => {
    if (control.type === 'choice') {
      return Decoration.replace({ widget: new ChoiceWidget(control) }).range(control.from, control.to);
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
        title: `${formatContextualValue(control.name, control.value)}; drag to adjust or click to edit`,
        role: 'spinbutton',
        tabindex: '0',
        'aria-label': `Adjust ${readableName(control.name)}`,
        'aria-valuemin': String(control.min),
        'aria-valuemax': String(control.max),
        'aria-valuenow': String(control.value),
        'aria-valuetext': formatContextualValue(control.name, control.value),
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
  for (const method of findMethodHelp(state.doc.toString())) {
    ranges.push(Decoration.mark({
      class: 'cm-method-help',
      attributes: {
        title: method.description,
        'data-method-help': method.name,
      },
    }).range(method.from, method.to));
  }
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
    const hud = document.createElement('div');
    hud.className = 'cm-number-hud';
    hud.setAttribute('aria-hidden', 'true');
    hud.innerHTML = '<span class="cm-number-hud-name"></span><span class="cm-number-hud-value"></span><i><b></b></i><small>shift · fine</small>';
    const controlName = target.dataset.smartName || 'value';
    hud.querySelector('.cm-number-hud-name').textContent = readableName(controlName);
    document.body.appendChild(hud);
    const targetRect = target.getBoundingClientRect();
    hud.style.left = `${Math.max(8, Math.min(targetRect.left, window.innerWidth - 210))}px`;
    hud.style.top = `${Math.max(8, targetRect.top - 48)}px`;

    const updateHud = (value, fine = false) => {
      const percent = max === min ? 0 : ((value - min) / (max - min)) * 100;
      hud.querySelector('.cm-number-hud-value').textContent = formatContextualValue(controlName, value);
      hud.querySelector('b').style.transform = `scaleX(${Math.max(0, Math.min(1, percent / 100))})`;
      hud.classList.toggle('is-fine', fine);
    };
    updateHud(initial);

    const apply = (moveEvent) => {
      const distance = moveEvent.clientX - startX;
      if (Math.abs(distance) < 3 && !moved) return;
      moved = true;
      const fine = moveEvent.shiftKey ? 0.2 : 1;
      const raw = Math.max(min, Math.min(max, initial + distance * drag * fine));
      const stepped = Math.round(raw / step) * step;
      const next = formatInlineNumber(stepped, step, original);
      updateHud(stepped, moveEvent.shiftKey);
      if (next === current) return;
      view.dispatch({ changes: { from, to, insert: next } });
      to = from + next.length;
      current = next;
    };

    const finish = (upEvent) => {
      window.removeEventListener('pointermove', apply);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      hud.classList.add('is-done');
      window.setTimeout(() => hud.remove(), 140);
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

function steppingDirection(key) {
  if (['ArrowRight', 'ArrowUp'].includes(key)) return 1;
  if (['ArrowLeft', 'ArrowDown'].includes(key)) return -1;
  return 0;
}

/** Range and step for a stepped number, from the selected control or the widget's dataset. */
function steppingBounds(control, target) {
  return {
    from: control?.from ?? Number(target.dataset.smartFrom),
    to: control?.to ?? Number(target.dataset.smartTo),
    min: control?.min ?? Number(target.dataset.smartMin),
    max: control?.max ?? Number(target.dataset.smartMax),
    baseStep: control?.step ?? Number(target.dataset.smartStep),
  };
}

const numberKeyboardStepping = EditorView.domEventHandlers({
  keydown(event, view) {
    if (!(event.target instanceof Element)) return false;
    const target = event.target.closest('.cm-smart-number');
    const selection = view.state.selection.main;
    const selectedControl = !target && findInlineControls(view.state.doc.toString()).find((control) =>
      control.type === 'number' && selection.from >= control.from && selection.to <= control.to);
    if ((!target || !view.dom.contains(target)) && !selectedControl) return false;
    const direction = steppingDirection(event.key);
    if (!direction) return false;

    const { from, to, min, max, baseStep } = steppingBounds(selectedControl, target);
    const original = view.state.doc.sliceString(from, to);
    const multiplier = event.altKey ? 10 : (event.shiftKey ? 0.2 : 1);
    const step = baseStep * multiplier;
    const raw = Math.max(min, Math.min(max, Number(original) + direction * step));
    const next = formatInlineNumber(raw, step, original);
    event.preventDefault();
    event.stopPropagation();
    view.dispatch({
      changes: { from, to, insert: next },
      selection: { anchor: from, head: from + next.length },
    });
    announceCommit(view);
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

export const inlineControlExtensions = [
  smartControlField,
  numberScrubbing,
  Prec.highest(numberKeyboardStepping),
  booleanToggling,
];
