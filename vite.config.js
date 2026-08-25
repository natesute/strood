import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isSafeName, safeFile, versionOf } from './src/server-utils.js';

const SONGS_DIR = path.resolve(__dirname, 'songs');
const HISTORY_DIR = path.join(SONGS_DIR, '.history');
const TRASH_DIR = path.join(SONGS_DIR, '.trash');
const PATCHES_DIR = path.resolve(__dirname, 'synth-modules/patches');
const MAX_SONG_BYTES = 1024 * 1024;
const MAX_PATCH_BYTES = 512 * 1024;

function sendJson(res, status, payload, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));
  res.end(JSON.stringify(payload));
}

function sendText(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));
  res.end(body);
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error('Request body is too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function atomicWrite(filePath, content) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.promises.writeFile(tempPath, content, 'utf8');
  await fs.promises.rename(tempPath, filePath);
}

function decodeSegment(value) {
  try { return decodeURIComponent(value); } catch { return null; }
}

function parseJsonBody(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Request body is not valid JSON');
    error.statusCode = 400;
    throw error;
  }
}

function historyFolder(name) {
  return path.join(HISTORY_DIR, crypto.createHash('sha1').update(name).digest('hex').slice(0, 16));
}

async function snapshotSong(name, content) {
  if (!content) return;
  const folder = historyFolder(name);
  await fs.promises.mkdir(folder, { recursive: true });
  const id = `${Date.now()}-${versionOf(content).replaceAll('"', '')}`;
  await atomicWrite(path.join(folder, `${id}.strudel`), content);
  const files = (await fs.promises.readdir(folder)).filter((file) => file.endsWith('.strudel')).sort().reverse();
  await Promise.all(files.slice(40).map((file) => fs.promises.unlink(path.join(folder, file))));
}

function liveSyncPlugin() {
  return {
    name: 'live-sync',
    configureServer(server) {
      let activeFile = null;
      let activeName = null;
      let lastWrittenContent = null;

      server.watcher.on('change', async (filePath) => {
        if (filePath !== activeFile) return;
        try {
          const content = await fs.promises.readFile(filePath, 'utf8');
          if (content === lastWrittenContent) return;
          lastWrittenContent = content;
          server.hot.send('strudel:update', { name: activeName, code: content, version: versionOf(content) });
        } catch (error) {
          server.config.logger.warn(`[strood] Could not sync ${filePath}: ${error.message}`);
        }
      });

      server.hot.on('strudel:open', async (data) => {
        const filePath = safeFile(SONGS_DIR, data?.name, '.strudel');
        if (!filePath) return;
        activeFile = filePath;
        activeName = data.name;
        if (!fs.existsSync(filePath)) await atomicWrite(filePath, data.code || '');
        lastWrittenContent = await fs.promises.readFile(filePath, 'utf8');
        server.watcher.add(filePath);
      });
    },
  };
}

