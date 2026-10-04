// WGSL compute shaders for the XPBD cloth solver. Formulas ported verbatim from the original
// Seamer WebGPU engine; constants are injected from SimConfig. Velocities and lastPositions use
// vec4 storage (the .w lane is padding) to avoid vec3 array-stride pitfalls.

import type { SimConfig } from '../config';
import { finiteContactsWGSL } from './finiteContacts';
import { seamGateWGSL, type SeamGateLayout } from './seamGate';

// Closest point on a finite triangle (Ericson's Voronoi-region tests). Shared by body and
// self collision so both kernels agree at faces, edges, vertices and degenerate triangles.
export const closestPointOnTriangleWGSL = /* wgsl */ `
fn getClosestPointOnSegment(start: vec3f, end: vec3f, point: vec3f) -> vec3f {
  let edge = end - start;
  let lengthSq = dot(edge, edge);
  if (lengthSq <= 1e-20) { return start; }
  return start + edge * clamp(dot(point - start, edge) / lengthSq, 0.0, 1.0);
}

fn getClosestPointOnTriangle(p0: vec3f, p1: vec3f, p2: vec3f, point: vec3f) -> vec3f {
  let ab = p1 - p0; let ac = p2 - p0;
  let normal = cross(ab, ac);
  if (dot(normal, normal) <= 1e-7 * max(dot(ab, ab) * dot(ac, ac), 1e-20)) {
    let a = getClosestPointOnSegment(p0, p1, point);
    let b = getClosestPointOnSegment(p0, p2, point);
    let c = getClosestPointOnSegment(p1, p2, point);
    let da = dot(point - a, point - a);
    let db = dot(point - b, point - b);
    let dc = dot(point - c, point - c);
    if (da <= db && da <= dc) { return a; }
    if (db <= dc) { return b; }
    return c;
  }
  let ap = point - p0;
  let d1 = dot(ab, ap); let d2 = dot(ac, ap);
  if (d1 <= 0.0 && d2 <= 0.0) { return p0; }
  let bp = point - p1;
  let d3 = dot(ab, bp); let d4 = dot(ac, bp);
  if (d3 >= 0.0 && d4 <= d3) { return p1; }
  let vc = d1 * d4 - d3 * d2;
  if (vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0) {
    return p0 + ab * (d1 / (d1 - d3));
  }
  let cp = point - p2;
  let d5 = dot(ab, cp); let d6 = dot(ac, cp);
  if (d6 >= 0.0 && d5 <= d6) { return p2; }
  let vb = d5 * d2 - d1 * d6;
  if (vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0) {
    return p0 + ac * (d2 / (d2 - d6));
  }
  let va = d3 * d6 - d5 * d4;
  if (va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0) {
    return p1 + (p2 - p1) * ((d4 - d3) / (d4 - d3 + d5 - d6));
  }
  let inverse = 1.0 / (va + vb + vc);
  return p0 + ab * (vb * inverse) + ac * (vc * inverse);
}`;

const WG = 64;
export const WORKGROUP_SIZE = WG;

/** Predict step: save last position, reset correction, apply gravity, integrate. */
export function integrateWGSL(cfg: SimConfig): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> velocities: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> lastPositions: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> positionCorrection: array<vec4f>;
@group(0) @binding(4) var<storage, read> anchors: array<vec4f>;
struct SimParams { anchorScale: f32, gravityScale: f32, p1: f32, p2: f32 };
@group(0) @binding(5) var<uniform> simParams: SimParams;
@group(0) @binding(6) var<storage, read> positions2d: array<vec4f>;
struct DynamicConfig { grabbing: f32, grabIndex: f32, dragInfluenceRadius: f32, _pad: f32, grabPosition: vec3f, _pad2: f32 };
@group(0) @binding(7) var<uniform> dynamicConfig: DynamicConfig;

const gravity = vec3f(${cfg.gravity[0]}, ${cfg.gravity[1]}, ${cfg.gravity[2]});
const deltaT = ${cfg.deltaT}f;
const maxVelocity = ${cfg.maxVelocity}f;
const anchorStrength = 0.12;

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= arrayLength(&positions)) { return; }
  var pos = positions[index].xyz;
  lastPositions[index] = vec4f(pos, 0.0);
  positionCorrection[index] = vec4f(0.0);
  let invMass = positions[index].w;
  var vel = velocities[index].xyz + gravity * simParams.gravityScale * deltaT;
  if (invMass <= 0.0) { vel = vec3f(0.0); }
  velocities[index] = vec4f(vel, 0.0);
  pos += vel * deltaT;

  // Interactive grab: pull the grabbed particle (and same-piece neighbours within dragInfluenceRadius,
  // by 2D pattern distance) toward the drag target, with linear falloff. Same-piece keeps it stable —
  // a 3D cross-piece grab imparts momentum to a large multi-piece blob and flings the free garment off.
  // Adjacent panels follow through their seams.
  var grabInfluence = 0.0;
  if (dynamicConfig.grabbing > 0.0 && invMass > 0.0) {
    let grabbedIndex = u32(dynamicConfig.grabIndex);
    if (positions2d[grabbedIndex].w == positions2d[index].w) {
      let dist2d = distance(positions2d[index].xy, positions2d[grabbedIndex].xy);
      grabInfluence = max(0.0, 1.0 - dist2d / dynamicConfig.dragInfluenceRadius);
      if (grabInfluence > 0.0) {
        var grabbedDelta = dynamicConfig.grabPosition - lastPositions[grabbedIndex].xyz;
        let maxGrabbedDelta = maxVelocity * 0.5 * deltaT;
        if (length(grabbedDelta) > maxGrabbedDelta) { grabbedDelta = normalize(grabbedDelta) * maxGrabbedDelta; }
        pos += grabbedDelta * grabInfluence;
      }
    }
  }
  // Hold pieces near their settled (cached) drape — but FULLY release the hold inside the grab's
  // influence region (a clean step, not a falloff) so the pulled patch moves freely; everything
  // outside stays pinned to the good drape. This keeps the garment at the source's equilibrium off
  // the grab (self-collision stays quiescent there, no curl) while a pull stays responsive.
  let held = select(1.0, 0.0, grabInfluence > 0.001);
  let aw = anchors[index].w * simParams.anchorScale * held;
  if (aw > 0.0 && invMass > 0.0) {
    pos = mix(pos, anchors[index].xyz, anchorStrength * aw);
  }
  positions[index] = vec4f(pos, invMass);
}`;
}

/** XPBD distance constraint (used for both stretch and bend). One color group per dispatch. */
export function distanceConstraintWGSL(cfg: SimConfig): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read> edgeConstraints: array<vec4f>;
@group(0) @binding(2) var<storage, read> edgeProperties: array<vec4f>;

const deltaT = ${cfg.deltaT}f;

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= arrayLength(&edgeConstraints)) { return; }
  let constraint = edgeConstraints[index];
  let p1Index = u32(constraint.x);
  let p2Index = u32(constraint.y);
  if (p1Index == p2Index) { return; }
  let restLength = constraint.z;
  let isLongRange = constraint.w > 0.0;
  var p1 = positions[p1Index].xyz;
  var p2 = positions[p2Index].xyz;
  let w1 = positions[p1Index].w;
  let w2 = positions[p2Index].w;
  let sumWeight = w1 + w2;
  if (sumWeight <= 0.0) { return; }
  let p1p2 = p1 - p2;
  let dist = length(p1p2);
  if (isLongRange && dist < restLength) { return; }
  if (dist < 0.0000001) { return; }
  let alphaTilde = edgeProperties[index].x / (deltaT * deltaT);
  let grad = p1p2 / dist;
  let c = dist - restLength;
  let lambda = -c / (sumWeight + alphaTilde);
  p1 += grad * lambda * w1;
  p2 += grad * -lambda * w2;
  positions[p1Index] = vec4f(p1, w1);
  positions[p2Index] = vec4f(p2, w2);
}`;
}

/** Dihedral bending constraint (the original's dedicated bending shader): when a target fold angle
 *  is set it rotates the two opposite vertices around the shared hinge edge toward that dihedral
 *  angle; with target angle ~0 it falls back to a plain distance constraint between them. */
export function bendingConstraintWGSL(cfg: SimConfig): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read> edgeConstraints: array<vec4f>; // p1, p2, hingeA, hingeB
@group(0) @binding(2) var<storage, read> bendingProperties: array<vec4f>; // alpha, alphaBeyond, restLen, targetAngle

const deltaT = ${cfg.deltaT}f;
const PI = 3.1415926535897932384626433832795;
const ANGLE_EPS = 1e-4;
const MAX_ANGLE_STEP = 0.01;     // ~0.57deg/iter, keeps the fold nudge stable
const ANGLE_NUDGE_GAIN = 0.01;

