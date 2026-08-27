function splitLines(value) {
  return value ? String(value).split('\n') : [];
}

function prefixSuffixDiff(before, after) {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) {
    suffix += 1;
  }
  const rows = [];
  for (let index = 0; index < prefix; index += 1) {
    rows.push({ type: 'same', text: before[index], oldLine: index + 1, newLine: index + 1 });
  }
  for (let index = prefix; index < before.length - suffix; index += 1) {
    rows.push({ type: 'remove', text: before[index], oldLine: index + 1, newLine: null });
  }
  for (let index = prefix; index < after.length - suffix; index += 1) {
    rows.push({ type: 'add', text: after[index], oldLine: null, newLine: index + 1 });
  }
  for (let index = suffix; index > 0; index -= 1) {
    const oldLine = before.length - index + 1;
    const newLine = after.length - index + 1;
    rows.push({ type: 'same', text: before[oldLine - 1], oldLine, newLine });
  }
  return rows;
}

function completeLineDiff(before, after) {
  if (before.length * after.length > 1_500_000) return prefixSuffixDiff(before, after);
  const lengths = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let oldIndex = before.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = after.length - 1; newIndex >= 0; newIndex -= 1) {
      lengths[oldIndex][newIndex] = before[oldIndex] === after[newIndex]
        ? lengths[oldIndex + 1][newIndex + 1] + 1
        : Math.max(lengths[oldIndex + 1][newIndex], lengths[oldIndex][newIndex + 1]);
    }
  }

  const rows = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < before.length || newIndex < after.length) {
    if (oldIndex < before.length && newIndex < after.length
      && before[oldIndex] === after[newIndex]) {
      rows.push({
        type: 'same',
        text: before[oldIndex],
        oldLine: oldIndex + 1,
        newLine: newIndex + 1,
      });
      oldIndex += 1;
      newIndex += 1;
    } else if (newIndex < after.length
      && (oldIndex >= before.length
        || lengths[oldIndex][newIndex + 1] > lengths[oldIndex + 1][newIndex])) {
      rows.push({ type: 'add', text: after[newIndex], oldLine: null, newLine: newIndex + 1 });
      newIndex += 1;
    } else {
      rows.push({ type: 'remove', text: before[oldIndex], oldLine: oldIndex + 1, newLine: null });
      oldIndex += 1;
    }
  }
  return rows;
}

export function diffLines(savedCode, currentCode, { context = 2 } = {}) {
  const rows = completeLineDiff(splitLines(savedCode), splitLines(currentCode));
  const visible = new Uint8Array(rows.length);
  let changes = 0;
  rows.forEach((row, index) => {
    if (row.type === 'same') return;
    changes += 1;
    const start = Math.max(0, index - context);
    const end = Math.min(rows.length - 1, index + context);
    for (let nearby = start; nearby <= end; nearby += 1) visible[nearby] = 1;
  });
  if (!changes) return [];

  const compact = [];
  for (let index = 0; index < rows.length;) {
    if (visible[index]) {
      compact.push(rows[index]);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < rows.length && !visible[end]) end += 1;
    compact.push({ type: 'skip', count: end - index });
    index = end;
  }
  return compact;
}
