# GarmentCode generation bridge

This bridge runs the real [GarmentCode](https://github.com/maria-korosteleva/GarmentCode)
`MetaGarment` generator and returns its sewing pattern specification. It supports
made-to-measure t-shirts, hoodies, skirts, pants and dresses. It preserves curved
edges, stitch references, panel labels and initial 3D panel placement.

Geometry generation uses CPU Python and needs neither Maya/Qualoth nor Warp/GPU.
It does **not** simulate sewn cloth. Seamer imports the resulting specification
for editing and panel rendering; physically draped simulation is a separate step.

## Isolated installation

Use Python 3.12. The tested upstream revision is
`d449629979028123a5c4dc9e732a2ec19b7fce31` (upstream MIT license).
Install into a virtual environment, outside the application dependency tree:

```sh
git clone https://github.com/maria-korosteleva/GarmentCode.git work/GarmentCode
git -C work/GarmentCode checkout d449629979028123a5c4dc9e732a2ec19b7fce31
python3.12 -m venv work/garmentcode-venv
work/garmentcode-venv/bin/python -m pip install -r scripts/garmentcode/requirements.txt
export GARMENTCODE_ROOT="$PWD/work/GarmentCode"
export GARMENTCODE_PYTHON="$PWD/work/garmentcode-venv/bin/python"
```

CairoSVG is imported by upstream even though this bridge does not invoke image
export. Linux generally supplies its native Cairo dependency; if unavailable,
install your OS's Cairo runtime. No upstream `system.json` is required and upstream
source is not modified. The provided requirements pin direct geometry dependencies;
transitive dependency versions are selected by pip.

For the Node generation endpoint, these deployment-owned environment variables
select the trusted upstream checkout and interpreter. A static-only deployment can
import saved specifications but cannot run the Python generator.

## JSON boundary

```sh
"$GARMENTCODE_PYTHON" scripts/garmentcode/generate.py <<'JSON' > t-shirt.json
{
  "preset": "t-shirt",
  "body": {"bust": 104, "waist": 90, "hips": 108},
  "design": {"sleeve": {"length": 0.6}, "shirt": {"width": 1.1}}
}
JSON
```

`preset` defaults to `t-shirt`. `body` merges supplied upstream measurement names
with `assets/bodies/mean_all.yaml` defaults. Lengths/circumferences are in
centimetres; angles are degrees. Omitted measurements remain the neutral defaults,
so supply a consistent measured set for an actual wearer. Derived `_` measurements
are calculated by upstream and cannot be overridden.

`design` is a nested subset of the upstream design schema. Leaves accept scalars
or `{ "v": value }`; schema/range/type metadata cannot be overridden. The bridge
rejects unknown fields, out-of-range values, duplicate JSON keys, non-finite numbers,
empty/intersecting garments and invalid stitch references. Upstream geometric
constraints can reject some combinations even when individual values are in range.
Requests cannot choose classes, Python modules or file paths. Enum values are
restricted to the upstream schema, including `meta.upper`, `meta.bottom` and collar
component selections that upstream uses to choose its own fixed classes.

The `dress` preset joins an upstream loose `Shirt` block to a `StraightWB` waist
band and `Skirt2`. Its default `shirt.length` is `1.0`, the waist-length ratio;
the earlier `0.8` default created a cropped torso, and its measured test drape
lifted the band above the waist after temporary supports released. This changes
newly generated defaults only.
Explicit `design.shirt.length: 0.8`, saved choices, and imported cuts retain their
source geometry. Length is an upstream drafting parameter, not a guarantee of fit
on the approximate avatar; corrected garments still require a fresh drape check.

Success is exactly one JSON document on stdout: the upstream specification with
`pattern.panels`, `pattern.stitches`, `properties.units_in_meter` (100 for this
generator), `parameters`, and `parameter_order`. Upstream diagnostics go to stderr.
Generated files also retain `properties.garmentcode_body`: all resolved drafting
measurements, including neutral defaults for omitted fields. Seamer uses these to
calibrate its existing avatar's actual height and anatomical landmark placement.
This approximates source dimensions, rather than reproducing the upstream body
mesh or guaranteeing an exact fit. Editing avatar measurements invalidates that
calibration. Generate again to establish a new garment/body match.
Exit 2 means invalid input; exit 1 means a dependency/configuration/generation error.
The caller must enforce its execution timeout and output size limit.

Inspect accepted measurements, defaults and design ranges:

```sh
"$GARMENTCODE_PYTHON" scripts/garmentcode/generate.py --describe
```

This returns `presets`, `body`, `design`, and `testedUpstreamRevision` (the revision
verified by this integration; it is not a runtime checkout inspection).

Run strict boundary checks and real generation tests:

```sh
"$GARMENTCODE_PYTHON" -m unittest discover -s scripts/garmentcode -p 'test_*.py' -v
```

Without `GARMENTCODE_ROOT`, generation integration tests skip; boundary tests still
run. Generation tests cover all five presets, valid directed boundaries/stitches,
body measurement changes and sleeve-style changes.

## Reproduce the garment coverage matrix

[`matrix.json`](matrix.json) contains five exact requests: short sleeves at 164 cm,
long sleeves without cuffs at 176 cm, a skirt at 170 cm, trousers at 183 cm, and a
sleeveless dress at 176 cm. Run the helper with the same isolated Python environment
and trusted `GARMENTCODE_ROOT` used by the generator:

```sh
"$GARMENTCODE_PYTHON" scripts/garmentcode/generate_matrix.py work/garment-matrix \
  --include-bundled-examples
```

The helper writes each input request, generated specification, diagnostic log and a
manifest with hashes, resolved measurement counts, panel/stitch counts, limitations,
tested upstream revision and observed revision when git metadata is available. It
sets `PYTHONHASHSEED=0`, sorts JSON object keys and whole stitch records for stable
fixture ordering, retains raw upstream output separately as `.upstream.json`, and
runs three CPU
generators concurrently, allows 90 seconds per fixture and exits
nonzero if any fixture fails. Successful generated files include complete resolved
body metadata. Existing output files with matching names are replaced on success.

The optional flag copies four original upstream examples (shirt, hoodie, pencil
dress and jumpsuit) byte-for-byte. Their source body measurements are absent and
are not inferred. These are bundled upstream examples and newly generated presets,
**not verified records from the released GarmentCodeData dataset**. The helper does
not download data, reproduce released material batches or run cloth simulation.
The matrix's varying heights test calibration while omitted dimensions remain
neutral defaults. Generated pants explicitly record the upstream apart-leg pose
in `properties.garmentcode_body_pose`; other styles record `straight`. The existing
avatar approximates source crotch height, apart-leg stance and upper-thigh
circumference using bounded deformations. It still differs from the upstream
body mesh, so test fresh drapes independently.

Only the matrix helper canonicalizes JSON object and stitch-list ordering. It
preserves explicit assembly/panel-order arrays, every panel vertex/edge array,
directed stitch endpoints, orientation flags and all measurements. Production
`generate.py` and the importer keep their existing behavior. Canonical container
ordering can change cloth preparation or staged sewing order, so it does not imply
an identical simulation trajectory to a raw fixture. The original fixtures used
for the current GPU matrix remain frozen raw upstream outputs; their hashes and
metrics refer to those files. Use a fresh output directory for comparison runs.

With a running development server and WebGPU-capable Chromium, the retained
browser runner can check the generated fixtures sequentially:

```sh
CHROMIUM_PATH=/usr/bin/chromium node scripts/check-garment-matrix.mjs \
  --fixtures work/garment-matrix --base-url http://127.0.0.1:4173 \
  --frames 24 --spacing 40 --output work/garment-matrix-check
```

Adjust the browser path and server URL for your environment. Add `--fixture
pants-183` to select one case. The runner verifies input hashes and records the
exact source order, body/topology, contacts, free-anchor state, source fingerprints,
OBJ checkpoints and motion/seam metrics. Choose a new output directory when
comparing runs. These bounded coarse runs check execution and geometry; they do
not certify settled fit or reproduce the dataset simulation conditions.

For a fresh run at the application's 15 mm import spacing, require unassisted
settling observations rather than stopping at a fixed short preview:

```sh
CHROMIUM_PATH=/usr/bin/chromium node scripts/check-garment-matrix.mjs \
  --fixtures work/garment-matrix --base-url http://127.0.0.1:4173 \
  --frames 160 --spacing 15 --until-settled \
  --output work/garment-fit-check
```

This records every eligible frame for two adjacent motion windows and preserves
rejected candidate coordinates separately from the last safe displayed state.
The [independent acceptance checks](qa/README.md) also require body clearance,
closed seams, anatomical placement and support release throughout those windows.
Acceptance remains incomplete until the final frozen garment and body have been
rendered and their actual coordinates independently verified.

Screen a frozen checkpoint for body intersections without running another GPU
simulation:

```sh
node scripts/check-garment-geometry.mjs \
  work/garment-matrix-check/pants-183-40mm/frame-24-frozen.json \
  work/pants-body-geometry-report.json
```

The report includes finite positions, body manifold edges, three-ray interior
particle classification, bidirectional cloth/body facet intersections and the
worst active seam. Add `--require-clear` to exit nonzero when body intersections,
parity disagreement or nonmanifold body geometry are detected. This screen does
not inspect cloth self-intersections, anatomical coverage, sleeve opening
containment, coplanar overlaps, contact thickness or convergence. Zero interior
particles alone does not rule out a body crossing the interior of a coarse cloth
triangle.

For an explicit assembly experiment, `--zero-gravity-frames 10` starts with ten
frames of zero gravity and then uses normal gravity. For example:

```sh
CHROMIUM_PATH=/usr/bin/chromium node scripts/check-garment-matrix.mjs \
  --fixtures work/garment-matrix --fixture dress-sleeveless-176 \
  --frames 24 --spacing 40 --zero-gravity-frames 10 \
  --output work/dress-zero-gravity-benchmark
```

This flag is a nondefault benchmark and does not change the application solver.
At the transition, the public gravity setter updates the existing engine uniform;
positions, previous positions and velocities remain in their original buffers.
The current engine has
no persistent XPBD multipliers or frame counters to restore, and local damping is
disabled in these runs. Parallel GPU computations can also vary between fresh
runs with identical inputs.

Ten frames are 0.16 simulated seconds with this application's timestep, versus
1/6 second in the upstream simulator at 60 frames per second. Only the initial
gravity schedule is changed. Source-calibrated fresh assembly also uses temporary
vertical shoulder/waist supports with measured closure and gradual release;
reference drag and the complete upstream material settings are not reproduced.
Keep both baseline and experimental checkpoints and compare seam closure,
surface intersections and motion before drawing a fit conclusion.
