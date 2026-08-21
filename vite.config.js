import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

const SONGS_DIR = path.resolve(__dirname, 'songs');
const PATCHES_DIR = path.resolve(__dirname, 'synth-modules/patches');

function liveSyncPlugin() {
  return {
    name: 'live-sync',
    configureServer(server) {
      let activeFile = null;
      let lastWrittenContent = null;

      // Watch for external file changes
      server.watcher.on('change', (filePath) => {
        if (filePath !== activeFile) return;
        const content = fs.readFileSync(filePath, 'utf-8');
        if (content === lastWrittenContent) return; // loop prevention
        lastWrittenContent = content;
        server.hot.send('strudel:update', { code: content });
      });

      // Receive saves from browser
      server.hot.on('strudel:save', (data, client) => {
        if (!activeFile) return;
        lastWrittenContent = data.code;
        fs.writeFileSync(activeFile, data.code, 'utf-8');
      });

      // Receive active file selection
      server.hot.on('strudel:open', (data, client) => {
        const filePath = path.join(SONGS_DIR, data.name + '.strudel');
        if (!filePath.startsWith(SONGS_DIR)) return;
        activeFile = filePath;
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, data.code || '', 'utf-8');
        }
        lastWrittenContent = fs.readFileSync(filePath, 'utf-8');
        server.watcher.add(filePath);
      });
    },
  };
}

function songsApi() {
  return {
    name: 'songs-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url.startsWith('/api/songs')) return next();

        // GET /api/songs — list all song files
        if (req.method === 'GET' && req.url === '/api/songs') {
          const files = fs.readdirSync(SONGS_DIR).filter(f => f.endsWith('.strudel'));
          const songs = files.map(f => {
            const stat = fs.statSync(path.join(SONGS_DIR, f));
            return { name: f.replace(/\.strudel$/, ''), mtime: stat.mtimeMs };
          });
          songs.sort((a, b) => b.mtime - a.mtime);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(songs));
          return;
        }

        // Extract song name from /api/songs/:name
        const match = req.url.match(/^\/api\/songs\/(.+)$/);
        if (!match) return next();
        const songName = decodeURIComponent(match[1]);
        const filePath = path.join(SONGS_DIR, songName + '.strudel');

        // Prevent path traversal
        if (!filePath.startsWith(SONGS_DIR)) {
          res.statusCode = 400;
          res.end('Bad request');
          return;
        }

        // GET /api/songs/:name — read a song
        if (req.method === 'GET') {
          if (!fs.existsSync(filePath)) { res.statusCode = 404; res.end('Not found'); return; }
          res.setHeader('Content-Type', 'text/plain');
          res.end(fs.readFileSync(filePath, 'utf-8'));
          return;
        }

        // PUT /api/songs/:name — write a song
        if (req.method === 'PUT') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            fs.writeFileSync(filePath, body, 'utf-8');
            res.end('ok');
          });
          return;
        }

        // DELETE /api/songs/:name — delete a song
        if (req.method === 'DELETE') {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          res.end('ok');
          return;
        }

        next();
      });
    },
  };
}

function patchesApi() {
  return {
    name: 'patches-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url.startsWith('/api/patches')) return next();

        // GET /api/patches — list all patch files
        if (req.method === 'GET' && req.url === '/api/patches') {
          if (!fs.existsSync(PATCHES_DIR)) { res.setHeader('Content-Type', 'application/json'); res.end('[]'); return; }
          const files = fs.readdirSync(PATCHES_DIR).filter(f => f.endsWith('.json'));
          const patches = files.map(f => {
            const stat = fs.statSync(path.join(PATCHES_DIR, f));
            return { name: f.replace(/\.json$/, ''), mtime: stat.mtimeMs };
          });
          patches.sort((a, b) => b.mtime - a.mtime);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(patches));
          return;
        }

        // Extract patch name from /api/patches/:name
        const match = req.url.match(/^\/api\/patches\/(.+)$/);
        if (!match) return next();
        const patchName = decodeURIComponent(match[1]);
        const filePath = path.join(PATCHES_DIR, patchName + '.json');

        if (!filePath.startsWith(PATCHES_DIR)) {
          res.statusCode = 400;
          res.end('Bad request');
          return;
        }

        // GET /api/patches/:name
        if (req.method === 'GET') {
          if (!fs.existsSync(filePath)) { res.statusCode = 404; res.end('Not found'); return; }
          res.setHeader('Content-Type', 'application/json');
          res.end(fs.readFileSync(filePath, 'utf-8'));
          return;
        }

        // PUT /api/patches/:name
        if (req.method === 'PUT') {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => {
            fs.writeFileSync(filePath, body, 'utf-8');
            res.end('ok');
          });
          return;
        }

        // DELETE /api/patches/:name
        if (req.method === 'DELETE') {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          res.end('ok');
          return;
        }

        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [songsApi(), patchesApi(), liveSyncPlugin()],
});
