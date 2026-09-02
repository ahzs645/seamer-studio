// The skeleton, and skinning the mesh to it.
//
// Every joint is a weighted combination of four mesh vertices, so the skeleton
// is derived from whatever body the shape parameters produce rather than
// stored for one of them. Bones have a parent and a rest rotation (XYZ Euler,
// radians); a bone's rest position is its joint's world position expressed in
// its parent's rest frame. A pose is a set of absolute XYZ Euler rotations for
// some bones; the rest keep their rest rotation.
//
// Matrices are column-major 4×4 in Float64Array(16), the same layout three.js
// uses, so its Euler and compose formulas apply unchanged.

function identity() {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function multiply(a, b, out = new Float64Array(16)) {
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      out[column * 4 + row] =
        a[row] * b[column * 4] +
        a[4 + row] * b[column * 4 + 1] +
        a[8 + row] * b[column * 4 + 2] +
        a[12 + row] * b[column * 4 + 3];
    }
  }
  return out;
}

// A rigid transform: rotation from XYZ Euler angles, then translation.
function rigid(position, euler, out = new Float64Array(16)) {
  const a = Math.cos(euler[0]);
  const b = Math.sin(euler[0]);
  const c = Math.cos(euler[1]);
  const d = Math.sin(euler[1]);
  const e = Math.cos(euler[2]);
  const f = Math.sin(euler[2]);
  const ae = a * e;
  const af = a * f;
  const be = b * e;
  const bf = b * f;
  out[0] = c * e;
  out[4] = -c * f;
  out[8] = d;
  out[1] = af + be * d;
  out[5] = ae - bf * d;
  out[9] = -b * c;
  out[2] = bf - ae * d;
  out[6] = be + af * d;
  out[10] = a * c;
  out[3] = 0;
  out[7] = 0;
  out[11] = 0;
  out[12] = position[0];
  out[13] = position[1];
  out[14] = position[2];
  out[15] = 1;
  return out;
}

// The inverse of a rigid transform: transposed rotation, negated translation.
function invertRigid(m, out = new Float64Array(16)) {
  out[0] = m[0];
  out[1] = m[4];
  out[2] = m[8];
  out[4] = m[1];
  out[5] = m[5];
  out[6] = m[9];
  out[8] = m[2];
  out[9] = m[6];
  out[10] = m[10];
  out[3] = out[7] = out[11] = 0;
  out[12] = -(out[0] * m[12] + out[4] * m[13] + out[8] * m[14]);
  out[13] = -(out[1] * m[12] + out[5] * m[13] + out[9] * m[14]);
  out[14] = -(out[2] * m[12] + out[6] * m[13] + out[10] * m[14]);
  out[15] = 1;
  return out;
}

function transformPoint(m, point, out = [0, 0, 0]) {
  const [x, y, z] = point;
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}

function jointWorldPosition(positions, bone) {
  const point = [0, 0, 0];
  for (let index = 0; index < bone.indices.length; index++) {
    const at = bone.indices[index] * 3;
    const weight = bone.weights[index];
    point[0] += positions[at] * weight;
    point[1] += positions[at + 1] * weight;
    point[2] += positions[at + 2] * weight;
  }
  return point;
}

// The skeleton for one rest shape: bones in the model's order, each with its
// parent index, rest rotation, local rest position, rest world matrix and the
// inverse that takes a rest vertex into the bone's frame.
function createSkeleton(baseModel, restVertices) {
  const names = baseModel.bones.map(([name]) => name);
  const indexOf = new Map(names.map((name, index) => [name, index]));
  const bones = baseModel.bones.map(([name, data]) => ({
    name,
    parent: data.parent ? indexOf.get(data.parent) ?? -1 : -1,
    rotation: [data.rotation[0], data.rotation[1], data.rotation[2]],
    indices: data.indices,
    weights: data.weights,
    position: [0, 0, 0],
    world: identity(),
    bindInverse: identity(),
  }));
  // Parents come before children in the model's order for every bone but
  // the ones listed after their parent; walk in dependency order regardless.
  const placed = new Array(bones.length).fill(false);
  const place = (index) => {
    if (placed[index]) {
      return;
    }
    const bone = bones[index];
    const world = jointWorldPosition(restVertices, bone);
    if (bone.parent >= 0) {
      place(bone.parent);
      bone.position = transformPoint(invertRigid(bones[bone.parent].world), world);
      multiply(bones[bone.parent].world, rigid(bone.position, bone.rotation), bone.world);
    } else {
      bone.position = world;
      rigid(bone.position, bone.rotation, bone.world);
    }
    invertRigid(bone.world, bone.bindInverse);
    placed[index] = true;
  };
  for (let index = 0; index < bones.length; index++) {
    place(index);
  }
  return { bones, indexOf, poses: baseModel.poses ?? {} };
}

