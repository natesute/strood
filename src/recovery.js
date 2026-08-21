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
  localStorage.setItem(RECOVERY_KEY, JSON.stringify(snapshots.slice(0, MAX_SNAPSHOTS)));
}

export function listRecoverySnapshots(name = null) {
  const snapshots = readAll();
  return name ? snapshots.filter((snapshot) => snapshot.name === name) : snapshots;
}

export function clearRecoverySnapshots(name) {
  localStorage.setItem(RECOVERY_KEY, JSON.stringify(readAll().filter((snapshot) => snapshot.name !== name)));
}
