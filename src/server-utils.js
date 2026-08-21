import path from 'node:path';
import crypto from 'node:crypto';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}$/;

export function isSafeName(name) {
  return typeof name === 'string' && SAFE_NAME.test(name);
}

export function safeFile(root, name, extension) {
  if (!isSafeName(name)) return null;
  const target = path.resolve(root, `${name}${extension}`);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return target;
}

export function versionOf(content) {
  return `"${crypto.createHash('sha256').update(content).digest('hex').slice(0, 24)}"`;
}
