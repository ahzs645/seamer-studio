// Plain Node, no runner: `node packages/body-model/test/body-model.test.mjs`.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
import {
  loadBodyModel,
  reconstructVertices,
  meanCoefficients,
  createSkeleton,
  poseVertices,
  jointWorldPositions,
  armsUpPose,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const folder = resolve(here, "..", "..", "..", "static", "models");
const fetchJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const fetchBytes = async (path) => {
  const bytes = await readFile(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

let passed = 0;
const test = (name, run) => {
  try {
    const said = run();
    console.log(`  PASS  ${name}${said ? ` — ${said}` : ""}`);
    passed += 1;
  } catch (error) {
    console.log(`  FAIL  ${name} — ${error.message}`);
    process.exitCode = 1;
  }
};

const model = await loadBodyModel(folder, { gender: "male", fetchJson, fetchBytes });
const means = meanCoefficients(model.baseModel, model.statistics);
const rest = reconstructVertices(model.baseModel, model.coefficients, means);
const skeleton = createSkeleton(model.baseModel, rest);
const highest = (positions) => {
  let top = -Infinity;
  for (let index = 1; index < positions.length; index += 3) {
    top = Math.max(top, positions[index]);
  }
  return top;
};

test("the mean male is a man-sized mesh, mirrored across x = 0", () => {
  assert.equal(rest.length / 3, model.skin.indices.length / 4, "skin quads per vertex");
  const height = highest(rest);
  assert.ok(height > 1.7 && height < 1.85, `top of head at ${height.toFixed(3)} m`);
  const { pairs } = model.baseModel.symmetry;
  let worst = 0;
  for (const [a, b] of pairs) {
    worst = Math.max(worst, Math.abs(rest[a * 3] + rest[b * 3]), Math.abs(rest[a * 3 + 1] - rest[b * 3 + 1]));
  }
  assert.ok(worst < 1e-6, `mirror pairs disagree by ${worst}`);
  return `${rest.length / 3} vertices, ${height.toFixed(3)} m tall`;
});

test("the skeleton has fifty-two bones on one root and every joint is inside the body", () => {
  assert.equal(skeleton.bones.length, 52);
  assert.equal(skeleton.bones.filter((bone) => bone.parent < 0).length, 1, "roots");
  const joints = jointWorldPositions(skeleton, {});
  const hips = joints.get("mixamorigHips");
  const head = joints.get("mixamorigHead");
  assert.ok(hips[1] > 0.8 && hips[1] < 1.1, `hips at ${hips[1].toFixed(2)} m`);
  assert.ok(head[1] > 1.5 && head[1] < 1.75, `head at ${head[1].toFixed(2)} m`);
  return `hips ${hips[1].toFixed(2)} m, head ${head[1].toFixed(2)} m`;
});

test("skinning at rest leaves every vertex where it was", () => {
  const posed = poseVertices(skeleton, rest, model.skin, {});
  let drift = 0;
  for (let index = 0; index < rest.length; index++) {
    drift = Math.max(drift, Math.abs(posed[index] - rest[index]));
  }
  assert.ok(drift < 1e-5, `drift ${drift}`);
  return `drift ${drift.toExponential(1)} m`;
});

test("the T pose holds the arms out level with the shoulders", () => {
  const joints = jointWorldPositions(skeleton, model.baseModel.poses.T);
  const shoulder = joints.get("mixamorigRightArm");
  const hand = joints.get("mixamorigRightHand");
  assert.ok(Math.abs(hand[1] - shoulder[1]) < 0.08, `hand ${hand[1].toFixed(2)} m against shoulder ${shoulder[1].toFixed(2)}`);
  assert.ok(Math.abs(hand[0] - shoulder[0]) > 0.45, `hand only ${Math.abs(hand[0] - shoulder[0]).toFixed(2)} m out`);
  return `hand ${Math.abs(hand[0] - shoulder[0]).toFixed(2)} m out, ${(hand[1] - shoulder[1]).toFixed(2)} m up`;
});

test("hands up puts both hands above the head and the mesh follows", () => {
  const pose = armsUpPose(model.baseModel, 1.1);
  const joints = jointWorldPositions(skeleton, pose);
  const head = joints.get("mixamorigHead");
  for (const side of ["Left", "Right"]) {
    const hand = joints.get(`mixamorig${side}Hand`);
    assert.ok(hand[1] > head[1] + 0.15, `${side} hand at ${hand[1].toFixed(2)} m, head ${head[1].toFixed(2)}`);
  }
  const posed = poseVertices(skeleton, rest, model.skin, pose);
  assert.ok(highest(posed) > highest(rest) + 0.2, `the mesh only reaches ${highest(posed).toFixed(2)} m`);
  // The trunk did not move: the hips' vertices are where they were.
  const hipsBone = skeleton.bones[skeleton.indexOf.get("mixamorigHips")];
  for (const vertex of hipsBone.indices) {
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(posed[vertex * 3 + axis] - rest[vertex * 3 + axis]) < 1e-5, "the hips moved");
    }
  }
  return `mesh top ${highest(posed).toFixed(2)} m against ${highest(rest).toFixed(2)} at rest`;
});

console.log(`${passed} passed`);