fn rotateAroundAxis(p: vec3f, axis: vec3f, angle: f32) -> vec3f {
  let cosA = cos(angle); let sinA = sin(angle);
  return p * cosA + cross(axis, p) * sinA + axis * dot(axis, p) * (1.0 - cosA);
}
fn clampAngle(angle: f32) -> f32 {
  var a = angle;
  if (a > PI) { a -= 2.0 * PI; }
  if (a < -PI) { a += 2.0 * PI; }
  return a;
}

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= arrayLength(&edgeConstraints)) { return; }
  let constraint = edgeConstraints[index];
  let p1Index = u32(constraint.x);
  let p2Index = u32(constraint.y);
  if (p1Index == p2Index) { return; }
  let bendProp = bendingProperties[index];
  let restLength = bendProp.z;
  let targetAngle = bendProp.w;
  var p1 = positions[p1Index].xyz;
  var p2 = positions[p2Index].xyz;
  let w1 = positions[p1Index].w;
  let w2 = positions[p2Index].w;
  let sumWeight = w1 + w2;
  if (sumWeight <= 0.0) { return; }

  if (abs(targetAngle) > ANGLE_EPS) {
    // Angular fold path: rotate the opposite vertices around the hinge line toward the dihedral.
    let hingeAIndex = u32(constraint.z);
    let hingeBIndex = u32(constraint.w);
    let hingeA = positions[hingeAIndex].xyz;
    let hingeB = positions[hingeBIndex].xyz;
    var edgeDir = hingeB - hingeA;
    let edgeLen = length(edgeDir);
    if (edgeLen < 1e-6) { return; }
    edgeDir = edgeDir / edgeLen;
    var n1 = cross(p1 - hingeA, p1 - hingeB);
    var n2 = cross(p2 - hingeB, p2 - hingeA);
    let n1Len = length(n1); let n2Len = length(n2);
    if (n1Len < 1e-6 || n2Len < 1e-6) { return; }
    n1 = n1 / n1Len; n2 = n2 / n2Len;
    let sinPhi = dot(cross(n1, n2), edgeDir);
    let cosPhi = clamp(dot(n1, n2), -1.0, 1.0);
    var phi = clampAngle(atan2(sinPhi, cosPhi));
    let error = clampAngle(phi - targetAngle);
    let angleStep = clamp(error * ANGLE_NUDGE_GAIN, -MAX_ANGLE_STEP, MAX_ANGLE_STEP);
    let hingeMid = 0.5 * (hingeA + hingeB);
    let w1Scale = w1 / sumWeight;
    let w2Scale = w2 / sumWeight;
    p1 = hingeMid + rotateAroundAxis(p1 - hingeMid, edgeDir, -angleStep * w1Scale);
    p2 = hingeMid + rotateAroundAxis(p2 - hingeMid, edgeDir, angleStep * w2Scale);
    positions[p1Index] = vec4f(p1, w1);
    positions[p2Index] = vec4f(p2, w2);
  } else {
    // Distance-based bending (no fold line): hold the opposite vertices at their rest separation.
    let p1p2 = p1 - p2;
    let dist = length(p1p2);
    if (dist < 1e-7) { return; }
    var compliance = bendProp.x;
    if (dist > restLength) { compliance = bendProp.y; }
    let alphaTilde = compliance / (deltaT * deltaT);
    let grad = p1p2 / dist;
    let c = dist - restLength;
    let lambda = -c / (sumWeight + alphaTilde);
    p1 += grad * lambda * w1;
    p2 += grad * -lambda * w2;
    positions[p1Index] = vec4f(p1, w1);
    positions[p2Index] = vec4f(p2, w2);
  }
}`;
}

/** Jacobi sewing: both endpoints read the same positions and receive their inverse-mass
 * share of the gap. Doubling this share swaps an isolated pair instead of closing it. */
export function seamWGSL(cfg: SimConfig, maxDisplacementSq: number, gateLayout?: SeamGateLayout,
  closedRestoration?: { maximumSq: number; previousGapSq: number }): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read> seams: array<i32>;
@group(0) @binding(2) var<storage, read_write> positionCorrection: array<vec4f>;
@group(0) @binding(3) var<storage, read> seamOrder: array<i32>;
@group(0) @binding(4) var<uniform> gate: SeamGate;${closedRestoration ? '\n@group(0) @binding(5) var<storage, read> lastPositions: array<vec4f>;' : ''}

${seamGateWGSL('SeamGate', gateLayout)}

const stiffness = ${cfg.seamStrength}f;
const maxDisplacementSq = ${maxDisplacementSq}f;${closedRestoration ? `
const closedRestorationMaxDisplacementSq = ${closedRestoration.maximumSq}f;
const closedGapSq = ${closedRestoration.previousGapSq}f;` : ''}

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= arrayLength(&positions)) { return; }
  let invMass1 = positions[index].w;
  var totalCorrection = vec3f(0.0);
  var count = 0.0;
  if (invMass1 > 0.0) {
    for (var j = 0u; j < 4u; j = j + 1u) {
      let connected = seams[index * 4u + j];
      // continue, not break: a gated-out link must not hide the links in later slots.
      if (connected < 0 || u32(connected) == index) { continue; }
      if (seamOrder[index * 4u + j] >= gate.sewnUpTo) { continue; }
      if (!activeSourceStitch(seamOrder[index * 4u + j])) { continue; }
      let ci = u32(connected);
      let invMass2 = positions[ci].w;
      let totalInvMass = invMass1 + invMass2;
      if (totalInvMass <= 0.0) { continue; }
      let delta = positions[ci].xyz - positions[index].xyz;
      let weight = invMass1 / totalInvMass;
      var correction = delta * stiffness * weight;
${closedRestoration ? `      // This history is immutable for all sewing iterations in the physical substep.
      let previousGap = lastPositions[ci].xyz - lastPositions[index].xyz;
      let correctionMaximumSq = select(maxDisplacementSq, closedRestorationMaxDisplacementSq,
        dot(previousGap, previousGap) <= closedGapSq);
` : ''}      if (dot(correction, correction) > ${closedRestoration ? 'correctionMaximumSq' : 'maxDisplacementSq'}) {
        correction = normalize(correction) * sqrt(${closedRestoration ? 'correctionMaximumSq' : 'maxDisplacementSq'});
      }
      totalCorrection += correction;
      count += 1.0;
    }
  }
  positionCorrection[index] += vec4f(totalCorrection, count);
}`;
}

/** External (body) collision gather — ported from the original's InitExternalCollisionsShader.
 *  At the configured substep cadence: walk the body-triangle hash around each particle sweep,
 *  recording up to
 *  numExternalCollisionConstraintsPerParticle nearby body triangles per particle (within
 *  externalStaticCollisionRadius of the triangle centre). Indices are stored +2 so 0 means
 *  "no triangle" (matching the self-collision encoding; the external list carries no sideness sign). */
