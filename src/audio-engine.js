import {
  getAudioContext,
  getSuperdoughAudioController,
  resetGlobalEffects,
} from '@strudel/webaudio';

let engine = null;

function configureCompressor(node, settings) {
  for (const [name, value] of Object.entries(settings)) node[name].value = value;
}

function disconnectEngine() {
  if (!engine) return;
  try { engine.masterGain.disconnect(); } catch {}
  try { engine.compressor.disconnect(); } catch {}
  try { engine.limiter.disconnect(); } catch {}
  try { engine.analyser.disconnect(); } catch {}
}

export function ensureMasterEngine() {
  const context = getAudioContext();
  const controller = getSuperdoughAudioController();
  const source = controller.output.destinationGain;
  if (engine?.source === source) return engine;

  disconnectEngine();

  source.disconnect();
  const masterGain = context.createGain();
  masterGain.gain.value = 1;

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

  source.connect(masterGain);
  masterGain.connect(compressor);
  compressor.connect(limiter);
  limiter.connect(analyser);
  analyser.connect(context.destination);

  engine = { context, controller, source, masterGain, compressor, limiter, analyser, timeData };
  return engine;
}

export function silenceMasterEngine() {
  if (engine) {
    const now = engine.context.currentTime;
    engine.masterGain.gain.cancelScheduledValues(now);
    engine.masterGain.gain.setValueAtTime(0, now);
  }
  disconnectEngine();
  resetGlobalEffects();
  engine = null;
  return ensureMasterEngine();
}

export function setOrbitAudibility(orbit, audible, rampSeconds = 0.01) {
  const current = ensureMasterEngine();
  const gain = current.controller.nodes[orbit]?.output?.gain;
  if (!gain) return false;
  const now = current.context.currentTime;
  const value = gain.value;
  gain.cancelScheduledValues(now);
  gain.setValueAtTime(value, now);
  gain.linearRampToValueAtTime(audible ? 1 : 0, now + rampSeconds);
  return true;
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
    compressionDb: Math.min(0, current.compressor.reduction),
    limiterDb: Math.min(0, current.limiter.reduction),
  };
}
