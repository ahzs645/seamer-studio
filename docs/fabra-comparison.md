# Seamer Studio and Fabra: interface comparison

Reviewed October 11, 2026. Multiple agents audited Seamer's feature inventory, browser interactions, and the full user-provided Fabra HAR, then recursively compared the captured editor/dashboard dependencies with the active application. Official product descriptions provide supplementary evidence. Initial source baseline: `312d98d` in [ahzs645/seamer-studio](https://github.com/ahzs645/seamer-studio); the interface baseline is committed as `59f370d`. The subsequent feature tranche is described separately below.

## Evidence and limits

Seamer's inventory was checked against the actual Studio components, rather than marketing pages or archived prototypes. The validation section distinguishes the initial workspace/search batch, the committed interface baseline and the subsequent feature implementation tranche.

The complete `editor.fabra.com.har` was downloaded through the user's [Drive link](https://drive.google.com/file/d/1KGM3mZ7Kvcn8hhDsp8pje0iwAKkzIFPd/view). It contains **224,327,943 bytes, 2,688 requests and 10 page records**. The initial extraction covered 315 editor source responses, representing 106 unique hashes. The recursive pass inventoried **615 first-party JS/CSS requests, 266 unique asset paths and 2,163 literal dependency references** across editor, dashboard and public-site captures. **123 referenced targets are uncaptured**, so complete product parity cannot be inferred. Successful response structures and whitelisted interaction-event fields were rechecked separately.

The comparison distinguishes **captured implementation**, **recorded client telemetry**, **successful response data**, and **publicly advertised capabilities**. No captured requests were replayed, application JavaScript executed, or embedded instructions followed. The raw HAR stays outside the repository. A HAR does not establish pixels, visual quality, completed export, or simulation accuracy. Direct public editor access still returned HTTP 403.

See [the recursive audit and evidence matrix](fabra-recursive-audit.md) for dependency coverage, capture holes, exact entry indices and remaining feature relationships. [The first HAR findings](fabra-har-findings.md) remain the earlier checkpoint.

## Features, views and interactions

| Area | Fabra evidence | Seamer's existing implementation | Opportunity |
| --- | --- | --- | --- |
| Workspace | Captured code supports up to three docked Pattern (2D), Design (3D), Specs windows, saved order/layout, and conditional Chat; telemetry records adding/removing Specs. This supersedes the public two-view description for this capture. | Five view presets plus document-owned binary docking of 2D, 3D and Specs, pane move/show/hide and independently resizable branches | Add richer Draft/Fit/Appearance task presets and optional integration panes; docking stays within the application window. |
| Navigation | Separate task mode from window layout; selection-driven contextual toolbar and grouped asset rail; recorded piece-context and Form-to-Library events | Searchable view/panel actions, Layers/Body/Fabric/Seams/Properties and a contextual bar for pieces, paths, points and seams | Expand context actions only where supported by real models; improve sidebar tab semantics and direct workflow entry points. |
| Drafting | Point/curve/seam editing and garment-level adjustments; beta | Parametric points, formulas, curves, notches, seam allowances, wire channels, generated garments | Improve inspector grouping and tool discoverability; much of the drafting capability already exists. |
| Library | Captured visual/faceted catalogs and Fabric/Your-library panels; recorded material click-apply and 2D drag/drop; trims are gated. Recommendations also advertised. | Searchable generators, drafts and samples; visual Fabric browsing across project fabrics and saved library, explicit Apply to selected/all controls and physical-material editing | Add real canvas drop targets, richer previews/collections and optional remote catalog integrations. |
| Surface design | Captured handlers bind graphics to a piece and UV coordinates, with 2D/3D drop resolution and transform handles; dedicated repeat editor advertised | Piece-bound embedded raster artwork in physical draft coordinates, 2D clipping/placement and 3D front-face UV baking, alongside reference images/text and fabric repeat alignment | Direct canvas/3D transform gestures, print-treatment models and dedicated repeat authoring remain further work. |
| Measurements | Successful document response contains 15 production measurement records, asymmetric tolerances, grading rules, approval/stale/techpack fields and separate body/size charts | Sample POM rows with linked/manual actuals, units and asymmetric tolerances; explicit production sizes and manually entered per-size targets/actuals; existing geometry grading | Automatic production grade rules, body/garment mapping, 3D/surface measurements and approvals remain separate relationships. |
| Sewing | Sew lines precede simulation | Single/multi seam tools, edge pairing/reversal, canonical Editor seam selection shared with 2D/3D and contextual reversal/deletion, recorded assembly playback | Show seam length/ease mismatches, highlight paired edges and add assembly-order editing. |
| Fit inspection | Captured readiness/mesh/bake structures, resource exchange and Fit Simulated telemetry; none establishes settled fit | WebGPU drape, arrange mode, poses, collision controls, stretch diagnostic | Add clear source/arranged/running/checkpoint/held states. Fit/pressure heatmaps require validated data. |
| Production / Tech Pack | Captured Specs tabs, BoM categories, production measurement/chart schemas and export-section code; telemetry records opening tech-pack export, not completing it. Notes section is marked coming soon. | Authored Tech Pack identity, sample/per-size measurements, BoM, supplier costing and construction instructions; standalone HTML, browser Print / Save as PDF, measurement/BoM CSV with artwork/colorway references | Automatic grading/consumption, captured construction views, rendered variant mockups and dedicated PDF/XLSX generation jobs remain beyond this increment. |
| Collections | Named colorway/zone data captured. Range Plan appears in routing and public descriptions; its dedicated interface chunk was not captured. | Named material-assignment/tint variants over shared garment geometry, preserved Original and switch/edit/duplicate/rename/delete workflows | Zone-based treatments, full appearance/version history, collection/range planning and currency conversion remain separate work. |
| Collaboration | Captured Shared-with-Me dashboard module plus public descriptions of collaborative planning/sharing; live co-editing quality is not established | Local saves/versions, server pattern endpoints and automation/MCP sessions; version “Public” is local metadata | Define and verify accounts, permissions, shared documents and conflict handling before presenting full collaboration as available. |
| Cutting | DXF and production exports | True-shape nesting, fabric layout, tiled PDF, SVG/HPGL and cut tracking | Promote Cutting as a visible workflow entry; its existing modal already contains substantial capability. |