export function initExternalCollisionWGSL(cfg: SimConfig, hashTableSize: number): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> nearTriangles: array<i32>;
@group(0) @binding(2) var<storage, read> hashTable: array<u32>;
@group(0) @binding(3) var<storage, read> hashPositions: array<u32>;
@group(0) @binding(4) var<storage, read> triangleCenters: array<vec4f>;
@group(0) @binding(5) var<storage, read> lastPositions: array<vec4f>;
${hashFunctions(hashTableSize, cfg.externalHashSpacing)}
const maxDist = ${cfg.externalStaticCollisionRadius}f;
const maxDist2 = maxDist * maxDist;
const numCollisionConstraintsPerParticle = ${cfg.numExternalCollisionConstraintsPerParticle}u;

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= arrayLength(&positions)) { return; }
  for (var i : u32 = 0u; i < numCollisionConstraintsPerParticle; i++) {
    nearTriangles[index * numCollisionConstraintsPerParticle + i] = 0;
  }
  let pos = positions[index].xyz;
  let previous = lastPositions[index].xyz;
  let motion = pos - previous;
  let motionLengthSq = dot(motion, motion);
  let low = min(pos, previous) - vec3f(maxDist);
  let high = max(pos, previous) + vec3f(maxDist);
  let x0 = intCoord(low.x); let y0 = intCoord(low.y); let z0 = intCoord(low.z);
  let x1 = intCoord(high.x); let y1 = intCoord(high.y); let z1 = intCoord(high.z);
  var num : u32 = 0u;
  var distances: array<f32, ${cfg.numExternalCollisionConstraintsPerParticle}>;
  for (var xi = x0; xi <= x1; xi++) {
    for (var yi = y0; yi <= y1; yi++) {
      for (var zi = z0; zi <= z1; zi++) {
        let h = hashCoords(xi, yi, zi);
        let start = hashTable[h];
        let end = hashTable[h + 1];
        for (var i = start; i < end; i++) {
          let triangleIndex = hashPositions[i];
          if (triangleIndex >= arrayLength(&triangleCenters)) { continue; }
          let trianglePosition = triangleCenters[triangleIndex].xyz;
          var closest = pos;
          if (motionLengthSq > 1e-20) {
            closest = previous + motion * clamp(dot(trianglePosition - previous, motion) / motionLengthSq, 0.0, 1.0);
          }
          let distVec = closest - trianglePosition;
          let distanceSq = dot(distVec, distVec);
          if (distanceSq > maxDist2) { continue; }
          let encodedIndex : i32 = i32(triangleIndex) + 2i; // +2 so 0 means "no triangle"
          var duplicate = false;
          var farthest = 0u;
          for (var slot = 0u; slot < num; slot++) {
            if (nearTriangles[index * numCollisionConstraintsPerParticle + slot] == encodedIndex) { duplicate = true; }
            if (distances[slot] > distances[farthest]) { farthest = slot; }
          }
          if (duplicate) { continue; }
          if (num < numCollisionConstraintsPerParticle) {
            nearTriangles[index * numCollisionConstraintsPerParticle + num] = encodedIndex;
            distances[num] = distanceSq;
            num++;
          } else if (distanceSq < distances[farthest]) {
            // A full candidate budget keeps the closest surfaces, not the first hash cells visited.
            nearTriangles[index * numCollisionConstraintsPerParticle + farthest] = encodedIndex;
            distances[farthest] = distanceSq;
          }
        }
      }
    }
  }
}`;
}

/** External (body) collision solve — ported from the original's SolveExternalCollisionsShader.
 *  Per substep: against the latest gathered candidates, pick the best contact (preferring body
 *  surfaces whose normal faces the particle), then push out along the normal with friction.
 *  The per-piece cloth-normal filter (incidentTriangles flag) rejects cavity backfaces (crotch,
 *  armpit); flag sign flips the cloth normal for flipNormals pieces. 8 storage buffers — fits the
 *  default per-stage limit. */
export function solveExternalCollisionWGSL(cfg: SimConfig, maxIncident: number): string {
  const incidentStride = maxIncident + 1;
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> positionCorrection: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> nearTriangles: array<i32>;
@group(0) @binding(3) var<storage, read> triangles: array<vec4u>;
@group(0) @binding(4) var<storage, read> externalPositions: array<vec4f>;
@group(0) @binding(5) var<storage, read> lastPositions: array<vec4f>;
@group(0) @binding(6) var<storage, read> clothTriangles: array<vec4u>;
@group(0) @binding(7) var<storage, read> incidentTriangles: array<i32>;

const thickness = ${cfg.simulationThickness}f;
const numCollisionConstraintsPerParticle = ${cfg.numExternalCollisionConstraintsPerParticle}u;
const frictionCoefficient = ${cfg.externalCollisionFriction}f;
const maxIncidentTrianglesPerParticle = ${maxIncident}u;
const incidentStride = ${incidentStride}u;

${closestPointOnTriangleWGSL}

fn computeClothNormal(particleIndex: u32) -> vec3f {
  if (maxIncidentTrianglesPerParticle == 0u || incidentStride == 0u) { return vec3f(0.0); }
  var accumulated = vec3f(0.0);
  let base = particleIndex * incidentStride + 1u;
  for (var slot = 0u; slot < maxIncidentTrianglesPerParticle; slot++) {
    let incidentIndex = base + slot;
    if (incidentIndex >= arrayLength(&incidentTriangles)) { break; }
    let triIndex = incidentTriangles[incidentIndex];
    if (triIndex < 0) { break; }
    let clothTri = clothTriangles[u32(triIndex)];
    let c0Index = u32(clothTri.x); let c1Index = u32(clothTri.y); let c2Index = u32(clothTri.z);
    if (c0Index >= arrayLength(&positions) || c1Index >= arrayLength(&positions) || c2Index >= arrayLength(&positions)) { continue; }
    let c0 = positions[c0Index].xyz;
    let c1 = positions[c1Index].xyz;
    let c2 = positions[c2Index].xyz;
    let triNormal = cross(c1 - c0, c2 - c0);
    let triNormalLength = length(triNormal);
    if (triNormalLength < 1e-6) { continue; }
    accumulated += triNormal / triNormalLength;
  }
  let accumulatedLength = length(accumulated);
  if (accumulatedLength < 1e-5) { return vec3f(0.0); }
  return accumulated / accumulatedLength;
}

fn getNormalFilterFlag(particleIndex: u32) -> i32 {
  if (incidentStride == 0u) { return 0; }
  let flagIndex = particleIndex * incidentStride;
  if (flagIndex >= arrayLength(&incidentTriangles)) { return 0; }
  return incidentTriangles[flagIndex];
}

fn applyFriction(particleDelta: vec3f, contactNormal: vec3f, penetration: f32, surfaceDelta: vec3f) -> vec3f {
  if (frictionCoefficient <= 0.0 || penetration <= 0.0) { return vec3f(0.0); }
  let relativeDelta = particleDelta - surfaceDelta;
  let tangential = relativeDelta - contactNormal * dot(relativeDelta, contactNormal);
  let tangentialLength = length(tangential);
  if (tangentialLength <= 1e-6) { return vec3f(0.0); }
  let maxFriction = frictionCoefficient * penetration;
  if (maxFriction <= 0.0) { return vec3f(0.0); }
  return -min(tangentialLength, maxFriction) * (tangential / tangentialLength);
}

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= arrayLength(&positions)) { return; }
  let pos = positions[index].xyz;
  let invMass = positions[index].w;
  if (invMass <= 0.0) { return; }
  if (index >= arrayLength(&lastPositions)) { return; }
  let particleLast = lastPositions[index].xyz;
  let particleDelta = pos - particleLast;

  var clothNormal = vec3f(0.0);
  var wantsFilter = false;
  var flipFactor = 1.0;
  let filterFlag = getNormalFilterFlag(index);
  if (filterFlag != 0) {
    wantsFilter = true;
    if (filterFlag < 0) { flipFactor = -1.0; }
    clothNormal = computeClothNormal(index) * flipFactor;
  }

  var bestDistance2 = 3.40282e38f;
  var bestPlaneDistance = 0.0;
  var bestNormal = vec3f(0.0);
  var hasContact = false;
  var bestWasPositive = false;
  var bestWasSwept = false;
  var bestCrossingTime = 2.0;

  for (var collisionIndex = 0u; collisionIndex < numCollisionConstraintsPerParticle; collisionIndex++) {
    let encodedTriangleIndex = nearTriangles[index * numCollisionConstraintsPerParticle + collisionIndex];
    if (encodedTriangleIndex < 1) { break; }
    let decodedTriangleIndex = encodedTriangleIndex - 2;
    if (decodedTriangleIndex < 0) { continue; }
    let triangleIndex = u32(decodedTriangleIndex);
    if (triangleIndex >= arrayLength(&triangles)) { continue; }
    let triData = triangles[triangleIndex];
    let p0Index = u32(triData.x); let p1Index = u32(triData.y); let p2Index = u32(triData.z);
    if (p0Index >= arrayLength(&externalPositions) || p1Index >= arrayLength(&externalPositions) || p2Index >= arrayLength(&externalPositions)) { continue; }
    let p0 = externalPositions[p0Index].xyz;
    let p1 = externalPositions[p1Index].xyz;
    let p2 = externalPositions[p2Index].xyz;
    let triNormalRaw = cross(p1 - p0, p2 - p0);
    let normalLength = length(triNormalRaw);
    if (normalLength < 0.000001) { continue; }
    let triNormal = triNormalRaw / normalLength;
    let closestPoint = getClosestPointOnTriangle(p0, p1, p2, pos);
    let offset = pos - closestPoint;
    let dist2 = dot(offset, offset);
    let planeDistance = dot(pos - p0, triNormal);
    let previousPlaneDistance = dot(particleLast - p0, triNormal);
    var sweptContact = false;
    var crossingTime = 2.0;
    if (previousPlaneDistance >= 0.0 && planeDistance < 0.0) {
      crossingTime = previousPlaneDistance / (previousPlaneDistance - planeDistance);
      let crossing = particleLast + particleDelta * crossingTime;
      let closestCrossing = getClosestPointOnTriangle(p0, p1, p2, crossing);
      let crossingOffset = crossing - closestCrossing;
      sweptContact = dot(crossingOffset, crossingOffset) <= 1e-10;
    }
    // Accept a contact only near the finite triangle, or after crossing its actual face. Testing
    // only the endpoint would silently discard a particle that tunneled deeper than thickness.
    if (!sweptContact && (dist2 >= thickness * thickness || planeDistance < -thickness)) { continue; }
    // Prefer surfaces where the particle is on the positive side of the normal; otherwise fall back
    // to the nearest triangle that passed the backface test.
    let isPositiveSide = planeDistance >= 0.0;
    var shouldChoose = false;
    if (sweptContact) {
      shouldChoose = !bestWasSwept || crossingTime < bestCrossingTime;
    } else if (!bestWasSwept) {
      if (isPositiveSide) {
        shouldChoose = !bestWasPositive || dist2 < bestDistance2;
      } else if (!bestWasPositive && dist2 < bestDistance2) { shouldChoose = true; }
    }
    if (shouldChoose) {
      bestDistance2 = dist2;
      bestWasPositive = isPositiveSide;
      bestWasSwept = sweptContact;
      bestCrossingTime = crossingTime;
      bestPlaneDistance = planeDistance;
      bestNormal = triNormal;
      hasContact = true;
    }
  }

  var shouldApplyContact = hasContact && bestPlaneDistance < thickness;
  if (bestWasPositive) { shouldApplyContact = shouldApplyContact && bestPlaneDistance >= 0.0; }
  // Only collide when moving into the surface; avoids jitter when already separating.
  if (shouldApplyContact && dot(particleDelta, bestNormal) >= 0.0) { shouldApplyContact = false; }
  if (shouldApplyContact && wantsFilter && !bestWasSwept) {
    let clothNormalLength = length(clothNormal);
    if (clothNormalLength > 1e-5) { shouldApplyContact = dot(clothNormal, bestNormal) >= 0.0; }
  }
  if (shouldApplyContact) {
    let penetration = thickness - bestPlaneDistance;
    if (penetration > 0.0) {
      var correction = bestNormal * penetration;
      if (frictionCoefficient > 0.0) {
        correction += applyFriction(particleDelta, bestNormal, penetration, vec3f(0.0));
      }
      positionCorrection[index] += vec4f(correction, 1.0);
    }
  }
}`;
}

