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

These are explicit migration gaps, not completed features:

- Thin Atelier viewport orchestration is partial. The existing
  `seamer/src/lib/scene/scene3d.ts` `PatternRenderer` is still the main
  renderer. It consumes the extracted avatar/cloth packages, engine
  `createSurfaceMaterial`, r181 addon APIs, and `SolverRunner`, but it has not
  yet been decomposed onto `Viewport`, `CameraRig`, `LightingRig`, `PostFX`,
  `PickService`, `OverlayLayer`, and `GizmoService`.
- The incremental viewport migration still uses Seamer's N8AO composer chain
  from `seamer/src/lib/scene/scene3d.ts`. Moving the whole renderer to
  `Viewport.post` (GTAO) and visually tuning garment/skin parity remains.
- `PatternCanvas2D.svelte` still reads compatibility selection stores instead
  of using `EditorState.selection` directly. Source:
  `seamer/src/lib/components/PatternCanvas2D.svelte`. Replacing Canvas2D with
  Atelier's 2D projection remains explicitly out of scope (migration Phase 6).
- Most panels still read the point/path/piece compatibility selection views.
  Direct `Selection` migration remains for
  `seamer/src/lib/components/{StudioToolbar,ObjectBrowser,DrawingTools,StatusBar,ErrorsPanel,PropertyPanel}.svelte`.
- The command palette and MCP adapter still retain the local compatibility
  dispatcher while browser automation uses `Editor`. Sources:
  `seamer/src/lib/components/CommandPalette.svelte`,
  `seamer/src/lib/stores/mcpSession.ts`, and
  `seamer/src/lib/commands/execute.ts`.
- The command, creation, arc, formula, import, linked-path, symmetry, avatar,
  and cloth-build tests have moved to the packages and run against the engine
  registry. Broader UI interaction coverage still comes from the original
  Playwright suite under `seamer/e2e/`, which was not copied or run because it
  requires a development server.
- `packages/pattern-model/src/utils/patternGeometry.ts` still includes the
  source's domain-free helper implementations. The remaining cleanup is to
  retain only Pattern resolvers and replace duplicated helpers with
  `@atelier/geometry`. Source:
  `seamer/src/lib/utils/patternGeometry.ts`.
- SVG uses the new single `Pattern → Drawing` flattener and `@atelier/io`.
  DXF, CSV, PDF, HPGL, PNG, print, and cut-file UI paths still use compatibility
  implementations from `seamer/src/lib/utils/{exporters,pdf,hpgl,cutfile}.ts`;
  migration to `@atelier/io` remains.
- glTF is available as `sceneToGLTF` from the exporter module, but no Studio UI
  action exposes it yet. The current 3D export UI lives in
  `seamer/src/lib/scene/scene3d.ts` and
  `seamer/src/routes/studio/[...slug]/+page.svelte`.
- WebGPU cloth is wired as `clothSolverPlugin` and the live renderer uses
  `SolverRunner`, but GPU execution and visual drape parity are unverified in
  this headless environment.
- The product/server surface was copied for continuity, not exhaustively
  exercised here: `seamer/src/routes/api/**`, `seamer/src/lib/server/**`,
  `seamer/src/hooks.server.ts`, and the marketing/docs routes.