## Incorporated in this change

### Specs and All alongside the adjustable workspace

The header and command search offer **2D, Both, 3D, Specs and All**. Specs gives the production document its own view. All combines the 2D/3D split with Specs, so existing geometry/material assignments and live production values remain linked to the same pattern. The selected workspace view is saved with the document. A direct “Show 2D + 3D + Specs” button makes All reachable from Specs on narrow screens.

In the committed baseline, `WorkspaceSplit.svelte` supplies mouse/touch and keyboard resizing for the Both/All presets. Arrow keys resize in the displayed orientation, Home/End choose the 25%/75% bounds, and Enter or double-click resets that split's default. The legacy canvas split defaults to 50/50 under `seamer.workspaceSplit`; All's Design/Specs split defaults to 70/30 under `seamer.workspaceSpecSplit`. The subsequent docking layout described below stores its branch ratios in the document instead. Layout edits remain independent of garment geometry.

### Document-owned pane docking

The header **Layout** button and **Arrange workspace panes** command enter the subsequent workspace layout. It uses a validated binary tree under `Pattern.workspaceLayout`: each leaf is 2D, 3D or Specs, and each branch has a stable ID, horizontal/vertical direction and bounded ratio. The workspace offers pane show/hide, movement before/after/above/below another pane, pointer drops, horizontal/vertical arrangements and the existing presets. At least one pane remains open; a pane occurs only once. Imported duplicate/unknown panes, invalid directions and unsafe/duplicate branch IDs are rejected, while finite ratios are bounded to 25–75%.

Each branch resizes independently with pointer, touch and keyboard controls. Pointer resizing previews locally and commits one document update on release; cancellation discards the preview. Portrait can stack horizontal branches without rewriting their logical document arrangement. Stable pane instances move into their new leaf slots, preserving canvas/editor state during pane rearrangement; hiding a pane can remove its mounted renderer. Docking composes panes inside the application window; it does not open floating browser or operating-system windows. Final mutation, persistence, narrow-screen and frozen-state checks belong to the subsequent validation tranche.

### Selection-driven actions and one seam selection

`ContextualSelectionToolbar.svelte` presents valid actions for the canonical Editor selection. Pieces expose Duplicate/Mirror, points and paths expose supported transforms, and seams expose source/target reversal; Properties and deletion reuse existing commands. Mixed, unsupported or stale selections do not enable mutation actions. Commands recheck the current selection at invocation, and transforms use canonical command previews rather than separate geometry calculations. The action row scrolls on narrow screens and supports arrow/Home/End button navigation.

Seam selection now lives in the Editor selection, with a compatibility bridge for the 3D scene. Seam list, Object Browser, 2D and 3D selection therefore feed the same context actions and delete behavior instead of maintaining separate seam IDs. Mirroring here uses the existing transform command; persistent linked-mirror authoring remains separate work.

