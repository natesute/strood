# Strood

Strood is a local live-coding studio built on Strudel. Write a song as code, hear changes immediately, shape its sound, build modular synth patches and keep the source as ordinary files on disk.

## Start it

```bash
cd ~/projects/strood
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Run on the open-llm server

The server runs Strood in Docker and exposes Vite only on its own loopback interface. The container installs dependencies on its first start and whenever `package-lock.json` changes:

```bash
cd ~/projects/strood
docker compose up -d
```

From another computer on the same Tailscale network, forward the private server port:

```bash
ssh -i ~/.ssh/open_llm_ed25519 -o IdentitiesOnly=yes \
  -N -L 5173:127.0.0.1:5173 nathan@100.96.156.40
```

Keep that SSH session open and use [http://127.0.0.1:5173](http://127.0.0.1:5173) as usual. Song and patch writes are stored in the server copy of this repository.

## Working with songs

- Press `Ctrl/⌘ + Enter` to run the whole song and `Ctrl/⌘ + .` to stop.
- Master tracks in the song source. Drag underlined numbers, click quoted values to choose from a list and click highlighted booleans; every interaction rewrites the visible code.
- Set the editor column count with `Ctrl/⌘ + 1`, `2` or `3`. Every column is a linked view of the same document, so edits remain synchronised.
- Save and open songs from the transport bar. The song browser supports search, rename, duplicate, version history and recoverable deletion.
- Strood keeps local recovery snapshots after edits and before risky operations. They appear alongside saved history when you open a song's History view.

Songs are `.strudel` files in `songs/`. Disk and browser edits sync live. If the browser contains unsaved work, an external edit is reported instead of overwriting the buffer. Saves use version checks and atomic replacement to prevent accidental data loss.

## Patch editor

Open **Patch** to build modular instruments. The patch editor has a searchable module palette, undo and redo, keyboard-accessible controls, zoom, fit-to-view and patch save/load. Patches are JSON files in `synth-modules/patches/`.

## Development

```bash
npm test          # unit tests
npm run test:e2e  # browser tests
npm run build     # production bundle
npm run check     # all of the above
```

The development server exposes checked song and patch APIs under `/api`. Song writes use `If-Match` versions, old versions are kept in `songs/.history/`, and deleted files move to `songs/.trash/`.
