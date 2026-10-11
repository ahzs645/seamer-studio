# Seamer Studio and Fabra: interface comparison

Reviewed October 11, 2026. Multiple agents audited Seamer's feature inventory, browser interactions, and the full user-provided Fabra HAR, then recursively compared the captured editor/dashboard dependencies with the active application. Official product descriptions provide supplementary evidence. Seamer source baseline: `312d98d` in [ahzs645/seamer-studio](https://github.com/ahzs645/seamer-studio); current local changes are described below.

## Evidence and limits

Seamer's inventory was checked against the actual Studio components, rather than marketing pages or archived prototypes. The validation section distinguishes the earlier verified batch from the current implementation tranche.

The complete `editor.fabra.com.har` was downloaded through the user's [Drive link](https://drive.google.com/file/d/1KGM3mZ7Kvcn8hhDsp8pje0iwAKkzIFPd/view). It contains **224,327,943 bytes, 2,688 requests and 10 page records**. The initial extraction covered 315 editor source responses, representing 106 unique hashes. The recursive pass inventoried **615 first-party JS/CSS requests, 266 unique asset paths and 2,163 literal dependency references** across editor, dashboard and public-site captures. **123 referenced targets are uncaptured**, so complete product parity cannot be inferred. Successful response structures and whitelisted interaction-event fields were rechecked separately.

The comparison distinguishes **captured implementation**, **recorded client telemetry**, **successful response data**, and **publicly advertised capabilities**. No captured requests were replayed, application JavaScript executed, or embedded instructions followed. The raw HAR stays outside the repository. A HAR does not establish pixels, visual quality, completed export, or simulation accuracy. Direct public editor access still returned HTTP 403.

See [the recursive audit and evidence matrix](fabra-recursive-audit.md) for dependency coverage, capture holes, exact entry indices and remaining feature relationships. [The first HAR findings](fabra-har-findings.md) remain the earlier checkpoint.

## Features, views and interactions

| Area | Fabra evidence | Seamer's existing implementation | Opportunity |
| --- | --- | --- | --- |
| Workspace | Captured code supports up to three docked Pattern (2D), Design (3D), Specs windows, saved order/layout, and conditional Chat; telemetry records adding/removing Specs. This supersedes the public two-view description for this capture. | 2D, 3D, Both, Specs and All; All combines both canvases with Specs using two independently persisted resizable splits | Add useful task presets and arbitrary pane docking/reordering as separate improvements. |
| Navigation | Separate task mode from window layout; selection-driven contextual toolbar and grouped asset rail; recorded piece-context and Form-to-Library events | Searchable view/panel actions, Layers/Body/Fabric/Seams/Properties and a contextual bar for pieces, paths, points and seams | Expand context actions only where supported by real models; improve sidebar tab semantics and direct workflow entry points. |
| Drafting | Point/curve/seam editing and garment-level adjustments; beta | Parametric points, formulas, curves, notches, seam allowances, wire channels, generated garments | Improve inspector grouping and tool discoverability; much of the drafting capability already exists. |
| Library | Captured visual/faceted catalogs and Fabric/Your-library panels; recorded material click-apply and 2D drag/drop; trims are gated. Recommendations also advertised. | Searchable generators, drafts and samples; visual Fabric browsing across project fabrics and saved library, explicit Apply to selected/all controls and physical-material editing | Add real canvas drop targets, richer previews/collections and optional remote catalog integrations. |
| Surface design | Captured handlers bind graphics to a piece and UV coordinates, with 2D/3D drop resolution and transform handles; dedicated repeat editor advertised | Images/text in drafting, material/texture settings and fabric-repeat matching in cutting | Piece-bound graphic placement needs coordinate/renderer/export work. A dedicated repeat editor is a further feature. |
| Measurements | Successful document response contains 15 production measurement records, asymmetric tolerances, grading rules, approval/stale/techpack fields and separate body/size charts | Distance/angle annotations plus persistent production POM rows with manual or annotation-linked actuals, row units, targets and asymmetric tolerances; existing body variables, sizes and grading | Add production per-size targets/grade rules, 3D/surface measurement references and approvals; preserve body/garment chart distinctions. |
| Sewing | Sew lines precede simulation | Single/multi seam tools, edge pairing/reversal, canonical Editor seam selection shared with 2D/3D and contextual reversal/deletion, recorded assembly playback | Show seam length/ease mismatches, highlight paired edges and add assembly-order editing. |
| Fit inspection | Captured readiness/mesh/bake structures, resource exchange and Fit Simulated telemetry; none establishes settled fit | WebGPU drape, arrange mode, poses, collision controls, stretch diagnostic | Add clear source/arranged/running/checkpoint/held states. Fit/pressure heatmaps require validated data. |
| Production / Tech Pack | Captured Specs tabs, BoM categories, production measurement/chart schemas and export-section code; telemetry records opening tech-pack export, not completing it. Notes section is marked coming soon. | Specs Measurements and Bill of materials sections; live assigned-fabric usage and manual procurement rows alongside pattern export, versions and cutting | Add supplier/costing relationships, construction callouts, artwork and production export; the current Specs increment is not a full Tech Pack. |
| Collections | Named colorway/zone data captured. Range Plan appears in routing and public descriptions; its dedicated interface chunk was not captured. | Individual patterns and local libraries/versions; no colorway or collection-planning model found | Add colorway variants first; plan collection/costing workflows separately, without claiming the capture verifies Range Plan UI. |
| Collaboration | Captured Shared-with-Me dashboard module plus public descriptions of collaborative planning/sharing; live co-editing quality is not established | Local saves/versions, server pattern endpoints and automation/MCP sessions; version “Public” is local metadata | Define and verify accounts, permissions, shared documents and conflict handling before presenting full collaboration as available. |
| Cutting | DXF and production exports | True-shape nesting, fabric layout, tiled PDF, SVG/HPGL and cut tracking | Promote Cutting as a visible workflow entry; its existing modal already contains substantial capability. |

