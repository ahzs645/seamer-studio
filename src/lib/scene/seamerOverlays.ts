// App-owned seam/measurement/arrangement semantics rendered through @atelier/viewport overlays.

import * as THREE from 'three';
import type { AvatarController } from '@seamer/avatar';
import { measurementSegment } from '@seamer/avatar';
import type { CylinderFrame, PreparedCloth } from '@seamer/cloth-sim';
import {
  docToWorld,
  worldToDoc,
  type CustomOverlayLabel,
  type Viewport
} from '@atelier/viewport';
import {
  samePick,
  seamColor,
  type SeamPick,
  type SeamToolState
} from '@seamer/pattern-model';

export interface ArrangementMarker {
  name: string;
  cylinderName: string;
  uDegrees: number;
  v: number;
  position: THREE.Vector3;
  picker: THREE.Mesh;
}

export interface MeasurementOverlayDef {
  id: string;
  name: string;
  a: { x: number; y: number };
  b: { x: number; y: number };
  unit: string;
}

interface SeamLineEntry {
  id: string;
  seamId: string;
  pairs: number[];
}

interface WireLineEntry {
  id: string;
  /** Consecutive particle pairs along the wire, ready for the line overlay. */
  segments: number[];
  diameter: number;
}

interface MeasureEntry {
  lineId: string;
  labelId: string;
  aIdx: number;
  bIdx: number;
  name: string;
  unit: string;
  label: THREE.Sprite;
  lastLen: number;
  lastTextAt: number;
}

interface SeamToolEntry {
  mesh: THREE.InstancedMesh;
  cone: THREE.Mesh;
  run: number[];
  reversed: boolean;
}

type LabelFactory = (text: string) => {
  obj: THREE.Object3D;
  aspect: number;
};

const ARRANGEMENT_POINTS_ID = 'seamer-arrangement-points';
const ARRANGEMENT_HOVER_ID = 'seamer-arrangement-hover';
const OUTLINE_ID = 'seamer-selection-outline';
const BODY_LINE_ID = 'seamer-body-measure-line';
const BODY_LABEL_ID = 'seamer-body-measure-label';

export class SeamerOverlays {
  private prepared: PreparedCloth | null = null;
  private positions: Float32Array | null = null;
  private avatar: AvatarController | null = null;
  private cylinders = new Map<string, CylinderFrame>();
  private readonly markerPickGroup = new THREE.Group();
  private markerGeometry: THREE.SphereGeometry | null = null;
  private markerMaterial: THREE.MeshBasicMaterial | null = null;
  private arrangementMarkers: ArrangementMarker[] = [];
  private hasArrangementPoints = false;
  private showArrangementPoints = false;
  private seamLines: SeamLineEntry[] = [];
  private showSeams = false;
  private selectedSeam: string | null = null;
  private wireLines: WireLineEntry[] = [];
  private showWires = true;
  private readonly seamToolGroup = new THREE.Group();
  private seamToolEntries: SeamToolEntry[] = [];
  private seamToolState: SeamToolState | null = null;
  private seamToolHover: SeamPick | null = null;
  private seamToolKind: 'single' | 'multi' = 'single';
  private outlinePairs: number[] = [];
  private highlightedPiece: string | null = null;
  private measurementDefs: MeasurementOverlayDef[] = [];
  private measurementEntries: MeasureEntry[] = [];
  private bodyMeasureName: string | null = null;

  constructor(
    private readonly viewport: Viewport,
    private readonly clothGroup: THREE.Group,
    private readonly makeLabel: LabelFactory
  ) {
    this.markerPickGroup.name = 'seamer-arrangement-point-pickers';
    this.viewport.scene.add(this.markerPickGroup);
    this.seamToolGroup.name = 'seamer-seam-tool';
    this.viewport.scene.add(this.seamToolGroup);
  }

  setAvatarContext(
    avatar: AvatarController | null,
    cylinders: Map<string, CylinderFrame>
  ): void {
    this.avatar = avatar;
    this.cylinders = cylinders;
    this.rebuildArrangementMarkers();
  }

  setPrepared(prepared: PreparedCloth | null, positions: Float32Array | null): void {
    this.clearPrepared();
    this.prepared = prepared;
    this.positions = positions;
    if (!prepared || !positions) return;
    this.rebuildSeamLines();
    this.rebuildWireLines();
    this.rebuildSeamTool();
    this.rebuildSelectionOutline();
    this.rebuildMeasurements();
  }

