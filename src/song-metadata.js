const ARRANGEMENT_BLOCK = /\bconst\s+arrangement\s*=\s*\[([\s\S]*?)\]/m;
const ARRANGEMENT_ENTRY = /\{\s*(?:section\s*:\s*(['"])(.*?)\1\s*,\s*cycles\s*:\s*(\d+(?:\.\d+)?)|cycles\s*:\s*(\d+(?:\.\d+)?)\s*,\s*section\s*:\s*(['"])(.*?)\5)\s*,?\s*\}/g;
const LEGACY_SECTION_PATTERN = /^\s*\/\/\s*@section\s+([^|]+?)\s*\|\s*(\d+)\s*-\s*(\d+)\s*$/i;
const SONG_PART = /\bconst\s+songPart\s*=\s*(['"])(.*?)\1/;

export function parseSections(code) {
  const block = code.match(ARRANGEMENT_BLOCK)?.[1] || '';
  let cursor = 0;
  const arrangement = [...block.matchAll(ARRANGEMENT_ENTRY)].flatMap((match) => {
    const cycles = Number(match[3] ?? match[4]);
    if (!Number.isFinite(cycles) || cycles <= 0) return [];
    const section = { name: (match[2] ?? match[6]).trim(), start: cursor, end: cursor + cycles };
    cursor = section.end;
    return [section];
  });
  if (arrangement.length) return arrangement;

  return code.split('\n').flatMap((line) => {
    const match = line.match(LEGACY_SECTION_PATTERN);
    if (!match) return [];
    const start = Number(match[2]);
    const end = Number(match[3]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    return [{ name: match[1].trim(), start, end }];
  }).sort((a, b) => a.start - b.start);
}

export function sectionAtCycle(sections, cycle) {
  if (!sections.length) return null;
  const length = Math.max(...sections.map((section) => section.end));
  const position = ((cycle % length) + length) % length;
  return sections.find((section) => position >= section.start && position < section.end) || null;
}

export function cycleWithinSection(section, elapsedCycles) {
  const length = Number(section?.end) - Number(section?.start);
  if (!Number.isFinite(length) || length <= 0) return Number(section?.start) || 0;
  const elapsed = Number.isFinite(Number(elapsedCycles)) ? Number(elapsedCycles) : 0;
  return section.start + (((elapsed % length) + length) % length);
}

export function selectedSongSection(code) {
  const selected = code.match(SONG_PART)?.[2]?.trim();
  if (!selected) return null;
  if (selected === 'Full song') return { name: selected, start: 0 };
  const section = parseSections(code).find(({ name }) => name === selected);
  return section ? { name: section.name, start: section.start } : null;
}

export function setSelectedSongSection(code, name) {
  const selected = String(name || '').trim();
  if (!selected || !SONG_PART.test(code)) return code;
  SONG_PART.lastIndex = 0;
  return code.replace(SONG_PART, (match, quote) => match.replace(
    /(['"])(.*?)\1\s*$/,
    `${quote}${selected}${quote}`,
  ));
}

export function nextCycleTiming(now, cps, leadMs = 80) {
  const targetCycle = Math.floor(now + 0.0001) + 1;
  const milliseconds = Math.max(0, ((targetCycle - now) / cps) * 1000 - leadMs);
  return { targetCycle, milliseconds };
}

export function sectionEndTiming(now, cps, section, sourceCycle, leadMs = 80) {
  const remainingCycles = Math.max(0, Number(section?.end) - Number(sourceCycle));
  const targetCycle = now + remainingCycles;
  const milliseconds = Math.max(0, (remainingCycles / cps) * 1000 - leadMs);
  return { targetCycle, milliseconds };
}
