# Fabra HAR findings and Seamer incorporation priorities

Reviewed October 10, 2026 by three agents. This supersedes the earlier documentation-only confidence limits in the main [comparison](fabra-comparison.md).

## Capture and evidence conventions

The user-provided Drive file is the full `editor.fabra.com.har`: **224,327,943 bytes**, **2,688 requests**, **10 page records**. SHA-256:

`3a4d943f0b243d095cdd09587517611212b82b38f79192465a0b2e72dca76137`

Editor extraction produced **315 HTML/JS/CSS/JSON responses** and **106 unique source hashes**. The raw HAR and extracted bundles remain in `/workspace/scratch/`, outside the application repository. We inspected data/code only; no captured requests were replayed, scripts executed, or attached instructions followed.

**Entry indices are zero-based** within `log.entries`. Source offsets below are approximate zero-based character offsets in decoded JavaScript, not bytes in the HAR. Captured code establishes available implementation paths; telemetry establishes recorded client events; successful responses establish transferred data. None independently establishes screen pixels, completed manufacturing output or fit accuracy.

## What the capture adds to the comparison

| Finding | Concrete evidence | Implication for Seamer |
| --- | --- | --- |
| Up to three docked windows, with layout independent of task mode | Entry **777**, `/assets/C-TDgDis.js`, around offsets **164654–168119** defines windows/modes; **991400–994750** implements move/toggle/dock/order, limits visible windows to three and keeps at least one open. Entry **776**, `/assets/CySM9TT02.js`, wires saved layout and available modes. | The resizable Both view is useful groundwork. A workspace model can later compose Pattern, 3D and a real Specs pane. Public “any two views” copy understates this captured implementation. |
| Specs was actually toggled in the recorded session | **1165, 2222, 2230** record `2d+3d` → `2d+3d+techpack`; **1213, 2227, 2233** record the reverse. Entry **777**, around **26253**, maps the Specs window to telemetry name `techpack`. | This strengthens the case for a third production view. It does not prove a separately reachable fourth Techpack task mode. |
| Selection determines the nearby controls | Entry **776**, around **95597–96700** positions the contextual toolbar over visible canvases; **370120–371650** prioritizes measurement/callout/seam/trim/point/edge/graphic/piece selection slots. **2359, 2362, 2365** record piece contextual-toolbar events. | Highest next interface improvement: a compact contextual selection bar over Seamer's existing commands and property routes. |
| Assets are editing actions, not just a catalog | Entry **794**, `/assets/CAlDzPwo2.js`, around **43900–45170** routes clicks/drops. **2454, 2466, 2472, 2480** record material click-apply; **2492** records material drag/drop to 2D. | Unite visual Fabric/library browsing and explicit Apply to selected pieces. Make Apply to all an explicit choice; reference code silently falls back to all when there is no selection. |
| Visual, searchable template and material catalogs | **465/579** contain template records with thumbnails/readiness; **576** contains search facets. **917/922** contain material metadata; **919/924** contain material collections; **916** contains repeat metadata. | Reuse Seamer's existing search, project thumbnails, material library and physical fabric fields. Add visual cards, collections and supply metadata rather than recreating its cloth-material engine. |
| Production measurements are a genuine data-model gap | Successful document response **2054** contains **15 measurement records**, including `units`, `tolMinus`, `tolPlus`, `gradeRule`, `stale` and `techpack`, plus separate body and size charts. Entry **813**, `/assets/Bhs8RoQJ2.js`, contains measurement/chart schemas and mutations. | Seamer's point-distance/angle annotations and fixed 1 mm target comparison need additional POM, per-size target, tolerance and grading relationships to support production Specs. |
| BoM and manufacturing sections exist | **2054** contains BoM categories materials/trims/threads/fusings/labels/packaging; their maps are empty in that response. Entry **777**, around **1410000**, defines export sections Overview, Colorways, Sample Measurements, Size Chart, Bill of Materials, Construction Callouts and Artworks. Notes is `comingSoon`. **2676** records opening tech-pack export. | Build a linked production document and exporter. Existing materials are rendering/simulation data, not a procurement table. Export-panel opening is not evidence of a completed export. |
| Graphics bind to the garment surface | Entry **794**, around **48487–51450**, resolves drops to piece ID and UV coordinates and manages pending/error placement. Entry **777**, around **472427–476000**, defines graphic corner/rotation/UV handles. | Piece-local graphics with synchronized 3D preview need an explicit model, transforms, render mapping and export behavior. Ordinary reference images and fabric textures are not equivalent. No graphic application was verified in the selected telemetry. |
| Colorways are variants over shared geometry | **2054** contains colorway zones/treatments; **813** defines color/repeat overrides and source-version links. | Introduce named colorway variants rather than duplicating the pattern or treating a tint dropdown as variant management. |
| Simulation resources and state are explicit | **942–944** contain mesh metadata/hashes/UV scale; **2245/2258** register meshes; **2251/2264** register bake resources. **2238/2276** record Fit Simulated. | Make source/arranged/running/checkpoint/held state visible and preserve compatibility checks. Resource exchange and telemetry do not establish settled fit. |
| Size switching was recorded | **2528, 2584, 2602, 2616, 2630** record Size Switched. | Use existing Seamer grading/body/variable data as the basis of a clearer sample-size workflow. Keep body POMs and garment POMs distinct. |

