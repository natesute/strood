// Modular synth engine — public API
import { registerSound } from 'superdough';
import { compilePatch } from './patch-runner.mjs';
import { registerModule, getModuleFactory, listModules } from './registry.mjs';
import { loadCustomWorklets } from './worklets/loader.mjs';

// Import all built-in modules to register them
import './modules/sources.mjs';
import './modules/filters.mjs';
import './modules/modulators.mjs';
import './modules/vca.mjs';

// Register a named patch as a playable sound
export function registerPatch(name, patchDef) {
  const onTrigger = compilePatch(patchDef);
  registerSound(name, onTrigger, { type: 'synth', prebake: true });
}

// Initialize the module system (loads custom worklet processors)
export async function initModularSynth() {
  await loadCustomWorklets();
}

// Re-export for external use
export { compilePatch, registerModule, getModuleFactory, listModules };
