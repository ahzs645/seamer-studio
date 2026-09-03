# body-model

The body both [seamer-studio](https://github.com/ahzs645/seamer-studio) and
knitterer put clothes on, as one package so there is one of it. Plain ES
modules with no dependencies, and the model's files come with it, so it runs in
a browser, in Node, and inside either app's own renderer.

Both apps consume this as a git submodule, so a change here is a change in both
once the submodule is moved forward.

```
git submodule add https://github.com/ahzs645/body-model vendor/body-model
```

## What it holds

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
- **Poses.** `baseModel.poses` has `T`, `BentArm` and `Sitting`; `armsUpPose`
  here is a hands-in-the-air preset built on `T`.

Units are metres, +Y up, as stored; callers scale. TypeScript declarations sit
next to the source.

## Loading

`models/` holds the eight files the loaders read; the binary formats are
documented in `src/assets.js`.

In Node, off disk, with no folder to name:

```js
import { loadBodyModelFromDisk } from "./vendor/body-model/src/node.js";

const model = await loadBodyModelFromDisk(undefined, { gender: "male" });
```

In a browser, from wherever the app serves them:

```js
import { loadBodyModel } from "./vendor/body-model/src/index.js";

const model = await loadBodyModel("/models/", { gender: "male" });
```

`loadBodyModel()` with no folder reads `models/` relative to its own module URL,
which is what a bundler that treats the package as source wants. An app that
copies the files to a static route passes that route instead.

## A whole body, start to finish

```js
import {
  reconstructVertices,
  meanCoefficients,
  createSkeleton,
  poseVertices,
  armsUpPose,
} from "./vendor/body-model/src/index.js";

const means = meanCoefficients(model.baseModel, model.statistics);
const rest = reconstructVertices(model.baseModel, model.coefficients, means);
const skeleton = createSkeleton(model.baseModel, rest);
const posed = poseVertices(skeleton, rest, model.skin, armsUpPose(model.baseModel, 1.1));
```

## Tests

```
node test/body-model.test.mjs
```

Plain Node, no runner: the mean male comes out man-sized and mirrored, the
skeleton has its fifty-two bones inside the body, skinning at rest moves
nothing, the T pose holds the arms level, and hands-up lifts the mesh without
moving the hips.

MIT.
