# seamer-studio

`seamer-studio` is the new SvelteKit application for Seamer's parametric
sewing-pattern domain. It consumes the local `atelier` engine through `file:`
dependencies and owns the pattern model, formula/constraint solver, avatar,
XPBD cloth simulation, application UI, server routes, and product pages.

## Studio feature release

The current Studio includes Draft/Fit/Appearance/Production/Cutting tasks, accessible sidebar navigation, configurable pane docking and detached browser panes. Compact landscape places all five tasks in More with 44px touch targets; other desktop and portrait layouts retain the taskbar. Direct artwork editing, structured vector motifs, repeat/zone/ink treatments, named colorways and appearance versions use actual document geometry and mesh UVs. Linked mirrors follow source/axis edits, show dependency warnings and offer Detach; an invalid axis can be restored through drafting or undo.

Production supports unit-aware grade rules, body-chart/ease mapping, captured mesh measurements, stale approvals, validated true-shape-marker consumption and dated exchange quotes. Tech Pack downloads include generated PDF/XLSX, HTML/CSV, actual construction views and freshly rendered flat variant mockups. Fabric libraries include collections, physical-criteria ranking, real configured catalog import and piece-targeted drops; range plans preserve style, size, colorway and budget records.

Starting simulation, 3D downloads and garment captures wait for completed preparation of the current document. Pause remains available during an active simulation. Pending SSP capture retains existing checkpoints; asynchronous exports reject a changed source document.

