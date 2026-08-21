// Module factory registry
// Each module type maps to a factory function + metadata

const moduleFactories = new Map();

export function registerModule(type, factory, meta = {}) {
  moduleFactories.set(type, { factory, meta });
}

export function getModuleFactory(type) {
  const entry = moduleFactories.get(type);
  if (!entry) {
    throw new Error(`[synth-modules] Unknown module type: "${type}"`);
  }
  return entry;
}

export function listModules() {
  return [...moduleFactories.entries()].map(([type, { meta }]) => ({ type, ...meta }));
}