  clearPrepared(): void {
    this.clearSeamLines();
    this.clearWireLines();
    this.clearSeamTool();
    this.viewport.overlays.remove(OUTLINE_ID);
    this.outlinePairs = [];
    this.clearMeasurements();
    this.prepared = null;
    this.positions = null;
  }

  updatePositions(positions: Float32Array): void {
    this.positions = positions;
    this.updateSeamLines();
    this.updateWireLines();
    this.updateSeamToolPositions();
    this.updateSelectionOutline();
    this.updateMeasurements();
  }

  /** Show the stiffener sewn into each channel — the ribs that make a lantern hold its shape. */
  setShowWires(show: boolean): void {
    this.showWires = show;
    if (show && this.wireLines.length === 0) this.rebuildWireLines();
    for (const entry of this.wireLines) this.viewport.overlays.setVisible(entry.id, show);
    this.updateWireLines();
  }

  setHighlightedPiece(pieceId: string | null): void {
    this.highlightedPiece = pieceId;
    this.rebuildSelectionOutline();
  }

  setShowSeams(show: boolean): void {
    this.showSeams = show;
    if ((show || this.selectedSeam) && this.seamLines.length === 0) {
      this.rebuildSeamLines();
    }
    this.applySeamVisibility();
  }

  setSelectedSeam(seamId: string | null): void {
    this.selectedSeam = seamId;
    if ((this.showSeams || seamId) && this.seamLines.length === 0) {
      this.rebuildSeamLines();
    }
    this.applySeamVisibility();
  }

  setSeamToolState(
    state: SeamToolState | null,
    kind: 'single' | 'multi' = 'single'
  ): void {
    this.seamToolState = state
      ? { from: [...state.from], to: [...state.to], phase: state.phase }
      : null;
    this.seamToolKind = kind;
    if (!state) this.seamToolHover = null;
    this.rebuildSeamTool();
  }

  setSeamToolHover(pick: SeamPick | null): void {
    this.seamToolHover = pick;
    this.rebuildSeamTool();
  }

  setShowArrangementPoints(show: boolean): void {
    this.showArrangementPoints = show;
    this.rebuildArrangementMarkers();
  }

  pickArrangementMarker(event: PointerEvent): ArrangementMarker | null {
    if (!this.showArrangementPoints || this.arrangementMarkers.length === 0) return null;
    const hit = this.viewport.picking.raycast(event, {
      objects: [this.markerPickGroup],
      recursive: true
    })[0];
    return hit
      ? this.arrangementMarkers.find((marker) => marker.picker === hit.object) ?? null
      : null;
  }

  setArrangementHover(marker: ArrangementMarker | null): void {
    if (!marker) {
      this.viewport.overlays.remove(ARRANGEMENT_HOVER_ID);
      return;
    }
    this.viewport.overlays.addPoints(
      ARRANGEMENT_HOVER_ID,
      new Float32Array(marker.position.toArray()),
      { color: '#f97316', size: 12 },
      { depthTest: false, renderOrder: 11 }
    );
  }

  setMeasurements(defs: MeasurementOverlayDef[]): void {
    this.measurementDefs = defs;
    this.rebuildMeasurements();
  }

  addPieceLabel(id: string, object: THREE.Object3D): void {
    this.viewport.overlays.addCustomLabel(
      id,
      this.ownLabel(object),
      object.position,
      { parent: this.clothGroup, depthTest: true, renderOrder: 10 }
    );
  }

  removePieceLabel(id: string): void {
    this.viewport.overlays.remove(id);
  }

  clearBodyMeasurement(): void {
    this.viewport.overlays.remove(BODY_LINE_ID);
    this.viewport.overlays.remove(BODY_LABEL_ID);
    this.bodyMeasureName = null;
  }

  showBodyMeasurement(name: string): boolean {
    if (this.bodyMeasureName === name) {
      this.clearBodyMeasurement();
      return false;
    }
    this.clearBodyMeasurement();
    if (!this.avatar) return false;
    const def = this.avatar.measurementSegmentDefs.find((candidate) => candidate.name === name);
    if (!def) return false;
    const segment = measurementSegment(
      def,
      this.avatar.vertexPositions,
      this.avatar.indices
    );
    if (!segment || segment.points.length < 2) return false;
    const points = segment.closed
      ? [...segment.points, segment.points[0]]
      : segment.points;
    const positions: number[] = [];
    for (let index = 1; index < points.length; index++) {
      positions.push(...points[index - 1], ...points[index]);
    }
    this.viewport.overlays.addLines(
      BODY_LINE_ID,
      new Float32Array(positions),
      { color: '#e11d8f', width: 3, opacity: 0.95 },
      { depthTest: false, renderOrder: 12 }
    );
    const { obj } = this.makeLabel(
      `${name}: ${(segment.lengthM * 100).toFixed(1)} cm`
    );
    const top = points.reduce(
      (best, point) => point[1] > best[1] ? point : best,
      points[0]
    );
    this.viewport.overlays.addCustomLabel(
      BODY_LABEL_ID,
      this.ownLabel(obj),
      new THREE.Vector3(top[0], top[1] + 0.05, top[2]),
      { depthTest: true, renderOrder: 12 }
    );
    this.bodyMeasureName = name;
    return true;
  }