/** Gather body surfaces around each finite cloth face, including its interior. Particle gathers
 * cannot see a hand crossing a coarse face when all three cloth vertices remain outside. */
export function initExternalSurfaceCollisionWGSL(cfg: SimConfig, hashTableSize: number, bodyTriangleRadius: number): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read> clothTriangles: array<vec4u>;
@group(0) @binding(2) var<storage, read_write> candidates: array<i32>;
@group(0) @binding(3) var<storage, read> hashTable: array<u32>;
@group(0) @binding(4) var<storage, read> hashPositions: array<u32>;
@group(0) @binding(5) var<storage, read> bodyCenters: array<vec4f>;
@group(0) @binding(6) var<storage, read> bodyTriangles: array<vec4u>;
@group(0) @binding(7) var<storage, read> bodyPositions: array<vec4f>;
${hashFunctions(hashTableSize, cfg.externalHashSpacing)}
${closestPointOnTriangleWGSL}
${finiteContactsWGSL}
const padding = ${bodyTriangleRadius + cfg.simulationThickness}f;
const budget = ${cfg.numExternalSurfaceCollisionConstraints ?? cfg.numExternalCollisionConstraintsPerParticle}u;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= arrayLength(&clothTriangles)) { return; }
  for (var slot = 0u; slot < budget; slot++) { candidates[index * budget + slot] = 0; }
  let tri = clothTriangles[index];
  let a = positions[tri.x].xyz; let b = positions[tri.y].xyz; let c = positions[tri.z].xyz;
  let low = min(a, min(b, c)) - vec3f(padding);
  let high = max(a, max(b, c)) + vec3f(padding);
  var count = 0u;
  var distances: array<f32, ${cfg.numExternalSurfaceCollisionConstraints ?? cfg.numExternalCollisionConstraintsPerParticle}>;
  for (var x = intCoord(low.x); x <= intCoord(high.x); x++) {
    for (var y = intCoord(low.y); y <= intCoord(high.y); y++) {
      for (var z = intCoord(low.z); z <= intCoord(high.z); z++) {
        let cell = hashCoords(x, y, z);
        for (var at = hashTable[cell]; at < hashTable[cell + 1]; at++) {
          let bodyIndex = hashPositions[at];
          if (bodyIndex >= arrayLength(&bodyCenters)) { continue; }
          let center = bodyCenters[bodyIndex].xyz;
          let nearest = getClosestPointOnTriangle(a, b, c, center);
          let offset = center - nearest;
          var distanceSq = dot(offset, offset);
          // The hash query uses the largest body radius for complete coverage; this
          // precise per-face bound avoids admitting hundreds of unrelated fine skin faces.
          let localPadding = bodyCenters[bodyIndex].w + ${cfg.simulationThickness}f;
          if (distanceSq > localPadding * localPadding) { continue; }
          let body = bodyTriangles[bodyIndex];
          if (finiteTrianglesCross(a,b,c,bodyPositions[body.x].xyz,bodyPositions[body.y].xyz,bodyPositions[body.z].xyz)) {
            // An actual finite crossing wins over nearby centers from densely tessellated skin.
            distanceSq = -1.0;
          }
          let encoded = i32(bodyIndex) + 2;
          var duplicate = false; var farthest = 0u;
          for (var slot = 0u; slot < count; slot++) {
            if (candidates[index * budget + slot] == encoded) { duplicate = true; }
            if (distances[slot] > distances[farthest]) { farthest = slot; }
          }
          if (duplicate) { continue; }
          if (count < budget) {
            candidates[index * budget + count] = encoded;
            distances[count] = distanceSq; count++;
          } else if (distanceSq < distances[farthest]) {
            candidates[index * budget + farthest] = encoded;
            distances[farthest] = distanceSq;
          }
        }
      }
    }
  }
}`;
}

/** One invocation owns a cloth triangle's three correction slots. Body vertices that project onto
 * its finite surface generate a unilateral outward constraint, shared by barycentric inverse-mass
 * weights. A later vertex gather avoids float atomics and preserves the eight-buffer baseline. */
export function solveExternalSurfaceCollisionWGSL(cfg: SimConfig): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read> clothTriangles: array<vec4u>;
@group(0) @binding(2) var<storage, read> candidates: array<i32>;
@group(0) @binding(3) var<storage, read> bodyTriangles: array<vec4u>;
@group(0) @binding(4) var<storage, read> bodyPositions: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> corrections: array<vec4f>;
@group(0) @binding(6) var<storage, read> previous: array<vec4f>;
${closestPointOnTriangleWGSL}
${finiteContactsWGSL}
const thickness = ${cfg.simulationThickness}f;
const maxCorrection = ${cfg.maxSurfaceCorrection ?? 0.005}f;
const searchDepth = ${cfg.externalStaticCollisionRadius}f;
const budget = ${cfg.numExternalSurfaceCollisionConstraints ?? cfg.numExternalCollisionConstraintsPerParticle}u;
fn barycentric(a: vec3f, b: vec3f, c: vec3f, point: vec3f) -> vec3f {
  let ab = b - a; let ac = c - a; let ap = point - a;
  let aa = dot(ab, ab); let bc = dot(ab, ac); let cc = dot(ac, ac);
  let pa = dot(ap, ab); let pc = dot(ap, ac);
  let inverse = 1.0 / (aa * cc - bc * bc);
  let y = (cc * pa - bc * pc) * inverse;
  let z = (aa * pc - bc * pa) * inverse;
  return max(vec3f(1.0 - y - z, y, z), vec3f(0.0));
}
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= arrayLength(&clothTriangles)) { return; }
  for (var slot = 0u; slot < 3u; slot++) { corrections[index * 3u + slot] = vec4f(0.0); }
  let tri = clothTriangles[index];
  let a = positions[tri.x]; let b = positions[tri.y]; let c = positions[tri.z];
  let rawNormal = cross(b.xyz - a.xyz, c.xyz - a.xyz);
  let area = length(rawNormal);
  if (area < 1e-6) { return; }
  var normal = rawNormal / area;
  if ((tri.w & 0x80000000u) != 0u) { normal = -normal; }
  var bestDepth = 0.0;
  var bestWeights = vec3f(0.0);
  var bestNormal = normal;
  var bestPriority = 6u;
  var bestKind=2u;
  let previousCenter = (previous[tri.x].xyz+previous[tri.y].xyz+previous[tri.z].xyz)/3.0;
  for (var slot = 0u; slot < budget; slot++) {
    let encoded = candidates[index * budget + slot];
    if (encoded < 2) { break; }
    let bodyIndex = u32(encoded - 2);
    if (bodyIndex >= arrayLength(&bodyTriangles)) { continue; }
    let body = bodyTriangles[bodyIndex];
    let p0 = bodyPositions[body.x].xyz; let p1 = bodyPositions[body.y].xyz; let p2 = bodyPositions[body.z].xyz;
    let bodyNormal = cross(p1 - p0, p2 - p0);
    let bodyArea = length(bodyNormal);
    if (bodyArea < 1e-7) { continue; }
    let outward = bodyNormal / bodyArea;
    let alignment = dot(outward,normal);
    // A perpendicular body face can still cut a cloth edge. Resolve that finite contact
    // along its outward direction; the cloth-plane projection has no useful normal there.
    let contactNormal = select(normal * select(-1.0,1.0,alignment>=0.0), outward, abs(alignment)<=0.05);
    var priority = select(1u,0u,dot(previousCenter-p0,outward)>=-thickness);
    // An already intersecting diagnostic seed has no outside history. Preserve its material
    // outside direction as a deterministic tie-break; valid trajectories use actual outside history.
    if(priority>0u && dot(outward,normal)<0.0) { priority=2u; }
    // Prefer an established face-normal escape when available. Perpendicular edge contacts
    // remain a fallback, so opposing box sides do not cancel a valid material-side escape.
    if(abs(alignment)<=0.05) { priority+=3u; }
    let vertices = array<vec3f, 3>(p0, p1, p2);
    for (var vertex = 0u; vertex < 3u; vertex++) {
      if (abs(alignment)<=0.05) { break; }
      let point = vertices[vertex];
      // A negative infinite-plane sign does not establish finite skin proximity.
      // Deeper finite crossings retain their separate edge/chord recovery below.
      let finiteNearest = getClosestPointOnTriangle(a.xyz, b.xyz, c.xyz, point);
      let finiteOffset = point - finiteNearest;
      if (dot(finiteOffset, finiteOffset) > thickness * thickness) { continue; }
      let signedDistance = dot(a.xyz - point, contactNormal);
      if (signedDistance >= thickness || signedDistance < -searchDepth) { continue; }
      let projected = point + contactNormal * signedDistance;
      let nearest = getClosestPointOnTriangle(a.xyz, b.xyz, c.xyz, projected);
      let tangential = nearest - projected;
      // The projection must fall on this finite face (or within thickness at its edge).
      if (dot(tangential, tangential) > thickness * thickness) { continue; }
      let depth = thickness - signedDistance;
      let kind=select(1u,0u,signedDistance<0.0 && dot(tangential,tangential)<1e-12);
      if (kind<bestKind || (kind==bestKind && (priority < bestPriority || (priority == bestPriority && depth > bestDepth)))) {
        bestDepth = depth; bestWeights = barycentric(a.xyz,b.xyz,c.xyz,nearest);
        bestNormal = contactNormal; bestPriority = priority; bestKind=kind;
      }
    }
    let clothPoints = array<vec3f,3>(a.xyz,b.xyz,c.xyz);
    for (var edge=0u;edge<3u;edge++) {
      let clothHit = segmentTriangleHit(clothPoints[edge],clothPoints[(edge+1u)%3u],p0,p1,p2);
      let bodyHit = segmentTriangleHit(vertices[edge],vertices[(edge+1u)%3u],a.xyz,b.xyz,c.xyz);
      var hit = select(bodyHit, clothHit, clothHit.w>=0.0);
      var edgeNormal=contactNormal;var edgeDepth=thickness;
      if (clothHit.w>=0.0 && dot(clothPoints[(edge+1u)%3u]-clothPoints[edge],outward)<0.0) {
        // An outside-to-outside edge can shortcut a skin crease while both endpoints remain
        // clear. Recover its actual finite interior chord, rather than using an endpoint's
        // distance behind the infinite entry plane (which can greatly overstate penetration).
        var exitT=2.0;
        var exitTriangle=vec3u(0u);
        for (var otherSlot=0u;otherSlot<budget;otherSlot++) {
          let otherEncoded=candidates[index*budget+otherSlot];
          if(otherEncoded<2) { break; }
          let otherIndex=u32(otherEncoded-2);
          if(otherIndex>=arrayLength(&bodyTriangles)) { continue; }
          let other=bodyTriangles[otherIndex];
          let q0=bodyPositions[other.x].xyz;
          let q1=bodyPositions[other.y].xyz;
          let q2=bodyPositions[other.z].xyz;
          if(dot(clothPoints[(edge+1u)%3u]-clothPoints[edge],cross(q1-q0,q2-q0))<=0.0) { continue; }
          let exitHit=segmentTriangleHit(clothPoints[edge],clothPoints[(edge+1u)%3u],q0,q1,q2);
          if(exitHit.w>clothHit.w+1e-6 && exitHit.w<exitT) {
            exitT=exitHit.w;exitTriangle=other.xyz;
          }
        }
        if(exitT<=1.0) {
          let parameter=0.5*(clothHit.w+exitT);
          let insidePoint=mix(clothPoints[edge],clothPoints[(edge+1u)%3u],parameter);
          let entryClosest=getClosestPointOnTriangle(p0,p1,p2,insidePoint);
          let exitClosest=getClosestPointOnTriangle(bodyPositions[exitTriangle.x].xyz,
            bodyPositions[exitTriangle.y].xyz,bodyPositions[exitTriangle.z].xyz,insidePoint);
          let entryOffset=entryClosest-insidePoint;let exitOffset=exitClosest-insidePoint;
          let escape=select(exitOffset,entryOffset,dot(entryOffset,entryOffset)<=dot(exitOffset,exitOffset));
          let penetration=length(escape);
          if(penetration>1e-8) {
            edgeNormal=escape/penetration;edgeDepth=thickness+penetration;
            hit=vec4f(insidePoint,parameter);
            let previousPoint=mix(previous[tri[edge]].xyz,previous[tri[(edge+1u)%3u]].xyz,parameter);
            priority=select(1u,0u,dot(previousPoint-(insidePoint+escape),edgeNormal)>=-thickness);
          }
        }
      }
      if(clothHit.w<0.0 && bodyHit.w>=0.0) {
        // A body edge passing through a cloth interior must separate along the cloth plane's
        // normal. Pushing it along a perpendicular body-face normal only slides the crossing.
        // Preserve an unambiguous previous outside side; an intersecting diagnostic seed uses
        // the material normal until an outside history exists.
        if(abs(alignment)<=0.05) {
          let oldMinimum=min(dot(p0-previousCenter,normal),min(dot(p1-previousCenter,normal),dot(p2-previousCenter,normal)));
          edgeNormal=normal*select(1.0,-1.0,oldMinimum>0.000001);
        }
        edgeDepth=thickness+max(0.0,max(dot(vertices[edge]-hit.xyz,edgeNormal),
          dot(vertices[(edge+1u)%3u]-hit.xyz,edgeNormal)));
      }
      if (hit.w>=0.0 && (bestKind>0u || (priority<bestPriority || (priority==bestPriority && edgeDepth>bestDepth)))) {
        bestDepth=edgeDepth;bestWeights=barycentric(a.xyz,b.xyz,c.xyz,hit.xyz);
        bestNormal=edgeNormal;bestPriority=priority;bestKind=0u;
      }
    }
  }
  if (bestDepth <= 0.0) { return; }
  let inverseMass = vec3f(a.w, b.w, c.w);
  let denominator = dot(inverseMass, bestWeights * bestWeights);
  if (denominator <= 0.0) { return; }
  for (var slot = 0u; slot < 3u; slot++) {
    if (inverseMass[slot] <= 0.0 || bestWeights[slot] <= 1e-6) { continue; }
    // Bound recovery separately from physical clearance; coarse curved facets may need several
    // millimetres of depenetration even when fabric clearance is one millimetre.
    let displacement = min(maxCorrection, inverseMass[slot] * bestWeights[slot] * bestDepth / denominator);
    corrections[index * 3u + slot] = vec4f(bestNormal * displacement, 1.0);
  }
}`;
}