The default `pnpm build` profile remains a static application for on-device editing. `pnpm build:server` adds self-hosted persistent accounts, membership roles, shared documents/revisions, conflicts and live polling/chat; see [server setup and detached windows](docs/self-hosting-collaboration.md). Detached editors require a same-origin main window and keep its canonical document/history. Source features and operating boundaries are described in [the comparison](docs/fabra-comparison.md); the [completion checklist](docs/completion-checklist.md#final-verification-record) records integrated verification and its operating boundaries.

The checkpoint below preserves the archived garment pipeline's physical acceptance status; the Studio release does not certify settled fit or manufacturing readiness.

## Garment implementation checkpoint

This is an in-progress implementation checkpoint. The application includes
GarmentCode import/generation, sewing and collision diagnostics, garment camera
framing, Library improvements, and collapsible controls for narrow screens.
The latest isolated pipeline implementations are preserved as source archives in
`research/garment-pipeline/`; they are review prototypes, not enabled production
backend code. Their original workspace paths and hash manifests are retained for
provenance, so the archives are not standalone installable packages.

Seven fresh source examples passed initial body-clearance and self-intersection
checks. Three targeted GPU operator cases passed, including the corrected
collision-constraint processing order and coupled body friction. These checks do
not establish completed sewing or settled fit: **0 of 7 garments have passed the
full released-drape acceptance test**. New body6 context/engine integration and
final desktop/mobile garment renders remain pending. The archived Kit delivery
has an explicit body164 review hold; the later body168 fix is archived separately.

The yielding preparation prototype passed three actual Chromium CPU contexts
(desktop, touch portrait, touch landscape) with all workers and processes closed.
Post-reply heartbeat gaps were approximately 246–269 ms and whole-preparation
gaps 482–550 ms, substantially below the earlier 10–11 second pause. This is a CPU
probe result, not a physical-phone or shipping-Library responsiveness claim.

Checkpoint validation: `pnpm check`, 1,054 unit tests, `pnpm build`, `pnpm lint`,
and compilation of all 42 WGSL kernels passed. Uploaded HAR/PDF/ZIP files,
credentials, dependency installations, body-model binaries, and large GPU
diagnostic states are excluded from the source archives.

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
- `vendor/body-model` — `@seamer/body-model`, a git submodule of
  [ahzs645/body-model](https://github.com/ahzs645/body-model): the parametric
  rigged body itself — shape, skeleton, skinning — as plain ES modules with the
  model's binary assets alongside them in `models/`. `packages/avatar` is a
  three.js skin over it, so there is one implementation of the body, shared with
  knitterer. Served to the browser at `/models` by a plugin in `vite.config.ts`.
  Initialise it with `git submodule update --init vendor/body-model`. Both
  apps pin the same commit; a change to the body is made in that repository
  and the pin moved forward here and in knitterer together.

The 2D editor intentionally remains the existing Canvas2D implementation. Its
document Y axis is mathematical Y-up; only the canvas/SVG projection flips Y.

## Editor behavior

The canonical document is an Atelier `Editor<Pattern>`. It uses the pattern
command registry, a single immutable Atelier `Selection`, labeled snapshot
history, an 800 ms coalescing window, and `IndexedDbHistoryPersistence` keyed
by pattern id. Canvas2D, panels and contextual actions read the canonical
selection; the old point/path/piece selection stores have been removed.

`window.seamer` is installed through `installAutomationApi`. Compatibility
aliases preserve the old `getPattern()` and object-shaped `getSelection()`
results for existing scripts.

## Wire channels, assembly timeline, generators

Three features share one idea: a garment is not only a shape, it is a shape plus an order it gets
sewn in, plus whatever structure is sewn into it.

**Wire channels.** Any `PiecePath` may carry a `wire` (`WireChannel`): a stiffener along the edge —
boning, a hoop, a lantern rib. Add or remove one per edge in the property panel. `channelWidth` is
extra CUT width only, applied through the existing per-edge `seamAllowance` override, so the finished
geometry is untouched. The panel keeps the two in step — adding a wire grows the edge's allowance by
the channel, changing the channel moves it, removing the wire puts it back — but only while the
override is still tracking. Once someone types their own number, or drives the edge with a formula,
the panel stops touching it and says so instead.

In the drape a wire becomes near-inextensible distance constraints along the edge plus curvature
constraints across alternate particles, both resting on the FLAT pattern lengths. That is the
physical claim of the construction: the cut edge already carries the correct in-plane curvature, so
the wire holds that curve and only bends out of the plane of the cloth. Wire constraints are
deliberately kept out of `allStretchEdges` — that list seeds near-damping neighbours and feeds the
cross-seam softening pass, and a rib usually runs *along* a seam, so softening would disable exactly
what holds the form.

The panel also picks how the wire is held, which is a physical fork rather than a note for the maker.
**Stitched** is sewn in as the seam is made, so cloth and wire are fixed along their whole length;
its links are ordinary two-sided distance constraints. **Threaded** is fed through a finished casing
afterwards, so the cloth may gather along the wire but cannot stretch past it; the same links are
marked long-range, so they act only once the fabric is pulled longer than the wire and stay quiet
while it bunches. The distance kernel already had that flag. A threaded rib ruffles, a stitched one
cannot.

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

**Patterns without a person.** Not everything drafted here is worn. `settings3d.avatarEnabled: false`
means the pattern has no body at all — no avatar, no pose bar, no body chip, and no silhouette behind
the 2D pieces. It is a document setting, so it persists and undoes; the 3D rail toggles it. Piece
name labels have their own toggle in the same rail, and a pattern that sets `showPieceNames: false`
starts with them off in 3D as well as 2D.

**Globe lantern generator.** Library → Generators → Globe lantern. Produces a full `Pattern` from
parameters in two constructions: stacked rings (each an annular sector, closed form) or a helix (one
ribbon whose flat shape is the double spiral you get by integrating geodesic curvature). Both carry
wire channels per coil and a complete assembly order; both split to fit a cutting mat. The generator
also ships each piece's exact 2D→3D map as `savedPositions`, so the studio shows the finished lantern
immediately rather than asking the solver to fold a sphere out of a flat spiral — which nothing in
the physics would drive it to do.

Every piece is built to land with its triangles facing INWARD, because that is the convention the
renderer already assumes — `scene3d` puts the face texture on a `BackSide` mesh for exactly that
reason. A ring above the equator develops the other way round, its upper edge becoming the sector's
inner arc, so its map is the mirror handedness and the whole upper hemisphere would show its lining
to the room. The generator mirrors those bands, which costs nothing: an annular sector is symmetric
about its own bisector, so the cut piece is identical and only which way up it is applied changes.
`Piece.settings3d.flipNormals` looks like the lever for this and is not — the saved-drape path never
reads it — so the facing is measured against the globe axis and built in, and the smoke test asserts
it for every piece in both modes.

Helix pieces stay on the developed spiral by default, so the plan reads as the one continuous ribbon
the construction actually is; untick that and they pack into rows for cutting. Near the openings the
coils crowd so tightly that neighbouring CUT outlines overlap on the page — the generator reports
that clearance rather than letting the layout look broken, and trimming the seam allowance or wire
channel is what raises it. Every piece join carries a balance notch, and the lantern's material has
a dark inner face so the top and bottom openings read as holes instead of a solid dome.

## GarmentCode garments

Library → Generators → **GarmentCode garment…** opens made-to-measure t-shirt,
hoodie, skirt, pants and dress controls. Supply body measurements in centimetres
and adjust the length/sleeve options. Reopening a generated garment restores its
last style settings. The draft is independently editable; changing an imported
point does not rerun the upstream parametric generator. The library has search and
category filters for GarmentCode, 3D samples, 2D patterns and generators. Its open
state is explicit, so renderer focus changes do not dismiss it. Mobile **Fabric**
opens the material panel directly; **More** contains secondary studio actions.
The source garment camera controls include **Zoom to garment** for a closer view
of the published clothing. **Reset view** restores whole-body framing. The Library
uses the visible screen height and keeps its Close button reachable when a mobile
keyboard changes the viewport.

Import → **GarmentCode examples** provides four attributed upstream garments,
including a jumpsuit. The regular JSON import also accepts GarmentCode and legacy
Garment-Pattern-Generator specifications. Units, editable curves, stitch references,
panel facing and source 3D transforms are preserved. The separated 2D cutting layout
does not move the source 3D panels. Manual arrangement controls replace a panel's
source placement. Native project saves preserve the imported metadata and placement.

Generation runs the real CPU Python library through `POST /api/garmentcode`.
Install the isolated environment and set `GARMENTCODE_ROOT` and
`GARMENTCODE_PYTHON` as described in
[scripts/garmentcode/README.md](scripts/garmentcode/README.md), then start the dev
server. The endpoint limits request/output size, concurrent processes and runtime;
only deployment configuration selects executable/source paths. This repository's
default production adapter is static: built static hosts support examples and JSON
imports, while live generation requires the Node server profile with the SvelteKit
endpoint or the documented CLI followed by JSON import. The dialog reports an
unavailable backend and offers the examples.
The endpoint returns the validated original generator JSON. This preserves signed
zero and source panel order across transport, so the browser can check the source
pattern against the generator's provenance digest without changing that digest.

The 3D view initially renders **unsewn source panel placement**. Start simulation
to try Seamer's WebGPU cloth engine; imported specifications do not contain the
dataset's physically draped meshes. Import/rendering support is separate from a
validated garment fit. New generated specifications include resolved source body
measurements in `properties.garmentcode_body`. Import restores these measurements,
calibrates the existing avatar's height, torso girths and drafting landmarks, and
aligns posed shoulder width, source surface arm length, and arm inclination.
Source arm length follows the upstream triangle-surface geodesic from shoulder
to wrist rather than a shoulder-to-hand-joint chord. The browser performs this
calibration in a cancellable worker so fitting does not block touch controls. The source neck-width measurement is a
back-neck surface trace, so it is not used as a physical neck diameter.
Source calibration also aligns crotch height and, for explicitly generated pants,
approximates the upstream apart-leg stance and upper-thigh circumference with
bounded deformations that preserve triangle orientation.
Hand shape is preserved; the arms are not measured from internal shoulder joints. The body is an approximation of
the source body, not the dataset's original mesh. Editing body measurements
invalidates that calibration; manual pose choices remain available. Older raw
specifications without body metadata retain the ordinary avatar and optional **A**
pose control.

Saved GarmentCode positions are free simulation checkpoints. Saving or exporting
an unassembled garment does not turn its flat panels into holding anchors. **Hold
saved checkpoint** explicitly holds a cached shape; it does not certify that the
shape is settled or fits. Legacy native garment caches retain their existing hold
behavior. Older source-body checkpoints are preserved in the saved document, but
reassembled from panel placement for the corrected body and assembly placement;
the 3D view prompts to start simulation. New exported/simulated positions record
body-fit revision 5 and the assembly revision. On narrow 3D panes, **Start/Pause**, **Reset** and **Controls** remain
visible; camera, pose and rendering controls move into a collapsible drawer.

Development inspection can display a source-bound frozen simulation frame through
the actual 3D renderer. It verifies the current body, source files, topology,
materials and seam activation, then independently checks the frozen geometry.
The view is visibly labeled as an unaccepted diagnostic and disables simulation,
editing, saving and export; leaving it restores the original scene. This does not
make a checkpoint eligible for resuming simulation or certify garment fit.
An actual revision-5 long-shirt frame was displayed in desktop, touch portrait
and touch landscape browsers with zero coordinate error against its frozen body
and cloth arrays. The portrait 3D canvas was 601 px high; landscape remained
height-constrained. These are rendering and interface checks of an early frame,
not evidence of a fully sewn or settled shirt.

Source previews are checked against the actual posed body before being displayed.
An incompatible free checkpoint falls back to a checked fresh arrangement;
an intersecting explicitly held or frozen garment requires releasing its hold or
unfreezing its pieces. Playback checks interpolated positions as well as recorded
frames, and rejects recordings from a different body or topology. Source export
checks the actual displayed mesh, including its world transform.

Collision handling uses exact nearest finite body features, swept particle contacts,
and body-vertex/cloth-face constraints. Welded edge normals and angle-weighted
vertex normals classify points near skin corners; verified interior points recover
even when their velocity points outward. The body query refreshes after face
corrections, which can otherwise push a shared particle through the skin. Face
constraints catch hands crossing coarse cloth facets when every cloth vertex is
outside the body; bounded barycentric corrections are reduced through incident
triangles without floating-point atomics. Finite face contacts also cover both
cloth windings and perpendicular body edges. Stackless finite-triangle bounding
trees find nearby faces without scanning every pair. The passes use at most eight
storage buffers, matching WebGPU's guaranteed limit.
Cloth edges that enter and exit a body facet are recovered from their actual
interior chord and finite skin distance, rather than an extended face plane.

Active source garments refine sleeve and cuff boundaries to at most 10 mm while
preserving cutting geometry and matched stitch counts. Automatic contact padding
uses the thickest active physical/visual material plus 0.5 mm clearance: imported
0.5 mm fabric uses a 1 mm envelope. Native padding and explicit solver overrides
remain intact. Geometry preparation stores the material target; live solver
options are resolved when simulation starts.
Fresh eligible generated garments also refine sufficiently long gathered edges
when the pinned upstream program reports an actual resolved gather interface.
New boundary particles remain free, existing source knots and cuts remain intact,
and split material edges preserve their combined rest length and compliance.
Contact checks follow the actual refined boundary at the same source-material
coordinate. Source hashes bind the data; approval also requires the deployment's
pinned program registry or an explicitly approved authored import.
Refined checkpoints retain their source and simulation data in saved documents,
but reopen for fresh assembly until a topology-aware cache decoder is available.
Manual recording rebuilds the original sewing mesh before recording begins.
Measured source garments use four collision-only contact passes at every substep,
including at least four on the final substep for thin cloth. A separate
5 mm recovery-displacement bound means the 1 mm clearance does not restrict
recovery to 1 mm. Source sewing uses eight bounded mass-weighted iterations before contact
resolution. For an active source stitch, the previous physical substep's immutable
gap selects its movement limit for all eight iterations: open joins share the
substep sewing budget, while joins within 3 mm retain the original per-iteration
restoration limit. This keeps a newly stretched closed seam from separating merely
because an open seam needs slower assembly. It does not impose one universal
movement bound on both classes. Native sewing retains its previous rule.
Solver controls report the effective garment settings and preserve
explicit overrides. Rebuilding the engine after a settings change transfers the
support phase and elapsed release time, keeping already released supports free.
Stitches use mass-weighted Jacobi corrections: a free pair meets at its weighted
midpoint, and a free endpoint meets a fixed partner. The previous doubled
correction could swap endpoints indefinitely instead of closing the stitch.
Pending GPU frames cannot overwrite a reset or advance its new support phase.
Pose and settings changes drain the current frame before replacing resources;
disposal retains buffers until readback finishes. Source saves preserve the exact
collision-checked geometry rather than applying an unchecked seam snap afterward.
Guarded source simulation starts from the exact checked preview geometry instead
of applying native planar-panel initialization tilt. Every corrected substep is
recorded directly on the GPU, including the actual starting positions. A persistent
worker checks intermediate body/self geometry and consecutive particle sweeps
before publishing the frame, leaving Library and controls responsive during the
check. Missing, mismatched or failed proofs preserve the last safe state and pause;
reset/body changes invalidate pending results. Native initialization stays intact.
Manual assembly recordings use the same persistent failure warning and preserve
the rejected trace for diagnosis. A rejected take is not returned as playable
frames; Reset clears the failure. A late rejection from a replaced scene cannot
invalidate its replacement.

A source-calibrated 176 cm cuffed hoodie at 30 mm spacing (1,665 particles) was
checked after 40 frames: zero interior particles, zero body-crossing cloth facets,
both hand sections inside their cuff openings, 3.79–4.37 mm minimum opening
clearance, and cuff/attachment seam gaps below 1.91 mm. Desktop/mobile closeups
and rendered OBJ vertices match this exact solved geometry. The largest other
seam gap remains 15.35 mm, so these checks do not certify a fully settled or
physically validated garment fit.
That historical gravity-first experiment is separate from the current source
assembly sequence. Fresh eligible source imports now close structural units before
enabling their attachments; only checked seam closure advances the sequence.

The current 15 mm seven-style early screen (tee, long shirt, skirt, pants,
sleeveless dress, cuffed hoodie and the default 12-panel sleeved dress) passed
three checked frames per style with four contact passes and eight sewing
iterations. Each frame includes the actual start and all 40 corrected substeps.
This is **early collision evidence only**: supports are still active and seams
are still open, so none of these runs establishes a complete fit or settling.
The source sewing controls also passed 12 GPU primitive cases; native sewing
output remained byte-identical to its captured reference. Longer released runs
and anatomical checks are required before declaring a garment successful.
The revision-5 body screen used actual desktop-browser body arrays, with an
independent replay of all 861 initial states and 840 substep transitions. A fresh
32-frame screen then recorded 123 attempts: five styles stopped on body or self
contacts, pants remained clear with a 25.18 mm seam gap, and the skirt closed its
seams to 1.03 mm while beginning support release. No style passed complete fit.
Independent checks covered all 5,043 states and 4,920 substep transitions in that
screen, including rejected attempts. The pants' 25 mm crotch junction gap also
persists in a CPU replay of the material and sewing stages without contacts or
supports; this diagnosis does not establish a production fix.
A fresh revision-5 skirt run completed 180 accepted frames without a collision
halt. Its supports released and all seams closed (final largest gap 1.10 mm),
but the waistband finished 41.16 mm below its source position and no consecutive
pair of full motion windows passed. The corrected body therefore does not resolve
this released waist-fit failure.

An isolated replacement contact solver now handles a captured 1,123-row,
143-particle contact group using eight GPU storage buffers. Its saved output
matches an independent Float32 calculation exactly; the largest correction is
1.105 mm. This test uploads sealed reference rows and verifies solver algebra.
It does not yet verify GPU contact generation, complete substeps or garment fit,
and the replacement is not enabled in the live engine.
A copied complete GPU contact backend now binds actual finite geometry, raw rows,
response components and fresh-query certificates to the original body, source,
sewing mask and substep. Its 17 CPU/lifecycle checks pass. The first genuine tee
GPU attempt failed shader parsing; the identifier-only correction reached startup
but timed out after 180 seconds before returning its first complete inventory.
The terminated process closed, but its device cleanup receipt was unavailable.
A separate timing diagnostic returned a complete inventory in 39 seconds;
its 180,932 records reported 5,639 physical clearance deficits and no unknowns.
The first full response run failed: resetting to the original state while dropping
already-satisfied protections reintroduced deficits after locally valid solves.
A corrected selector retains current protections needed at that original state.
It repaired the same genuine tee state in two GPU responses and three complete
queries: final clearance was 1.001587 mm with no deficits or unknowns, and maximum
movement was 1.605056 mm. Independent Float32 replay matches both responses
exactly. All 266 buffers and the device closed. This isolated state uses the
historical material masses and does not establish a complete physical-mass
simulation, friction history, support-free garment fit or full trajectory safety.
The replacement backend remains disabled in the live engine.
Separate device checks passed six declared pressure/friction cases and 24
refined-seam classification cases. The pressure tests check physical normal
multipliers separately from extra numerical clearance; the seam tests use the
actual source midpoint identities and original stitch masks. Both sets closed
all GPU resources and passed independent readback checks. They are component
checks, not complete garment simulations. A subsequent complete-body anchor
probe passed on the same historical tee state: all 146,634 body records returned
finite material anchors, all 33,688 self records remained separate, and no rows
were unsupported. Independent replay checked every record and its preserved ray
votes. An alternate ray triple resolved 49 ambiguous records using the same
arithmetic bounds and full three-ray agreement. All 23 buffers and the device
closed. This verifies one anchor-producing state; persistent body contact history,
the complete refined contact producer and all 40 physical substeps still require
integration and verification before this candidate can replace the live path.
An isolated physical membrane candidate completed 15 GPU controls with exact
Float32 reference agreement, including multiplier reset, fixed coordinates and
failed-step restoration. The first candidate failed temporal convergence because
small corrections rounded away when added to world coordinates. A new candidate
preserves those corrections for velocity: all 70 saved velocity updates match the
Float32 reference, and timestep errors improve from 0.913 to 0.433 to 0.123 µm.
Its original Float64 waistband-shear multiplier accuracy check still fails; both
earlier and current failures remain recorded. This material candidate is not yet
a complete fabric model or a validated garment default.
A fresh copied full-engine physical-mass skirt run accepted 13 frames, then
rejected frame 14 at substep 4 after front waistband/skirt self-intersections.
Independent replay verified all 574 position and raw displacement samples,
560 transitions, physical mass bits and body/source/sewing bindings. Rejection
restored the whole GPU transaction and owner state exactly. Supports remained
active, assembly was incomplete, and seams reached 46.35 mm, so this run does
not establish released waist fit or settling. The copied engine still uses
legacy finishing contacts; the joint contact replacement remains separate.
The earlier long skirt experiments below used body-fit revision 4.
An independent 80-frame run of the refined 170 cm skirt checked all 3,280 observed
states and 3,200 transitions without detected body or cloth intersections. Its
supports fully released, and every seam was within 3 mm in frames 64–80. It still
failed fit: the waistband ended 40.74 mm below the source waist, and its final
motion window reached 4.75 mm RMS and 15.01 mm maximum displacement. The waistband
stretched 3.27% from its authored 840 mm contour. Collision safety and complete
assembly therefore remain separate from a successful, freely settled fit.
A fresh continuous repeat reached a motion candidate at frame 135. Independent
checks covered all 5,535 recorded states and 5,400 transitions without detected
intersections. Its final 17 support-free samples passed seam closure, coverage and
both motion windows (0.59/0.47 mm RMS, 2.90/2.78 mm maximum), but every sample failed
waist placement: the final waistband was 40.92 mm below the source target. This
resolves the earlier motion failure; it does not resolve the garment's fit.

The broader coverage matrix uses five fresh upstream-generated styles and bodies
from 164–183 cm. These are generated specifications, not verified records from the
released GarmentCodeData dataset. Four bundled upstream examples also passed
import/geometry checks. See the [matrix helper and browser runner](scripts/garmentcode/README.md#reproduce-the-garment-coverage-matrix)
to generate inputs and retain source hashes, body geometry and simulation checkpoints.

At 40 mm spacing after 24 frames (0.384 simulated seconds), the production-policy
screen found the following. All runs were finite with no browser/GPU errors and no
held particles. Zero interior cloth vertices did **not** rule out crossing facets.

| Generated style | Body-crossing cloth facets | Largest seam gap | Findings |
| --- | ---: | ---: | --- |
| Short-sleeve shirt, 164 cm | 0 | 7.11 mm | Clear body-contact screen; still moving. |
| Long-sleeve shirt, 176 cm | 27 | 24.20 mm | Includes hand contacts; open hems have ample circumference but locally distorted openings. |
| Skirt, 170 cm | 0 | 1.60 mm | Waistband descended about 50 mm without temporary support. |
| Pants, 183 cm | 23 | 55.18 mm | Seat/hip body crossings and 22 remote inner-leg self-intersections; waistband descended about 68 mm. |
| Sleeveless dress, 176 cm | 0 | 134.37 mm | Shoulder joins remain separated across the body's depth. |

These short, coarse trajectories do not establish settling or validated fit.
An independent fresh long-sleeve run continued to 48 frames (0.768 seconds):
body-crossing facets decreased from 29 at its own frame 24 to 25, but its largest
seam remained 25.63 mm and its last eight-frame RMS motion was 2.47 mm. That run
had zero detected hand crossings at frame 48, but all 25 remaining crossings were
near wrists/forearms. Its right sleeve opening missed part of the body section by
1.11 mm and hem-side joins remained 11.45–12.57 mm apart; it failed clean
contact/closure. Parallel GPU ordering can produce small
trajectory differences with identical initial geometry, so repeat runs retain
their own checkpoints rather than treating a baseline checkpoint as a restart.
An explicit dress benchmark used ten initial zero-gravity frames followed by
fourteen ordinary frames, with particle positions/history/velocities preserved
bit-for-bit across the switch. It stayed body-clear but retained a 132.83 mm
shoulder gap versus the 134.37 mm baseline, and motion did not improve. This
limited gravity-policy change does not resolve the assembly failure and remains
outside the application's defaults.
These measurements describe the earlier body/assembly policy. The updated source
pipeline calibrates crotch height and explicitly selected pants stance, arranges
connected waistband/torso/lower-panel interfaces at the anatomical waist, and
temporarily supports shoulder and waist edges vertically. Supports release only
after measured seam closure, then fade before free-settling checks. Imported
placement matrices and flat cutting geometry remain intact. A runtime guard
checks candidate body and cloth surface intersections before publishing a frame;
rejected frames restore the previous positions, history and velocities and pause
the solver. These changes require fresh simulation and independent fit checks;
the earlier table does not establish their final results.

The [independent garment checks](scripts/garmentcode/qa/README.md) require closed
seams, clear body and cloth surfaces, anatomical shoulder/wrist/waist placement,
two contiguous motion windows after complete support release, and exact final
rendered body/cloth coordinates. Each eight-frame motion window compares all
36 pairs of its nine observed frames; the maximum RMS displacement must stay
within 1 mm and every particle within 3 mm. Saved intermediate observations let
the independent auditor catch oscillation that returns to its starting point.
The sixteen incoming frame trajectories also retain every corrected solver
substep in hash-verified binary files. The auditor binds each path to its exact
published start/end, body and cloth topology, then checks intermediate body/self
geometry and consecutive particle sweeps. A straight chord between two published
frames is not substituted for the observed substep path.
Locally closed matching stitch segments may
touch during assembly while other stitches close; final whole-seam gaps must be
at most 3 mm. A paused rejection or stationary off-body garment cannot pass.

Body-Shape-Estimation and NeuralTailor inference are not
connected to this workflow. Inputs with `normalize_panel_translation=true` require
upstream normalization before import and are rejected with an explanation.

Upstream examples retain their MIT license and revision in
`static/examples/garmentcode/`. Converter, placement, triangulation and generator
tests cover real upstream geometry, curved edges, seams and malformed input.

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

Browser regressions cover desktop workspaces, touch controls, and narrow-screen layouts:

```sh
pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:e2e:mobile
```

Set `CHROMIUM_PATH` to a system Chromium executable when using an existing browser installation.
The mobile project emulates touch input; physical-device and other-browser checks remain separate.

The app pins `three` to `0.181.2`; Vite deduplicates `three` so the app and
Atelier viewport do not create separate runtime instances.

## Not yet ported

Explicit migration gaps, not completed features. Verified against the code on
2026-07-26 — earlier revisions of this list overstated what remained.

**2D canvas.** `components/PatternCanvas2D.svelte` (3317 LOC) remains a
hand-rolled `CanvasRenderingContext2D` renderer. Porting it to the engine's
`projection: '2d'` is MIGRATION.md Phase 6 and is **explicitly out of scope and
not recommended** — it buys architectural consistency, not capability.

**Physical validation remains.** Browser regressions exercise desktop/mobile
workspaces and real GarmentCode meshes. Chromium's software WebGPU adapter runs
short cloth simulations with finite-particle, movement, pause/reset and device-loss
checks. These establish execution, not converged garment fit or physical-device
performance; hardware/mobile GPU and settled-fit validation remain separate.

**Other carried routes.** Marketing/docs routes and API/server paths outside
the exercised workflows retain their migration status. The GarmentCode endpoint
and process bridge have real generation and failure-boundary coverage.
Collaboration persistence, authorization, shared revisions and sessions have
dedicated unit, runtime and browser coverage; the current integrated results
are recorded in [the comparison](docs/fabra-comparison.md#current-completion-tranche-final-verification).

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
