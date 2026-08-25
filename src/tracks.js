const TRACK_START = /^\s*(?:([A-Za-z_][A-Za-z0-9_]*)\$|\$):/;
const TRACK_DIRECTIVE = /^\/\/\s*@track\s+([A-Za-z0-9_-]+)(?:\s*\|\s*(.+))?$/i;
const TRACK_COLORS = ['#ff8844', '#58a6ff', '#d985ff', '#63d7da', '#d9dde5', '#ff6b78', '#ffd166', '#8be36b'];

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'track';
}

function safeTrackColor(value, fallback) {
  const color = value?.trim();
  if (!color) return fallback;
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
  if (/^[a-z]+$/i.test(color)) return color.toLowerCase();
  return fallback;
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
    const sourceLabel = lines[lineIndex].match(TRACK_START)?.[1];
    const name = label || sourceLabel || `Track ${index + 1}`;
    const orbitMatch = block.match(/\.orbit\(\s*(\d+)\s*\)/);
    const colorMatch = block.match(/\.color\(\s*(["'])([^"']+)\1\s*\)/);
    return {
      id: `${index}-${lineIndex}`,
      key: explicitKey || slug(sourceLabel || name),
      index,
      name,
      line: lineIndex + 1,
      start: offsets[lineIndex],
      end: endLine < lines.length ? offsets[endLine] : code.length,
      orbit: orbitMatch ? Number(orbitMatch[1]) : index + 1,
      color: safeTrackColor(colorMatch?.[2], TRACK_COLORS[index % TRACK_COLORS.length]),
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

export function trackLineRange(code, trackIndex) {
  const track = parseTracks(code)[trackIndex];
  if (!track) return null;
  return { start: track.start, end: track.end, line: track.line };
}
