const TRACK_COLOURS = ['#56d4dd', '#f07178', '#e6b450', '#7ee787', '#c792ea', '#ff9e64', '#82aaff'];
const MASTER_GAIN_MARKER = '// strood-track-gain';

export function parseTracks(code) {
  const lines = code.split('\n');
  const offsets = [];
  let offset = 0;
  lines.forEach((line) => { offsets.push(offset); offset += line.length + 1; });

  const starts = [];
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith('$:')) starts.push(index);
  });

  return starts.map((lineIndex, index) => {
    const nextTrackLine = starts[index + 1] ?? lines.length;
    let endLine = nextTrackLine;
    if (nextTrackLine < lines.length) {
      while (endLine > lineIndex + 1 && !lines[endLine - 1].trim()) endLine--;
      if (/^\/\/\s*[A-Za-z][A-Za-z0-9 _-]*$/.test(lines[endLine - 1]?.trim() || '')) endLine--;
      while (endLine > lineIndex + 1 && !lines[endLine - 1].trim()) endLine--;
    }
    let label = '';
    for (let cursor = lineIndex - 1; cursor >= 0; cursor--) {
      const text = lines[cursor].trim();
      if (!text) continue;
      const match = text.match(/^\/\/\s*([A-Za-z][A-Za-z0-9 _-]*)$/);
      if (match) label = match[1].trim();
      break;
    }
    const block = lines.slice(lineIndex, endLine).join('\n').replace(/\n+$/, '');
    const gainMatch = block.match(/\)\.gain\((\d*\.?\d+)\)\s*\/\/ strood-track-gain\s*$/);
    return {
      id: `${index}-${lineIndex}`,
      index,
      name: label || `Track ${index + 1}`,
      line: lineIndex + 1,
      start: offsets[lineIndex],
      end: endLine < lines.length ? offsets[endLine] : code.length,
      gain: gainMatch ? Number(gainMatch[1]) : 1,
      muted: gainMatch ? Number(gainMatch[1]) === 0 : false,
      colour: TRACK_COLOURS[index % TRACK_COLOURS.length],
    };
  });
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