export function gatherExternalSurfaceCorrectionsWGSL(maxIncident: number): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> clothTriangles: array<vec4u>;
@group(0) @binding(1) var<storage, read> incidentTriangles: array<i32>;
@group(0) @binding(2) var<storage, read> triangleCorrections: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> particleCorrections: array<vec4f>;
const stride = ${maxIncident + 1}u;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= arrayLength(&particleCorrections)) { return; }
  var correction = vec4f(0.0);
  for (var slot = 0u; slot < ${maxIncident}u; slot++) {
    let incident = incidentTriangles[index * stride + slot + 1u];
    if (incident < 0) { break; }
    let triangleIndex = u32(incident);
    let tri = clothTriangles[triangleIndex];
    var corner = 0u;
    if (tri.y == index) { corner = 1u; }
    else if (tri.z == index) { corner = 2u; }
    else if (tri.x != index) { continue; }
    correction += triangleCorrections[triangleIndex * 3u + corner];
  }
  particleCorrections[index] += correction;
}`;
}

/** Average accumulated corrections and apply to movable particles. */
export function applyCorrectionsWGSL(): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> positionCorrection: array<vec4f>;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= arrayLength(&positions)) { return; }
  let correction = positionCorrection[index];
  if (positions[index].w <= 0.0) { return; }
  if (correction.w < 1.0) { return; }
  let d = correction.xyz / correction.w;
  positions[index] = vec4f(positions[index].xyz + d, positions[index].w);
}`;
}

export function resetCorrectionsWGSL(): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> positionCorrection: array<vec4f>;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= arrayLength(&positionCorrection)) { return; }
  positionCorrection[index] = vec4f(0.0);
}`;
}

// ---------------------------------------------------------------------------------------------
// Self-collision (cloth-vs-cloth). Ported verbatim from the original Seamer engine: a GPU
// counting-sort spatial hash over cloth-triangle centres, a per-particle near-triangle gather, and
// an edge+face XPBD contact solve. This is what stops panels folding through themselves / curling
// inside-out (the red back-faces seen when the garment "falls apart").
// ---------------------------------------------------------------------------------------------

/** Spatial-hash helpers shared by the hash-build and gather shaders. */
export function hashFunctions(hashTableSize: number, spacing: number): string {
  return /* wgsl */ `