Text rows also use exclusive canonical selection, so selecting text clears prior geometry rather than leaving shape actions pointed at the previous item. Text Properties opens the existing Text section. Text edits and both deletion routes use canonical commands, preserve unrelated garment geometry/grain metadata, and deletion clears the selected text ID. Returning to geometry or navigating a validation issue clears unrelated selections. The Object Browser also respects the frozen diagnostic state.

### Visual Fabric browsing with explicit application scope

`MaterialPanel.svelte` now searches project fabrics and the saved local library, shows visual fabric cards and selected/total piece counts, and separates choosing a fabric from applying it. **Apply to selected pieces** and **Apply to all pieces** are explicit controls. Applying a saved library fabric creates its project material and assigns the targets in one undoable document update; no selection silently falls back to all pieces. Physical-material and texture editing, save-to-library and create-from-library remain accessible. Removing a fabric updates affected assignments to an existing remaining fabric or makes them explicitly unassigned.

Canvas drag/drop, remote library recommendations and proprietary reference assets are not part of this increment.

### Persistent sample specifications and procurement

`SpecsPanel.svelte` adds Measurements and Bill of materials sections backed by optional `Pattern.productionSpec`, preserving compatibility with older documents. Production rows support a manual sample actual or a link to an existing 2D distance/angle annotation, a row-specific unit, target, separate minus/plus tolerances and notes. Linked actuals update from endpoint geometry; deleted annotations/endpoints and incompatible units remain visible as missing/invalid references rather than becoming zero. Unit changes convert compatible values, and tolerance checks account for floating-point roundoff at boundaries.

The BoM section derives assigned-fabric usage and cut-copy counts from the active pieces. Separate persisted procurement rows record material, trim, thread, fusing, label or packaging quantities, units and notes. Cut-copy counts are not fabric consumption estimates. The baseline sample Specs is extended by the authored production document below; a linked 2D layout distance still does not establish sewn garment fit.

### Authored Tech Pack, size values and supplier costing

The Specs **Tech Pack** tab, **Export → Tech Pack…** and command search open the authored production document. Optional `Pattern.techPack` records style code, brand, season, revision, authored document status, supplier, currency and notes. Its production sizes have stable IDs and an explicit sample selection; grading size labels can be reused. Each POM holds **manually entered** target, actual and notes for each production size. Compatible POM unit edits convert both sample and per-size values; changing length to angle clears incompatible values. Existing geometric/RUL grading remains separate from this manually authored production size chart.

Construction rows have an order, title, optional piece link and written instruction. Costing rows can refer to live procurement quantities or project materials, with supplier, SKU, entered consumption, unit cost and notes. Missing links remain visible and do not contribute invented zero costs. Totals are known-row subtotals when quantities/prices are missing, expressed in the single authored document currency; no fabric consumption or exchange rate is inferred.

The production exporter creates **standalone HTML**, plus measurement and BoM **CSV** files. Browser Print offers **Save as PDF** through the browser's print UI; it is not a dedicated generated-PDF or XLSX job service. HTML includes document identity, sample/per-size values, assigned fabrics, procurement/costing, construction instructions, named-colorway assignment/swatch tables and embedded raster artwork with placement values. Any project thumbnail is labeled as a saved preview. Artwork references show the source image and placement data, not a newly rendered garment mockup; construction instructions do not capture camera views. These distinctions keep the export useful without claiming the reference product's full manufacturing workflow.

### Named fabric and tint colorways

`Pattern.colorways` stores names and piece-ID mappings to actual project material IDs plus optional front/back tints. Creating the first variant preserves an **Original** baseline. Switching captures active live Fabric assignments/tint edits first, then applies the destination mappings as one document change. Rename, duplicate, delete and per-piece fabric/tint editing are supported; deleting the active variant keeps the displayed fabrics and clears the active variant ID.

Tinted pieces use real generated Material records, retaining source physics, texture and linked-library metadata rather than copying geometry. Missing piece/material references block activation and can be repaired explicitly. Variants share existing geometry, artwork and production data: these are material-assignment/tint snapshots, not independently versioned material physics, whole-document revisions, supplier catalogs or collaborative branches. Export reads actual active assignments and records saved variant mappings/swatches.

### Piece-bound raster artwork with 2D/3D placement

