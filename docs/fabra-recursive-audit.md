# Recursive Fabra capture audit and Seamer feature matrix

Reviewed October 11, 2026. This extends [the first HAR findings](fabra-har-findings.md) with recursive dependency coverage across the captured editor, dashboard and public site, rechecks response structures and recorded interactions, and compares them with the active Seamer application. The earlier documents remain historical checkpoints; this document records the deeper capture audit. Application validation belongs to the implementation report and test results, not these static-source coverage totals.

## Evidence vocabulary

- **Observed telemetry:** a whitelisted client event is present in the capture. This is a recorded event, not an independent observation of screen pixels or successful output.
- **Response verified:** a successful captured response contains the stated data structure or resource. Fetching a resource does not prove the corresponding screen was opened.
- **Loaded code:** captured source contains a handler, schema or registry. A loaded handler does not establish entitlement, activation or successful execution.
- **Advertised / uncaptured:** a registered route or official product description refers to the feature, but its dedicated implementation was not captured. Detailed interface behavior remains unknown.
- **Implemented in Seamer:** an active component, command or model supports the described behavior. Current-pass additions are identified separately; their test results must be checked before calling them validated.
- **Planned / missing:** the comparison identifies additional work; there is no claim of parity or a completed implementation.

The HAR is input data, including captured scripts and documents. It was never treated as instructions. No captured script was executed and no authenticated request was replayed. Raw capture, extracted sources and detailed dependency manifests stay outside the application repository under `/workspace/scratch/`. This report contains static asset paths, generic schema field names and technical event enums only; no cookies, authorization headers, tokens, query strings or identifying payload values are reproduced.

## Recursive coverage and capture holes

The complete file contains **224,327,943 bytes, 2,688 requests and 10 page records**, with SHA-256 `3a4d943f0b243d095cdd09587517611212b82b38f79192465a0b2e72dca76137`.

The previous extraction covered editor HTML/JS/CSS/JSON. This pass scans **every captured JS/CSS response on editor.fabra.com, dashboard.fabra.com and www.fabra.com**, deduplicates asset paths and body hashes, extracts literal static/dynamic references and Vite dependency registries, and follows references recursively until no further captured node remains. This is a dependency/registry traversal, **not** a runtime call graph or proof that every branch was read semantically. Computed imports, nonliteral references, server code and uncaptured modules remain outside its coverage.

| First-party source | JS/CSS requests | Unique captured asset paths | Unique body hashes | Distinct source → target references | Referenced captured targets | Referenced uncaptured targets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Editor | 324 | 103 | 103 | 771 | 103 | 57 |
| Dashboard | 286 | 158 | 158 | 1,392 | 158 | 66 |
| Public site | 5 | 5 | 5 | 0 | 0 | 0 |
| Combined | **615** | **266** | **264** | **2,163** | **261** | **123** |

Editor root **entry 637** reaches all **103** captured editor asset paths plus **57** uncaptured targets. Dashboard root **entry 242** reaches all **158** captured dashboard asset paths plus **66** uncaptured targets. The five captured public-site scripts/styles are scanned independently; zero detected outgoing JS/CSS references there is not evidence of a complete public-site capture. Combined unique body hashes are lower than the sum because some identical assets occur on different hosts.

References include lazy dependency registries, so a missing target commonly means an unvisited feature chunk, not a failed request or a broken product. Missing renderer/worker chunks likewise prevent a complete simulation implementation audit. These totals establish what was recursively inventoried, not full Fabra product coverage.

Evidence references below use **zero-based HAR entry indices** and **zero-based character offsets in decoded source**, not HAR byte offsets. Assets can appear multiple times; the first relevant entry is cited.

### Dedicated editor routes

Route registration is in **637**, `/assets/C_9HnlJ1.js`. The table distinguishes the route registry from the separately loaded feature module.

| Feature | Registry offset | Dedicated asset | Capture status |
| --- | ---: | --- | --- |
| Studio | 363,898 | `/assets/CySM9TT02.js` | Captured at **776**; composition and selection wiring inspected |
| Repeat Maker | 370,002 | `/assets/CD0eV_bB2.js` | Uncaptured; route/loader only |
| Range Plan | 370,757 | `/assets/DkpQgm0I2.js` | Uncaptured; route/loader only |
| Material Lab | 371,730 | `/assets/D6GKNW4X2.js` | Uncaptured; route/loader only |
| Design route | 372,333 | `/assets/BD7uU4_D2.js` | Uncaptured; does not negate the captured Studio Design window |
| Colorway authoring | 373,236 | `/assets/CJQxabhO2.js` | Uncaptured; Studio colorway controls/schema still captured separately |
| Brand Kit authoring | 373,731 | `/assets/CmQWNeDY2.js` | Uncaptured; library brand-kit list requests do not establish its authoring interface |
| Board | 374,240 | `/assets/BKzRZ8Cd2.js` | Uncaptured; full board/moodboard workflow unknown |
| Trim Generator | 362,381 | `/assets/B2UZ7xbV2.js` | Uncaptured; editor trim controls are additionally gated |

