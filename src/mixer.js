import { readOrbitMeter, setOrbitGain } from './audio-engine.js';
import { effectiveTrackGains } from './mixer-state.js';
export { effectiveTrackGains } from './mixer-state.js';

const MIXER_KEY = 'strood_mixer_v1';

function readStore() {
  try {
    const value = JSON.parse(localStorage.getItem(MIXER_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

export class RuntimeMixer {
  constructor(songName = 'Untitled') {
    this.songName = songName;
    this.tracks = [];
    this.states = {};
    this.persistTimer = 0;
    this.load();
  }

  load() {
    const store = readStore();
    this.states = store[this.songName] || {};
  }

  persist() {
    window.clearTimeout(this.persistTimer);
    const songName = this.songName;
    const states = Object.fromEntries(Object.entries(this.states).map(([key, state]) => [key, { ...state }]));
    this.persistTimer = window.setTimeout(() => this.persistNow(songName, states), 120);
  }

  persistNow(songName = this.songName, states = this.states) {
    try {
      const store = readStore();
      store[songName] = states;
      localStorage.setItem(MIXER_KEY, JSON.stringify(store));
    } catch {}
  }

  setSong(name) {
    this.songName = name || 'Untitled';
    this.load();
    this.sync(this.tracks);
  }

  sync(tracks) {
    this.tracks = tracks;
    for (const track of tracks) {
      this.states[track.key] ||= { gain: 1, muted: false, solo: false };
    }
    this.apply();
  }

  stateFor(track) {
    return this.states[track.key] || { gain: 1, muted: false, solo: false };
  }

  update(track, patch) {
    this.states[track.key] = { ...this.stateFor(track), ...patch };
    this.persist();
    const changesAudibility = 'muted' in patch || 'solo' in patch;
    const hasSolo = this.tracks.some((item) => this.stateFor(item).solo);
    if (changesAudibility || hasSolo) this.apply();
    else setOrbitGain(track.orbit, this.stateFor(track).gain);
    return this.states[track.key];
  }

  apply() {
    const gains = effectiveTrackGains(this.tracks, this.states);
    for (const track of this.tracks) setOrbitGain(track.orbit, gains[track.key]);
  }

  meterFor(track) {
    return readOrbitMeter(track.orbit);
  }
}
