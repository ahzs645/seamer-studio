# Independent garment checks

Run from the repository root with its Node dependencies installed. These scripts consume frozen actual body/cloth coordinates; they never solve, hide geometry, repair garments, or declare an interim trajectory settled.

```sh
node scripts/garmentcode/qa/region-guard.mjs frozen.json regions.json previous-frozen.json
node scripts/garmentcode/qa/inspect-all-self-contacts.mjs frozen.json regions.json self.json
node scripts/garmentcode/qa/open-sleeve-guard.mjs frozen.json openings.json
node scripts/garmentcode/qa/shoulder-wear-guard.mjs frozen.json shoulders.json
node scripts/garmentcode/qa/motion-window-audit.mjs evidence.json motion.json
node scripts/garmentcode/qa/evaluate-acceptance.mjs evidence.json acceptance.json
node scripts/garmentcode/qa/finite-body-contact-probe.mjs rejected-raw.json regions.json finite-features.json
node --test scripts/garmentcode/qa/qa.test.mjs
```

`previous-frozen.json` is optional. Run the opening guard only for garments whose sleeve/cuff openings reach the wrists; short sleeves use the whole-body guard. The shoulder guard is required for upper garments and dresses. An absent applicable report fails acceptance.

The evidence manifest identifies `frozen`, `regionGuard`, `selfContacts`, optional applicable `openingGuard` and `shoulderGuard`, and `renderVerification` files. Reports and rendered geometry must reference that exact final frozen checkpoint. It explicitly supplies `runHalted:false`, `openingsApplicable`, `shoulderApplicable`, `waistbandApplicable`, nonempty `requiredCoveredRegions`, `sewing.fullyEnabled`, `release.windows`, `waistSupport` when applicable, and `freshness`. The benchmark writes this evidence; independent final renders supply the render verification.

Required regions depend on the actual style. For the current matrix: tee covers neck/underarms/waist; long shirt and hoodie additionally wrists/forearms; skirt covers waist/hips/pelvis; pants additionally crotch/thighs/calves; sleeveless dress covers neck/underarms/waist/hips/pelvis. Each named region must have anatomical metadata and actual cloth coverage. An uncovered region cannot pass by returning zero intersections.

Final limits are fixed: no inside particles or finite cloth/body crossings; whole sewn seams no more than 3mm apart; no nonadjacent self crossings or crossings next to an unclosed paired seam; hand sections contained by their actual openings with nonnegative clearance and no hand/wrist/forearm crossings. Only finite contacts within 5mm of BOTH matching closed seam sides and actual paired topology are classified as sewing contacts. `local-seam-gap-probe.mjs frozen.json self.json local.json` diagnoses locally closed stitch segments during assembly; its classification does **not** relax the whole-seam final limit.

Shoulder stitches must be source semantic neck/armhole-adjacent pairs, represented by the actual assembly groups. Frozen `bodyAnatomicalReferences.neckSideToShoulder` and `neckToWaistBack` contain native barycentric coordinates and actual posed points. The guard independently reconstructs these points from the frozen body mesh; missing, invalid, or mismatched annotations fail. The lateral neck and shoulder-tip anchors bound shoulder X, and the actual nape anchor bounds shoulder height. Source `neck_w` is a back-neck trace length and is never treated as a physical diameter. Each final paired midpoint must lie inside this anatomical span, with both stitch endpoints on their original anatomical side, within 10mm of the actual shoulder crest at that X inside the original front/back span. Flat source panel X positions are assembly seeds; their rigid placement preserves the 2D rest cut and does not constrain final medial draping. Seed-X drift is reported as a diagnostic. Skin crest is computed from actual body triangles between the verified actual nape and 200mm below it; there is no nearest-whole-body fallback. Height loss is bounded at 10mm. This allowance derives from the assembly 8mm skin offset and source 0.5mm fabric thickness. Both shoulders must be observed; floor, off-body, arm, wrong-side, and cross-neck substitutes fail.

Acceptance also requires two contiguous independent 128ms windows, every frame observed, at full gravity with no temporary support or fixed anchors, all four contact mechanisms enabled, runtime safety true, no halt, and closed seams throughout. Each nine-frame window compares all 36 pairs of frames: maximum pairwise RMS displacement must be at most 1mm and maximum pairwise per-particle displacement at most 3mm. A large oscillation returning to its starting position cannot pass. Start-to-end measurements remain diagnostics. Waist interfaces require confirmed source target and maximum per-particle level and post-release drift at most 10mm; a small average cannot hide a tilted ring.

The evidence manifest includes `motionSamples:{staticSource,samples:[{frame,file}]}` and `motionAudit`. The final two windows each list nine consecutive `sampleFrames`, `motionMetric:"maximum-all-frame-pairs"`, and `comparedFramePairs:36`; together they bind 17 distinct exact samples. The independent auditor reconstructs motion from coordinates, checks immutable source/body/topology agreement, verifies the last sample matches the final checkpoint, and reruns finite body/self, required coverage, applicable openings/shoulders and waist location guards for **every** intermediate sample. The evaluator recomputes this audit instead of trusting asserted helper metrics. Missing samples fail closed. Old runs cannot retroactively supply unrecorded intermediate observations.