const hashTableSize : i32 = ${hashTableSize};
const spacing : f32 = ${spacing}f;
fn hashCoords(xi: i32, yi: i32, zi: i32) -> i32 {
  let h = (xi * 92837111) ^ (yi * 689287499) ^ (zi * 283923481);
  return abs(h) % hashTableSize;
}
fn intCoord(coord: f32) -> i32 { return i32(floor(coord / spacing)); }
fn hashPos(pos: vec3f) -> i32 { return hashCoords(intCoord(pos.x), intCoord(pos.y), intCoord(pos.z)); }`;
}

/** #14 — triangle centroid = (p0+p1+p2)/3, used as the hash key. */
export function triangleCentersWGSL(): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> triangles: array<vec4u>;
@group(0) @binding(1) var<storage, read> positions: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> triangleCenters: array<vec4f>;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= arrayLength(&triangles)) { return; }
  let p0 = positions[triangles[index].x].xyz;
  let p1 = positions[triangles[index].y].xyz;
  let p2 = positions[triangles[index].z].xyz;
  let center=(p0+p1+p2)/3.0;
  triangleCenters[index] = vec4f(center, max(distance(center,p0),max(distance(center,p1),distance(center,p2))));
}`;
}

/** #9/#10 — zero a u32 array (hash table or hash positions). */
export function clearU32WGSL(): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= arrayLength(&data)) { return; }
  data[index] = 0u;
}`;
}

/** #11 — count triangles per hash cell (atomic histogram). */
export function countHashWGSL(hashTableSize: number, spacing: number): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> trianglePositions: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> hashTable: array<atomic<u32>>;
${hashFunctions(hashTableSize, spacing)}
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= arrayLength(&trianglePositions)) { return; }
  let h = hashPos(trianglePositions[index].xyz);
  atomicAdd(&hashTable[h], 1u);
}`;
}

/** #12 — serial prefix sum over the histogram (must dispatch exactly 1 workgroup). */
export function prefixSumWGSL(hashTableSize: number): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> hashTable: array<u32>;
const hashTableSize : u32 = ${hashTableSize}u;
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x != 0u) { return; }
  var start = 0u;
  for (var i = 0u; i < hashTableSize - 1u; i++) {
    start += hashTable[i];
    hashTable[i] = start;
  }
  hashTable[hashTableSize - 1u] = start; // guard
}`;
}

/** #13 — scatter triangle indices into the sorted hash-position array. */
export function fillHashWGSL(hashTableSize: number, spacing: number): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> trianglePositions: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> hashTable: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> hashPositions: array<u32>;
${hashFunctions(hashTableSize, spacing)}
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= arrayLength(&trianglePositions)) { return; }
  let h = hashPos(trianglePositions[index].xyz);
  let slot = atomicSub(&hashTable[h], 1u); // value before decrement
  hashPositions[slot - 1u] = index;
}`;
}

/** #15 — gather up to N near triangles per particle (skipping seam particles & 2D-close tris). */
export function initSelfCollisionWGSL(cfg: SimConfig, hashTableSize: number): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> nearTriangles: array<i32>;
@group(0) @binding(2) var<storage, read> hashTable: array<u32>;
@group(0) @binding(3) var<storage, read> hashPositions: array<u32>;
@group(0) @binding(4) var<storage, read> triangles: array<vec4u>;
@group(0) @binding(5) var<storage, read> positions2d: array<vec4f>;
@group(0) @binding(6) var<storage, read> triangleCenters: array<vec4f>;
@group(0) @binding(7) var<storage, read> seams: array<i32>;
${hashFunctions(hashTableSize, cfg.clothSpacing)}
const maxDist = ${cfg.staticCollisionRadius}f;
const maxDist2 = maxDist * maxDist;
const minDistance2d = ${cfg.minDistance2d}f;
const minDistance2d2 = minDistance2d * minDistance2d;
const numCollisionConstraintsPerParticle = ${cfg.numInternalCollisionConstraintsPerParticle}u;