## Incorporated in this change

### Specs and All alongside the adjustable workspace

The header and command search offer **2D, Both, 3D, Specs and All**. Specs gives the production document its own view. All combines the 2D/3D split with Specs, so existing geometry/material assignments and live production values remain linked to the same pattern. The selected workspace view is saved with the document. A direct “Show 2D + 3D + Specs” button makes All reachable from Specs on narrow screens.

`WorkspaceSplit.svelte` supports mouse/touch dragging and keyboard resizing. Use Left/Right in side-by-side layout or Up/Down in portrait; Home/End choose the 25%/75% bounds, and Enter or double-click resets to that split's default. The canvas split defaults to 50/50 and persists under `seamer.workspaceSplit`; All's Design/Specs split defaults to 70/30 and persists independently under `seamer.workspaceSpecSplit`. Portrait stacks the panes. Preferences change layout independently of pattern geometry and remain usable in memory if storage fails. Separators announce pane labels, orientation and percentages; resizing and Specs editing are guarded during frozen diagnostics. This nested split is a three-view layout, not arbitrary docking.

### Selection-driven actions and one seam selection

`ContextualSelectionToolbar.svelte` presents valid actions for the canonical Editor selection. Pieces expose Duplicate/Mirror, points and paths expose supported transforms, and seams expose source/target reversal; Properties and deletion reuse existing commands. Mixed, unsupported or stale selections do not enable mutation actions. Commands recheck the current selection at invocation, and transforms use canonical command previews rather than separate geometry calculations. The action row scrolls on narrow screens and supports arrow/Home/End button navigation.

Seam selection now lives in the Editor selection, with a compatibility bridge for the 3D scene. Seam list, Object Browser, 2D and 3D selection therefore feed the same context actions and delete behavior instead of maintaining separate seam IDs. Mirroring here uses the existing transform command; persistent linked-mirror authoring remains separate work.

Text rows also use exclusive canonical selection, so selecting text clears prior geometry rather than leaving shape actions pointed at the previous item. Text Properties opens the existing Text section. Text edits and both deletion routes use canonical commands, preserve unrelated garment geometry/grain metadata, and deletion clears the selected text ID. Returning to geometry or navigating a validation issue clears unrelated selections. The Object Browser also respects the frozen diagnostic state.

### Visual Fabric browsing with explicit application scope

`MaterialPanel.svelte` now searches project fabrics and the saved local library, shows visual fabric cards and selected/total piece counts, and separates choosing a fabric from applying it. **Apply to selected pieces** and **Apply to all pieces** are explicit controls. Applying a saved library fabric creates its project material and assigns the targets in one undoable document update; no selection silently falls back to all pieces. Physical-material and texture editing, save-to-library and create-from-library remain accessible. Removing a fabric updates affected assignments to an existing remaining fabric or makes them explicitly unassigned.

Canvas drag/drop, remote library recommendations and proprietary reference assets are not part of this increment.

### Persistent sample specifications and procurement

`SpecsPanel.svelte` adds Measurements and Bill of materials sections backed by optional `Pattern.productionSpec`, preserving compatibility with older documents. Production rows support a manual sample actual or a link to an existing 2D distance/angle annotation, a row-specific unit, target, separate minus/plus tolerances and notes. Linked actuals update from endpoint geometry; deleted annotations/endpoints and incompatible units remain visible as missing/invalid references rather than becoming zero. Unit changes convert compatible values, and tolerance checks account for floating-point roundoff at boundaries.

The BoM section derives assigned-fabric usage and cut-copy counts from the active pieces. Separate persisted procurement rows record material, trim, thread, fusing, label or packaging quantities, units and notes. Cut-copy counts are not fabric consumption estimates. These sample specifications do not supply production per-size grading, construction callouts, artwork placements or full Tech Pack export. A 2D layout distance also does not establish sewn garment fit.

