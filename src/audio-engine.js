import { getAudioContext, getSuperdoughAudioController } from '@strudel/webaudio';

const MASTER_GAIN_KEY = 'strood_master_gain_v1';
const orbitMeters = new Map();
let engine = null;

function storedMasterGain() {
  try { return Number(localStorage.getItem(MASTER_GAIN_KEY) ?? 0.82); }
  catch { return 0.82; }
}

function configureCompressor(node, settings) {
  for (const [name, value] of Object.entries(settings)) node[name].value = value;
}

export function ensureMasterEngine() {
  const context = getAudioContext();
  const controller = getSuperdoughAudioController();
  const source = controller.output.destinationGain;
  if (engine?.source === source) return engine;

  if (engine) {
    try { engine.masterGain.disconnect(); } catch {}
    try { engine.compressor.disconnect(); } catch {}
    try { engine.limiter.disconnect(); } catch {}
    try { engine.analyser.disconnect(); } catch {}
    try { engine.meterSink.disconnect(); } catch {}
  }

  source.disconnect();
  const masterGain = context.createGain();
  masterGain.gain.value = Math.max(0, Math.min(1.2, storedMasterGain()));

  const compressor = context.createDynamicsCompressor();
  configureCompressor(compressor, {
    threshold: -14,
    knee: 10,
    ratio: 3,
    attack: 0.015,
    release: 0.18,
  });

  const limiter = context.createDynamicsCompressor();
  configureCompressor(limiter, {
    threshold: -1,
    knee: 0,
    ratio: 20,
    attack: 0.002,
    release: 0.06,
  });

  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.72;
  const timeData = new Float32Array(analyser.fftSize);
  const meterSink = context.createGain();
  meterSink.gain.value = 0;

  source.connect(masterGain);
  masterGain.connect(compressor);
  compressor.connect(limiter);
  limiter.connect(analyser);
  analyser.connect(context.destination);
  meterSink.connect(context.destination);

  engine = { context, controller, source, masterGain, compressor, limiter, analyser, timeData, meterSink };
  orbitMeters.clear();
  return engine;
}

export function getMasterGain() {
  return ensureMasterEngine().masterGain.gain.value;
}

export function setMasterGain(value) {
  const { context, masterGain } = ensureMasterEngine();
  const next = Math.max(0, Math.min(1.2, Number(value)));
  masterGain.gain.cancelScheduledValues(context.currentTime);
  masterGain.gain.setTargetAtTime(next, context.currentTime, 0.025);
  try { localStorage.setItem(MASTER_GAIN_KEY, String(next)); } catch {}
  return next;
}

function meterReading(analyser, data) {
  analyser.getFloatTimeDomainData(data);
  let sum = 0;
  let peak = 0;
  for (let index = 0; index < data.length; index++) {
    const absolute = Math.abs(data[index]);
    sum += data[index] * data[index];
    if (absolute > peak) peak = absolute;
  }
  const rms = Math.sqrt(sum / data.length);
  return {
    rms,
    peak,
    rmsDb: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
    peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
  };
}

export function readMasterMeter() {
  const current = ensureMasterEngine();
  return {
    ...meterReading(current.analyser, current.timeData),
    compressionDb: Math.min(0, current.compressor.reduction + current.limiter.reduction),
  };
}

function ensureOrbitMeter(orbitNumber) {
  const current = ensureMasterEngine();
  if (orbitMeters.has(orbitNumber)) return orbitMeters.get(orbitNumber);
  const orbit = current.controller.getOrbit(orbitNumber);
  const analyser = current.context.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.78;
  const data = new Float32Array(analyser.fftSize);
  orbit.output.connect(analyser);
  analyser.connect(current.meterSink);
  const meter = { analyser, data };
  orbitMeters.set(orbitNumber, meter);
  return meter;
}

export function setOrbitGain(orbitNumber, value) {
  const current = ensureMasterEngine();
  const orbit = current.controller.getOrbit(orbitNumber);
  const next = Math.max(0, Math.min(1.5, Number(value)));
  orbit.output.gain.cancelScheduledValues(current.context.currentTime);
  orbit.output.gain.setTargetAtTime(Math.max(0.0001, next), current.context.currentTime, 0.018);
  if (next === 0) orbit.output.gain.setValueAtTime(0, current.context.currentTime + 0.12);
  ensureOrbitMeter(orbitNumber);
  return next;
}

export function readOrbitMeter(orbitNumber) {
  const meter = ensureOrbitMeter(orbitNumber);
  return meterReading(meter.analyser, meter.data);
}
