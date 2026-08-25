# Strood

Local-first Strudel live-coding studio. Vanilla JS + Vite, no framework. Songs are
plain `.strudel` files in `songs/`, edited in a CodeMirror-based editor with canvas
visualisers rendered inline as widgets.

## Commands

- `npm run dev` — Vite on 5173. A dev server is often already running; check before
  starting a second one (`.claude/launch.json` has an attach-only entry).
- `npm test` / `npm run test:e2e` / `npm run check` (unit + build + e2e).
- E2E caveat: the two tests polling `#master-level` / `#limiter-state`
  (strood.spec.js ~955, ~1047) read a real AnalyserNode and flake when anything else
  on the machine holds audio. Re-run them in isolation before calling a regression.

## Module map

- `main.js` — app shell: transport, evaluation, editor wiring, highlight pipeline,
  ripples, song browser. Large; extract into `src/` rather than growing it.
- `src/graph-model.js` + `src/graph-view.js` + `src/orthogonal-router.js` — song
  graph. graph-model does regex-based source parsing and offset-splice edits.
- `visualizers.js` — all custom canvas widgets. `src/optional-systems.js` lazy-loads
  it (and the modular synth) only when a song's text references them.
- `patch-editor.js` + `synth-modules/` — modular synth patches (JSON in
  `synth-modules/patches/`, served live via `/api/patches`).

## Contracts that are easy to re-derive wrong

- **Songs API** (vite.config.js middleware): GET/PUT `/api/songs/:name` with
  `If-Match` version headers → 409 on conflict; every overwrite snapshots the old
  content into `songs/.history/`; deletes go to `songs/.trash/`. Renames 409 on
  existing names.
- **Live sync**: the dev server watches `songs/` and pushes `strudel:update` /
  `strudel:open` over the Vite hot channel; main.js reconciles against unsaved edits.
- **Adding a visualiser needs four touchpoints**: `registerWidget` in visualizers.js,
  the `CUSTOM_VISUALIZERS` regex in src/optional-systems.js, `VISUALIZER_METHODS` in
  src/graph-model.js (graph menu), `METHOD_HELP` in src/inline-controls.js.
- **Regex sniffing of song text** decides what loads: patch names
  (optional-systems.js), sample packs (sample-loader.js), inline controls and the
  graph (inline-controls.js, graph-model.js). None of them are syntax-aware; keep
  their patterns in sync when song conventions change.
- Visualiser painting gates on `document.hidden` + an IntersectionObserver — a
  hidden browser pane shows blank canvases even while audio runs.

## Repo hygiene

- `public/audio/` is gitignored on purpose: the repo is public and the vocal stems
  are processed copies of commercial recordings. Regenerate them with `scripts/`.
- Commit style: lowercase imperative subject describing the change (see `git log`).