Samples may be complete frozen files or compact JSON with a `staticSource` relative/absolute reference and exact per-frame positions/state. `frozen-sample.mjs` inherits only immutable source geometry and topology. Runtime safety, contact flags, gravity, sewing completion, supports, frame/time, and cloth positions must come from the sample; safe defaults are never inherited from the static seed. This permits portable storage with one shared body/topology snapshot.

Fresh arrangement, zero reused cached particles, verified current source body and assembly revisions, and source fingerprints are required. Exact final app rendering must reproduce every cloth and body coordinate within 0.01mm and have no page errors. Missing observations reject; motion alone cannot accept a garment that has fallen onto the floor.

Limits: finite noncoplanar triangle checks do not certify entirely coplanar overlap or all continuous trajectories. Opening projection requires interpreting the reported nonplanarity. A passing frozen snapshot certifies these explicit observations, not an exact reproduction of the upstream dataset simulator or an unmeasured dataset record.

For stopped simulations, diagnose the exact raw rejected candidate, not the returned last-safe rollback snapshot. A raw replay is explicitly a different trajectory. The finite feature probe reports both cloth-edge/body-face and body-edge/cloth-face intersections, finite projection membership, triangle winding alignment, vertex skin clearances, and edge lengths. Infinite plane depths outside the finite facet are diagnostics and cannot be reported as penetration depth.

The overall run must explicitly have completed without a guard halt. A safe last-accepted rollback snapshot cannot certify a halted run; exact rejected-candidate coordinates and safety reports are separate diagnostic artifacts.

Body parity retains every strictly interior triangle hit, including real entry/exit pairs closer than a micrometre. Only the same actual geometric edge/vertex, same oriented crossing, and machine-scale identical hit distance coalesce. Opposing crossings never merge. This numerical correction preserves the zero-disagreement requirement; a majority vote does not waive uncertainty.

Final motion evidence also requires packed actual substep paths for every one of the 16 frame intervals spanning the 17 published samples. Each ending frozen sample supplies `particleTrajectory`: `file`, `sha256`, `format:"float32-le-vec4"`, `byteLength`, `sampleCount`, `subSteps`, `particleCount`, `fromFrame`, `toFrame`, consecutive `stepIndices`, `inputSha256`, and SHA256 values named `startPositionsSha256`, `endPositionsSha256`, `bodyPositionsSha256`, `bodyIndicesSha256`, `clothTrianglesSha256`, and `sourceFingerprintsSha256`. Numeric hashes use explicit little-endian Float32 body coordinates and Uint32 topology; fingerprint hashes use recursively key-sorted JSON. A 40-substep frame stores 41 position arrays: the exact published starting state and every corrected substep endpoint. All inverse masses remain identical. Binary paths can be relative to the ending frozen sample.

`particle-trajectory-audit.mjs` verifies actual bytes, dimensions, source hashes, consecutive step annotations, finite values, invariant inverse masses, and exact published starting/ending coordinates. It independently reloads each path and calls the strict CPU `ClothCollisionGuard.inspectTrajectory` API on all 41 static geometries and 40 consecutive particle segments. This artifact verification is independent of the GPU contact solver, but shares the production CPU guard's triangle algorithm; the 17 separate published-sample region/self/opening/shoulder/waist audits remain required. Clear endpoints cannot replace missing trajectories, and an unrecorded curved path cannot waive a coarse-chord rejection. This certifies the recorded substep geometries and particle segments, not continuous moving cloth-edge/face collision detection. Node 22.18 or later is required to load the pure TypeScript CPU guard through native type stripping.


Source assembly completion is mandatory whenever an artifact or manifest explicitly
requires it, or the artifact carries actual source-body/staging, source stretch,
SI physical material/delta, or joint execution provenance. An explicit false cannot
opt out of a requirement derived from those source fields. This preserves native
artifacts with no source provenance and prevents a new solver policy from dropping
the legacy stretch marker to bypass source assembly completion.

Compact samples bind `sourceAssemblyRequired`, SI physical membrane/material and
preparation policy, material policy SHA, delta and joint policies, source execution
and pressure bindings, and the actual browser body replay/fingerprint context as
immutable fields. Current-frame geometry proof, commit receipts, support weights,
assembly completion, and pressure history observations remain explicit sample
fields and are never inherited as safe defaults. Host execution adapters must
validate actual SI/joint commit receipts against the corresponding frame geometry,
source, body and proof-used seam gate; this geometric acceptance CLI does not turn
an unvalidated physical-backend receipt or `motionCandidate` into engine authority.
