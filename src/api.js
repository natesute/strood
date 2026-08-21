export class ApiError extends Error {
  constructor(message, { status = 0, code = 'request_failed', details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text();
    let payload;
    try { payload = JSON.parse(body); } catch { payload = { message: body }; }
    throw new ApiError(payload?.message || `Request failed (${response.status})`, {
      status: response.status,
      code: payload?.code,
      details: payload,
    });
  }
  return response;
}

export async function listSongs() {
  return request('/api/songs').then((response) => response.json());
}

export async function readSong(name) {
  const response = await request(`/api/songs/${encodeURIComponent(name)}`);
  return {
    code: await response.text(),
    version: response.headers.get('ETag'),
  };
}

export async function writeSong(name, code, version = null) {
  const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
  if (version) headers['If-Match'] = version;
  const response = await request(`/api/songs/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers,
    body: code,
  });
  return { version: response.headers.get('ETag') };
}

export async function removeSong(name) {
  await request(`/api/songs/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export async function renameSong(from, to) {
  const response = await request(`/api/songs/${encodeURIComponent(from)}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: to }),
  });
  return response.json();
}

export async function listSongHistory(name) {
  return request(`/api/songs/${encodeURIComponent(name)}/history`).then((response) => response.json());
}

export async function readSongHistory(name, version) {
  return request(`/api/songs/${encodeURIComponent(name)}/history/${encodeURIComponent(version)}`).then((response) => response.text());
}

export async function listPatches() {
  return request('/api/patches').then((response) => response.json());
}

export async function readPatch(name) {
  return request(`/api/patches/${encodeURIComponent(name)}`).then((response) => response.json());
}

export async function writePatch(name, patch) {
  await request(`/api/patches/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch, null, 2),
  });
}
