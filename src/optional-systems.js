let modularPromise = null;
let visualizerPromise = null;
let patchEditorPromise = null;

const PATCH_SOUNDS = /\.sound\s*\(\s*["'](?:vox|acid|lush|glitch|init)["']/i;
const CUSTOM_VISUALIZERS = /\._(?:lissajous|orbit|tonnetz|cymatics|harmonics|helix|epicycles)\b/;

export function needsModularSynth(code) {
  return PATCH_SOUNDS.test(code);
}

export function needsCustomVisualizers(code) {
  return CUSTOM_VISUALIZERS.test(code);
}

export function ensureModularSynthSystem() {
  if (!modularPromise) {
    modularPromise = Promise.all([
      import('../synth-modules/index.mjs'),
      import('../synth-modules/patches/init.json'),
      import('../synth-modules/patches/acid-bass.json'),
      import('../synth-modules/patches/lush-pad.json'),
      import('../synth-modules/patches/glitch-pluck.json'),
      import('../synth-modules/patches/vox-pad.json'),
    ]).then(async ([engine, init, acid, lush, glitch, vox]) => {
      await engine.initModularSynth();
      engine.registerPatch('init', init.default);
      engine.registerPatch('acid', acid.default);
      engine.registerPatch('lush', lush.default);
      engine.registerPatch('glitch', glitch.default);
      engine.registerPatch('vox', vox.default);
      return engine;
    });
  }
  return modularPromise;
}

export function ensureCustomVisualizers() {
  visualizerPromise ||= import('../visualizers.js');
  return visualizerPromise;
}

export async function prepareOptionalSystems(code) {
  const tasks = [];
  if (needsModularSynth(code)) tasks.push(ensureModularSynthSystem());
  if (needsCustomVisualizers(code)) tasks.push(ensureCustomVisualizers());
  await Promise.all(tasks);
}

export async function openPatchEditor() {
  await ensureModularSynthSystem();
  patchEditorPromise ||= import('../patch-editor.js');
  const editor = await patchEditorPromise;
  return editor.togglePatchEditor();
}