// World matrices for a pose: absolute XYZ Euler rotations by bone name, the
// rest rotation for any bone not named.
function poseWorldMatrices(skeleton, pose = {}) {
  const { bones } = skeleton;
  const worlds = bones.map(() => identity());
  const done = new Array(bones.length).fill(false);
  const local = new Float64Array(16);
  const solve = (index) => {
    if (done[index]) {
      return;
    }
    const bone = bones[index];
    const said = pose[bone.name];
    const rotation = said ? [said.x ?? 0, said.y ?? 0, said.z ?? 0] : bone.rotation;
    if (bone.parent >= 0) {
      // The parent first, and the local matrix only after: `local` is one
      // scratch matrix and the recursion would overwrite it.
      solve(bone.parent);
      rigid(bone.position, rotation, local);
      multiply(worlds[bone.parent], local, worlds[index]);
    } else {
      rigid(bone.position, rotation, worlds[index]);
    }
    done[index] = true;
  };
  for (let index = 0; index < bones.length; index++) {
    solve(index);
  }
  return worlds;
}

// Where every joint is in a pose, by bone name.
function jointWorldPositions(skeleton, pose = {}) {
  const worlds = poseWorldMatrices(skeleton, pose);
  const out = new Map();
  skeleton.bones.forEach((bone, index) => {
    out.set(bone.name, [worlds[index][12], worlds[index][13], worlds[index][14]]);
  });
  return out;
}

// Linear-blend skinning: each vertex is carried by up to four bones, weighted.
function poseVertices(skeleton, restVertices, skin, pose = {}, out = new Float32Array(restVertices.length)) {
  const worlds = poseWorldMatrices(skeleton, pose);
  const skinMatrices = skeleton.bones.map((bone, index) => multiply(worlds[index], bone.bindInverse));
  const count = restVertices.length / 3;
  const blend = new Float64Array(16);
  const point = [0, 0, 0];
  for (let vertex = 0; vertex < count; vertex++) {
    blend.fill(0);
    let total = 0;
    for (let slot = 0; slot < 4; slot++) {
      const weight = skin.weights[vertex * 4 + slot];
      if (!(weight > 0)) {
        continue;
      }
      const matrix = skinMatrices[skin.indices[vertex * 4 + slot]];
      if (!matrix) {
        continue;
      }
      for (let element = 0; element < 16; element++) {
        blend[element] += matrix[element] * weight;
      }
      total += weight;
    }
    const at = vertex * 3;
    if (!(total > 0)) {
      out[at] = restVertices[at];
      out[at + 1] = restVertices[at + 1];
      out[at + 2] = restVertices[at + 2];
      continue;
    }
    point[0] = restVertices[at];
    point[1] = restVertices[at + 1];
    point[2] = restVertices[at + 2];
    transformPoint(blend, point, point);
    out[at] = point[0];
    out[at + 1] = point[1];
    out[at + 2] = point[2];
  }
  return out;
}

// Hands in the air: the T pose's shoulders, and the upper arms turned on up
// from horizontal. `lift` is how far above horizontal, in radians; the upper
// arm bone's own x axis is the one that lifts it, negative on both sides
// (measured: −0.8 on the right arm takes the hand from 1.46 m to 1.83 m).
function armsUpPose(baseModel, lift = 1.0) {
  const t = baseModel.poses?.T ?? {};
  const left = t.mixamorigLeftArm ?? { x: 0, y: 0, z: 0 };
  const right = t.mixamorigRightArm ?? { x: 0, y: 0, z: 0 };
  return {
    ...t,
    mixamorigLeftArm: { x: left.x - lift, y: left.y, z: left.z },
    mixamorigRightArm: { x: right.x - lift, y: right.y, z: right.z },
  };
}

export {
  createSkeleton,
  poseWorldMatrices,
  jointWorldPositions,
  poseVertices,
  armsUpPose,
  jointWorldPosition,
  rigid,
  multiply,
  invertRigid,
  transformPoint,
};