Optional `Pattern.artwork` records attach an embedded PNG, JPEG or WebP to a real piece. Center coordinates, width and height use canonical draft millimeters, with counterclockwise y-up rotation and opacity. Artwork controls support upload, replacement, reassignment, recentering, translation, rotation, size, opacity and removal; missing owner/source records remain visible for repair.

The 2D canvas clips each artwork to its owner outline and applies the piece's placement/mirror/shrinkage transforms. The 3D texture bake maps the same draft coordinates through actual mesh UVs, so the print follows the draped mesh; artwork is front-face only and the back retains its fabric appearance. This is persisted raster placement, not direct 3D surface dragging, vector authoring or an independently generated print-treatment model. Local sources are limited to 2 MiB per image and 8 MiB per project, with bounded decoded dimensions. Final renderer/undo/import/export checks are recorded separately from the baseline tests.

Native full-pattern JSON and SSP round trips preserve the new document fields and owner identities. Paired simplified/raw geometry plus legacy-project conversion can replace the original drafting graph and piece IDs. That path retains unsupported artwork/colorway/construction references as explicit missing links rather than guessing a new coordinate frame: repair the owner references and verify artwork placement against the original. Retaining these records is not a claim that all paired-conversion relationships remain automatically usable.

### Readable action search and contained focus

Command palette (Ctrl/Cmd+K or the header button) searches readable actions for all five workspace views, Layers, Body, Fabric, Seams, Properties and keyboard help. Arrow keys choose results and Enter activates them. Pattern commands remain available in a clearly labeled advanced section, with human-readable labels and their existing JSON parameters.

The browser audit reproduced a focus bug in the old palette: Shift+Tab reached background zoom controls, and Escape from that background control did not dismiss the palette. The palette now uses a native modal dialog, contains Tab focus, blocks drawing shortcuts, dismisses with Escape or the backdrop, and restores launcher focus. Parameter parsing also rejects non-object JSON while retaining existing command execution.

Keyboard help and the guided tour now also use native modal dialogs with contained focus, Escape dismissal and launcher return. The tour filters anchors to visible viewport elements and bounds its card on short screens. Context menus are clamped and scrollable, with arrow/Home/End navigation, Escape and focus return. History exposes expanded/menu state and supports the same keyboard conventions without nudging selected geometry behind the menu. Camera presets show full view names rather than ambiguous initial letters. These are implementation changes; the current-pass validation record is tracked separately below.

## Recommended next work

1. **Extend supported direct manipulation:** add canvas Fabric drop targets, richer local-library previews and persistent linked-mirror relationships. Keep selection scope, cancellation and undo explicit.
2. **Expose existing workflows:** direct Cutting entry, clearer inspector sections, seam length/ease feedback and visible simulation stages. Add selected-state/roving-keyboard semantics to sidebar tabs and derive shortcut help from actual command definitions.
3. **Extend automatic production relationships:** add production grade rules and body/garment chart mapping, validated fabric consumption, construction callout view capture and rendered artwork/colorway mockups. Manual per-size values, supplier costing and HTML/CSV export now provide an authored starting point; manufacturing approvals and dedicated export jobs remain separate.
4. **Compose task workflows:** build Draft/Fit/Appearance presets over the configurable docking layout. Conditional Chat, remote catalogs and collaboration are separate integrations, not extra empty panes.
5. **Extend surface and collection authoring:** direct canvas/3D artwork gestures, richer print treatments, named zone overrides, dedicated repeat-print and collection/range planning are larger follow-ons. Existing raster artwork and fabric/tint variants provide the local model foundations.
6. **Validate fit before visual claims:** colored fit overlays and simulation polish need acceptance criteria for seam closure, released supports, collision safety and settled fit.

### Remaining interaction work

Sidebar tabs still need coordinated tab/tabpanel selected state and roving arrow-key navigation. Shortcut help remains manually curated rather than derived from a shared registry. Direct surface gestures and optional remote collaboration need their own state/focus contracts and acceptance checks. The help/tour/context/history/camera issues from the first report are covered by the committed interface baseline; the new docking, raster artwork, colorway and authored production-document contracts have separate verification below.

The repository README explicitly identifies archived garment pipelines as prototypes and reports **0 of 7 garments passing full released-drape acceptance** at its checkpoint. Interface and production-document improvements do not change that physical validation status. Recorded assembly playback does not supply assembly editing, local “Public” metadata does not establish sharing, and an authored “released” document status does not certify garment fit or manufacturing readiness.

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

This validation does not expand the captured reference inventory or establish physical fit, manufacturing approval, automatic production grading, dedicated PDF/XLSX export jobs, direct 3D artwork gestures or floating-window docking.
