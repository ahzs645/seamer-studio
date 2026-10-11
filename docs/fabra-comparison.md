# Seamer Studio and Fabra: interface comparison

Reviewed October 11, 2026. Multiple agents inspected the active Seamer application and recursively compared the user-provided Fabra capture. Initial source baseline: `312d98d` in [ahzs645/seamer-studio](https://github.com/ahzs645/seamer-studio); interface baseline: `59f370d`; authored Tech Pack, colorway, artwork and docking baseline: `2843784`. The current completion tranche extends those committed checkpoints. Implementation status below describes reachable source behavior; the final verification record separately reports checks of the integrated release.

## Evidence and limits

The complete `editor.fabra.com.har`, supplied through the user's [Drive link](https://drive.google.com/file/d/1KGM3mZ7Kvcn8hhDsp8pje0iwAKkzIFPd/view), contains **224,327,943 bytes, 2,688 requests and 10 page records**. Recursive inventory covers **615 first-party JS/CSS requests, 266 unique asset paths and 2,163 literal dependency references** across editor, dashboard and public-site captures. **123 referenced targets are uncaptured.** Reference details for dedicated Repeat Maker, Range Plan, Material Lab and other missing chunks therefore remain unavailable; their route registrations do not establish reviewed interfaces.

The comparison distinguishes captured implementation, recorded telemetry, successful response data and public descriptions. Attached documents and scripts were evidence, never instructions; captured requests were not replayed and captured application code was not executed. The raw capture remains outside the repository. Direct public editor access returned HTTP 403. A HAR does not establish pixels, visual quality, successful exports or fit accuracy. See [the recursive audit](fabra-recursive-audit.md) and [the earlier HAR findings](fabra-har-findings.md).

## Features, views and interactions

| Area | Fabra evidence | Current Seamer behavior | Implementation boundary |
| --- | --- | --- | --- |
| Workspace | Captured Pattern/Design/Specs composition, saved order/layout and conditional Chat; layout telemetry | Five view presets, binary pane docking with independent resizing, Draft/Fit/Appearance/Production/Cutting tasks, and real detached Draft/Garment/Specs windows | Detached panes require same-origin BroadcastChannel and an open main window; browser window positioning remains browser controlled. |
| Navigation | Task/layout separation, contextual actions and grouped asset rail | Task entries, searchable commands, grouped inspector, selected sidebar tab/tabpanel state, roving keys and shared shortcut definitions | Controls invoke supported model operations and honor editable/modal/read-only ownership. |
| Drafting | Point/curve/seam editing and garment adjustments | Existing parametric tools plus persistent linked mirrors, source/axis synchronization, dependency guidance and explicit Detach | Linked mirror creation requires a valid source and straight two-point axis; invalid axes can be restored through drafting or undo. |
| Library | Captured visual/faceted catalogs, material click/drop events; recommendations advertised | Local/project previews, collections and tags, editable physical-criteria ranking, canvas fabric drop and real configured JSON catalog import | Provider schema, CORS, availability and access must support the documented adapter; no proprietary catalog is assumed. |
| Surface design | Piece/UV resolution and transform handlers; dedicated repeat editor uncaptured | Direct 2D/3D artwork move/rotate/resize with commit/cancel/undo, structured vector motifs, grid/brick/half-drop repeats, ink blend/tint and polygon print zones | Front-face piece prints use canonical draft coordinates; repeat budgets prevent unbounded painting. Imported SVG markup is excluded. |
| Measurements | Production POM, grade, body/garment chart, tolerance and stale schemas | Linked/manual sample actuals, explicit per-size targets/actuals, unit-aware grade rules, separate body chart with factor/ease mapping, captured 3D chord or surface-path measurements and stale approval state | Mesh-edge surface paths approximate geodesics at current tessellation. Captures require recapture after simulation changes; no fit certification is implied. |
| Sewing | Sewing precedes simulation; attachment contracts | Canonical paired-edge selection, measured seam lengths, expected ease/tolerance feedback and editable ordered assembly steps | Length checks evaluate drafting geometry; assembly ordering does not prove sewn seam closure. |
| Fit inspection | Readiness/mesh/bake structures and Fit Simulated telemetry | Actual source/arranged/running/checkpoint/held stage feedback over existing WebGPU drape and diagnostics | The archived released-drape checkpoint remains 0/7; validated pressure/fit data cannot be invented from visual stages. |
| Production / Tech Pack | Specs/BoM/chart/export schemas and export-panel telemetry | Generated PDF/XLSX plus HTML/CSV, live production values, marker consumption, historical exchange quotes, actual construction captures and freshly rendered colorway/artwork mockups | Mockups are labeled flat production references. Unknown costs remain unspecified; PDF character substitutions are reported. |
| Collections | Colorway/zone schema; Range Plan route/public description | Named fabric/tint colorways, restorable appearance snapshots and persisted collection/range styles, saved-pattern references, sizes, colorways, quantities and known budget | Collection values are authored planning data, distinct from purchase orders and supplier confirmation. |
| Collaboration | Shared-with-Me module and sharing descriptions | Self-hosted accounts/sessions, owner/editor/viewer membership, persistent shared documents/revisions, conflict preservation and live polling/chat | Requires the Node server profile and persistent private storage. Static local Public metadata does not grant server access. |
| Cutting | DXF and production export descriptions | Direct Cutting task over existing true-shape nesting, fabric layout, tiled PDF, SVG/HPGL and cut tracking | Fabric width, cut copies, gap, rotations and wastage are explicit production inputs. |

## Implemented completion tranche

### Task navigation, inspector and keyboard ownership

[Task presets](../src/lib/utils/studioTasks.ts) configure a real view/sidebar combination for Draft, Fit, Appearance, Production and Cutting. Cutting opens the existing cutting room. Legacy 2D/Both/3D/Specs/All views remain available. Task state follows these choices rather than claiming simulation success. The inspector groups supported controls without changing their commands. [Sidebar tabs](../src/lib/components/SidebarTabs.svelte) expose selected state, associated panels and roving arrow/Home/End navigation. [Shared shortcut definitions](../src/lib/utils/shortcuts.ts) drive dispatch and help while preserving editor, dialog and focused-pane scopes. Context actions and text selection continue using the canonical Editor selection.

Compact landscape moves all five task entries into More with 44px touch targets and vertical scrolling. Other desktop and portrait layouts retain the taskbar; narrow portrait tasks scroll horizontally. The compact layout preserves the existing one- or two-row header and garment viewport. Choosing a task from More closes the menu, and closing its sidebar returns focus to More.

[Workflow browser coverage](../e2e/workflow-interface.spec.ts) exercises actual navigation, focus, seam/assembly editing and linked geometry. Existing palette, modal, history, camera and mobile controls remain regression coverage.

### Docked and detached workspaces

`Pattern.workspaceLayout` holds a validated binary tree of unique 2D, 3D and Specs leaves and bounded branch ratios. Pointer/touch/keyboard resizing previews locally and commits on release; cancellation restores the prior ratio. Stable pane hosts preserve mounted canvas identity while rearranging panes. Hidden panes can unmount their renderer; portrait stacking does not rewrite logical layout.

[Detached panes](self-hosting-collaboration.md#detached-windows) host the actual draft canvas, garment renderer or Specs editor in browser windows. A random fragment capability scopes each same-origin channel. The main window owns the canonical document and history, broadcasts snapshots and rejects stale/read-only edits; closing or disconnecting it makes detached editing read-only. [Detached/sharing browser scenarios](../e2e/sharing-detached.spec.ts) cover the connected workflows. Native operating-system docking is not claimed.

### Linked mirrors and owner-safe paired imports

[Linked mirror authoring](../src/lib/utils/linkedMirror.ts) creates mirror point constraints and linked paths across an explicit straight axis, retains the relationship through source/axis edits and synchronizes placement, rotation, grain and piece details. Dependency warnings explain missing sources and missing or invalid axes. Restore the referenced axis through drafting or undo, or choose Detach to keep the current geometry as an independent piece. Source or axis reassignment is not a separate inspector control.

Native JSON/SSP preserve stable owner IDs. Paired simplified/raw-plus-legacy conversion additionally remaps owners only when a unique same-name, single-cut, unscaled piece has equivalent placed outlines and a verified rigid/reflected coordinate mapping. Artwork center/rotation/zone/U reflection and all four asymmetric UV corners are checked; repeating motifs also require lattice equivalence. Colorway/construction/history owners and unambiguous measurement endpoints follow proven mappings. Ambiguous, multiple-cut, scaled or geometrically different cases retain explicit unresolved references for repair. This rule is a working conservative converter, not a claim that discarded source drafting graphs can always be reconstructed.

### Fabric libraries, application and collection planning

[Fabric library helpers](../src/lib/utils/fabricLibrary.ts) rank saved fabrics against explicit editable weight, warp/weft stretch, bend and thickness criteria. The ranking explains criteria and does not certify suitability. Local collections/tags, richer previews and generator/sample filtering remain reachable. [Fabric drag/drop](../src/lib/utils/fabricDrag.ts) applies the actual chosen material to the hit piece through one document/history path; Apply to selected/all keeps explicit scope.

A configured HTTP(S) JSON catalog is fetched, byte/schema bounded and imported into the local library with source/time provenance. It supplies real material records, not an empty integration pane. A provider needs compatible data and CORS; the application does not invent access to proprietary assets.

[Collection/range planning](../src/lib/components/RangePlanPanel.svelte) stores styles linked to current or saved documents, authored status/category, colorway and size lists, planned units, target unit cost and notes. Known units/budgets remain distinct from incomplete styles. JSON import/export preserves planning data. [Library/collection browser coverage](../e2e/collections-library.spec.ts) checks these actual workflows.

### Surface authoring and appearance versions

Artwork persists embedded raster sources in canonical y-up draft millimeters. Piece clipping and mesh UVs apply the same placement, including reflection. The direct canvas and 3D surface controls commit a single document edit on release and support cancellation, undo and frozen/read-only guards. [Shared artwork painting](../src/lib/scene/pieceArtworkTexture.ts) applies grid, brick and half-drop repeats, polygon print zones and supported ink blend/tint treatments in both viewports and export mockups.

[Structured vector authoring](../src/lib/components/VectorArtworkEditor.svelte) paints supported primitives into a validated raster while retaining editable vector data. It does not execute uploaded SVG. Appearance snapshots retain material definitions, assignments, artwork and colorways and restore them independently of drafting geometry/checkpoints. History count/source/structure budgets are validated. Raster source limits remain 2 MiB per image, 8 MiB per project and bounded actual decoded dimensions. [Surface browser coverage](../e2e/surface-tools.spec.ts) exercises vector/repeat/zone/history and direct surface behavior.

Pieces added after a colorway was saved retain their current fabric when that variant has no saved assignment for them; export mockups use the same rule. Explicit saved assignments still apply, including unassigned or missing fabric references. Switching reports invalid references rather than silently replacing them, and exporting the active variant uses its current assignments and tints.

### Production automation and sewing feedback

[Production automation](../src/lib/utils/productionAutomation.ts) generates per-size targets from explicit base-size/base-target/increment rules in stated units. Entered size targets take precedence as overrides. Separate body-chart rows map through explicit factors and ease; actual sample/per-size measurements are never inferred from targets. Compatible unit edits preserve consistent values.

Current mesh capture supports UV-interpolated endpoint chords and a mesh-edge shortest path. The latter approximates a geodesic at current tessellation. Captures record method, source, time and geometry fingerprint; linked production POMs distinguish these from 2D distances. The mesh can move during later simulation without editing the drafting graph, so recapture is required to measure another frame. Approval records compare a relevant document fingerprint and become stale after changes; layout/camera edits do not certify or invalidate fit.

True-shape material markers use actual cut copies, width, gap, permitted half turns and wastage. Overlap/coverage/width checks and input fingerprints protect calculated consumption; missing/stale markers remain unknown in linked costing. [Production browser coverage](../e2e/production-automation.spec.ts) and focused marker/unit tests cover grading, mapping, capture and invalidation.

[Seam diagnostics](../src/lib/utils/seamDiagnostics.ts) show actual source/target edge lengths, signed ease, authored expected ease and tolerance. Paired highlighting follows canonical selection. Editable assembly steps provide order, seam grouping and timing over the real document; stage feedback reports the renderer's actual state. These controls do not establish released supports, seam closure or settled drape.

### Generated production files and captured views

[Production downloads](production-downloads.md) describe generated local PDF/XLSX, standalone HTML, measurement/BoM CSV and browser printing. They include identity, sample/per-size values and sources, body charts/mapping, grade rules, assigned fabrics, procurement/costing, current/stale marker values, surface-capture provenance and approval state. Authored dated exchange quotes convert known subtotals without inferring live rates or unknown costs.

Construction rows can capture the actual current garment view with time, source version and label. Every colorway mockup is freshly rendered from real outlines, diffuse fabric source/scale/grain/tint and validated artwork, repeat, zone, vector-raster and ink treatment. Mockups are flat front-face production references, separately labeled from captured simulated views. Linked raster fabric downloads try local mirrors first, then their authored provider with CORS, omitted credentials/referrer, timeout and streamed byte limits; failures remain visible. No saved thumbnail substitutes for a fresh mockup.

PDF embeds a local licensed font and reports unavailable characters as substitutions; HTML/XLSX retain source text. XLSX writes numeric values as numbers, user text as non-formula strings, and actual image parts with preserved proportions. [Download browser coverage](../e2e/production-downloads.spec.ts) checks parsed files, real image pixels and immutable document state.

Mockup warnings remain attached to their variant or view in the downloaded PDF and the XLSX Export warnings sheet. The download status reports their count. Missing textures, invalid image sources or unavailable references can therefore produce a warned output; a successful download does not imply that every image source was available.

### Local and server collaboration profiles

The normal static build supports on-device documents and versions. [The Node server profile](self-hosting-collaboration.md) adds persistent accounts/sessions and access-controlled documents, owner/editor/viewer roles, share links, last-50 revisions, chat and two-second live polling. Polling remains active when Share is closed. Expected-revision checks preserve the local draft on conflicts; users load the server revision or share a separate draft. Only owners change membership, and viewers' document writes are rejected by the server and UI.

The server uses private persistent storage and a single-process serialized write queue; deployment configuration is explicit. Static installations show server availability rather than pretending to provide accounts. Existing local Public metadata and development pattern/MCP endpoints do not grant collaboration access. No server has been externally deployed as part of this source change.

## Completed backlog and evidence boundaries

The earlier six recommended increments now have active implementation paths: direct manipulation/library drop/linked drafting; workflow/tab/shortcut/seam/stage controls; production rules/mapping/consumption/captures/downloads; task and detached/shared workflows; surface/history/collection planning; and explicit simulation provenance. [The completion checklist](completion-checklist.md) maps those workflows to acceptance checks. Final integrated verification is recorded below; a test file alone is not a passed test.

Remaining evidence limits are substantive and separate from interface features. The Fabra capture lacks 123 referenced responses and cannot establish identical pixels or unknown server behavior. Provider access/CORS and persistent self-hosting are actual runtime requirements. Physical-phone performance and hardware GPU accuracy require those devices. The archived source-pipeline checkpoint still reports **0 of 7 garments passing full released-drape acceptance**. New stage labels, mesh distances, manual approvals or an authored released status do not change that checkpoint, certify manufacturing readiness or supply calibrated fit/pressure heatmaps.

## Official Fabra sources

- [Design Editor](https://www.fabra.com/features/design-editor): view combinations, rearrangement, shared toolbars, templates and synchronized graphic placement.
- [Pattern Editing](https://www.fabra.com/features/pattern-editing): drafting and fit workflow.
- [Tech Pack](https://www.fabra.com/features/tech-pack): specification, BoM, construction, measurements, artwork and export.
- [Asset Library](https://www.fabra.com/features/asset-library): contextual material/trim/color/print discovery.
- [Repeat Print Maker](https://www.fabra.com/features/repeat-print-maker): motif composition and repeat layouts.
- [Range Plan](https://www.fabra.com/features/range-plan): collection and commercial planning.
- [AI Tools](https://www.fabra.com/features/ai-tools): material/trim generation and image workflows.
- [What's in Fabra V2](https://www.fabra.com/resources/article/whats-in-fabra-v2): August 6, 2026 release descriptions and beta/forthcoming distinctions.

The V2 article lists comments, custom size charts and several other tools as forthcoming. Moodboards are ambiguous because pricing mentions them separately. Those are not counted as verified current editor features here.

## Validation

### Earlier workspace/search batch

The following results belong to the earlier splitter and command-palette implementation. They **do not validate the subsequent Specs/All, contextual selection, Fabric or focus changes**.

- Svelte/workspace type checks passed with **0 errors and 0 warnings**.
- Production build and lint passed. The build retains its existing model-URL and bundle-size notices.
- **3 splitter browser tests passed:** real mouse resizing, rendered canvas dimensions, view/reload persistence, keyboard bounds/reset, unchanged pattern geometry and real emulated touch resizing in portrait.
- **3 command-palette browser tests passed:** focus containment and dismissal, drawing-key isolation, arrow/Enter workspace actions, parameter validation and successful command execution.
- An additional 390px probe passed the More → command palette → Fabric drawer focus transition and Escape return.
- **All 21 existing desktop/mobile workspace regressions passed** against an independently managed development server: four short-viewport control cases, ten desktop settings/document/navigation cases, and seven touch layout/library cases. Combined with the six new tests, **27 browser tests passed**. An earlier overlapping run lost its test-owned server; the complete rerun resolved those connection failures.

These UI checks do not establish physical-phone performance, hardware GPU accuracy or Fabra visual parity.

### Committed interface baseline

The following validation was recorded October 11, 2026 for the interface baseline committed as `59f370d`. It does not validate the subsequent Tech Pack, colorway, piece-artwork or docking implementation tranche.

- **82 unit-test files and 1,070 tests passed**, including contextual action eligibility, fabric assignment/removal, live POM values, unit/tolerance boundaries, missing references, and SSP/legacy import preservation.
- Svelte/workspace type checks passed with **0 errors and 0 warnings**; lint, production build and `git diff --check` passed. Existing model-URL and bundle-size build notices remain.
- **60 distinct desktop/touch browser scenarios passed across the complete run and targeted reruns.** This includes 18 new contextual/Fabric/Specs/focus cases and 42 existing workspace, splitter, palette, drawing, edge-edit, material-source, persistence and SSP export cases. The complete run passed 56; the nine-case targeted rerun resolved three outdated generated-garment control-count expectations and the text deletion defect while rechecking all contextual actions and four actual garment-framing sizes. Browser failures were investigated rather than suppressed; text deletion now preserves the original constrained garment's full point/piece records, including grain metadata.
- Browser checks cover actual document mutations, undo/redo, autosave/reload, independent three-pane resizing, unique separator controls, missing annotation references, strict geometry preservation, keyboard ownership/focus return, viewport bounds and real emulated touch targets. The final text edit/undo extension also passed as a separate targeted rerun, preserving the same geometry contract on the original constrained garment.

The browser run uses Chromium and emulated touch; it does not establish physical-phone performance, hardware GPU accuracy, settled garment fit or Fabra visual parity. The capture still has 123 uncaptured dependency targets. The baseline is committed as `59f370d`.

### Subsequent feature tranche

Tech Pack document/export, named colorways, piece-bound raster artwork and configurable pane docking are integrated after the committed baseline. The October 11, 2026 checks for this implementation are recorded separately:

- **91 unit-test files and 1,137 tests passed**, including 67 additional cases for production values/export, appearance variants, raster placement/UV mapping, texture decoding/lifetimes, pane trees, malformed extension admission and combined document round trips.
- Svelte and workspace type checks passed with **0 errors and 0 warnings**; lint, production build and `git diff --check` passed. Existing model-URL and bundle-size build notices remain.
- **73 desktop/touch browser scenarios passed**: 13 new feature workflows and all 60 existing regression cases. The integrated 52-case run and the separate 21-case drawing/export regression run both completed without failures. Checks cover actual 2D/3D artwork pixels and rotation, exact OBJ geometry/UV preservation, colorway switching/repair/undo, offline HTML/CSV downloads, production unit conversion and costing, malformed-import isolation, stable docked canvas instances, persisted pane trees, single-commit resize undo, portrait touch controls and existing document/keyboard/export behavior.

Independent review found and corrected malformed optional-field admission, actual decoded-image dimension checks, active-colorway export freshness, costing overflow and external undo workspace restoration. Native JSON/SSP retains all four extensions together; legacy paired-conversion limitations remain described above. The first 3D artwork fixture sat below the avatar's torso camera, so its saved camera was corrected to frame the native flat piece; actual raster, OBJ, UV, checkpoint and canvas-identity assertions were retained.

These `2843784` checks do not validate the later completion tranche above. They do not expand reference coverage or establish physical fit or manufacturing readiness.

## Current completion tranche: final verification

The completion tranche passed **109 unit-test files / 1,239 tests**, clean type/lint checks, both static and Node builds, **134 distinct desktop/touch browser cases across the complete run and targeted reruns**, **24 distinct WebGPU browser cases across the full run and recovery**, and **five production sharing/detached cases against the compiled Node app**. Compiled HTTP authorization and actual process-restart persistence also passed. Current-document export/capture readiness, exact camera persistence, actual generated file/image content, canonical document/history and permission guards are included. The [completion checklist](completion-checklist.md#final-verification-record) records the exact run breakdown, WebGPU and compiled-server results, and remaining evidence boundaries. This record is committed together with the implementation; earlier baseline counts remain historical.