  dispose(): void {
    this.clearPrepared();
    this.clearArrangementMarkers();
    this.clearBodyMeasurement();
    this.viewport.scene.remove(this.markerPickGroup);
    this.viewport.scene.remove(this.seamToolGroup);
  }

  private rebuildSelectionOutline(): void {
    this.viewport.overlays.remove(OUTLINE_ID);
    this.outlinePairs = [];
    if (!this.highlightedPiece || !this.prepared) return;
    const piece = this.prepared.simData.pieces.find(
      (candidate) => candidate.pieceId === this.highlightedPiece
    );
    if (!piece) return;
    const counts = new Map<string, number>();
    const ends = new Map<string, [number, number]>();
    for (let triangle = 0; triangle < piece.triangles.length; triangle += 3) {
      const vertices = [
        piece.triangles[triangle],
        piece.triangles[triangle + 1],
        piece.triangles[triangle + 2]
      ];
      for (let edge = 0; edge < 3; edge++) {
        const a = vertices[edge];
        const b = vertices[(edge + 1) % 3];
        const key = `${Math.min(a, b)}_${Math.max(a, b)}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        ends.set(key, [a, b]);
      }
    }
    for (const [key, count] of counts) {
      if (count !== 1) continue;
      const pair = ends.get(key);
      if (pair) this.outlinePairs.push(...pair);
    }
    if (this.outlinePairs.length === 0) return;
    this.viewport.overlays.addLines(
      OUTLINE_ID,
      this.positionsForIndices(this.outlinePairs),
      { color: '#1d4ed8', width: 4, opacity: 0.95 },
      { parent: this.clothGroup, depthTest: true, renderOrder: 10 }
    );
  }

  private updateSelectionOutline(): void {
    if (this.outlinePairs.length === 0) return;
    this.viewport.overlays.updateLines(
      OUTLINE_ID,
      this.positionsForIndices(this.outlinePairs)
    );
  }

  private rebuildSeamLines(): void {
    this.clearSeamLines();
    if (!this.prepared || (!this.showSeams && !this.selectedSeam)) return;
    for (const { seamId, index, pairs } of this.prepared.simData.seamPairsBySeam) {
      if (pairs.length === 0) continue;
      // `pairs` is [from0,to0, from1,to1, ...]. Drawing it directly produces a dense ladder of
      // cross-seam links which can read as brightly filled/torn triangles. The source's “show all
      // seams” view traces each sewn boundary on the cloth surface instead.
      const edgeSegments: number[] = [];
      for (let side = 0; side < 2; side += 1) {
        for (let particle = side; particle + 2 < pairs.length; particle += 2) {
          edgeSegments.push(pairs[particle], pairs[particle + 2]);
        }
      }
      if (edgeSegments.length === 0) continue;
      const id = `seamer-seam-${seamId}`;
      this.viewport.overlays.addLines(
        id,
        this.positionsForIndices(edgeSegments),
        { color: seamColor(index), width: 1.5, opacity: 0.78 },
        { parent: this.clothGroup, depthTest: true, renderOrder: 3 }
      );
      this.seamLines.push({ id, seamId, pairs: edgeSegments });
    }
    this.applySeamVisibility();
  }

  private applySeamVisibility(): void {
    for (const entry of this.seamLines) {
      const selected = entry.seamId === this.selectedSeam;
      this.viewport.overlays.setVisible(entry.id, this.showSeams || selected);
      this.viewport.overlays.setStyle(entry.id, {
        width: selected ? 3.5 : 1.5,
        opacity: !this.selectedSeam || selected ? 0.78 : 0.4
      });
    }
    this.updateSeamLines();
  }

  private updateSeamLines(): void {
    for (const entry of this.seamLines) {
      if (!this.showSeams && entry.seamId !== this.selectedSeam) continue;
      this.viewport.overlays.updateLines(
        entry.id,
        this.positionsForIndices(entry.pairs)
      );
    }
  }

  private clearSeamLines(): void {
    for (const entry of this.seamLines) this.viewport.overlays.remove(entry.id);
    this.seamLines = [];
  }

  /** One polyline per wire run. Drawn heavier than a seam line and in a metal tone, because a rib
   *  reads as structure rather than stitching. */
  private rebuildWireLines(): void {
    this.clearWireLines();
    if (!this.prepared || !this.showWires) return;
    for (const run of this.prepared.simData.wireRuns) {
      if (run.particles.length < 2) continue;
      const segments: number[] = [];
      for (let i = 1; i < run.particles.length; i++) segments.push(run.particles[i - 1], run.particles[i]);
      if (run.closed) segments.push(run.particles[run.particles.length - 1], run.particles[0]);
      const id = `seamer-wire-${run.pieceId}-${run.piecePathId}`;
      this.viewport.overlays.addLines(
        id,
        this.positionsForIndices(segments),
        { color: '#B8862B', width: Math.max(2, Math.min(6, run.diameter * 1.6)), opacity: 0.95 },
        { parent: this.clothGroup, depthTest: true, renderOrder: 6 }
      );
      this.wireLines.push({ id, segments, diameter: run.diameter });
    }
  }

  private updateWireLines(): void {
    if (!this.showWires) return;
    for (const entry of this.wireLines) {
      this.viewport.overlays.updateLines(entry.id, this.positionsForIndices(entry.segments));
    }
  }

  private clearWireLines(): void {
    for (const entry of this.wireLines) this.viewport.overlays.remove(entry.id);
    this.wireLines = [];
  }

  private seamRunFor(pick: { id: string; mirrored: boolean }): number[] | null {
    if (!this.prepared) return null;
    const suffix = `::${pick.id}${pick.mirrored ? '#M' : ''}`;
    for (const [key, run] of this.prepared.simData.edgeRuns) {
      if (key.endsWith(suffix) && run.length >= 2) return run;
    }
    return null;
  }

  private rebuildSeamTool(): void {
    this.clearSeamTool();
    const state = this.seamToolState;
    if (!state || !this.prepared) {
      this.seamToolGroup.visible = false;
      return;
    }
    this.seamToolGroup.visible = true;
    const addRun = (pick: SeamPick, color: number, opacity = 0.95): void => {
      const run = this.seamRunFor(pick);
      if (!run) return;
      const radius = 0.0025; // the original's seamToolRadius
      const cylinder = new THREE.CylinderGeometry(radius, radius, 1, 5, 1);
      cylinder.translate(0, 0.5, 0); // unit Y cylinder, base at origin -> scaled per segment
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthTest: false
      });
      const mesh = new THREE.InstancedMesh(cylinder, material, run.length - 1);
      mesh.frustumCulled = false;
      mesh.renderOrder = 11;
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.007, 0.018, 10),
        material
      );
      cone.frustumCulled = false;
      cone.renderOrder = 12;
      this.seamToolGroup.add(mesh, cone);
      this.seamToolEntries.push({ mesh, cone, run, reversed: pick.reversed });
    };
    for (const pick of state.from) addRun(pick, 0xd946ef);
    for (const pick of state.to) addRun(pick, 0x2563eb);
    const hover = this.seamToolHover;
    if (
      hover
      && !state.from.some((pick) => samePick(pick, hover))
      && !state.to.some((pick) => samePick(pick, hover))
    ) {
      // Hover previews the side the click would land on: blue for "to", magenta for "from".
      const toPhase = this.seamToolKind === 'multi'
        ? state.phase === 'to'
        : state.from.length > 0;
      addRun(hover, toPhase ? 0x60a5fa : 0xe879f9, 0.6);
    }
    this.updateSeamToolPositions();
    this.viewport.invalidate();
  }

  private clearSeamTool(): void {
    for (const entry of this.seamToolEntries) {
      this.seamToolGroup.remove(entry.mesh, entry.cone);
      entry.mesh.geometry.dispose();
      (entry.mesh.material as THREE.Material).dispose();
      entry.cone.geometry.dispose();
    }
    this.seamToolEntries = [];
    this.viewport.invalidate();
  }

  /** Re-place the tool tubes and cones on the live particle positions. */
  private updateSeamToolPositions(): void {
    if (this.seamToolEntries.length === 0 || !this.prepared || !this.positions) return;
    const position = this.positions;
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const quaternion = new THREE.Quaternion();
    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    for (const entry of this.seamToolEntries) {
      const run = entry.reversed ? [...entry.run].reverse() : entry.run;
      let total = 0;
      for (let index = 0; index + 1 < run.length; index++) {
        const a = run[index];
        const b = run[index + 1];
        from.set(position[a * 4], position[a * 4 + 1], position[a * 4 + 2]);
        to.set(position[b * 4], position[b * 4 + 1], position[b * 4 + 2]);
        direction.subVectors(to, from);
        const length = direction.length() || 1e-6;
        total += length;
        quaternion.setFromUnitVectors(up, direction.normalize());
        matrix.compose(from, quaternion, scale.set(1, length, 1));
        entry.mesh.setMatrixAt(index, matrix);
      }
      entry.mesh.instanceMatrix.needsUpdate = true;

      let traveled = 0;
      const midpoint = total / 2;
      for (let index = 0; index + 1 < run.length; index++) {
        const a = run[index];
        const b = run[index + 1];
        from.set(position[a * 4], position[a * 4 + 1], position[a * 4 + 2]);
        to.set(position[b * 4], position[b * 4 + 1], position[b * 4 + 2]);
        direction.subVectors(to, from);
        const length = direction.length() || 1e-6;
        if (traveled + length >= midpoint || index === run.length - 2) {
          const fraction = Math.max(
            0,
            Math.min(1, (midpoint - traveled) / length)
          );
          entry.cone.position.copy(from).addScaledVector(direction, fraction);
          entry.cone.quaternion.setFromUnitVectors(up, direction.normalize());
          break;
        }
        traveled += length;
      }
    }
  }

  private rebuildArrangementMarkers(): void {
    this.viewport.overlays.remove(ARRANGEMENT_HOVER_ID);
    this.clearArrangementPickers();
    if (
      !this.showArrangementPoints
      || !this.avatar
      || this.cylinders.size === 0
    ) {
      this.viewport.overlays.remove(ARRANGEMENT_POINTS_ID);
      this.hasArrangementPoints = false;
      return;
    }
    this.markerGeometry = new THREE.SphereGeometry(0.012, 8, 6);
    this.markerMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false
    });
    const positions: number[] = [];
    for (const def of this.avatar.arrangementPointDefs) {
      if (def.enabled === false) continue;
      const frame = this.cylinders.get(def.cylinderName);
      if (!frame) continue;
      const position = frame.uvToWorld(
        def.uDegrees,
        def.v,
        0.012,
        new THREE.Vector3()
      );
      const picker = new THREE.Mesh(this.markerGeometry, this.markerMaterial);
      picker.position.copy(position);
      this.markerPickGroup.add(picker);
      positions.push(...position.toArray());
      this.arrangementMarkers.push({
        name: def.name,
        cylinderName: def.cylinderName,
        uDegrees: def.uDegrees,
        v: def.v,
        position,
        picker
      });
    }
    if (positions.length > 0) {
      const points = new Float32Array(positions);
      if (this.hasArrangementPoints) {
        this.viewport.overlays.updatePoints(ARRANGEMENT_POINTS_ID, points);
      } else {
        this.viewport.overlays.addPoints(
          ARRANGEMENT_POINTS_ID,
          points,
          { color: '#0ea5e9', size: 10 },
          { depthTest: false, renderOrder: 10 }
        );
        this.hasArrangementPoints = true;
      }
    } else {
      this.viewport.overlays.remove(ARRANGEMENT_POINTS_ID);
      this.hasArrangementPoints = false;
    }
  }

  private clearArrangementMarkers(): void {
    this.viewport.overlays.remove(ARRANGEMENT_POINTS_ID);
    this.viewport.overlays.remove(ARRANGEMENT_HOVER_ID);
    this.hasArrangementPoints = false;
    this.clearArrangementPickers();
  }

  private clearArrangementPickers(): void {
    this.markerPickGroup.clear();
    this.markerGeometry?.dispose();
    this.markerMaterial?.dispose();
    this.markerGeometry = null;
    this.markerMaterial = null;
    this.arrangementMarkers = [];
  }

  private rebuildMeasurements(): void {
    this.clearMeasurements();
    if (!this.prepared || this.measurementDefs.length === 0) return;
    const data = this.prepared.simData;
    const count = data.positions2d.length / 4;
    const nearest = (point: { x: number; y: number }): number => {
      const world = docToWorld(point);
      let best = -1;
      let bestDistance = 0.025 * 0.025;
      for (let index = 0; index < count; index++) {
        const dx = data.positions2d[index * 4] - world.x;
        const dy = data.positions2d[index * 4 + 1] - world.y;
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
      return best;
    };

    for (const def of this.measurementDefs) {
      const aIdx = nearest(def.a);
      const bIdx = nearest(def.b);
      if (aIdx < 0 || bIdx < 0) continue;
      const lineId = `seamer-measure-line-${def.id}`;
      const labelId = `seamer-measure-label-${def.id}`;
      this.viewport.overlays.addLines(
        lineId,
        new Float32Array(6),
        { color: '#f97316', width: 1.5, opacity: 0.95 },
        { depthTest: false, renderOrder: 11 }
      );
      const { obj } = this.makeLabel(`${def.name}: …`);
      if (!(obj instanceof THREE.Sprite)) continue;
      this.viewport.overlays.addCustomLabel(
        labelId,
        this.ownLabel(obj),
        new THREE.Vector3(),
        { depthTest: false, renderOrder: 12 }
      );
      this.measurementEntries.push({
        lineId,
        labelId,
        aIdx,
        bIdx,
        name: def.name,
        unit: def.unit,
        label: obj,
        lastLen: -1,
        lastTextAt: 0
      });
    }
    this.updateMeasurements();
  }

  private updateMeasurements(): void {
    if (!this.positions || this.measurementEntries.length === 0) return;
    const now = performance.now();
    for (const entry of this.measurementEntries) {
      const a = entry.aIdx * 4;
      const b = entry.bIdx * 4;
      const ax = this.positions[a];
      const ay = this.positions[a + 1];
      const az = this.positions[a + 2];
      const bx = this.positions[b];
      const by = this.positions[b + 1];
      const bz = this.positions[b + 2];
      this.viewport.overlays.updateLines(
        entry.lineId,
        new Float32Array([ax, ay, az, bx, by, bz])
      );
      entry.label.position.set(
        (ax + bx) / 2,
        (ay + by) / 2 + 0.02,
        (az + bz) / 2
      );
      const lengthMm = worldToDoc(new THREE.Vector3(
        Math.hypot(bx - ax, by - ay, bz - az),
        0,
        0
      )).x;
      // Re-bake only on a meaningful change, at most about four times per second.
      if (
        Math.abs(lengthMm - entry.lastLen) <= 0.5
        || now - entry.lastTextAt <= 250
      ) {
        continue;
      }
      entry.lastLen = lengthMm;
      entry.lastTextAt = now;
      const display = entry.unit === 'inch'
        ? `${(lengthMm / 25.4).toFixed(2)} in`
        : entry.unit === 'cm'
          ? `${(lengthMm / 10).toFixed(1)} cm`
          : `${lengthMm.toFixed(0)} mm`;
      const { obj, aspect } = this.makeLabel(`${entry.name}: ${display}`);
      if (!(obj instanceof THREE.Sprite)) continue;
      const material = entry.label.material;
      material.map?.dispose();
      material.map = obj.material.map;
      material.needsUpdate = true;
      obj.material.map = null;
      obj.material.dispose();
      entry.label.scale.set(0.032 * aspect, 0.032, 1);
    }
    this.viewport.invalidate();
  }

  private clearMeasurements(): void {
    for (const entry of this.measurementEntries) {
      this.viewport.overlays.remove(entry.lineId);
      this.viewport.overlays.remove(entry.labelId);
    }
    this.measurementEntries = [];
  }

  private positionsForIndices(indices: readonly number[]): Float32Array {
    const output = new Float32Array(indices.length * 3);
    if (!this.positions) return output;
    for (let index = 0; index < indices.length; index++) {
      const source = indices[index] * 4;
      output[index * 3] = this.positions[source];
      output[index * 3 + 1] = this.positions[source + 1];
      output[index * 3 + 2] = this.positions[source + 2];
    }
    return output;
  }

  private ownLabel(object: THREE.Object3D): CustomOverlayLabel {
    return {
      object,
      dispose: () => {
        if (!(object instanceof THREE.Sprite) && !(object instanceof THREE.Mesh)) return;
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        for (const material of materials) {
          if (
            material instanceof THREE.SpriteMaterial
            || material instanceof THREE.MeshBasicMaterial
          ) {
            material.map?.dispose();
          }
          material.dispose();
        }
        if (object instanceof THREE.Mesh) object.geometry.dispose();
      }
    };
  }
}