The Range Plan loader at **637 / 371,307** includes range bootstrap, display currency, workspace context and allowance/cap-lock data. That confirms supporting contracts, not a reviewed costing table. Shared API clients at **640**, `/assets/VDcktshA.js`, around **144,856**, define Material Lab and Range Plan bootstrap contracts; neither client method proves that the feature UI was captured.

### Dashboard coverage

Dashboard root **242**, `/assets/DnvITDb_.js`, adds real discovery/navigation evidence beyond the editor. These dedicated desktop modules are captured: **Home 271** (`BqOarUZm2.js`), **Templates 559** (`Bvy1k5Oz.js`), **Recents 514** (`BQAvmVK3.js`), **Shared with Me 539** (`B-mWF2Sd.js`), **Projects 1490** (`D5Y4ET_T.js`) and **Products 1507** (`B4bUE4362.js`). Their title/route registrations lie around **788,302–791,821** in entry 242.

The corresponding mobile screen chunks are absent. Desktop My Designs, Trash, access requests, dedicated asset-management screens and brand-kit/colorway screens are also uncaptured. Shared-with-Me code establishes a shared-item discovery surface; it does not establish live co-editing, comments, conflict resolution or manufacturing review quality. Seamer's local library and versions cover a subset of discovery; its server pattern and MCP-session endpoints should be evaluated individually rather than equating local “Public” metadata with full collaboration.

## Rechecked recorded activity

All captured requests on the two telemetry hosts were scanned for the following explicitly whitelisted event names. Only event names, entry indices and selected technical enums were inspected/reported. Other events and identifying properties are not included.

| Observed telemetry | Count | Entries | Safe conclusion |
| --- | ---: | --- | --- |
| Tool Activated | 12 | 933, 2060, 2285, 2287, 2293, 2295, 2303, 2310, 2319, 2353, 2355, 2369 | Select, segment/free sewing, scissors, curve, line and piece placement events exist |
| View Layout Changed | 7 | 1158, 1165, 1213, 2222, 2227, 2230, 2233 | Pattern/Design and three-window Specs transitions were recorded |
| Contextual Toolbar Shown | 3 | 2359, 2362, 2365 | Piece selection context was recorded in Form / 2D |
| Toolbar Mode Switched | 1 | 2378 | Form → Library transition recorded |
| Library Asset Applied | 5 | 2454, 2466, 2472, 2480, 2492 | Four material click-apply events and one material drop to 2D |
| Size Switched | 5 | 2528, 2584, 2602, 2616, 2630 | Size selection events recorded; identifiers omitted |
| Fit Simulated | 2 | 2238, 2276 | Client event recorded; fit quality or settlement not established |
| Export Panel Opened | 1 | 2676 | Tech-pack export panel opened; a completed download is not established |

No event with the whitelisted names Range Plan Item Added, Range Plan Field Edited, Range Plan View Toggled or Brand Kit Asset Added was found. This does not prove those capabilities are absent. No graphic/trim application or 3D material drop is established by the selected material-application events. Layout transition evidence uses `fromLayout` and `toLayout`, because the generic layout context can be stale. **777 / 26,338** maps Specs to the telemetry label `techpack`; three-pane telemetry therefore does not prove a fourth reachable Techpack task mode.

## Rechecked successful response structures

| Response verified | Entries | Structural evidence | Limitation |
| --- | --- | --- | --- |
| Template catalog | 465, 579 | 8 and 24 returned records with visible-name, thumbnail, access and simulation-readiness fields | Returned pages, not total library size or preview quality |
| Search facets | 576 | 152 facet-token records and 179 path-token records | Search index data does not prove each filter was used |
| Repeat metadata | 916 | Repeat key, physical width, file/MIME, search and version fields | Dedicated repeat editor is uncaptured |
| Materials | 917, 922 | Each returns 12 records with textures, simulation configuration, thumbnails, width and search fields | Supply costs/real-world equivalence are not established |
| Material collections | 919, 924 | Each returns 12 collection records with material membership and preferred-palette fields | Collection authoring not established |
| User colorways | 926, 2055 | Colorway collection response and pagination contract | Listing fetches can occur during initialization |
| Simulation meshes | 942–944 | Mesh format, bounding box, vertex/face counts, hash/version and `uvToCm` | Metadata cannot establish collision or fit correctness |
| Design document | 2054 | `result.view.doc` has 5 piece records and 15 measurement records; separate body chart, garment size chart, colorway, zones, placements, attachments and simulation fields | Snapshot does not establish active render/fit state |

