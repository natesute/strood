// Worklet loader — registers custom AudioWorklet processors via blob URLs
// This avoids needing vite-plugin-bundle-audioworklet in strood's build
import { getAudioContext } from 'superdough';

let loaded = false;
let loading = null;

// All processor code inlined as a single string
const processorCode = () => `
const PI = Math.PI;
const TWO_PI = 2 * PI;
const INVSR = 1 / sampleRate;
const clamp = (n, min, max) => Math.min(Math.max(n, min), max);
const lerp = (a, b, t) => a + t * (b - a);

// ── SVF (State Variable Filter) ──────────────────────────
// Continuous LP/BP/HP/Notch morphing via a single 'mode' param (0-3)
// 0=LP, 1=BP, 2=HP, 3=Notch — fractional values morph smoothly between modes
class SVFProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'frequency', defaultValue: 1000, minValue: 20, maxValue: 20000 },
      { name: 'resonance', defaultValue: 0.5, minValue: 0, maxValue: 1 },
      { name: 'mode', defaultValue: 0, minValue: 0, maxValue: 3 },
    ];
  }

  constructor() {
    super();
    this.ic1eq = 0;
    this.ic2eq = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;

    const freq = parameters.frequency.length > 1 ? parameters.frequency : null;
    const res = parameters.resonance.length > 1 ? parameters.resonance : null;
    const mode = parameters.mode.length > 1 ? parameters.mode : null;

    const fConst = freq ? 0 : parameters.frequency[0];
    const rConst = res ? 0 : parameters.resonance[0];
    const mConst = mode ? 0 : parameters.mode[0];

    for (let i = 0; i < output.length; i++) {
      const f = freq ? freq[i] : fConst;
      const r = res ? res[i] : rConst;
      const m = mode ? mode[i] : mConst;

      // SVF coefficients (Andy Simper / Cytomic)
      const g = Math.tan(PI * f * INVSR);
      const k = 2 - 2 * r; // damping: r=0 → k=2 (no res), r=1 → k=0 (self-osc)
      const a1 = 1 / (1 + g * (g + k));
      const a2 = g * a1;
      const a3 = g * a2;

      const v3 = input[i] - this.ic2eq;
      const v1 = a1 * this.ic1eq + a2 * v3;
      const v2 = this.ic2eq + a2 * this.ic1eq + a3 * v3;

      this.ic1eq = 2 * v1 - this.ic1eq;
      this.ic2eq = 2 * v2 - this.ic2eq;

      // Filter outputs
      const lp = v2;
      const bp = v1;
      const hp = input[i] - k * v1 - v2;
      const notch = lp + hp;

      // Smooth morphing between modes
      const mFloor = Math.floor(m);
      const mFrac = m - mFloor;
      const outputs = [lp, bp, hp, notch];
      const idx1 = clamp(mFloor, 0, 3);
      const idx2 = clamp(idx1 + 1, 0, 3);
      output[i] = lerp(outputs[idx1], outputs[idx2], mFrac);
    }

    return true;
  }
}
registerProcessor('svf-processor', SVFProcessor);

// ── Comb Filter ──────────────────────────────────────────
// Feedback comb filter — metallic, resonant, karplus-strong textures
class CombProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'frequency', defaultValue: 200, minValue: 20, maxValue: 10000 },
      { name: 'feedback', defaultValue: 0.7, minValue: -0.99, maxValue: 0.99 },
      { name: 'damping', defaultValue: 0.3, minValue: 0, maxValue: 1 },
    ];
  }

  constructor() {
    super();
    this.buffer = new Float32Array(sampleRate); // max 1 second delay
    this.writePos = 0;
    this.prevOut = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;

    const freq = parameters.frequency.length > 1 ? parameters.frequency : null;
    const fb = parameters.feedback.length > 1 ? parameters.feedback : null;
    const damp = parameters.damping.length > 1 ? parameters.damping : null;

    const fConst = freq ? 0 : parameters.frequency[0];
    const fbConst = fb ? 0 : parameters.feedback[0];
    const dampConst = damp ? 0 : parameters.damping[0];
    const bufLen = this.buffer.length;

    for (let i = 0; i < output.length; i++) {
      const f = freq ? freq[i] : fConst;
      const feedback = fb ? fb[i] : fbConst;
      const damping = damp ? damp[i] : dampConst;

      // Delay time from frequency
      const delaySamples = Math.max(1, Math.round(sampleRate / f));
      const readPos = (this.writePos - delaySamples + bufLen) % bufLen;

      // Read from delay line with one-pole damping
      const delayed = this.buffer[readPos];
      const dampedOut = delayed * (1 - damping) + this.prevOut * damping;
      this.prevOut = dampedOut;

      // Write input + feedback to delay line
      this.buffer[this.writePos] = input[i] + dampedOut * feedback;
      this.writePos = (this.writePos + 1) % bufLen;

      output[i] = dampedOut;
    }

    return true;
  }
}
registerProcessor('comb-processor', CombProcessor);

// ── Formant Filter ───────────────────────────────────────
// Smooth vowel morphing via parallel bandpass filters
// morph: 0=a, 0.25=e, 0.5=i, 0.75=o, 1.0=u (with smooth interpolation)
class FormantProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'morph', defaultValue: 0, minValue: 0, maxValue: 1 },
      { name: 'gain', defaultValue: 1, minValue: 0, maxValue: 4 },
    ];
  }

  constructor() {
    super();
    // Formant frequencies and bandwidths for 3 formants across 5 vowels (a, e, i, o, u)
    // Based on classical vocal formant data
    this.formants = [
      // [F1, F2, F3] frequencies
      { f: [800, 1150, 2900], bw: [80, 90, 120], amp: [1.0, 0.5, 0.25] },    // a
      { f: [400, 1600, 2700], bw: [60, 80, 100], amp: [1.0, 0.4, 0.2] },     // e
      { f: [350, 2300, 3000], bw: [50, 100, 120], amp: [1.0, 0.3, 0.15] },   // i
      { f: [450, 800, 2830],  bw: [70, 80, 100], amp: [1.0, 0.4, 0.2] },     // o
      { f: [325, 700, 2530],  bw: [50, 60, 100], amp: [1.0, 0.35, 0.15] },   // u
    ];
    // Biquad state for 3 parallel bandpass filters (2nd order each)
    this.state = Array.from({ length: 3 }, () => ({
      x1: 0, x2: 0, y1: 0, y2: 0,
    }));
  }

  // Compute biquad bandpass coefficients
  bpCoeffs(freq, bw) {
    const w0 = TWO_PI * freq * INVSR;
    const alpha = Math.sin(w0) * Math.sinh(Math.log(2) / 2 * bw / freq * w0 / Math.sin(w0));
    const a0 = 1 + alpha;
    return {
      b0: alpha / a0,
      b1: 0,
      b2: -alpha / a0,
      a1: -2 * Math.cos(w0) / a0,
      a2: (1 - alpha) / a0,
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;

    const morphParam = parameters.morph.length > 1 ? parameters.morph : null;
    const gainParam = parameters.gain.length > 1 ? parameters.gain : null;
    const mConst = morphParam ? 0 : parameters.morph[0];
    const gConst = gainParam ? 0 : parameters.gain[0];

    // Update coefficients at block rate (not per-sample — too expensive)
    const morph = (morphParam ? morphParam[0] : mConst) * 4; // scale to 0-4 range
    const vowelIdx = clamp(Math.floor(morph), 0, 3);
    const vowelFrac = morph - vowelIdx;
    const v1 = this.formants[vowelIdx];
    const v2 = this.formants[vowelIdx + 1];

    const coeffs = [];
    const amps = [];
    for (let f = 0; f < 3; f++) {
      const freq = lerp(v1.f[f], v2.f[f], vowelFrac);
      const bw = lerp(v1.bw[f], v2.bw[f], vowelFrac);
      coeffs.push(this.bpCoeffs(freq, bw));
      amps.push(lerp(v1.amp[f], v2.amp[f], vowelFrac));
    }

    for (let i = 0; i < output.length; i++) {
      const g = gainParam ? gainParam[i] : gConst;
      const x = input[i];
      let sum = 0;

      for (let f = 0; f < 3; f++) {
        const c = coeffs[f];
        const s = this.state[f];
        const y = c.b0 * x + c.b1 * s.x1 + c.b2 * s.x2 - c.a1 * s.y1 - c.a2 * s.y2;
        s.x2 = s.x1;
        s.x1 = x;
        s.y2 = s.y1;
        s.y1 = y;
        sum += y * amps[f];
      }

      output[i] = sum * g;
    }

    return true;
  }
}
registerProcessor('formant-processor', FormantProcessor);

// ── Random Modulator ─────────────────────────────────────
// Sample-and-hold or smoothed random — great for generative modulation
class RandomProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rate', defaultValue: 4, minValue: 0.01, maxValue: 100 },
      { name: 'smooth', defaultValue: 0, minValue: 0, maxValue: 1 },
      { name: 'min', defaultValue: 0 },
      { name: 'max', defaultValue: 1 },
    ];
  }

  constructor() {
    super();
    this.phase = 0;
    this.current = Math.random();
    this.target = Math.random();
    this.smoothed = this.current;
  }

  process(_inputs, outputs, parameters) {
    const output = outputs[0]?.[0];
    if (!output) return true;

    const rate = parameters.rate[0];
    const smooth = parameters.smooth[0];
    const min = parameters.min[0];
    const max = parameters.max[0];
    const range = max - min;

    const dt = rate * INVSR;

    for (let i = 0; i < output.length; i++) {
      this.phase += dt;
      if (this.phase >= 1) {
        this.phase -= 1;
        this.current = this.target;
        this.target = Math.random();
      }

      // Interpolation for smoothing
      const raw = smooth > 0
        ? lerp(this.current, this.target, this.phase)
        : this.current;

      // Additional smoothing via one-pole filter
      if (smooth > 0) {
        const coeff = 1 - Math.exp(-INVSR / (smooth * 0.1));
        this.smoothed += (raw - this.smoothed) * coeff;
        output[i] = min + this.smoothed * range;
      } else {
        output[i] = min + raw * range;
      }
    }

    return true;
  }
}
registerProcessor('random-processor', RandomProcessor);

// ── Envelope Follower ────────────────────────────────────
// Tracks the amplitude of an input signal — use for sidechain, ducking, etc.
class FollowerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'attack', defaultValue: 0.01, minValue: 0.001, maxValue: 1 },
      { name: 'release', defaultValue: 0.1, minValue: 0.001, maxValue: 2 },
      { name: 'gain', defaultValue: 1, minValue: 0, maxValue: 10 },
    ];
  }

  constructor() {
    super();
    this.envelope = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;

    const attack = parameters.attack[0];
    const release = parameters.release[0];
    const gain = parameters.gain[0];

    const attackCoeff = 1 - Math.exp(-INVSR / attack);
    const releaseCoeff = 1 - Math.exp(-INVSR / release);

    for (let i = 0; i < output.length; i++) {
      const inAbs = input ? Math.abs(input[i]) : 0;
      const coeff = inAbs > this.envelope ? attackCoeff : releaseCoeff;
      this.envelope += (inAbs - this.envelope) * coeff;
      output[i] = this.envelope * gain;
    }

    return true;
  }
}
registerProcessor('follower-processor', FollowerProcessor);
`;

export async function loadCustomWorklets() {
  if (loaded || loading) return loading;

  const ac = getAudioContext();
  const blob = new Blob([processorCode()], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);

  loading = ac.audioWorklet.addModule(url).then(() => {
    loaded = true;
    URL.revokeObjectURL(url);
  });

  return loading;
}