// A seam particle is coincident with its partner and would self-collide against the adjoining panel
// every substep, so it is excluded from the gather.
//
// This deliberately does NOT gate on the assembly threshold, even though an unsewn edge is
// physically a free edge that ought to collide. Reading the per-link stitch order here would make a
// ninth storage buffer in this stage, and WebGPU only guarantees eight per stage
// (maxStorageBuffersPerShaderStage) — the pipeline then fails outright on any baseline adapter.
// Leaving it ungated means not-yet-sewn edges can pass through nearby cloth during a recording;
// that band is thin and the panels are near their final positions, so it is the cheaper wrong.
fn hasSeam(particleIndex: u32) -> bool {
  for (var j: u32 = 0u; j < 4u; j = j + 1u) {
    if (seams[particleIndex * 4u + j] > -1i) { return true; }
  }
  return false;
}

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= arrayLength(&positions)) { return; }
  if (hasSeam(index)) { return; }
  for (var i : u32 = 0u; i < numCollisionConstraintsPerParticle; i++) {
    nearTriangles[index * numCollisionConstraintsPerParticle + i] = 0;
  }
  let pos = positions[index].xyz;
  let x0 = intCoord(pos.x - maxDist); let y0 = intCoord(pos.y - maxDist); let z0 = intCoord(pos.z - maxDist);
  let x1 = intCoord(pos.x + maxDist); let y1 = intCoord(pos.y + maxDist); let z1 = intCoord(pos.z + maxDist);
  var num : u32 = 0u;
  for (var xi = x0; xi <= x1; xi++) {
    for (var yi = y0; yi <= y1; yi++) {
      for (var zi = z0; zi <= z1; zi++) {
        let h = hashCoords(xi, yi, zi);
        let start = hashTable[h];
        let end = hashTable[h + 1];
        for (var i = start; i < end; i++) {
          let triangleIndex = hashPositions[i];
          if (triangleIndex >= arrayLength(&triangles)) { continue; }
          let trianglePosition = triangleCenters[triangleIndex].xyz;
          let distVec = pos - trianglePosition;
          if (dot(distVec, distVec) > maxDist2) { continue; }
          let triangle = triangles[triangleIndex];
          let p0index = u32(triangle.x); let p1index = u32(triangle.y); let p2index = u32(triangle.z);
          if (p0index == index || p1index == index || p2index == index) { continue; }
          let pos2d = positions2d[index].xy;
          let v2d0 = positions2d[p0index].xy - pos2d;
          if (dot(v2d0, v2d0) < minDistance2d2) { continue; }
          let v2d1 = positions2d[p1index].xy - pos2d;
          if (dot(v2d1, v2d1) < minDistance2d2) { continue; }
          let v2d2 = positions2d[p2index].xy - pos2d;
          if (dot(v2d2, v2d2) < minDistance2d2) { continue; }
          let p0 = positions[p0index].xyz;
          let p1 = positions[p1index].xyz;
          let p2 = positions[p2index].xyz;
          let normal = cross(p1 - p0, p2 - p0);
          let p0p = pos - p0;
          let triangleIndexWithOffset = i32(triangleIndex) + 2i; // +2 so 0 means "no triangle"
          var encodedIndex : i32 = triangleIndexWithOffset;
          if (dot(p0p, normal) < 0.0) { encodedIndex = -triangleIndexWithOffset; }
          nearTriangles[index * numCollisionConstraintsPerParticle + num] = encodedIndex;
          num++;
          if (num >= numCollisionConstraintsPerParticle) { return; }
        }
      }
    }
  }
}`;
}

/** #16 — resolve cloth self-collision (edge + face contacts) into the correction buffer. */
export function solveSelfCollisionWGSL(cfg: SimConfig): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> positionCorrection: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> nearTriangles: array<i32>;
@group(0) @binding(3) var<storage, read> triangles: array<vec4u>;
@group(0) @binding(4) var<storage, read> lastPositions: array<vec4f>;
@group(0) @binding(5) var<storage, read> particleLayers: array<u32>;

const thickness = ${cfg.simulationThickness}f;
const thickness2 = thickness * thickness;
const edgeThickness = ${cfg.edgeThickness}f;
const numCollisionConstraintsPerParticle = ${cfg.numInternalCollisionConstraintsPerParticle}u;
const frictionCoefficient = ${cfg.selfCollisionFriction}f;
const TRIANGLE_LAYER_MASK = 0x7fffffffu;
const TRIANGLE_OUTSIDE_FLAG = 0x80000000u;

fn decodeTriangleLayer(metaValue: u32) -> u32 { return metaValue & TRIANGLE_LAYER_MASK; }
fn decodeTriangleOutsideSign(metaValue: u32) -> f32 {
  if ((metaValue & TRIANGLE_OUTSIDE_FLAG) != 0u) { return -1.0; }
  return 1.0;
}

${closestPointOnTriangleWGSL}

fn computeBarycentric(p0: vec3f, p1: vec3f, p2: vec3f, point: vec3f) -> vec3f {
  let v0 = p1 - p0; let v1 = p2 - p0; let v2 = point - p0;
  let d00 = dot(v0, v0); let d01 = dot(v0, v1); let d11 = dot(v1, v1);
  let d20 = dot(v2, v0); let d21 = dot(v2, v1);
  let denom = d00 * d11 - d01 * d01;
  if (abs(denom) < 1e-8) { return vec3f(1.0, 0.0, 0.0); }
  let v = (d11 * d20 - d01 * d21) / denom;
  let w = (d00 * d21 - d01 * d20) / denom;
  return vec3f(1.0 - v - w, v, w);
}

fn applyFriction(particleDelta: vec3f, contactNormal: vec3f, penetration: f32, surfaceDelta: vec3f) -> vec3f {
  if (frictionCoefficient <= 0.0 || penetration <= 0.0) { return vec3f(0.0); }
  let relativeDelta = particleDelta - surfaceDelta;
  let tangential = relativeDelta - contactNormal * dot(relativeDelta, contactNormal);
  let tl = length(tangential);
  if (tl <= 1e-6) { return vec3f(0.0); }
  let maxF = frictionCoefficient * penetration;
  if (maxF <= 0.0) { return vec3f(0.0); }
  return -min(tl, maxF) * (tangential / tl);
}

fn resolveEdgeCollision(particlePos: vec3f, particleDelta: vec3f, edgeStart: vec3f, edgeEnd: vec3f, edgeStartDelta: vec3f, edgeEndDelta: vec3f) -> vec4f {
  let edgeVec = edgeEnd - edgeStart;
  let edgeLengthSq = dot(edgeVec, edgeVec);
  if (edgeLengthSq < 0.000000001) { return vec4f(0.0); }
  let edgeLength = sqrt(edgeLengthSq);
  let edgeDir = edgeVec / edgeLength;
  let projection = dot(particlePos - edgeStart, edgeDir);
  let clampedProjection = clamp(projection, 0.0, edgeLength);
  let closestPoint = edgeStart + edgeDir * clampedProjection;
  let distVec = particlePos - closestPoint;
  let dist2 = dot(distVec, distVec);
  if (dist2 >= edgeThickness * edgeThickness) { return vec4f(0.0); }
  let dist = sqrt(dist2);
  if (dist < 0.000000001 || dist > 0.1) { return vec4f(0.0); }
  let normal = distVec / dist;
  let penetration = edgeThickness - dist;
  if (penetration <= 0.0) { return vec4f(0.0); }
  var correction = normal * (0.5 * penetration);
  if (frictionCoefficient > 0.0) {
    let tt = clampedProjection / edgeLength;
    let surfaceDelta = edgeStartDelta * (1.0 - tt) + edgeEndDelta * tt;
    correction += applyFriction(particleDelta, normal, penetration, surfaceDelta);
  }
  return vec4f(correction, 1.0);
}

fn resolveFaceCollision(particlePos: vec3f, particleDelta: vec3f, p0: vec3f, p1: vec3f, p2: vec3f, p0Delta: vec3f, p1Delta: vec3f, p2Delta: vec3f, normalSign: f32) -> vec4f {
  let normalRaw = cross(p1 - p0, p2 - p0);
  let normalLength = length(normalRaw);
  if (normalLength < 0.0001) { return vec4f(0.0); }
  let normal = normalSign * (normalRaw / normalLength);
  let planeDist = dot(particlePos - p0, normal);
  if (planeDist >= thickness) { return vec4f(0.0); }
  let closest = getClosestPointOnTriangle(p0, p1, p2, particlePos);
  let distVec = particlePos - closest;
  let dist2 = dot(distVec, distVec);
  if (dist2 >= thickness2) { return vec4f(0.0); }
  let dist = sqrt(dist2);
  if (dist < 0.000000001) { return vec4f(0.0); }
  let direction = distVec / dist;
  let penetration = thickness - dist;
  if (penetration <= 0.0) { return vec4f(0.0); }
  var correction = direction * (0.5 * penetration);
  if (frictionCoefficient > 0.0) {
    let bary = computeBarycentric(p0, p1, p2, closest);
    let surfaceDelta = p0Delta * bary.x + p1Delta * bary.y + p2Delta * bary.z;
    correction += applyFriction(particleDelta, direction, penetration, surfaceDelta);
  }
  return vec4f(correction, 1.0);
}

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= arrayLength(&positions)) { return; }
  let pos = positions[index].xyz;
  if (positions[index].w <= 0.0) { return; }
  if (index >= arrayLength(&particleLayers)) { return; }
  let particleLast = lastPositions[index].xyz;
  let particleDelta = pos - particleLast;
  let particleLayer = particleLayers[index];
  var totalCorrection = vec4f(0.0);
  for (var collisionIndex = 0u; collisionIndex < numCollisionConstraintsPerParticle; collisionIndex++) {
    var triangleIndex = nearTriangles[index * numCollisionConstraintsPerParticle + collisionIndex];
    if (triangleIndex < 1 && triangleIndex > -1) { break; }
    var sideness = 1.0;
    if (triangleIndex < -1) { triangleIndex = -triangleIndex; sideness = -1.0; }
    triangleIndex -= 2;
    let triData = triangles[triangleIndex];
    let triangleLayer = decodeTriangleLayer(triData.w);
    if (particleLayer < triangleLayer) { continue; }
    let triangleOutsideSign = decodeTriangleOutsideSign(triData.w);
    let sameLayer = particleLayer == triangleLayer;
    let p0Index = u32(triData.x); let p1Index = u32(triData.y); let p2Index = u32(triData.z);
    let p0 = positions[p0Index].xyz; let p1 = positions[p1Index].xyz; let p2 = positions[p2Index].xyz;
    let p0Delta = p0 - lastPositions[p0Index].xyz;
    let p1Delta = p1 - lastPositions[p1Index].xyz;
    let p2Delta = p2 - lastPositions[p2Index].xyz;
    totalCorrection += resolveEdgeCollision(pos, particleDelta, p0, p1, p0Delta, p1Delta);
    totalCorrection += resolveEdgeCollision(pos, particleDelta, p1, p2, p1Delta, p2Delta);
    totalCorrection += resolveEdgeCollision(pos, particleDelta, p2, p0, p2Delta, p0Delta);
    var normalFactor = sideness;
    if (!sameLayer) { normalFactor = triangleOutsideSign; }
    totalCorrection += resolveFaceCollision(pos, particleDelta, p0, p1, p2, p0Delta, p1Delta, p2Delta, normalFactor);
  }
  positionCorrection[index] += totalCorrection;
}`;
}

/** #7 — near-damping: damp each particle's velocity toward its 8-neighbour rigid-body motion. */
export function nearDampingWGSL(cfg: SimConfig): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> velocities: array<vec4f>;
@group(0) @binding(2) var<storage, read> neighborIndices: array<i32>;

const kdamping = ${cfg.nearDamping}f;
const maxVelocity = ${cfg.maxVelocity}f;
const neighborCount = 8u;

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= arrayLength(&positions) || kdamping <= 0.0) { return; }
  let index = gid.x;
  if (positions[index].w <= 0.0) { return; }
  let base = i32(index) * i32(neighborCount);

  var groupIndices : array<i32, 9>;
  var groupCount : u32 = 0u;
  groupIndices[groupCount] = i32(index);
  groupCount++;
  for (var n : u32 = 0u; n < neighborCount && groupCount < 9u; n++) {
    let neighbor = neighborIndices[base + i32(n)];
    if (neighbor < 0) { continue; }
    groupIndices[groupCount] = neighbor;
    groupCount++;
  }

  var totalMass = 0.0;
  var xcm = vec3f(0.0);
  var vcm = vec3f(0.0);
  for (var i : u32 = 0u; i < groupCount; i++) {
    let gIndex = groupIndices[i];
    if (gIndex < 0) { continue; }
    let invMass = positions[u32(gIndex)].w;
    if (invMass <= 0.0) { continue; }
    let mass = 1.0 / invMass;
    totalMass += mass;
    xcm += positions[u32(gIndex)].xyz * mass;
    vcm += velocities[u32(gIndex)].xyz * mass;
  }
  if (totalMass <= 0.0) { return; }
  xcm /= totalMass;
  vcm /= totalMass;

  var L = vec3f(0.0);
  var ICol0 = vec3f(0.0); var ICol1 = vec3f(0.0); var ICol2 = vec3f(0.0);
  for (var i : u32 = 0u; i < groupCount; i++) {
    let gIndex = groupIndices[i];
    if (gIndex < 0) { continue; }
    let invMass = positions[u32(gIndex)].w;
    if (invMass <= 0.0) { continue; }
    let mass = 1.0 / invMass;
    let ri = positions[u32(gIndex)].xyz - xcm;
    let vel = velocities[u32(gIndex)].xyz;
    L += cross(ri, vel * mass);
    let diagTerm = dot(ri, ri) * mass;
    ICol0 += vec3f(diagTerm - mass * ri.x * ri.x, -mass * ri.x * ri.y, -mass * ri.x * ri.z);
    ICol1 += vec3f(-mass * ri.y * ri.x, diagTerm - mass * ri.y * ri.y, -mass * ri.y * ri.z);
    ICol2 += vec3f(-mass * ri.z * ri.x, -mass * ri.z * ri.y, diagTerm - mass * ri.z * ri.z);
  }
  var omega = vec3f(0.0);
  let inertia = mat3x3<f32>(ICol0, ICol1, ICol2);
  let det = dot(inertia[0], cross(inertia[1], inertia[2]));
  if (abs(det) > 1e-9) {
    let invDet = 1.0 / det;
    let invInertia = mat3x3<f32>(cross(inertia[1], inertia[2]) * invDet, cross(inertia[2], inertia[0]) * invDet, cross(inertia[0], inertia[1]) * invDet);
    omega = invInertia * L;
  }
  var vel = velocities[index].xyz;
  let riSelf = positions[index].xyz - xcm;
  let targetVelocity = vcm + cross(omega, riSelf);
  vel = vel + kdamping * (targetVelocity - vel);
  if (length(vel) > maxVelocity) { vel = normalize(vel) * maxVelocity; }
  velocities[index] = vec4f(vel, 0.0);
}`;
}

/** Local (whole-garment rigid-body) damping, state pass — ported from the original's
 *  ComputeDampingStateShader. A single-workgroup two-stage reduction over ALL particles:
 *  total mass + centre of mass + centre-of-mass velocity, then angular momentum + inertia tensor
 *  (and its inverse) to get the rigid-body angular velocity omega. Dispatch with EXACTLY 1
 *  workgroup. Velocities use the repo's vec4 convention (.w padding; original used array<vec3f>,
 *  same 16-byte stride). dampingState is 3 vec4f: xcm(+totalMass in .w), vcm, omega. */
export function computeDampingStateWGSL(): string {
  return /* wgsl */ `
