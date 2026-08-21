export function effectiveTrackGains(tracks, states) {
  const anySolo = tracks.some((track) => states[track.key]?.solo);
  return Object.fromEntries(tracks.map((track) => {
    const state = states[track.key] || {};
    const audible = (!anySolo || state.solo) && !state.muted;
    return [track.key, audible ? Number(state.gain ?? 1) : 0];
  }));
}
