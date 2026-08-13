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

## Wire channels, assembly timeline, generators

Three features share one idea: a garment is not only a shape, it is a shape plus an order it gets
sewn in, plus whatever structure is sewn into it.

**Wire channels.** Any `PiecePath` may carry a `wire` (`WireChannel`): a stiffener sewn into the
edge — boning, a hoop, a lantern rib. `channelWidth` is extra CUT width only, applied through the
existing per-edge `seamAllowance` override, so the finished geometry is untouched. In the drape the
wire becomes near-inextensible distance constraints along the edge plus curvature constraints across
alternate particles, both resting on the FLAT pattern lengths. That is the physical claim of the
construction: the cut edge already carries the correct in-plane curvature, so the wire holds that
curve and only bends out of the plane of the cloth. Wire constraints are deliberately kept out of
`allStretchEdges` — that list seeds near-damping neighbours and feeds the cross-seam softening pass,
and a rib usually runs *along* a seam, so softening would disable exactly what holds the form.

**Assembly timeline.** `Pattern.assembly` orders the seams; `resolveAssembly()` completes it (seams
no step names sew last, in `pattern.seams` order). The solver gates seams by a per-link stitch index
(`SimData.seamOrder`) against a `sewnUpTo` uniform, defaulting to fully sewn so an ungated drape is
unchanged. The timeline's unit is the STITCH, not the seam — `seamPairsBySeam` is already ordered
along each edge — which is what lets a seam zip shut rather than snap, and lets one long spiral seam
be a timeline in its own right.

Unlike PackCAD's folding timeline, this one is a **recording, not a function**. Rigid origami can be
solved at any scrub position; XPBD is path-dependent and cannot. `recordAssembly()` runs the solver
forward once and snapshots as it goes; `AssemblyPlayback` scrubs the result. Transport lives in the
3D panel behind the timeline button.

**Globe lantern generator.** Templates → Generators → Globe lantern. Produces a full `Pattern` from
parameters in two constructions: stacked rings (each an annular sector, closed form) or a helix (one
ribbon whose flat shape is the double spiral you get by integrating geodesic curvature). Both carry
wire channels per coil and a complete assembly order; both split to fit a cutting mat. The generator
also ships each piece's exact 2D→3D map as `savedPositions`, so the studio shows the finished lantern
immediately rather than asking the solver to fold a sphere out of a flat spiral — which nothing in
the physics would drive it to do.

## Checking the WGSL

```sh
pnpm check:wgsl
```

Compiles every compute kernel and builds its pipeline against Chromium's software WebGPU adapter —
no GPU needed. Unit tests never touch the GPU, so this covers the one failure mode that takes the
whole drape down: a shader that typechecks and then fails at runtime. Pipelines are built with
WebGPU's *baseline* limits rather than the adapter's, because the guaranteed
`maxStorageBuffersPerShaderStage` is 8 and the software adapter allows 10 — a ninth storage buffer
compiles fine here and fails on real hardware.

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
