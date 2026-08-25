import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { parseTracks } from './tracks.js';

export const flashAppliedLines = StateEffect.define();
export const clearAppliedLines = StateEffect.define();
export const setPatchSoundLink = StateEffect.define();

function trackLineDecorations(state) {
  const decorations = [];
  const tracks = parseTracks(state.doc.toString());

  for (const track of tracks) {
    const firstLine = Math.max(1, Math.min(track.line, state.doc.lines));
    const lastPosition = Math.max(track.start, Math.min(state.doc.length, track.end - 1));
    const lastLine = Math.max(firstLine, state.doc.lineAt(lastPosition).number);
    for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
      const classes = ['cm-track-line'];
      if (lineNumber === firstLine) classes.push('cm-track-start');
      if (lineNumber === lastLine) classes.push('cm-track-end');
      decorations.push(Decoration.line({
        class: classes.join(' '),
        attributes: {
          'data-track': track.key,
          'data-track-color': track.color,
        },
      }).range(state.doc.line(lineNumber).from));
    }
  }

  return Decoration.set(decorations, true);
}

const trackScoreField = StateField.define({
  create: trackLineDecorations,
  update(decorations, transaction) {
    return transaction.docChanged ? trackLineDecorations(transaction.state) : decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function lineDecorations(state, positions, className) {
  const seen = new Set();
  const ranges = [];
  for (const position of positions) {
    const line = state.doc.lineAt(Math.max(0, Math.min(position, state.doc.length)));
    if (seen.has(line.from)) continue;
    seen.add(line.from);
    ranges.push(Decoration.line({ class: className }).range(line.from));
  }
  return Decoration.set(ranges, true);
}

const appliedLineField = StateField.define({
  create() { return Decoration.none; },
  update(decorations, transaction) {
    decorations = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(clearAppliedLines)) return Decoration.none;
      if (effect.is(flashAppliedLines)) {
        return lineDecorations(transaction.state, effect.value, 'cm-applied-line');
      }
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function patchSoundRanges(code, sound) {
  if (!sound) return [];
  const escaped = escapeRegExp(sound);
  const pattern = new RegExp(`(["'])${escaped}\\1`, 'g');
  return [...code.matchAll(pattern)].map((match) => ({
    from: match.index,
    to: match.index + match[0].length,
  }));
}

function patchLinkDecorations(state, sound) {
  const ranges = patchSoundRanges(state.doc.toString(), sound).map(({ from, to }) =>
    Decoration.mark({
      class: 'cm-patch-linked',
      attributes: { 'data-patch-link': sound },
    }).range(from, to));
  return Decoration.set(ranges, true);
}

const patchLinkField = StateField.define({
  create() { return { sound: null, decorations: Decoration.none }; },
  update(value, transaction) {
    let sound = value.sound;
    let changed = transaction.docChanged;
    for (const effect of transaction.effects) {
      if (!effect.is(setPatchSoundLink)) continue;
      sound = effect.value || null;
      changed = true;
    }
    if (!changed) return value;
    return { sound, decorations: patchLinkDecorations(transaction.state, sound) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

export const scoreVisualExtensions = [trackScoreField, appliedLineField, patchLinkField];