### Readable action search and contained focus

Command palette (Ctrl/Cmd+K or the header button) searches readable actions for all five workspace views, Layers, Body, Fabric, Seams, Properties and keyboard help. Arrow keys choose results and Enter activates them. Pattern commands remain available in a clearly labeled advanced section, with human-readable labels and their existing JSON parameters.

The browser audit reproduced a focus bug in the old palette: Shift+Tab reached background zoom controls, and Escape from that background control did not dismiss the palette. The palette now uses a native modal dialog, contains Tab focus, blocks drawing shortcuts, dismisses with Escape or the backdrop, and restores launcher focus. Parameter parsing also rejects non-object JSON while retaining existing command execution.

Keyboard help and the guided tour now also use native modal dialogs with contained focus, Escape dismissal and launcher return. The tour filters anchors to visible viewport elements and bounds its card on short screens. Context menus are clamped and scrollable, with arrow/Home/End navigation, Escape and focus return. History exposes expanded/menu state and supports the same keyboard conventions without nudging selected geometry behind the menu. Camera presets show full view names rather than ambiguous initial letters. These are implementation changes; the current-pass validation record is tracked separately below.

## Recommended next work

1. **Extend supported direct manipulation:** add canvas Fabric drop targets, richer local-library previews and persistent linked-mirror relationships. Keep selection scope, cancellation and undo explicit.
2. **Expose existing workflows:** direct Cutting entry, clearer inspector sections, seam length/ease feedback and visible simulation stages. Add selected-state/roving-keyboard semantics to sidebar tabs and derive shortcut help from actual command definitions.
3. **Extend production relationships:** add per-size POM targets and grade rules, body/garment chart links, supplier/costing fields, construction callouts and artwork. Preserve the current sample Specs as an honest supported increment, then add production export against those relationships.
4. **Compose further workspaces:** introduce Draft/Fit/Appearance task presets and arbitrary docking/reordering. All already combines Pattern, 3D and Specs with independent sizing; conditional Chat is a separate product integration.
5. **Add variants and surface authoring:** named colorways and piece-local graphics with synchronized 3D preview; dedicated repeat-print and collection/costing workflows are larger follow-ons.
6. **Validate fit before visual claims:** colored fit overlays and simulation polish need acceptance criteria for seam closure, released supports, collision safety and settled fit.

### Remaining interaction work

Sidebar tabs still need coordinated tab/tabpanel selected state and roving arrow-key navigation. Shortcut help remains manually curated rather than derived from a shared registry. Full docking, piece-bound graphics, production per-size editing and optional remote collaboration each need their own state/focus contracts and acceptance checks. The help/tour/context/history/camera issues from the first report have current-pass implementations described above; they should no longer be listed as untouched source findings.

The repository README explicitly identifies archived garment pipelines as prototypes and reports **0 of 7 garments passing full released-drape acceptance** at its checkpoint. Interface improvements do not change that physical validation status. Likewise, an existing recorded assembly player is not an assembly editor, local “Public” metadata is not sharing, and a material panel is not a full Tech Pack.

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

### Current implementation tranche

Validation completed October 11, 2026 against the local implementation:

- **82 unit-test files and 1,070 tests passed**, including contextual action eligibility, fabric assignment/removal, live POM values, unit/tolerance boundaries, missing references, and SSP/legacy import preservation.
- Svelte/workspace type checks passed with **0 errors and 0 warnings**; lint, production build and `git diff --check` passed. Existing model-URL and bundle-size build notices remain.
- **60 distinct desktop/touch browser scenarios passed across the complete run and targeted reruns.** This includes 18 new contextual/Fabric/Specs/focus cases and 42 existing workspace, splitter, palette, drawing, edge-edit, material-source, persistence and SSP export cases. The complete run passed 56; the nine-case targeted rerun resolved three outdated generated-garment control-count expectations and the text deletion defect while rechecking all contextual actions and four actual garment-framing sizes. Browser failures were investigated rather than suppressed; text deletion now preserves the original constrained garment's full point/piece records, including grain metadata.
- Browser checks cover actual document mutations, undo/redo, autosave/reload, independent three-pane resizing, unique separator controls, missing annotation references, strict geometry preservation, keyboard ownership/focus return, viewport bounds and real emulated touch targets. The final text edit/undo extension also passed as a separate targeted rerun, preserving the same geometry contract on the original constrained garment.

The browser run uses Chromium and emulated touch; it does not establish physical-phone performance, hardware GPU accuracy, settled garment fit or Fabra visual parity. The capture still has 123 uncaptured dependency targets. Full docking, per-size production POMs, piece-bound artwork, named colorways, full Tech Pack export and collaboration remain explicit next work. Changes are local and uncommitted.
