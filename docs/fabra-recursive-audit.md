# Recursive Fabra capture audit and Seamer feature matrix

Reviewed October 11, 2026. This extends [the first HAR findings](fabra-har-findings.md) with recursive dependency coverage across the captured editor, dashboard and public site, rechecks response structures and recorded interactions, and compares them with the active Seamer application. The earlier documents remain historical checkpoints; this document retains the recursive capture inventory and updates the active Seamer implementation matrix for the completion tranche after `2843784`. Source availability and implementation verification remain separate evidence.

## Evidence vocabulary

- **Observed telemetry:** a whitelisted client event is present in the capture. This is a recorded event, not an independent observation of screen pixels or successful output.
- **Response verified:** a successful captured response contains the stated data structure or resource. Fetching a resource does not prove the corresponding screen was opened.
- **Loaded code:** captured source contains a handler, schema or registry. A loaded handler does not establish entitlement, activation or successful execution.
- **Advertised / uncaptured:** a registered route or official product description refers to the feature, but its dedicated implementation was not captured. Detailed interface behavior remains unknown.
- **Implemented in Seamer:** an active component, command or model supports the described behavior. Current-pass additions are identified separately; their test results must be checked before calling them validated.
- **Operating / evidence boundary:** configured providers, deployment requirements, conservative repair cases and unavailable reference/physical evidence are distinguished from implemented features.

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