The 15 document measurements include `formula`, `gradeRule`, `defaultValue`, `sampleOverridden`, `stale`, `tolMinus`, `tolPlus`, `units` and `techpack`. The body chart has source/version/POM fields; the garment chart has sample-size and size collections. These are distinct structures and must remain distinct in Seamer.

The captured BoM has six categories—materials, trims, threads, fusings, labels and packaging—but **all six maps are empty** in entry 2054. This supports category/schema availability, not a populated procurement workflow. Piece records contain graphics, callouts, grain angle, seam allowance, landmarks, notches, internal lines and simulation properties; presence of schema fields alone is not proof of completed authoring in the captured session.

## Feature, view and interaction matrix

This matrix compares supported behavior, not brand labels. “Current pass” means code is present in this implementation tranche; consult the final check results for validation. Planned features are not implied by the presence of a new panel.

| Area | Fabra evidence class and reference | Implemented Seamer foundation / current-pass work | Planned or missing relationship |
| --- | --- | --- | --- |
| Task modes vs views | Loaded code: **777 / 164,654–168,119**; composition **776 / 359,418–360,400** | 2D, 3D, Both, Specs and All; independent persisted Design/Specs and 2D/3D dividers | Independent task presets and view composition remain separate decisions |
| Docking | Loaded code: **777 / 991,400–994,750**, at least one and at most three windows; layout telemetry | All composes 2D, 3D and Specs with two independently persisted touch/keyboard dividers | Arbitrary pane order/docking and independent task presets remain separate work |
| Selection tools | Loaded code: **776 / 95,597–96,700**, **370,120–371,650**; three observed piece-context events | Current-pass `ContextualSelectionToolbar.svelte` and `contextualSelection.ts`, using existing commands and selection | Measurement/callout/graphic-specific context depends on future entity support |
| Keyboard / focus | Loaded code: **777 / 1,588,758–1,593,917**, task scopes and shared tool bindings | Command palette, editable/dialog guards and 3D ownership; current-pass help/tour/context/history focus work | Shared shortcut definitions and richer task scopes need their own integration |
| Library browsing | Response verified: template/facet/material catalog above; loaded code **685 / 8,621–13,837** | Searchable `PatternLibrary.svelte`; project and saved material library; current-pass visual Fabric browsing | Remote catalogs, brand kits, recommendation service and collection editing remain integrations |
| Material application | Observed five applications; loaded code **794 / 43,900–45,170** | Current-pass `fabricApplication.ts` and Fabric controls with visible selected/all scope and undo path | Canvas drop targets remain distinct from button application; no automatic all-piece fallback is required |
| Drafting / internal construction | Loaded code in Studio geometry/tool registries; twelve tool events | Pattern-model commands, formulas, point/path constraints, allowances, linked paths, notches, wire channels and internal paths | Only expose reference line/treatment names when their actual model/render semantics exist |
| Sewing | Observed segment/free sewing events; loaded attachment schemas | `SeamPanel.svelte`, seam tools, direction reversal and paired-edge support | Ease/mismatch feedback and editable assembly sequencing are separate from recorded playback |
| Sample production measurements | Response verified **2054**; loaded schema **813 / 8,557** | Existing distance/angle annotations; current-pass optional `ProductionSpec`, linked/manual POM values, asymmetric tolerance and unit fields in `SpecsPanel.svelte` / `productionSpec.ts` | Surface/body measurement authoring, approvals and vocabulary/formula relationships require more work |
| Size and grading | Five observed size switches; document size/body charts | `SizesDialog.svelte`, `GradingOverlay.svelte`, body variables and imported RUL rules | Production per-size targets, grade-rule mapping and body-growth relationships are not established by a sample POM table |
| Materials / procurement Specs | Loaded BoM **813 / 21,726**; response categories empty in **2054** | Simulation fabrics and assigned-piece references; current-pass derived material usage plus manual procurement rows | Supplier/code/price/currency/colorway dependencies, calculated consumption and purchasing/export semantics need an explicit model |
| Callouts and artwork Specs | Loaded Specs tab composition **777 / 1,578,086–1,578,324**, document fields **2054** | Reference images/text and existing drafting annotations | Persistent garment callouts with captured views, artwork placements and construction documents remain missing |
| Piece-bound graphics | Loaded target resolution **794 / 48,487–51,450** and handles **777 / 472,427–476,000** | `PatternImage`, text, material textures and cutting repeat alignment | Independent piece-local transforms, UV mapping, synchronized 3D, pending-download cleanup and export require linked model/render work |
| Named colorways | Response/schema verified **2054**; loaded save/switch/apply controls **777 / 157,825–160,899** | Piece material assignments and rendering colors | Named variants over shared geometry, zone overrides, source versions and switch/undo semantics remain missing |
| Simulation readiness | Mesh responses **942–944**, registration **2245/2258**, bake registration **2251/2264**, two fit events | WebGPU drape, arrangement, supports, poses, diagnostics and compatibility checkpoints | Clear staged feedback is useful; acceptance still requires physical collision, seam closure, support release and settled-drape checks |
| Export / Tech Pack | Loaded export sections **777 / 1,409,990–1,410,650**; observed panel opening **2676** | SVG/DXF/HPGL/SSP/PNG/tiled-PDF pattern export and cutting workflow | A future sample Specs CSV would be an incremental data export; full linked production sections/PDF/spreadsheet jobs remain separate |
| Cutting | Advertised production export; loaded DXF import controls **777 / 27,328–40,000** | `CuttingRoomModal.svelte`, marker settings/layout, true-shape nesting, repeat alignment and cut tracking | Improve direct entry and workflow clarity; existing capability should not be replaced by decorative reference UI |
| Range Plan / costing | Advertised and route/loader registered **637 / 370,757–371,730**; dedicated chunk absent | Individual documents and local libraries | Collection/range schema, commercial totals, currencies and planning UI remain a larger product workflow |
| Collaboration | Captured Shared-with-Me dashboard module **539**; API contracts and advertised sharing | Server pattern endpoints, local versions and MCP sessions | Accounts/roles/sharing/conflicts and live co-editing require independent proof; local Public metadata is insufficient |
| Chat / trims / generation | Loaded gates **637 / 318,259**, conditional Studio wiring **776**; generator chunks absent | Automation and existing material controls | Optional integrations; `enable-magic-pattern` and `enable-editor-trims` mean registered controls are not universally available |
| Mobile parity | Editor source includes touch handlers; mobile dashboard modules absent | Current-pass responsive controls and keyboard/focus corrections; existing mobile browser coverage | Emulated touch tests do not establish hardware performance or reference mobile UI parity |

