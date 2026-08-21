# Strood

Strood is a local live-coding studio built on Strudel. Write a song as code, hear changes immediately, mix its tracks, build modular synth patches and keep the source as ordinary files on disk.

## Start it

```bash
cd ~/projects/strood
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Working with songs

- Press `Ctrl/⌘ + Enter` to run the whole song, `Shift + Enter` to run the current line and `Ctrl/⌘ + .` to stop.
- Use the track rail to jump to a track, mute or solo it, or change its gain. Gain changes are written back into the song code.
- Add editor columns with `Ctrl/⌘ + Shift + →`. Every column is a linked view of the same document, so edits remain synchronised.
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
