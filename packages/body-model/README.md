# @seamer/body-model

The body both seamer-studio and knitterer put clothes on, as one package so
there is one of it. Plain ES modules with no dependencies, so it runs in a
browser, in Node, and inside either app's own renderer.

What it holds, all read from `static/models/` at the repository root:

- **Shape.** `reconstructVertices(baseModel, coefficients, values)` evaluates
  the mesh from seventeen measurements (age, height, chest girth, ...) as an
  affine map per vertex, mirrored across `x = 0`. `male_model.json` and
  `female_model.json` carry the means and covariances the sliders start from.
- **Skeleton.** `createSkeleton(baseModel, restVertices)` derives the 52-bone
  Mixamo-named skeleton from the mesh: each joint is a weighted combination of
  four vertices, so it moves with the body's shape, and each bone has a parent
  and a rest rotation.
- **Skinning.** `poseVertices(skeleton, restVertices, skin, pose)` applies a
  pose (absolute XYZ Euler rotations for any subset of bones) and bakes
  linear-blend skinning, four bones per vertex. `jointWorldPositions` says where
  every joint ended up.
- **Poses.** `baseModel.poses` has `T`, `BentArm` and `Sitting`; `armsUp` here
  is a hands-in-the-air preset built on `T`.

Units are metres, +Y up, as stored; callers scale. The binary formats are
documented in `src/assets.js`.

knitterer consumes this package through a git submodule at
`vendor/seamer-studio`, so a change here is a change there once the submodule
is moved forward.
