# seamer-studio

`seamer-studio` is the new SvelteKit application for Seamer's parametric
sewing-pattern domain. It consumes the local `atelier` engine through `file:`
dependencies and owns the pattern model, formula/constraint solver, avatar,
XPBD cloth simulation, application UI, server routes, and product pages.

## Workspace

- `packages/pattern-model` — `@seamer/pattern-model`: Pattern schema,
  `CommandDef<Pattern>` registry, constraint/formula solver, and domain
  geometry/mutation utilities.
- `packages/cloth-sim` — `@seamer/cloth-sim`: cloth mesh preparation, body
  arrangement geometry, XPBD WebGPU engine, verbatim WGSL, and the Atelier
  `SolverPlugin`.
- `packages/avatar` — `@seamer/avatar`: model asset loading, measurement
  reconstruction, skinning, controllers, and silhouettes.
- `src` — SvelteKit application. `/studio` opens the Pencil Skirt template by
  default.
- `static/models` — the complete avatar model and skinning binary asset set.

The 2D editor intentionally remains the existing Canvas2D implementation. Its
document Y axis is mathematical Y-up; only the canvas/SVG projection flips Y.

## Editor behavior

The canonical document is an Atelier `Editor<Pattern>`. It uses the pattern
command registry, a single immutable Atelier `Selection`, labeled snapshot
history, an 800 ms coalescing window, and `IndexedDbHistoryPersistence` keyed
by pattern id. The old point/path/piece selection stores are compatibility
views over the one engine selection while the untouched Canvas2D and panels are
migrated incrementally.

`window.seamer` is installed through `installAutomationApi`. Compatibility
aliases preserve the old `getPattern()` and object-shaped `getSelection()`
results for existing scripts.

## Development

Use pnpm from this directory:

```sh
pnpm install
pnpm check
pnpm test:unit
pnpm lint
```

The app pins `three` to `0.181.2`; Vite deduplicates `three` so the app and
Atelier viewport do not create separate runtime instances.

## Not yet ported

Explicit migration gaps, not completed features. Verified against the code on
2026-07-26 — earlier revisions of this list overstated what remained.

**2D canvas.** `components/PatternCanvas2D.svelte` (3317 LOC) remains a
hand-rolled `CanvasRenderingContext2D` renderer. Porting it to the engine's
`projection: '2d'` is MIGRATION.md Phase 6 and is **explicitly out of scope and
not recommended** — it buys architectural consistency, not capability.

**Unverifiable headlessly.** WebGPU cloth drape (wired via `SolverRunner`, GPU
execution and visual parity unconfirmed) and the Playwright suite under
`seamer/e2e/`, which needs a dev server.

**Carried for continuity, not exercised.** `routes/api/**`, `lib/server/**`,
`hooks.server.ts`, and the marketing/docs routes.

### Completed since the first port

- Selection UI reads `EditorState.selection` directly; the three compatibility
  stores and `selectionStore()` are gone.
- True-shape packing delegates to `@atelier/geometry.nest()` while
  Pattern-specific cut-instance, marker, fabric, and label handling remains
  app-side.
- The 3D export rail exposes the live draped scene as glTF.
- 3D scene migrated onto `Viewport` / `CameraRig` / `PickService` /
  `OverlayLayer` / `GizmoService`; `scene3d.ts` 2570 → 1941 LOC.
- AO now injected through the engine's `aoPassFactory`, keeping the real
  `N8AOPass` and all four persisted `n8ao*` document fields intact.
- The duplicate `src/lib/commands/` layer (11 files, 2103 LOC) deleted; its
  reducers merged into `@seamer/pattern-model`.
- DXF, CSV, PDF, HPGL, PNG, print and cut-file paths migrated to `@atelier/io`.
- SVG import added (`SvgImportDialog` + `fromSVG`).
- Five commands added to match the original production registry.