struct DampingState {
  xcm : vec4f,
  vcm : vec4f,
  omega : vec4f,
};

@group(0) @binding(0) var<storage, read> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read> velocities: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> dampingState: DampingState;

const WORKGROUP_SIZE : u32 = ${WG}u;

var<workgroup> massShared : array<f32, ${WG}>;
var<workgroup> posShared : array<vec3f, ${WG}>;
var<workgroup> velShared : array<vec3f, ${WG}>;

var<workgroup> LShared : array<vec3f, ${WG}>;
var<workgroup> ICol0Shared : array<vec3f, ${WG}>;
var<workgroup> ICol1Shared : array<vec3f, ${WG}>;
var<workgroup> ICol2Shared : array<vec3f, ${WG}>;

var<workgroup> xcmShared : vec3f;
var<workgroup> vcmShared : vec3f;

@compute @workgroup_size(${WG})
fn main(@builtin(local_invocation_id) local_id: vec3u) {
  let particleCount = arrayLength(&positions);

  var massLocal = 0.0;
  var posMassLocal = vec3f(0.0);
  var velMassLocal = vec3f(0.0);

  var index = local_id.x;
  loop {
    if (index >= particleCount) { break; }
    let invMass = positions[index].w;
    if (invMass > 0.0) {
      let mass = 1.0 / invMass;
      let pos = positions[index].xyz;
      let vel = velocities[index].xyz;
      massLocal += mass;
      posMassLocal += pos * mass;
      velMassLocal += vel * mass;
    }
    index += WORKGROUP_SIZE;
  }

  massShared[local_id.x] = massLocal;
  posShared[local_id.x] = posMassLocal;
  velShared[local_id.x] = velMassLocal;
  workgroupBarrier();

  var stride = WORKGROUP_SIZE / 2u;
  loop {
    if (stride == 0u) { break; }
    if (local_id.x < stride) {
      massShared[local_id.x] += massShared[local_id.x + stride];
      posShared[local_id.x] += posShared[local_id.x + stride];
      velShared[local_id.x] += velShared[local_id.x + stride];
    }
    workgroupBarrier();
    stride = stride / 2u;
  }

  if (local_id.x == 0u) {
    let totalMass = massShared[0];
    var xcm = vec3f(0.0);
    var vcm = vec3f(0.0);
    if (totalMass > 0.0) {
      xcm = posShared[0] / totalMass;
      vcm = velShared[0] / totalMass;
    }
    dampingState.xcm = vec4f(xcm, totalMass);
    dampingState.vcm = vec4f(vcm, 0.0);
    xcmShared = xcm;
    vcmShared = vcm;
  }
  storageBarrier();
  workgroupBarrier();

  let totalMass = massShared[0];
  let hasMass = totalMass > 0.0;

  var LLocal = vec3f(0.0);
  var ICol0Local = vec3f(0.0);
  var ICol1Local = vec3f(0.0);
  var ICol2Local = vec3f(0.0);

  if (hasMass) {
    var index2 = local_id.x;
    loop {
      if (index2 >= particleCount) { break; }
      let invMass = positions[index2].w;
      if (invMass > 0.0) {
        let mass = 1.0 / invMass;
        let pos = positions[index2].xyz;
        let vel = velocities[index2].xyz;
        let ri = pos - xcmShared;
        let miVi = vel * mass;
        LLocal += cross(ri, miVi);

        let diagTerm = dot(ri, ri) * mass;
        let rx = ri.x; let ry = ri.y; let rz = ri.z;
        ICol0Local += vec3f(diagTerm - mass * rx * rx, -mass * rx * ry, -mass * rx * rz);
        ICol1Local += vec3f(-mass * ry * rx, diagTerm - mass * ry * ry, -mass * ry * rz);
        ICol2Local += vec3f(-mass * rz * rx, -mass * rz * ry, diagTerm - mass * rz * rz);
      }
      index2 += WORKGROUP_SIZE;
    }
  }

  LShared[local_id.x] = LLocal;
  ICol0Shared[local_id.x] = ICol0Local;
  ICol1Shared[local_id.x] = ICol1Local;
  ICol2Shared[local_id.x] = ICol2Local;
  workgroupBarrier();

  var stride2 = WORKGROUP_SIZE / 2u;
  loop {
    if (stride2 == 0u) { break; }
    if (local_id.x < stride2) {
      LShared[local_id.x] += LShared[local_id.x + stride2];
      ICol0Shared[local_id.x] += ICol0Shared[local_id.x + stride2];
      ICol1Shared[local_id.x] += ICol1Shared[local_id.x + stride2];
      ICol2Shared[local_id.x] += ICol2Shared[local_id.x + stride2];
    }
    workgroupBarrier();
    stride2 = stride2 / 2u;
  }

  if (local_id.x == 0u) {
    var omega = vec3f(0.0);
    if (hasMass) {
      let inertia = mat3x3<f32>(ICol0Shared[0], ICol1Shared[0], ICol2Shared[0]);
      let det = dot(inertia[0], cross(inertia[1], inertia[2]));
      let LTotal = LShared[0];
      if (abs(det) > 1e-9) {
        let invDet = 1.0 / det;
        let invInertia = mat3x3<f32>(
          cross(inertia[1], inertia[2]) * invDet,
          cross(inertia[2], inertia[0]) * invDet,
          cross(inertia[0], inertia[1]) * invDet
        );
        omega = invInertia * LTotal;
      }
    }
    dampingState.omega = vec4f(omega, 0.0);
  }
  storageBarrier();
}`;
}

/** Local damping, apply pass — ported from the original's ApplyLocalDampingShader: damp each
 *  particle's velocity toward the whole-garment rigid-body motion (vcm + omega x ri). */
export function applyLocalDampingWGSL(cfg: SimConfig): string {
  return /* wgsl */ `
struct DampingState {
  xcm : vec4f,
  vcm : vec4f,
  omega : vec4f,
};

@group(0) @binding(0) var<storage, read> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> velocities: array<vec4f>;
@group(0) @binding(2) var<storage, read> dampingState: DampingState;

const kdamping = ${cfg.localDamping}f;
const maxVelocity = ${cfg.maxVelocity}f;

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= arrayLength(&positions) || kdamping <= 0.0) { return; }
  let index = gid.x;
  let invMass = positions[index].w;
  if (invMass <= 0.0) { return; }

  let pos = positions[index].xyz;
  var vel = velocities[index].xyz;

  let xcm = dampingState.xcm.xyz;
  let vcm = dampingState.vcm.xyz;
  let totalMass = dampingState.xcm.w;
  let omega = dampingState.omega.xyz;

  if (totalMass <= 0.0) { return; }

  let ri = pos - xcm;
  let globalMotion = vcm + cross(omega, ri);
  let delta = globalMotion - vel;
  vel = vel + kdamping * delta;
  if (length(vel) > maxVelocity) { vel = normalize(vel) * maxVelocity; }
  velocities[index] = vec4f(vel, 0.0);
}`;
}

/** Ground collision + velocity from position delta, with clamping. */
export function velocityWGSL(cfg: SimConfig): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> positions: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> velocities: array<vec4f>;
@group(0) @binding(2) var<storage, read> lastPositions: array<vec4f>;

const deltaT = ${cfg.deltaT}f;
const globalDamping = ${1 - cfg.globalDamping}f;
const thickness = ${cfg.simulationThickness}f;
const maxVelocity = ${cfg.maxVelocity}f;
const minVelocity = ${cfg.minVelocity}f;

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let index = gid.x;
  if (index >= arrayLength(&positions)) { return; }
  if (positions[index].y <= thickness) {
    positions[index].y = thickness;
    velocities[index] = vec4f(0.0);
    return;
  }
  var vel = globalDamping * (positions[index].xyz - lastPositions[index].xyz) / deltaT;
  let speed = length(vel);
  if (speed > maxVelocity) { vel = normalize(vel) * maxVelocity; }
  else if (speed < minVelocity) { vel = vec3f(0.0); }
  velocities[index] = vec4f(vel, 0.0);
}`;
}
