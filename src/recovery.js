const RECOVERY_KEY = 'strood_recovery_v1';
const MAX_SNAPSHOTS = 24;

function readAll() {
  try {
    const value = JSON.parse(localStorage.getItem(RECOVERY_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function saveRecoverySnapshot(name, code, reason = 'edit') {
  if (!code?.trim()) return;
  const snapshots = readAll();
  const last = snapshots[0];
  if (last?.code === code && last?.name === name) return;
  snapshots.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: name || 'Untitled',
    code,
    reason,
    createdAt: Date.now(),
  });
  const trimmed = snapshots.slice(0, MAX_SNAPSHOTS);
  // Recovery must never break the caller's save path: on quota errors keep
  // halving the snapshot count, and give up silently if even one won't fit.
  for (let keep = trimmed.length; keep > 0; keep = Math.floor(keep / 2)) {
    try {
      localStorage.setItem(RECOVERY_KEY, JSON.stringify(trimmed.slice(0, keep)));
      return;
    } catch {
      // quota exceeded — retry with fewer snapshots
    }
  }
}

export function listRecoverySnapshots(name = null) {
  const snapshots = readAll();
  return name ? snapshots.filter((snapshot) => snapshot.name === name) : snapshots;
}

export function clearRecoverySnapshots(name) {
  localStorage.setItem(RECOVERY_KEY, JSON.stringify(readAll().filter((snapshot) => snapshot.name !== name)));
}