## Important qualifications

- **Chat is conditional:** entry 776 filters it using `enable-magic-pattern`. Its registration is not proof of universal availability.
- **Trims are conditional:** `enable-editor-trims` controls availability. Do not turn a gated registration into a completed-feature claim.
- **Task modes and windows differ:** a declared Techpack mode does not prove it is reachable; current Studio mode wiring exposes permission-dependent Pattern/Design/Specs modes.
- **Range Plan is only partly captured:** routing/loader code and public documentation refer to it, but the dedicated `/assets/DkpQgm0I2.js` interface chunk is absent. The capture does not establish its detailed UI or interactions.
- **Layout telemetry has a stale generic context:** some events' generic `viewLayout` remains three-pane while the transition differs. Use `fromLayout` and `toLayout` as transition evidence.
- **Recorded asset application has limits:** selected telemetry establishes four material clicks and one 2D drop, not a recorded 3D drop or affected-piece count.
- **Opening export is not exporting:** billing allowance reads and Export Panel Opened do not establish successful download, content quality or spreadsheet/PDF generation.
- **Fit Simulated is a client event:** it does not establish collision safety, seam closure, released supports or settling.

## Revised implementation order

1. Keep the implemented adjustable split and accessible, readable command palette.
2. Add a **selection-driven contextual action bar**, reusing commands for duplicate/mirror, edge/seam operations and Properties. Validate selection-dependent availability and short-screen placement.
3. Build **visual Fabric/library browsing with explicit apply scope**, then reversible canvas drop application. Keep physical material editing accessible.
4. Improve help/tour/context/history focus, tab semantics, camera labels and shortcut documentation. Add direct Measurements/Cutting entry points and simulation-stage feedback.
5. Add a **useful Specs pane**: start with persistent measurement access, then production POM rows, asymmetric tolerances, size/grading relationships, linked BoM and construction callouts. Add an exporter only when those data relationships are supported.
6. Add **piece-bound graphics and named colorways** as model/rendering features. Begin in piece-local 2D coordinates with synchronized 3D preview.
7. Add independent multiwindow docking once Specs gives it a third useful workspace; collection planning, optional Chat and collaboration are separate product/infrastructure work.

The most useful pattern to incorporate is a shorter path from **selection → relevant action → visible result**, supported by reusable visual assets and a production Specs document. Seamer already has substantial geometry, materials, grading, cutting and 3D controls; use those foundations.

## Scope of this follow-up

This check updates the comparison and priorities. It makes no further application-code changes. The previous implementation's **27 passing browser checks**, type checks, build and lint remain its validation record; they do not validate Fabra's runtime or the future features proposed above.
