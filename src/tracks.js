const TRACK_COLOURS = ['#56d4dd', '#f07178', '#e6b450', '#7ee787', '#c792ea', '#ff9e64', '#82aaff'];
const MASTER_GAIN_MARKER = '// strood-track-gain';
const TRACK_START = /^\s*(?:([A-Za-z_][A-Za-z0-9_]*)\$|\$):/;
const TRACK_DIRECTIVE = /^\/\/\s*@track\s+([A-Za-z0-9_-]+)(?:\s*\|\s*(.+))?$/i;

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'track';
}

export function parseTracks(code) {
  const lines = code.split('\n');
  const offsets = [];
  let offset = 0;
  lines.forEach((line) => { offsets.push(offset); offset += line.length + 1; });

  const starts = [];
  lines.forEach((line, index) => {
    if (TRACK_START.test(line)) starts.push(index);
  });

  return starts.map((lineIndex, index) => {
    const nextTrackLine = starts[index + 1] ?? lines.length;
    let endLine = nextTrackLine;
    if (nextTrackLine < lines.length) {
      while (endLine > lineIndex + 1 && !lines[endLine - 1].trim()) endLine--;
      const possibleHeader = lines[endLine - 1]?.trim() || '';
      if (/^\/\/\s*[A-Za-z][A-Za-z0-9 _-]*$/.test(possibleHeader) || TRACK_DIRECTIVE.test(possibleHeader)) endLine--;
      while (endLine > lineIndex + 1 && !lines[endLine - 1].trim()) endLine--;
    }
    let label = '';
    let explicitKey = '';
    for (let cursor = lineIndex - 1; cursor >= 0; cursor--) {
      const text = lines[cursor].trim();
      if (!text) continue;
      const directive = text.match(TRACK_DIRECTIVE);
      if (directive) {
        explicitKey = directive[1];
        label = directive[2]?.trim() || directive[1].replace(/[-_]/g, ' ');
        break;
      }
      const match = text.match(/^\/\/\s*([A-Za-z][A-Za-z0-9 _-]*)$/);
      if (match) label = match[1].trim();
      break;
    }
    const block = lines.slice(lineIndex, endLine).join('\n').replace(/\n+$/, '');
    const gainMatch = block.match(/\)\.gain\((\d*\.?\d+)\)\s*\/\/ strood-track-gain\s*$/);
    const sourceLabel = lines[lineIndex].match(TRACK_START)?.[1];
    const name = label || sourceLabel || `Track ${index + 1}`;
    const orbitMatch = block.match(/\.orbit\(\s*(\d+)\s*\)/);
    return {
      id: `${index}-${lineIndex}`,
      key: explicitKey || slug(sourceLabel || name),
      index,
      name,
      line: lineIndex + 1,
      start: offsets[lineIndex],
      end: endLine < lines.length ? offsets[endLine] : code.length,
      orbit: orbitMatch ? Number(orbitMatch[1]) : index + 1,
      gain: gainMatch ? Number(gainMatch[1]) : 1,
      muted: gainMatch ? Number(gainMatch[1]) === 0 : false,
      colour: TRACK_COLOURS[index % TRACK_COLOURS.length],
    };
  });
}

export function routeTracksForPlayback(code, tracks = parseTracks(code)) {
  let routed = code;
  for (const track of [...tracks].reverse()) {
    const original = routed.slice(track.start, track.end);
    if (/\.orbit\(\s*\d+\s*\)/.test(original)) continue;
    const trailing = original.match(/\s*$/)?.[0] || '';
    let body = original.slice(0, original.length - trailing.length);
    let suffix = '';
    if (body.endsWith(';')) {
      body = body.slice(0, -1);
      suffix = ';';
    }
    const replacement = `${body}.orbit(${track.orbit})${suffix}${trailing}`;
    routed = routed.slice(0, track.start) + replacement + routed.slice(track.end);
  }
  return routed;
}

export function setTrackGain(code, trackIndex, gain) {
  const tracks = parseTracks(code);
  const track = tracks[trackIndex];
  if (!track) return code;
  const value = Math.max(0, Math.min(1.5, Number(gain))).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  const before = code.slice(0, track.start);
  const after = code.slice(track.end);
  let block = code.slice(track.start, track.end).replace(/\n+$/, '');
  const trailing = code.slice(track.start, track.end).slice(block.length);

  const markedGain = /\)\.gain\((\d*\.?\d+)\)\s*\/\/ strood-track-gain\s*$/;
  if (markedGain.test(block)) {
    block = block.replace(markedGain, `).gain(${value}) ${MASTER_GAIN_MARKER}`);
  } else {
    const markerIndex = block.indexOf('$:');
    if (markerIndex === -1) return code;
    block = `${block.slice(0, markerIndex + 2)} (${block.slice(markerIndex + 2).trimStart()}).gain(${value}) ${MASTER_GAIN_MARKER}`;
  }
  return before + block + trailing + after;
}

export function trackLineRange(code, trackIndex) {
  const track = parseTracks(code)[trackIndex];
  if (!track) return null;
  return { start: track.start, end: track.end, line: track.line };
}
