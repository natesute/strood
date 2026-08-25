let modularPromise = null;
let visualizerPromise = null;
let patchEditorPromise = null;
const registeredPatches = new Set();

const PATCH_SOUNDS = /\.sound\s*\(\s*["'](vox|acid|lush|glitch|init)["']/gi;
const PATCH_SOUND_VARIABLES = /\.sound\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/g;
const PATCH_NAME = /^(?:vox|acid|lush|glitch|init)$/i;
const CUSTOM_VISUALIZERS = /\._(?:spiral|scope|lissajous|orbit|tonnetz|cymatics|harmonics|helix|epicycles|phase|interference|overtones|pendulum|resonance)\b/;
const PATCH_LOADERS = {
  init: () => import('../synth-modules/patches/init.json'),
  acid: () => import('../synth-modules/patches/acid-bass.json'),
  lush: () => import('../synth-modules/patches/lush-pad.json'),
  glitch: () => import('../synth-modules/patches/glitch-pluck.json'),
  vox: () => import('../synth-modules/patches/vox-pad.json'),
};

export function referencedPatchSounds(code) {
  const names = [...code.matchAll(PATCH_SOUNDS)].map((match) => match[1].toLowerCase());
  for (const match of code.matchAll(PATCH_SOUND_VARIABLES)) {
    const assignment = new RegExp(`\\bconst\\s+${match[1]}\\s*=\\s*(["'])([^"']+)\\1`).exec(code);
    if (assignment && PATCH_NAME.test(assignment[2])) names.push(assignment[2].toLowerCase());
  }
  return [...new Set(names)];
}

export function needsModularSynth(code) {
  return referencedPatchSounds(code).length > 0;
}

export function needsCustomVisualizers(code) {
  return CUSTOM_VISUALIZERS.test(code);
}

export async function ensureModularSynthSystem(code = '') {
  if (!modularPromise) {
    modularPromise = import('../synth-modules/index.mjs').then(async (engine) => {
      await engine.initModularSynth();
      return engine;
    });
  }
  const engine = await modularPromise;
  await Promise.all(referencedPatchSounds(code).map(async (name) => {
    if (registeredPatches.has(name)) return;
    const patch = await PATCH_LOADERS[name]();
    engine.registerPatch(name, patch.default);
    registeredPatches.add(name);
  }));
  return engine;
}

export function ensureCustomVisualizers() {
  visualizerPromise ||= import('../visualizers.js');
  return visualizerPromise;
}

export async function prepareOptionalSystems(code) {
  const tasks = [];
  if (needsModularSynth(code)) tasks.push(ensureModularSynthSystem(code));
  if (needsCustomVisualizers(code)) tasks.push(ensureCustomVisualizers());
  await Promise.all(tasks);
}

export async function openPatchEditor() {
  await ensureModularSynthSystem();
  patchEditorPromise ||= import('../patch-editor.js');
  const editor = await patchEditorPromise;
  return editor.togglePatchEditor();
}
