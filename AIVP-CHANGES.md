# AIVP changes to OpenCut Classic

Fork: `TheadoreL/aivp-opencut-classic`, based on upstream OpenCut Classic
`cf5e79e919144200294fb9fed22a222592a0aeea`. Upstream code remains under the
MIT licence in `LICENSE` (Copyright 2025-2026 OpenCut); these changes are
distributed under the same licence.

The AIVP desktop application embeds the real Classic editor (timeline,
preview, properties, media bin, renderer and mediabunny/WebCodecs export).
Nothing is replaced by a demo timeline or a JSON "export".

## Build

`bun run build:aivp` (root) → `apps/web/.next-aivp/` (Next.js 16 writes the
static export into the configured `distDir`, next to its own build
bookkeeping, which the AIVP desktop packaging step filters out): a static export of the
`*.aivp.tsx` app entries only (`AIVP_EDITOR_BUILD=1`, see
`apps/web/next.config.ts`). The AIVP desktop shell packages these files and
serves them from its own `aivp-editor://classic` origin. No Node/Bun server
runs at runtime. The regular OpenCut site build (`next build`) is unchanged.

The editor build type-checks its own program (`apps/web/tsconfig.aivp.json`:
the AIVP entries and every module they import, same strict options) and
loads the site-only BotId/content-collections config wrappers only for the
site build; Turbopack's root is pinned to this fork.

The AIVP build excludes BotId, content collections, analytics
(databuddy), react-scan and remote Google fonts (layout
`src/app/layout.aivp.tsx`) and hides features that need remote services
(`src/aivp/runtime.ts`): Freesound sounds, remote sticker/logo sources,
transcription model downloads, Google font CSS.

## Behavioural fixes (upstream defects)

- `core/managers/save-manager.ts`: a failed save no longer clears the dirty
  state; it records the error and schedules one bounded exponential retry
  (no tight loop). `flush()` waits for an in-flight save and keeps saving
  until edits made while it waits are persisted (bounded rounds), and
  rejects when persisting fails, so exit guards never treat unsaved work as
  saved. The AIVP close path freezes editing and reports "saved" only when
  the save manager is clean. Status is observable
  (`getStatus`, `subscribeStatus`).
- `core/managers/project-manager.ts`: `saveCurrentProject` propagates
  storage failures instead of logging and returning as if saved.

## Extensions used by the AIVP host

- `ProjectManager.createNewProject({ id })`, `importSerializedProject`,
  `serializeActiveProject`; `StorageService.serializeProject`,
  `saveSerializedProject` (server snapshots, migrated when older).
- `MediaManager.addMediaAsset({ id, ratchetFps, onError })`: stable media ids
  (manifest entry ids, no duplicates on re-sync) without changing project
  settings during background sync.
- `SceneExporter.exportToStream` / `RendererManager.exportProject({ writable })`
  / `ProjectManager.export({ writable })`: the same encoder writing
  positioned container chunks to a host stream (file-backed), plus the
  actually encoded codec/size/fps/duration (`ExportResult.details`).
- `components/editor/editor-layout.tsx`: the four-panel layout extracted from
  the editor route (shared by the route and the AIVP entry);
  `EditorRuntimeBindings` exported.
- `src/aivp/`: host bridge typing, server snapshot sync with optimistic
  concurrency and conflict handling, local sync records, manifest media
  import, timeline population on an empty timeline only, AIVP header/status,
  export, conflict and version-history dialogs (inspect any server version,
  explicitly recover it as a new version) and the VI theme.
- `src/aivp/title-card.ts` + `components/aivp-title-card-dialog.tsx`: “插入字幕卡”
  header action — a white centred title over a full-frame black rectangle,
  inserted at a main-track boundary as one `TracksSnapshotCommand`; every
  element at/after the boundary on all tracks moves by the same interval,
  and an element crossing the boundary refuses the insertion.
- Accessibility: icon-only timeline toolbar buttons, timeline zoom
  buttons/slider (`Slider.thumbLabel`), the scenes button and the preview
  play/fullscreen/zoom controls have accessible names (toggles expose
  `aria-pressed`).
