const SECTION_PATTERN = /^\s*\/\/\s*@section\s+([^|]+?)\s*\|\s*(\d+)\s*-\s*(\d+)\s*$/i;

export function parseSections(code) {
  return code.split('\n').flatMap((line) => {
    const match = line.match(SECTION_PATTERN);
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

export function nextCycleTiming(now, cps, leadMs = 80) {
  const targetCycle = Math.floor(now + 0.0001) + 1;
  const milliseconds = Math.max(0, ((targetCycle - now) / cps) * 1000 - leadMs);
  return { targetCycle, milliseconds };
}