function songsApi() {
  return {
    name: 'songs-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost');
        if (!url.pathname.startsWith('/api/songs')) return next();

        try {
          await fs.promises.mkdir(SONGS_DIR, { recursive: true });

          if (req.method === 'GET' && url.pathname === '/api/songs') {
            const files = (await fs.promises.readdir(SONGS_DIR)).filter((file) => file.endsWith('.strudel'));
            const songs = await Promise.all(files.map(async (file) => {
              const stat = await fs.promises.stat(path.join(SONGS_DIR, file));
              return { name: file.replace(/\.strudel$/, ''), mtime: stat.mtimeMs, size: stat.size };
            }));
            songs.sort((a, b) => b.mtime - a.mtime);
            return sendJson(res, 200, songs);
          }

          const historyRead = url.pathname.match(/^\/api\/songs\/([^/]+)\/history\/([^/]+)$/);
          if (req.method === 'GET' && historyRead) {
            const name = decodeSegment(historyRead[1]);
            const id = decodeSegment(historyRead[2]);
            if (!isSafeName(name) || !/^[A-Za-z0-9-]+$/.test(id || '')) return sendJson(res, 400, { code: 'invalid_name', message: 'Invalid song or history name' });
            const filePath = path.join(historyFolder(name), `${id}.strudel`);
            if (!fs.existsSync(filePath)) return sendJson(res, 404, { code: 'not_found', message: 'Recovery version not found' });
            return sendText(res, 200, await fs.promises.readFile(filePath, 'utf8'));
          }

          const historyList = url.pathname.match(/^\/api\/songs\/([^/]+)\/history$/);
          if (req.method === 'GET' && historyList) {
            const name = decodeSegment(historyList[1]);
            if (!isSafeName(name)) return sendJson(res, 400, { code: 'invalid_name', message: 'Invalid song name' });
            const folder = historyFolder(name);
            if (!fs.existsSync(folder)) return sendJson(res, 200, []);
            const files = (await fs.promises.readdir(folder)).filter((file) => file.endsWith('.strudel')).sort().reverse();
            return sendJson(res, 200, files.map((file) => {
              const id = file.replace(/\.strudel$/, '');
              return { id, createdAt: Number(id.split('-')[0]) };
            }));
          }

          const renameMatch = url.pathname.match(/^\/api\/songs\/([^/]+)\/rename$/);
          if (req.method === 'POST' && renameMatch) {
            const from = decodeSegment(renameMatch[1]);
            const payload = parseJsonBody(await readBody(req, 4096));
            const to = payload?.name;
            const fromPath = safeFile(SONGS_DIR, from, '.strudel');
            const toPath = safeFile(SONGS_DIR, to, '.strudel');
            if (!fromPath || !toPath) return sendJson(res, 400, { code: 'invalid_name', message: 'Use letters, numbers, spaces, hyphens or underscores' });
            if (!fs.existsSync(fromPath)) return sendJson(res, 404, { code: 'not_found', message: 'Song not found' });
            if (fs.existsSync(toPath)) return sendJson(res, 409, { code: 'already_exists', message: 'A song with that name already exists' });
            await fs.promises.rename(fromPath, toPath);
            const fromHistory = historyFolder(from);
            const toHistory = historyFolder(to);
            if (fs.existsSync(fromHistory) && !fs.existsSync(toHistory)) await fs.promises.rename(fromHistory, toHistory);
            return sendJson(res, 200, { name: to });
          }

          const songMatch = url.pathname.match(/^\/api\/songs\/([^/]+)$/);
          if (!songMatch) return next();
          const name = decodeSegment(songMatch[1]);
          const filePath = safeFile(SONGS_DIR, name, '.strudel');
          if (!filePath) return sendJson(res, 400, { code: 'invalid_name', message: 'Use letters, numbers, spaces, hyphens or underscores' });

          if (req.method === 'GET') {
            if (!fs.existsSync(filePath)) return sendJson(res, 404, { code: 'not_found', message: 'Song not found' });
            const content = await fs.promises.readFile(filePath, 'utf8');
            return sendText(res, 200, content, { ETag: versionOf(content), 'Cache-Control': 'no-store' });
          }

          if (req.method === 'PUT') {
            const content = await readBody(req, MAX_SONG_BYTES);
            const existing = fs.existsSync(filePath) ? await fs.promises.readFile(filePath, 'utf8') : null;
            const currentVersion = existing == null ? null : versionOf(existing);
            const expectedVersion = req.headers['if-match'];
            if (expectedVersion && expectedVersion !== currentVersion) {
              return sendJson(res, 409, {
                code: 'version_conflict',
                message: 'This song changed on disk after you opened it',
                currentVersion,
              });
            }
            if (existing != null && existing !== content) await snapshotSong(name, existing);
            await atomicWrite(filePath, content);
            const version = versionOf(content);
            return sendJson(res, 200, { ok: true, version }, { ETag: version });
          }

          if (req.method === 'DELETE') {
            if (!fs.existsSync(filePath)) return sendJson(res, 404, { code: 'not_found', message: 'Song not found' });
            await fs.promises.mkdir(TRASH_DIR, { recursive: true });
            await fs.promises.rename(filePath, path.join(TRASH_DIR, `${name}-${Date.now()}.strudel`));
            return sendJson(res, 200, { ok: true, recoverable: true });
          }

          return sendJson(res, 405, { code: 'method_not_allowed', message: 'Method not allowed' }, { Allow: 'GET, PUT, DELETE' });
        } catch (error) {
          server.config.logger.error(error.stack || error.message);
          return sendJson(res, error.statusCode || 500, { code: 'server_error', message: error.message || 'Server error' });
        }
      });
    },
  };
}

function validPatch(value) {
  return value && typeof value === 'object' && value.modules && typeof value.modules === 'object' && Array.isArray(value.routing || []);
}

function patchesApi() {
  return {
    name: 'patches-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost');
        if (!url.pathname.startsWith('/api/patches')) return next();
        try {
          await fs.promises.mkdir(PATCHES_DIR, { recursive: true });
          if (req.method === 'GET' && url.pathname === '/api/patches') {
            const files = (await fs.promises.readdir(PATCHES_DIR)).filter((file) => file.endsWith('.json'));
            const patches = await Promise.all(files.map(async (file) => {
              const stat = await fs.promises.stat(path.join(PATCHES_DIR, file));
              return { name: file.replace(/\.json$/, ''), mtime: stat.mtimeMs };
            }));
            patches.sort((a, b) => b.mtime - a.mtime);
            return sendJson(res, 200, patches);
          }

          const match = url.pathname.match(/^\/api\/patches\/([^/]+)$/);
          if (!match) return next();
          const name = decodeSegment(match[1]);
          const filePath = safeFile(PATCHES_DIR, name, '.json');
          if (!filePath) return sendJson(res, 400, { code: 'invalid_name', message: 'Invalid patch name' });

          if (req.method === 'GET') {
            if (!fs.existsSync(filePath)) return sendJson(res, 404, { code: 'not_found', message: 'Patch not found' });
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(await fs.promises.readFile(filePath, 'utf8'));
            return;
          }

          if (req.method === 'PUT') {
            const raw = await readBody(req, MAX_PATCH_BYTES);
            const patch = parseJsonBody(raw);
            if (!validPatch(patch)) return sendJson(res, 422, { code: 'invalid_patch', message: 'Patch must contain modules and routing' });
            await atomicWrite(filePath, JSON.stringify(patch, null, 2));
            return sendJson(res, 200, { ok: true });
          }

          return sendJson(res, 405, { code: 'method_not_allowed', message: 'Method not allowed' });
        } catch (error) {
          server.config.logger.error(error.stack || error.message);
          return sendJson(res, error.statusCode || 500, { code: 'server_error', message: error.message || 'Server error' });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [songsApi(), patchesApi(), liveSyncPlugin()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          strudel: ['@strudel/core', '@strudel/mini', '@strudel/tonal', '@strudel/transpiler'],
          audio: ['@strudel/webaudio', 'superdough'],
          editor: ['@strudel/codemirror'],
        },
      },
    },
  },
});