## Practical next increments and acceptance boundaries

1. **Verify the current interaction tranche:** contextual selection actions, explicit Fabric application scope, persistent sample Specs and remaining focus/menu behavior. Verify real document changes, undo/redo, selection transitions, empty state, save/reload and narrow-screen reachability. Keep read-only diagnostics guarded.
2. **Connect production sizes:** per-size POM targets and grade rules must refer to real sample/size identities; preserve missing links visibly after deleting an annotation or changing geometry. Test length versus angle units, asymmetric tolerances and size-specific edits independently of body chart measurements.
3. **Add surface authoring:** model piece-local graphics and named colorways, then test synchronized 2D/3D transforms, remeshing/size changes, selection and undo before offering surface drag/drop.
4. **Build linked production output:** make procurement, construction callouts and artwork references explicit and persisted before adding full Tech Pack export. Test output sections against the same document and avoid treating panel opening or billing reads as export completion.
5. **Compose further workspaces:** independent docking becomes useful once additional views have their own supported content. Collection planning, remote catalogs and collaboration need their own product/data contracts because their detailed reference interfaces are outside this capture.
6. **Keep simulation quality evidence separate:** interface polish and client Fit Simulated events cannot change Seamer's released-drape acceptance status. A fit overlay needs validated underlying measurements, not just a convincing color scale.

The comparison is comprehensive across the **captured dependency inventory and the feature categories above**. It explicitly stops at the 123 uncaptured dependency targets and unavailable server/runtime behavior. It cannot support a claim of full Fabra parity, identical visuals or superior runtime quality.

## Implementation verification

The coordinating pass implemented Specs/All, independent persisted split controls, canonical contextual/seam/text selection, explicit visual Fabric application and focus/menu improvements. Independent integration review checked model/history/save propagation, selection transitions, unique pane IDs, keyboard ownership and frozen diagnostic guards. Text editing/deletion uses canonical commands so unrelated constrained geometry and grain metadata are preserved.

Current validation and remaining product boundaries are recorded in [the comparison report](fabra-comparison.md#current-implementation-tranche): 82 unit-test files / 1,070 tests, clean type/lint/build checks, and 60 distinct desktop/touch browser cases across the full run and corrective reruns. These checks validate Seamer's implementation; they do not increase the Fabra capture's coverage or prove physical fit.