This matrix compares supported behavior, not brand labels. The interface baseline is `59f370d` and the first production/colorway/artwork/docking tranche is `2843784`. The table now describes active completion-tranche workflows, with their operating boundaries. Historical and final verification remain separate in [the comparison report](fabra-comparison.md#validation). A reachable component or a prepared test is not itself a passed acceptance check.

| Area | Fabra evidence class and reference | Active Seamer completion-tranche behavior | Operating / evidence boundary |
| --- | --- | --- | --- |
| Task modes vs views | Loaded code: **777 / 164,654–168,119**; composition **776 / 359,418–360,400** | Draft/Fit/Appearance/Production/Cutting entries configure actual view/sidebar combinations; compact landscape exposes 44px task targets in More while other desktop/portrait layouts retain the bar; five legacy view presets and unique 2D/3D/Specs docking remain available | Task presets compose existing operations; changing a task does not establish successful simulation. |
| Docking | Loaded code: **777 / 991,400–994,750**, at least one and at most three windows; layout telemetry | Document-owned binary docking, pane movement/show/hide and independent pointer/touch/keyboard resizing; actual detached Draft/Garment/Specs browser panes | Detached windows require same-origin BroadcastChannel, a live main window and browser popup support; native OS docking parity is not claimed. |
| Selection tools | Loaded code: **776 / 95,597–96,700**, **370,120–371,650**; three observed piece-context events | Canonical contextual piece/path/point/seam actions, paired seam-edge highlighting and direct artwork handles in 2D/3D | Entity actions remain limited to supported models and recheck current selection and mutation ownership. |
| Keyboard / focus | Loaded code: **777 / 1,588,758–1,593,917**, task scopes and shared tool bindings | Shared application/drawing shortcut registry used by dispatch/help; selected sidebar tab/tabpanel state and roving arrow/Home/End navigation; modal/document/pane guards | Emulated keyboard/touch checks establish the exercised workflows; they do not establish physical-device performance. |
| Library browsing | Response verified: template/facet/material catalog above; loaded code **685 / 8,621–13,837** | Generator/sample search and previews, local Fabric collections/tags, editable physical-criteria ranking and bounded configured HTTP(S) JSON catalog import | A real compatible endpoint and CORS are required; no proprietary catalog or recommendation service is assumed. |
| Material application | Observed five applications; loaded code **794 / 43,900–45,170** | Explicit selected/all application and actual piece-targeted fabric drag/drop with one document/history update | A drop targets the hit owner; no selection silently becomes an all-piece application. |
| Drafting / internal construction | Loaded code in Studio geometry/tool registries; twelve tool events | Existing geometry/formulas/constraints/allowances/notches/wire channels plus persistent source/axis linked-mirror authoring, dependency guidance and explicit Detach | Mirror authoring requires a valid source and straight two-point axis. Restore an invalid referenced axis through drafting/undo, or detach to keep current geometry; no separate source/axis reassignment control is claimed. |
| Sewing | Observed segment/free sewing events; loaded attachment schemas | Canonical edge pairing/reversal, source/target lengths, signed and expected ease/tolerance feedback, paired highlighting and editable assembly order/seam groups/timing | Draft lengths and assembly instructions do not prove simulated seam closure or manufacturing acceptance. |
| Sample production measurements | Response verified **2054**; loaded schema **813 / 8,557** | Linked/manual sample POM values with units/tolerances; real current-mesh chord/surface-path captures, provenance and stale manual approval state | Surface path is a mesh-edge shortest-path approximation at current tessellation. Another simulation frame requires recapture; these are not calibrated fit measurements. |
| Size and grading | Five observed size switches; document size/body charts | Explicit size IDs/sample choice, unit-aware base-size/increment grade rules, separate body chart with factor/ease mapping and entered target overrides | Targets never invent actual measurements. Geometry/RUL grading and production-target generation retain distinct source relationships. |
| Materials / procurement Specs | Loaded BoM **813 / 21,726**; response categories empty in **2054** | Assigned fabrics, categorized procurement, supplier/SKU costing, current true-shape-marker consumption and explicit dated currency conversion | Unknown quantities/prices remain unspecified. Width/gap/rotation/cut-copy/waste constraints and stale marker fingerprints are checked; quotes are authored historical data. |
| Callouts and artwork Specs | Loaded Specs tab composition **777 / 1,578,086–1,578,324**, document fields **2054** | Ordered construction instructions with captured actual garment views/time/version; shared piece artwork/treatments and fresh flat colorway mockups in output | Flat production mockups are separately labeled from captured garment views and physical samples. |
| Piece-bound graphics | Loaded target resolution **794 / 48,487–51,450** and handles **777 / 472,427–476,000** | Direct 2D/3D move/rotation/size gestures with cancel/undo; structured vector motifs; grid/brick/half-drop repeats; supported ink blend/tint and polygon zones | Embedded validated raster fronts follow canonical piece frames/UVs. Untrusted SVG execution is excluded; bounded repeat/source budgets apply. |
| Named colorways | Response/schema verified **2054**; loaded save/switch/apply controls **777 / 157,825–160,899** | Named actual-material/tint variants, Original/switch/edit/repair workflows and restorable appearance snapshots including materials, assignments, artwork and colorways | Appearance restore preserves drafting geometry/checkpoints; snapshots do not create independent collaborative document branches. |
| Simulation readiness | Mesh responses **942–944**, registration **2245/2258**, bake registration **2251/2264**, two fit events | Existing WebGPU drape/arrangement/support/pose/diagnostics plus actual source/arranged/running/checkpoint/held feedback and captured mesh distances | The archived checkpoint remains 0/7 full released-drape acceptance. Interface states and authored approvals do not provide calibrated pressure/fit heatmaps. |
| Export / Tech Pack | Loaded export sections **777 / 1,409,990–1,410,650**; observed panel opening **2676** | Local generated PDF/XLSX plus standalone HTML/CSV with resolved production values, costs/quotes, captures, provenance and freshly rendered variant/print images | PDF/XLSX contain real image parts; known subtotals remain distinct from complete costs. Font substitutions and unavailable linked raster sources are reported. |
| Cutting | Advertised production export; loaded DXF import controls **777 / 27,328–40,000** | Visible Cutting task opens the existing true-shape marker/cut workflow with PDF/SVG/HPGL and cut tracking; production marker consumption shares real geometry | Cutting parameters remain explicit inputs; the exporter does not certify supplier yield or finished garment fit. |
| Range Plan / costing | Advertised and route/loader registered **637 / 370,757–371,730**; dedicated chunk absent | Persisted collection styles linked to current/saved documents, category/status, sizes/colorways, planned units, target cost, incomplete/known totals and JSON import/export | These are authored planning records; unavailable reference Range Plan UI/server behavior remains outside the capture. |
| Collaboration | Captured Shared-with-Me dashboard module **539**; API contracts and advertised sharing | Node profile with persistent accounts/sessions, owner/editor/viewer roles, membership-based links, shared versions, expected-revision conflicts, polling and chat | Requires configured persistent private storage. Static installations expose local editing and server availability; local Public metadata grants no server access. |
| Chat / trims / generation | Loaded gates **637 / 318,259**, conditional Studio wiring **776**; generator chunks absent | Real server-backed member chat; existing automation/material controls and local structured vector/repeat authoring remain reachable | Reference AI/trim generators are gated and their dedicated chunks are uncaptured; provider entitlements or unknown interfaces cannot be inferred from registry entries. |
| Mobile parity | Editor source includes touch handlers; mobile dashboard modules absent | Responsive workflow/panel controls, touch docking/resize and editor focus/keyboard ownership with existing and new browser scenarios | Emulated touch is separate from physical-phone performance and the uncaptured reference mobile dashboard. |

## Completed implementation relationships and acceptance boundaries

The [current comparison](fabra-comparison.md#implemented-completion-tranche) and [completion checklist](completion-checklist.md) connect each audited increment to active source and verification paths:

1. **Production relationships:** stable POM/size IDs, units, manual overrides, explicit grade rules and body factors/ease resolve targets; actuals remain entered or measured. True-shape marker consumption and approvals expose stale state. Captured 3D distances identify a mesh frame; mesh-edge paths approximate geodesics and require recapture for another frame.
2. **Appearance relationships:** direct piece/UV gestures, bounded repeat/zone/ink/vector data and appearance versions use the same canonical frame and shared painter. Named colorways share drafting geometry. New pieces without saved variant assignments retain their current fabric in both activation and export; explicit saved assignments still apply. Appearance restore does not replace physical checkpoints.
3. **Production output:** [generated PDF/XLSX and HTML/CSV](production-downloads.md) include live tables, actual captured views and fresh flat variant images. Numeric/unknown costs, dated conversion provenance, image proportions, safe spreadsheet text and failed raster-provider access remain explicit. PDF warning pages and the XLSX Export warnings sheet preserve image/reference warnings with their variant or view; download status reports their count.
4. **Workflow and library:** actual task entries, grouped inspector, shared shortcuts, selected/roving sidebar tabs, measured seam/ease feedback and assembly editing are reachable. Fabric drop, local collections/ranking, a real configured catalog adapter and persisted range styles support local planning without fabricated provider data.
5. **Sharing and composition:** [static and Node profiles](self-hosting-collaboration.md) distinguish on-device editing from persistent membership-based accounts/documents/versions/conflicts/chat. Actual detached panes synchronize with a canonical main document/history; stale/disconnected/read-only mutations are rejected.
6. **Import admission:** native JSON/SSP retain extension data and original IDs. Paired raw/legacy conversion remaps only unique same-name, single-cut, unscaled equivalent outlines with a verified rigid/reflected frame. Artwork UV corners/zones and repeat lattices must agree before adoption; unambiguous measurement endpoints follow verified owners. Other references remain explicit repair records. Preserving ambiguous data is safer than inventing an owner or silently moving an asymmetric print.

These relationships are implemented in source; the final frozen-source record below determines their integrated verification status. Earlier historical test counts do not validate newly added behavior.

The comparison covers the captured dependency inventory and these feature categories. The 123 uncaptured targets, unavailable reference server behavior, proprietary/provider access, physical-phone performance and hardware GPU accuracy remain actual evidence/runtime boundaries. The README's archived checkpoint remains **0 of 7 garments passing full released-drape acceptance**. Stage labels, captured mesh values and authored approvals do not replace released-support/collision/seam/settlement validation or certify fit/manufacturing readiness.

## Historical implementation verification

The coordinating pass implemented Specs/All, independent persisted split controls, canonical contextual/seam/text selection, explicit visual Fabric application and focus/menu improvements. Independent integration review checked model/history/save propagation, selection transitions, unique pane IDs, keyboard ownership and frozen diagnostic guards. Text editing/deletion uses canonical commands so unrelated constrained geometry and grain metadata are preserved.

Historical baseline validation and its operating boundaries are recorded in [the comparison report](fabra-comparison.md#committed-interface-baseline): 82 unit-test files / 1,070 tests and 60 distinct desktop/touch browser cases for interface baseline `59f370d`. The [subsequent feature tranche](fabra-comparison.md#subsequent-feature-tranche) separately passed **91 unit-test files / 1,137 tests**, clean type/lint/build checks and **73 desktop/touch browser scenarios**, including all 13 new Tech Pack/colorway/artwork/docking/import workflows plus a fresh run of all 60 existing regressions. Actual image pixels, offline exported files, geometry/UV/checkpoint preservation, undo, save/reload/SSP and pane-instance identity were checked. This verification does not increase the Fabra capture's coverage or establish physical fit or manufacturing readiness.

## Current completion tranche: final verification

The completion tranche passed **109 unit-test files / 1,239 tests**, clean type/lint checks, both static and Node builds, **134 distinct desktop/touch browser cases across the complete run and targeted reruns**, **24 distinct WebGPU browser cases across the full run and recovery**, and **five production sharing/detached cases against the compiled Node app**. Compiled HTTP authorization and actual process-restart persistence also passed. Current-document export/capture readiness, exact camera persistence, actual generated file/image content, canonical document/history and permission guards are included. The [completion checklist](completion-checklist.md#final-verification-record) records the exact run breakdown, WebGPU and compiled-server results, and remaining evidence boundaries. This record is committed together with the implementation; earlier baseline counts remain historical.
