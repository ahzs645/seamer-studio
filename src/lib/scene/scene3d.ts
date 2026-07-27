// Thin app-level orchestration over @atelier/viewport plus seamer-owned cloth/avatar semantics.
// The WebGPU cloth solve runs in a separate self-paced async loop and writes results back into the
// cloth geometry; every write invalidates the on-demand viewport frame.

import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import type { Pattern, Material } from '@seamer/pattern-model';
import { AvatarController } from '@seamer/avatar';
import { buildCylinders, type CylinderFrame } from '@seamer/cloth-sim';
import { arrangeParticles } from '@seamer/cloth-sim';
import { prepareCloth, ClothSimulation, type PreparedCloth } from '@seamer/cloth-sim';
import { SIM_CONFIG, type SimConfig } from '@seamer/cloth-sim';
import { cylinderRefit } from '@seamer/cloth-sim';
import { SolverRunner, requestDevice, isWebGPUAvailable } from '@atelier/sim';
import {
  docToWorld,
  worldToDoc,
  type Viewport
} from '@atelier/viewport';
import { createGarmentMaterial, createAvatarMaterial, hasSeparateBack, disposeGarmentMaterial } from './materials';
import { createPieceTexture, pieceNeedsBake } from './pieceTexture';
import { indexPoints, pieceInternalPolylines } from '@seamer/pattern-model';
import { samePick, type SeamPick, type SeamToolState } from '$lib/utils/seamTool';
import { SeamerLighting } from './seamerLighting';
import {
  SeamerOverlays,
  type ArrangementMarker,
  type MeasurementOverlayDef
} from './seamerOverlays';

export type RendererStatus = 'idle' | 'loading' | 'ready' | 'simulating' | 'invalid' | 'error';

interface ClothMeshEntry {
  pieceId: string;
  start: number;
  count: number;
  geometry: THREE.BufferGeometry;
  mesh: THREE.Mesh;
  backMesh?: THREE.Mesh; // optional separate back-face mesh (shares geometry); for distinct back textures
  // visual fabric thickness (visualizationThickness > 0): the edge strip closing the front/back shells
  sideMesh?: THREE.Mesh;
  sidePairs?: number[]; // flat LOCAL index pairs of boundary edges
  shellM?: number; // half thickness in meters
  baseVisible: boolean; // visibility driven by the pattern's hidden flag (independent of triangle overlay)
}

// One movable piece in the pre-simulation arrangement editor: its flat-on-body geometry is centred
// in a Group at its centroid; the Group is moved/rotated by the transform gizmo. The sim is later
// seeded from group.matrixWorld * baseLocal.
interface ArrangeEntry {
  pieceId: string;
  start: number;
  count: number;
  group: THREE.Group;
  mesh: THREE.Mesh;
  baseLocal: Float32Array; // per-particle position relative to the group origin (centroid)
}

export type SceneMode = 'view' | 'arrange';

export class PatternRenderer {
  private readonly viewport: Viewport;
  private readonly container: HTMLElement;
  private readonly scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly lighting: SeamerLighting;
  private readonly overlays: SeamerOverlays;
  private clothGroup = new THREE.Group();
  private lightingMode = 'flat';
  private bokehFStop = 0; // 0 = depth of field off; focus auto-tracks the orbit target each frame

  // camera persistence: fired (debounced) after the user orbits/zooms so the app can save the view
  onCameraChanged: (pos: [number, number, number], target: [number, number, number], fov: number) => void = () => {};
  private cameraSaveTimer: ReturnType<typeof setTimeout> | undefined;

  // Named arrangement-point markers from base_model.json are rendered by SeamerOverlays.
  private arrangementHover: ArrangementMarker | null = null;
  onArrangementPointPicked: (pick: { pieceId: string; name: string; cylinderName: string; uDegrees: number; v: number }) => void = () => {};
  onArrangementPointHover: (name: string | null) => void = () => {};

  private avatar: AvatarController | null = null;
  private cylinders: Map<string, CylinderFrame> = new Map();
  private baseCylinders: Map<string, CylinderFrame> | null = null; // frames the cached drape was authored on
  private prepared: PreparedCloth | null = null;
  private clothMeshes: ClothMeshEntry[] = [];
  private clothBackMeshes: THREE.Mesh[] = []; // optional back-face meshes (separate back texture)
  private pieceLabels: {
    pieceId: string;
    overlayId: string;
    obj: THREE.Object3D;
    aspect: number;
  }[] = [];
  private showLabels = true;
  private labelMode: 'billboard' | 'flat' = 'flat';

  private device: GPUDevice | null = null;
  private sim: ClothSimulation | null = null;
  private simRunner: SolverRunner<{ positions: Float32Array }> | null = null;
  private disposeSimFrame: (() => void) | null = null;
  private simulating = false;
  private userSimulating = false; // true while a sim the USER started (via Start) is running
  // Live "hold" strength. The original solver has NO per-frame anchor; ours softly guides saved
  // pieces toward the cached drape (the original solver's own equilibrium) so our approximate solve
  // doesn't drift/curl. 1.0 froze it to a still image; a gentle value lets physics breathe/settle
  // while staying faithful to the source's shape. The source itself has NO anchor — but a fully free
  // settle (scale 0) slides the garment ~18-30cm off equilibrium (our solver lacks the source's
  // implicit grip), so a small hold is load-bearing. A headless anchor sweep showed a sharp cliff:
  // every nonzero scale holds the drape within <0.2mm drift (plateaued), only scale 0 drifts; 0.08
  // even had the LOWEST over-stretch (1.58 vs 0.25's 1.69). So we relax to 0.08 — ~3x more give /
  // closer to the source's free feel, while staying comfortably on the held side of the cliff.
  private static readonly LIVE_ANCHOR = 0.08;
  private liveAnchorScale = 0; // restored after an interactive grab
  // "Anchor to saved drape" toggle: OFF (default) = source-parity free-run — the garment hangs by
  // its seams/stretch alone like the original, so a drag pulls the whole connected garment; ON =
  // the gentle LIVE_ANCHOR hold above for extra cached-drape stability.
  private anchorsEnabled = false;

  /** The live hold strength honouring the "Anchor to saved drape" toggle. */
  private holdAnchor(): number {
    return this.anchorsEnabled ? PatternRenderer.LIVE_ANCHOR : 0;
  }

  /** Enable/disable the saved-drape anchor. Applies live to a running user sim. */
  setAnchorsEnabled(on: boolean): void {
    if (this.anchorsEnabled === on) return;
    this.anchorsEnabled = on;
    this.liveAnchorScale = this.holdAnchor();
    if (this.userSimulating && !this.grabbing) this.sim?.setAnchorScale(this.liveAnchorScale);
  }

  private pattern: Pattern | null = null;
  private readonly buildsByPattern = new WeakMap<Pattern, Promise<boolean>>();
  private buildQueue: Promise<boolean> = Promise.resolve(true);
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;

  // body-change tracking: savedPositions are valid only for the body they were authored on, so a
  // measurement/gender edit means the cached drape is stale and simulation must re-drape.
  private patternId: string | null = null;
  private baseBodyKey: string | null = null;
  private lastBodyKey: string | null = null;
  private bodyDirty = false;
  private adaptFramesLeft = 0; // frames left in a body-change re-drape before re-pinning
  private showTriangles = false;

  // interactive cloth grab
  private raycaster = new THREE.Raycaster();
  private grabbing = false;
  private grabIndex = -1;
  private grabDistance = 0;

  // pre-simulation arrangement editor
  private mode: SceneMode = 'view';
  private arrangeGroup = new THREE.Group();
  private arrangeEntries: ArrangeEntry[] = [];
  private selectedArrange = -1;
  private releaseGizmoLease: (() => void) | null = null;
  private readonly gizmoDisposers: Array<() => void> = [];

  onStatus: (status: RendererStatus, message?: string) => void = () => {};
  // `kind` distinguishes the two piece-edit tools while mode === 'arrange': 'arrange' (flat layout)
  // vs 'manipulate' (drag the draped pieces in place). null in 'view'. Lets the UI sync its toolbar
  // state even when Move mode is entered by clicking a piece in the 3D view (not via the toolbar).
  onModeChange: (mode: SceneMode, selectedPieceId: string | null, kind: 'arrange' | 'manipulate' | null) => void = () => {};
  /** Fired when a user-run drape settles (sim stopped): the freshly-settled per-piece savedPositions
   *  (stride-5: x2d,y2d mm, x3d,y3d,z3d m), keyed by base piece id, so the app can persist them. */
  onDrapeSettled: (savedByPiece: Record<string, number[]>) => void = () => {};
  /** Fired when a piece is picked in the 3D view (click) so the 2D editor can sync. */
  onSelectPiece: (pieceId: string | null) => void = () => {};
  private highlightId: string | null = null;
  private releaseSimulationLease: (() => void) | null = null;

  /**
   * Highlight a piece from an external (2D) selection. Tints the matching draped cloth
   * mesh and/or arrange mesh blue; in arrange mode also attaches the gizmo. id=null clears.
   */
  setHighlightedPiece(id: string | null): void {
    this.highlightId = id;
    this.invalidate();
    // The original keeps the fabric colour and draws a resolution-aware fat-line outline instead
    // of tinting; a faint emissive remains as a fallback cue on very dense meshes.
    const HI = 0x1d4ed8;
    for (const e of this.clothMeshes) {
      const m = e.mesh.material as THREE.MeshPhysicalMaterial;
      if (!m.emissive) continue;
      m.emissive.setHex(e.pieceId === id ? HI : 0x000000);
      m.emissiveIntensity = e.pieceId === id ? 0.12 : 1;
      if (e.backMesh) {
        const bm = e.backMesh.material as THREE.MeshPhysicalMaterial;
        bm.emissive.setHex(e.pieceId === id ? HI : 0x000000);
        bm.emissiveIntensity = e.pieceId === id ? 0.12 : 1;
      }
    }
    this.overlays.setHighlightedPiece(id);
    if (this.mode === 'arrange') {
      const idx = this.arrangeEntries.findIndex((e) => e.pieceId === id);
      // applying an EXTERNAL selection: don't echo onSelectPiece back out, or the
      // 2D-store -> effect -> setHighlightedPiece -> onSelectPiece cycle never terminates
      this.selectArrange(idx, false);
    } else {
      for (const e of this.arrangeEntries) {
        const m = e.mesh.material as THREE.MeshPhysicalMaterial;
        if (m.emissive) m.emissive.setHex(e.pieceId === id ? HI : 0x000000);
      }
    }
  }

  constructor(viewport: Viewport) {
    this.viewport = viewport;
    this.container = viewport.renderer.domElement.parentElement
      ?? viewport.renderer.domElement;
    this.scene = viewport.scene;
    this.renderer = viewport.renderer;
    const camera = viewport.camera.camera;
    if (!(camera instanceof THREE.PerspectiveCamera)) {
      throw new Error('PatternRenderer requires a 3D perspective viewport');
    }
    this.camera = camera;
    this.controls = viewport.camera.controls;
    // Preserve seamer's depth range while CameraRig owns projection and resize.
    this.camera.near = 0.01;
    this.camera.far = 100;
    this.camera.updateProjectionMatrix();
    this.isMobile = typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    this.lowEnd = this.detectLowEndHardware();
    this.controls.minDistance = 0.3;
    this.controls.maxDistance = 6;
    this.controls.update();
    // persist the view: debounce-fire after each completed orbit/zoom/pan interaction
    this.controls.addEventListener('end', this.handleControlsEnd);
    this.controls.addEventListener('start', this.handleControlsStart);

    this.scene.add(this.clothGroup);
    this.overlays = new SeamerOverlays(
      this.viewport,
      this.clothGroup,
      (text) => this.makeLabel(text)
    );
    this.lighting = new SeamerLighting(
      this.viewport.lighting,
      this.scene,
      this.renderer,
      () => this.invalidate()
    );
    this.viewport.gizmos.setSpace('local');
    this.gizmoDisposers.push(
      this.viewport.gizmos.onDragStart(() => {
        this.releaseGizmoLease?.();
        this.releaseGizmoLease = this.viewport.acquireRenderLease('arrange-gizmo');
      }),
      this.viewport.gizmos.onDrag(() => this.invalidate()),
      this.viewport.gizmos.onDragEnd(() => {
        this.releaseGizmoLease?.();
        this.releaseGizmoLease = null;
        this.invalidate();
      })
    );
    this.setupGrab();

    this.applyRenderQuality();

    this.invalidate();
    const ResizeObserverConstructor =
      this.renderer.domElement.ownerDocument.defaultView?.ResizeObserver;
    if (ResizeObserverConstructor) {
      this.resizeObserver = new ResizeObserverConstructor(() => this.onResize());
      this.resizeObserver.observe(this.container);
    } else {
      window.addEventListener('resize', this.onResize);
    }
  }

  // ---- Adaptive render quality + render-on-demand (the original's applyHdrAaSettings /
  // applyShadowQuality / detectLowEndHardware / invalidateRender) -------------------------------
  private isMobile = false;
  private lowEnd = false;
  private forceLowEnd = false;
  private smaaScale = 2;

  /** Request an engine-owned on-demand composite frame. */
  invalidate(): void {
    if (this.disposed) return;
    this.refreshPostSettings();
    this.viewport.invalidate();
  }

  private readonly handleControlsEnd = (): void => this.queueCameraSave();
  private readonly handleControlsStart = (): void => {
    // CameraRig has no public cancelFly(); re-applying its current state cancels an active fly
    // without changing the view when the user takes control.
    this.viewport.camera.setState(this.viewport.camera.getState());
    this.invalidate();
  };

  /** Low-end heuristics: few cores / little memory / known mobile-class GPU strings. */
  private detectLowEndHardware(): boolean {
    try {
      const cores = navigator.hardwareConcurrency ?? 8;
      const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
      if (cores <= 4 || mem <= 4) return true;
      const gl = this.renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
      if (/Mali|Adreno|PowerVR|SwiftShader/i.test(name)) return true;
    } catch { /* conservative default below */ }
    return false;
  }

  /** Pixel-ratio / MSAA / shadow-map policy: mobile ≤0.75×, low-end ≤1× + no MSAA + 512 shadows;
   *  HDRI lighting modes supersample by smaaScale (≥2), capped at 2× device ratio. */
  private applyRenderQuality(): void {
    const lowEnd = this.lowEnd || this.forceLowEnd;
    const hdr = this.lightingMode !== 'flat';
    const dpr = window.devicePixelRatio || 1;
    const ratio = this.isMobile
      ? Math.min(0.75, dpr)
      : lowEnd
        ? Math.min(1, dpr)
        : Math.min(2, dpr * (hdr ? Math.max(2, this.smaaScale) : 1));
    this.renderer.setPixelRatio(ratio);
    const sm = lowEnd ? 512 : 2048;
    this.lighting.setShadowMapSize(sm);
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.viewport.post.setQuality({
      // PostFX.forceLowEnd also disables AO. Seamer's persisted N8AO toggle must remain the only AO
      // enable switch, so low-end policy is expressed explicitly through ratio/MSAA/shadows here.
      forceLowEnd: false,
      smaaScale: ratio,
      msaaSamples: lowEnd ? 0 : hdr ? 16 : 4
    });
    this.invalidate();
  }

  /** Wire the pattern's quality settings (smaaScale supersampling, Force low-performance mode). */
  setRenderQualityOptions(opts: { forceLowEnd?: boolean; smaaScale?: number }): void {
    const force = !!opts.forceLowEnd;
    const scale = typeof opts.smaaScale === 'number' && opts.smaaScale > 0 ? opts.smaaScale : 2;
    if (force === this.forceLowEnd && scale === this.smaaScale) return;
    this.forceLowEnd = force;
    this.smaaScale = scale;
    this.applyRenderQuality();
  }

  /** Apply the pattern's post-processing settings: AO enable/intensity/radius/falloff + bokeh f-stop. */
  applyPostSettings(s: {
    aoEnabled?: boolean;
    aoIntensity?: number;
    aoRadius?: number;
    aoFalloff?: number;
    bokehFStop?: number;
  }): void {
    this.bokehFStop =
      typeof s.bokehFStop === 'number' && s.bokehFStop > 0
        ? s.bokehFStop
        : 0;
    this.viewport.post.apply({
      ao: {
        enabled: s.aoEnabled !== false,
        intensity: s.aoIntensity,
        radius: s.aoRadius,
        falloff: s.aoFalloff
      },
      dof: {
        enabled: this.shouldUseDof(),
        fStop: this.bokehFStop || undefined
      },
      smaa: true
    });
  }

  /** Toggle AO/SMAA post-processing (falls back to direct render when off). */
  setPostProcessing(on: boolean) {
    this.viewport.post.setEnabled(on);
    this.invalidate();
  }

  private refreshPostSettings(): void {
    this.viewport.post.apply({
      dof: {
        enabled: this.shouldUseDof(),
        fStop: this.bokehFStop || undefined
      },
      smaa: true
    });
  }

  private shouldUseDof(): boolean {
    return this.bokehFStop > 0
      && this.mode === 'view'
      && !this.grabbing
      && !this.highlightId
      && !this.seamToolState;
  }

  /** Switch lighting mode: 'flat' | 'studio1' | 'studio2' | 'sunset'. */
  setLightingMode(mode: string): void {
    this.lightingMode = this.lighting.setMode(mode, this.isMobile);
    this.applyRenderQuality(); // HDRI modes supersample (smaaScale), flat returns to 1×
  }

  /** Mouse interaction: grab a cloth particle and drag it (pulls the fabric, like the reference). */
  private setupGrab() {
    const dom = this.renderer.domElement;
    const ndc = new THREE.Vector2();
    const setNdc = (ev: PointerEvent) => {
      const r = dom.getBoundingClientRect();
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    };

    dom.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      // Arrange mode: click a piece to select it (the gizmo handles its own drags). Don't grab/pull.
      if (this.mode === 'arrange') {
        const handle = this.viewport.gizmos.handleState;
        if (handle.dragging || handle.axis) return; // gizmo handle -> let it drag
        setNdc(ev);
        // arrangement-point snap: with a piece selected, clicking a marker binds the piece to it
        const marker = this.overlays.pickArrangementMarker(ev);
        if (marker && this.selectedArrange >= 0) {
          const pieceId = this.arrangeEntries[this.selectedArrange].pieceId.replace(/#M$/, '');
          this.onArrangementPointPicked({ pieceId, name: marker.name, cylinderName: marker.cylinderName, uDegrees: marker.uDegrees, v: marker.v });
          return;
        }
        // A piece just moved by the gizmo only has its world matrix updated at render time; force it
        // current (and refresh bounds) so the raycast hits the piece at its NEW location.
        this.arrangeGroup.updateMatrixWorld(true);
        for (const e of this.arrangeEntries) e.mesh.geometry.computeBoundingSphere();
        const hit = this.viewport.picking.pick(ev, {
          kinds: ['face'],
          filter: (object) => this.arrangeEntries.some((entry) => entry.mesh === object)
        });
        const idx = hit
          ? this.arrangeEntries.findIndex((entry) => entry.mesh === hit.object)
          : -1;
        this.selectArrange(idx);
        return;
      }
      if (this.clothMeshes.length === 0) return;
      setNdc(ev);
      // refresh bounding spheres so raycasting matches the current (draped) geometry
      for (const e of this.clothMeshes) e.geometry.computeBoundingSphere();
      // Seam tool active: clicks pick piece edges on the garment instead of selecting/grabbing.
      if (this.seamToolState) {
        const pick = this.pickSeamEdge(ev);
        if (pick) this.onSeamEdgePick(pick);
        return; // miss -> orbit, but never enter manipulate/grab while the seam tool is up
      }
      const hit = this.viewport.picking.pick(ev, {
        kinds: ['face'],
        filter: (object) => this.clothMeshes.some((entry) => entry.mesh === object)
      });
      if (!hit || hit.faceIndex === undefined) return; // not on cloth -> let OrbitControls orbit
      const entry = this.clothMeshes.find((e) => e.mesh === hit.object);
      if (!entry) return;
      // selecting/highlighting the picked piece so the 2D editor stays in sync — but only while
      // IDLE: with the sim running the source grabs without selecting (no highlight mid-sim)
      if (!this.userSimulating) {
        this.setHighlightedPiece(entry.pieceId);
        this.onSelectPiece(entry.pieceId);
      }

      if (!ev.shiftKey && !this.userSimulating) {
        // Clicking a piece while IDLE enters in-place "Move pieces" mode and selects it, showing the
        // transform gizmo — i.e. arrange/drag, NOT a simulation.
        // While the simulation is RUNNING, a plain drag falls through to the grab below instead —
        // matching the source, where dragging live fabric pulls it (no modifier needed).
        this.enterManipulateMode();
        const idx = this.arrangeEntries.findIndex((e) => e.pieceId === entry.pieceId);
        if (idx >= 0) this.selectArrange(idx);
        return;
      }

      // Shift+drag: grab and pull the live fabric (soft-body); starts the sim if not already running.
      const pos = entry.geometry.getAttribute('position') as THREE.BufferAttribute;
      const index = entry.geometry.getIndex();
      const triangleStart = hit.faceIndex * 3;
      const triangle = index
        ? [
            index.getX(triangleStart),
            index.getX(triangleStart + 1),
            index.getX(triangleStart + 2)
          ]
        : [triangleStart, triangleStart + 1, triangleStart + 2];
      let bestL = triangle[0];
      let bd = Infinity;
      for (const l of triangle) {
        const dx = pos.getX(l) - hit.point.x, dy = pos.getY(l) - hit.point.y, dz = pos.getZ(l) - hit.point.z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bd) { bd = d; bestL = l; }
      }
      this.grabIndex = entry.start + bestL;
      this.grabDistance = hit.distance;
      this.grabbing = true;
      this.controls.enabled = false; // don't orbit while dragging fabric
      void this.beginGrab(hit.point);
    });

    dom.addEventListener('pointermove', (ev) => {
      // seam tool hover: highlight the edge run the cursor is over (throttled raycast)
      if (this.seamToolState && !this.grabbing && this.mode === 'view' && this.clothMeshes.length) {
        const now = performance.now();
        if (now - this.lastSeamHoverAt > 50) {
          this.lastSeamHoverAt = now;
          setNdc(ev);
          const pick = this.pickSeamEdge(ev);
          const changed = !!pick !== !!this.seamToolHover ||
            (pick && this.seamToolHover && (!samePick(pick, this.seamToolHover) || pick.reversed !== this.seamToolHover.reversed));
          if (changed) {
            this.seamToolHover = pick;
            this.overlays.setSeamToolHover(pick);
          }
        }
      }
      // arrangement-marker hover highlight (cheap raycast against the small marker set)
      if (!this.grabbing) {
        const marker = this.overlays.pickArrangementMarker(ev);
        if (marker !== this.arrangementHover) {
          this.arrangementHover = marker;
          this.overlays.setArrangementHover(marker);
          this.onArrangementPointHover(marker?.name ?? null);
          // ghost preview of the selected piece at the hovered marker's placement
          this.updateArrangementGhost(marker ?? null);
          this.invalidate();
        }
      }
      if (!this.grabbing || !this.sim) return;
      setNdc(ev);
      this.raycaster.setFromCamera(ndc, this.camera);
      // fixed-depth slide along the eye ray (matches the reference)
      const ray = this.raycaster.ray;
      const p = ray.origin.clone().addScaledVector(ray.direction, this.grabDistance);
      this.sim.setGrab(true, this.grabIndex, [p.x, p.y, p.z]);
    });

    const end = () => {
      if (!this.grabbing) return;
      this.grabbing = false;
      this.controls.enabled = true;
      this.sim?.setGrab(false, this.grabIndex, [0, 0, 0]);
      if (this.userSimulating && this.sim) {
        // The user explicitly started the simulation — keep it RUNNING after the drag. Re-engage the
        // hold + self-collision so the released fabric eases back to its draped shape and the live sim
        // continues (it does not stop/freeze).
        this.sim.setAnchorScale(this.liveAnchorScale);
        this.sim.setSelfCollision(true);
      } else {
        // Grab started from idle: leave the cloth exactly where you dropped it (freeze in place; no
        // snap-back, no slow droop). Use "Arrange"/"Reset" to return it to the settled drape.
        this.stopSimulation();
      }
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  private async beginGrab(point: THREE.Vector3) {
    const sim = await this.ensureSim();
    if (!sim || !this.grabbing) return;
    if (this.userSimulating) {
      // LIVE sim drag (source behavior): just grab — the integrate shader already releases the
      // anchor hold within the grab influence, so the fabric near the cursor follows while the
      // rest of the garment keeps simulating with self-collision on.
      sim.setSelfCollision(true);
    } else {
      // Idle drag (repo repositioning gesture): free the WHOLE garment so it moves as one
      // connected piece (panels held together by their seams) and follows the cursor — not
      // pinned, so seams don't pull open. Self-collision off during the drag: it's what curls a
      // free garment, and the trousers don't self-intersect in normal dragging; seams +
      // near-damping keep it coherent.
      sim.setAnchorScale(0);
      sim.setSelfCollision(false);
    }
    sim.setGrab(true, this.grabIndex, [point.x, point.y, point.z]);
    if (!this.simulating) {
      this.simulating = true;
      this.onStatus('simulating');
      void this.runSimLoop();
    }
  }

  private onResize = () => {
    if (this.disposed) return;
    this.viewport.resize();
    this.applyRenderQuality();
  };

  // Debug autofocus point retained as an editor aid. PostFX itself focuses on CameraRig's orbit
  // target; this marker raycasts the screen centre against the live garment.
  private focusNdc = new THREE.Vector2(0, 0);
  private debugFocusPoint = false;
  private hasDebugFocusPoint = false;

  setDebugFocusPoint(show: boolean): void {
    this.debugFocusPoint = show;
    if (!show) {
      this.viewport.overlays.remove('seamer-debug-focus');
      this.hasDebugFocusPoint = false;
    }
    else this.updateDebugFocusPoint();
    this.invalidate();
  }

  private updateDebugFocusPoint(): void {
    if (!this.debugFocusPoint) return;
    const tdist = this.camera.position.distanceTo(this.controls.target);
    let point = this.controls.target.clone();
    if (this.clothMeshes.length) {
      for (const e of this.clothMeshes) e.geometry.computeBoundingSphere();
      this.raycaster.setFromCamera(this.focusNdc, this.camera);
      const hits = this.raycaster.intersectObjects(this.clothMeshes.map((e) => e.mesh), false);
      if (hits[0]) {
        point = hits[0].point;
      } else {
        point = this.camera.position.clone().addScaledVector(
          this.raycaster.ray.direction,
          tdist
        );
      }
    }
    const positions = new Float32Array(point.toArray());
    if (this.hasDebugFocusPoint) {
      this.viewport.overlays.updatePoints('seamer-debug-focus', positions);
    } else {
      this.viewport.overlays.addPoints(
        'seamer-debug-focus',
        positions,
        { color: '#f43f5e', size: 8 }
      );
      this.hasDebugFocusPoint = true;
    }
  }

  /** Debounced camera write-back (orbit end, tween end, FOV change). */
  private queueCameraSave(): void {
    clearTimeout(this.cameraSaveTimer);
    this.cameraSaveTimer = setTimeout(() => {
      if (this.disposed) return;
      const p = this.camera.position, t = this.controls.target;
      this.onCameraChanged([p.x, p.y, p.z], [t.x, t.y, t.z], this.camera.fov);
    }, 600);
  }

  /** Build or update the avatar + cloth for a pattern. */
  setPattern(pattern: Pattern, changedPieces?: Set<string>): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const inFlight = this.buildsByPattern.get(pattern);
    if (inFlight) return inFlight;
    if (pattern === this.pattern && !changedPieces?.size) return Promise.resolve(true);

    // The initial template fetch can overlap the empty-scene build, and multiple reactive
    // invalidations can request the same immutable Pattern object. Share identical work and
    // serialize distinct builds so avatar/cloth teardown never races itself.
    const build = this.buildQueue
      .then(() => this.disposed ? false : this.applyPattern(pattern, changedPieces))
      .catch((error: unknown) => {
        this.onStatus('error', error instanceof Error ? error.message : String(error));
        return false;
      });
    this.buildQueue = build;
    this.buildsByPattern.set(pattern, build);
    void build.then(() => {
      if (this.buildsByPattern.get(pattern) === build) this.buildsByPattern.delete(pattern);
    });
    return build;
  }

  private async applyPattern(pattern: Pattern, changedPieces?: Set<string>): Promise<boolean> {
    const previousPattern = this.pattern;
    const previousPatternId = this.patternId;
    const previousBaseBodyKey = this.baseBodyKey;
    const previousLastBodyKey = this.lastBodyKey;
    const previousBodyDirty = this.bodyDirty;
    this.pattern = pattern;
    this.showTriangles = pattern.settings3d.showTriangles;
    this.setDebugFocusPoint(pattern.settings3d.debugFocusPoint);
    // Measurement segments are tied to the previous avatar vertex positions.
    this.clearBodyMeasurement();
    // Source parity (transferToScene's `wasSimulatorRunning`): capture whether a user-run sim was live
    // BEFORE we stop+rebuild, so we can restart it afterwards. The source re-settles an edited piece
    // ONLY if the sim was already running; a cold edit stays manual (press Simulate) — which we match.
    const wasRunning = this.userSimulating;
    this.stopSimulation();
    // Track whether the body changed vs the one the cached drape was authored on.
    const bodyKey = JSON.stringify(pattern.body);
    this.lastBodyKey = bodyKey;
    if (pattern.id !== this.patternId) {
      this.patternId = pattern.id;
      this.baseBodyKey = bodyKey;
      this.bodyDirty = false;
    } else {
      this.bodyDirty = bodyKey !== this.baseBodyKey;
    }
    this.onStatus('loading');
    try {
      if (!this.avatar) {
        this.avatar = await AvatarController.create(pattern.body, createAvatarMaterial(pattern.body.bodyColor));
        const mesh = this.avatar.mesh;
        if (mesh) this.scene.add(mesh);
      } else {
        await this.avatar.setBody(pattern.body);
        this.avatar.setMaterial(createAvatarMaterial(pattern.body.bodyColor));
      }
      this.setAvatarVisible(
        pattern.settings3d.avatarEnabled !== false
        && pattern.settings3d.showAvatar
      );
      this.applyCameraFromSettings(pattern);
      this.setLightingMode(pattern.settings3d.lightingMode || 'flat');
      this.rebuildCloth(pattern, changedPieces);
      this.onStatus('ready');
      // The engine renders on demand (ARCHITECTURE 5.3), and this method is async: by the time
      // the avatar resolves and the cloth is rebuilt, the initial frame has long been drawn
      // against an empty scene. Nothing else here reliably invalidates — setCameraState()
      // early-returns when the camera already matches the saved settings — so without this the
      // pane stays black until some unrelated setting change happens to request a frame.
      this.invalidate();
      // If the sim was live when the edit landed, re-settle the rebuilt cloth (the edited region drapes
      // instead of sitting at its seed). ~100 ms after the rebuild, matching the source's deferred
      // restart. simulate() recreates the sim from the fresh `prepared` via ensureSim().
      if (wasRunning && !this.disposed) {
        setTimeout(() => { if (!this.disposed && !this.simulating) void this.simulate(); }, 100);
      }
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (
        /Delaunator|polygon constraints|triangulat|incomplete mesh/i.test(message)
        && this.clothMeshes.length > 0
      ) {
        // A pointer drag can briefly self-intersect or invert a pattern piece. The geometry
        // kernel is right to reject an incomplete constrained mesh; keep the last complete
        // triangulation visible until the user returns to a valid shape.
        this.pattern = previousPattern;
        this.patternId = previousPatternId;
        this.baseBodyKey = previousBaseBodyKey;
        this.lastBodyKey = previousLastBodyKey;
        this.bodyDirty = previousBodyDirty;
        this.onStatus('invalid', 'Invalid shape — showing the last valid 3D mesh.');
        this.invalidate();
      } else {
        this.pattern = previousPattern;
        this.patternId = previousPatternId;
        this.baseBodyKey = previousBaseBodyKey;
        this.lastBodyKey = previousLastBodyKey;
        this.bodyDirty = previousBodyDirty;
        this.onStatus('error', message);
      }
      return false;
    }
  }

  private applyCameraFromSettings(pattern: Pattern) {
    const s = pattern.settings3d;
    this.setCameraState(s.cameraPosition, s.controlsTarget, s.cameraFov);
  }

  setCameraState(
    position: [number, number, number],
    target: [number, number, number],
    fov: number
  ): void {
    const current = this.viewport.camera.getState();
    const same =
      current.position.every((value, index) => value === position[index])
      && current.target.every((value, index) => value === target[index])
      && current.fov === fov;
    if (same) return;
    this.viewport.camera.setState({
      ...current,
      position,
      target,
      fov: fov || current.fov
    });
    this.invalidate();
  }

  /** Triangulate + arrange the garment and (re)build the static cloth meshes.
   *  `changedPieces` (pieces whose 2D shape was just edited) re-triangulate from live geometry. */
  private rebuildCloth(pattern: Pattern, changedPieces?: Set<string>) {
    if (!this.avatar) return;
    const verts = this.avatar.vertexPositions;
    const indices = this.avatar.indices;
    const nextCylinders = buildCylinders(
      this.avatar.cylinderDefs,
      (name) => this.avatar!.bonePosition(name, new THREE.Vector3()),
      (i) => new THREE.Vector3(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2])
    );
    // Triangulate before tearing down the current cloth. During a point drag the candidate
    // polygon may be temporarily invalid; prepareCloth deliberately throws rather than returning
    // an incomplete mesh, and setPattern then leaves this last valid scene intact.
    const nextPrepared = prepareCloth(
      {
        pattern,
        avatarVertices: verts,
        avatarIndices: indices,
        cylinders: nextCylinders
      },
      { changedPieces }
    );

    if (this.mode === 'arrange') this.exitArrangeMode(); // stale arrange meshes reference old pieces
    this.clearClothMeshes();
    this.disposeSimFrame?.();
    this.disposeSimFrame = null;
    this.simRunner?.dispose();
    this.simRunner = null;
    this.sim?.dispose();
    this.sim = null;
    this.cylinders = nextCylinders;
    // Capture the cylinder frames the cached drape is authored on (a fresh, non-dirty load). On a
    // later body edit these are the OLD frames the cylinder re-fit projects from. (Keep them across a
    // dirty rebuild — don't overwrite with the new-body frames.)
    if (!this.bodyDirty || !this.baseCylinders) this.baseCylinders = this.cylinders;
    this.overlays.setAvatarContext(this.avatar, this.cylinders);
    this.prepared = nextPrepared;
    if (!this.prepared) {
      this.overlays.setPrepared(null, null);
      return;
    }

    const flat = pattern.settings3d.lightingMode === 'flat';
    const matById = new Map<string, Material>();
    for (const m of pattern.materials) matById.set(m.id, m);

    for (const piece of this.prepared.simData.pieces) {
      const geo = new THREE.BufferGeometry();
      const positions = new Float32Array(piece.count * 3);
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(piece.uv, 2));
      const localIndex = piece.triangles.map((g) => g - piece.start);
      geo.setIndex(localIndex);
      const pieceMat = matById.get(piece.materialId);
      const separateBack = hasSeparateBack(pieceMat);
      // visualizationThickness extrudes the sheet into front/back shells + an edge strip
      const shellMm = pieceMat?.visualizationThickness ?? 0;
      const dualShell = separateBack || shellMm > 0;
      const shellM = shellMm > 0 ? docToWorld({ x: shellMm / 2, y: 0 }).x : 0;
      const srcPiece = pattern.pieces.find((p) => p.id === piece.pieceId);
      const name = srcPiece?.name ?? 'Piece';
      const hidden = !!srcPiece?.hidden; // object-browser visibility toggle

      // Build a `uvLabel` attribute (0..1 across the piece's pattern bbox) and per-piece canvas
      // badges, composited into the lit surface by the material shader — this is the default
      // 'flat' look (deforms + shades with the cloth). The shader picks the "face side" badge on the
      // outward face and the "back side" badge on the reverse. Built unconditionally so toggling
      // label mode is a cheap uniform flip rather than a full cloth rebuild (which would re-drape).
      const { face: faceLabelTex, back: backLabelTex, bbox } = this.buildPieceLabelTextures(geo, piece.uv, piece.count, piece.pieceId, name);
      // mirror instances have reversed winding; flipNormals also inverts the outward face — XOR them.
      const labelFlipFace = piece.pieceId.includes('#M') !== !!srcPiece?.settings3d.flipNormals;
      const labelOpacity = this.showLabels && !hidden && this.labelMode === 'flat' ? 1 : 0;

      // Baked piece maps (the original's buildPieceTextureCanvas): print anchored at the piece
      // origin + rotated by grain, internal style lines drawn in. Only built when there is a print
      // or lines to show — plain solid pieces keep the cheaper untextured material.
      let pieceMapFront: THREE.Texture | undefined;
      let pieceMapBack: THREE.Texture | undefined;
      if (srcPiece) {
        const mirror = piece.pieceId.includes('#M');
        const sgn = mirror ? -1 : 1;
        const pts = indexPoints(pattern);
        const visibleInternals = { ...srcPiece, internalPaths: srcPiece.internalPaths.filter((ip) => ip.showIn3d !== false) };
        const internals = pieceInternalPolylines(pattern, visibleInternals, undefined, pts, 4)
          .map((poly) => poly.map((p) => ({ x: sgn * p.x, y: p.y })));
        const origin = pts.get(srcPiece.originPoint);
        const g = srcPiece.grainVector;
        const grainDeg0 = (Math.atan2(g.y, g.x) * 180) / Math.PI;
        const bakeBase = {
          internalPolys: internals,
          originUV: { x: sgn * (origin?.x ?? 0), y: origin?.y ?? 0 },
          grainDeg: mirror ? 180 - grainDeg0 : grainDeg0,
          uMin: bbox.uMin, vMin: bbox.vMin, wMM: bbox.wMM, hMM: bbox.hMM,
          anisotropy: Math.min(this.renderer.capabilities.getMaxAnisotropy(), 8)
        };
        const frontSlot = pieceMat?.frontTexture ?? null;
        const frontBake = { ...bakeBase, slot: frontSlot, fillColor: frontSlot?.color ?? '#6b7a8f' };
        if (pieceNeedsBake(frontBake)) pieceMapFront = createPieceTexture(frontBake);
        if (dualShell) {
          const backSlot = pieceMat?.backTexture ?? frontSlot;
          const backBake = { ...bakeBase, slot: backSlot, fillColor: backSlot?.color ?? '#6b7a8f' };
          if (pieceNeedsBake(backBake)) pieceMapBack = createPieceTexture(backBake);
        }
      }

      // Our cloth triangles wind with their geometric front face pointing INWARD, so the outward
      // surface the camera sees is the BackSide. For a separate back texture we therefore render the
      // FACE (front) texture on a BackSide mesh (shows outward) and the back texture on a FrontSide
      // mesh (shows inward). With a single double-sided material this doesn't matter (both sides same).
      const mat = createGarmentMaterial(pieceMat, flat, { side: dualShell ? THREE.BackSide : THREE.DoubleSide, labelTexture: faceLabelTex, labelTextureBack: backLabelTex, labelOpacity, labelFlipFace, pieceMap: pieceMapFront, shellOffset: shellM > 0 ? shellM : undefined });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.visible = !hidden;
      this.clothGroup.add(mesh);
      this.viewport.picking.register(mesh, piece.pieceId, 'piece', ['face']);
      // back shell: a second mesh on the same (deforming) geometry — distinct back texture and/or
      // the inner face of a thick fabric (offset inward by half the visual thickness)
      let backMesh: THREE.Mesh | undefined;
      if (dualShell) {
        const backMat = createGarmentMaterial(pieceMat, flat, { side: THREE.FrontSide, back: true, labelTexture: faceLabelTex, labelTextureBack: backLabelTex, labelOpacity, labelFlipFace, pieceMap: pieceMapBack, shellOffset: shellM > 0 ? -shellM : undefined });
        backMesh = new THREE.Mesh(geo, backMat);
        backMesh.castShadow = true; backMesh.receiveShadow = true; backMesh.frustumCulled = false;
        backMesh.visible = !hidden;
        this.clothGroup.add(backMesh);
        this.clothBackMeshes.push(backMesh);
      }
      // side strip closing the shells at the boundary (darkened like the original's side mesh)
      let sideMesh: THREE.Mesh | undefined;
      let sidePairs: number[] | undefined;
      if (shellM > 0) {
        const seen = new Map<string, number>();
        const ends = new Map<string, [number, number]>();
        for (let t = 0; t < localIndex.length; t += 3) {
          const v = [localIndex[t], localIndex[t + 1], localIndex[t + 2]];
          for (let e = 0; e < 3; e++) {
            const a = v[e], b = v[(e + 1) % 3];
            const k = `${Math.min(a, b)}_${Math.max(a, b)}`;
            seen.set(k, (seen.get(k) ?? 0) + 1);
            ends.set(k, [a, b]);
          }
        }
        sidePairs = [];
        for (const [k, cnt] of seen) if (cnt === 1) { const [a, b] = ends.get(k)!; sidePairs.push(a, b); }
        if (sidePairs.length) {
          const sideGeo = new THREE.BufferGeometry();
          sideGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((sidePairs.length / 2) * 18), 3));
          const sideColor = new THREE.Color(pieceMat?.frontTexture?.color ?? '#6b7a8f').multiplyScalar(0.7);
          sideMesh = new THREE.Mesh(sideGeo, new THREE.MeshStandardMaterial({ color: sideColor, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }));
          sideMesh.frustumCulled = false;
          sideMesh.visible = !hidden;
          this.clothGroup.add(sideMesh);
        }
      }
      this.clothMeshes.push({ pieceId: piece.pieceId, start: piece.start, count: piece.count, geometry: geo, mesh, backMesh, sideMesh, sidePairs, shellM: shellM > 0 ? shellM : undefined, baseVisible: !hidden });

      // Camera-facing sprite badge for 'billboard' mode (hidden unless that mode is active).
      const { obj, aspect } = this.makeLabel(`${name} face side`);
      obj.visible = this.showLabels && !hidden && this.labelMode === 'billboard';
      const overlayId = `seamer-piece-label-${piece.pieceId}`;
      this.overlays.addPieceLabel(overlayId, obj);
      this.pieceLabels.push({ pieceId: piece.pieceId, overlayId, obj, aspect });
    }
    this.applyClothPositions(this.prepared.simData.positions);
    this.overlays.setPrepared(this.prepared, this.prepared.simData.positions);
    this.overlays.setHighlightedPiece(this.highlightId);
    if (this.showTriangles) this.setShowTriangles(true); // rebuild the wireframe overlays on the new meshes
  }

  /** Add a per-piece `uvLabel` attribute (0..1 across the piece's pattern bbox); returns the bbox. */
  private addLabelUVs(geo: THREE.BufferGeometry, uv: Float32Array, count: number): { wMM: number; hMM: number; uMin: number; vMin: number } {
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (let i = 0; i < count; i++) {
      const u = uv[i * 2], v = uv[i * 2 + 1];
      if (u < uMin) uMin = u; if (u > uMax) uMax = u;
      if (v < vMin) vMin = v; if (v > vMax) vMax = v;
    }
    const wMM = Math.max(1, uMax - uMin), hMM = Math.max(1, vMax - vMin);
    const uvLabel = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      uvLabel[i * 2] = (uv[i * 2] - uMin) / wMM;
      uvLabel[i * 2 + 1] = (uv[i * 2 + 1] - vMin) / hMM;
    }
    geo.setAttribute('uvLabel', new THREE.BufferAttribute(uvLabel, 2));
    return { wMM, hMM, uMin, vMin };
  }

  /** Set up uvLabel on `geo` and build the face/back name badges for a piece (back text is flipped
   *  the opposite way so it reads correctly when viewed from the reverse face). */
  private buildPieceLabelTextures(geo: THREE.BufferGeometry, uv: Float32Array, count: number, pieceId: string, name: string): { face: THREE.CanvasTexture; back: THREE.CanvasTexture; bbox: { wMM: number; hMM: number; uMin: number; vMin: number } } {
    const bbox = this.addLabelUVs(geo, uv, count);
    const mirror = pieceId.includes('#M'); // mirror instances have a negated U
    return {
      face: this.makeBakedLabelTexture(`${name}\nface side`, bbox.wMM, bbox.hMM, mirror),
      back: this.makeBakedLabelTexture(`${name}\nback side`, bbox.wMM, bbox.hMM, !mirror),
      bbox
    };
  }

  private applyClothPositions(global: Float32Array) {
    this.lastClothPositions = global;
    this.invalidate();
    this.updateDebugFocusPoint();
    for (const entry of this.clothMeshes) {
      const attr = entry.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < entry.count; i++) {
        const g = entry.start + i;
        const x = global[g * 4], y = global[g * 4 + 1], z = global[g * 4 + 2];
        arr[i * 3] = x; arr[i * 3 + 1] = y; arr[i * 3 + 2] = z;
        cx += x; cy += y; cz += z;
      }
      attr.needsUpdate = true;
      entry.geometry.computeVertexNormals();
      // bounding sphere not recomputed per frame: cloth meshes have frustumCulled = false.

      // visual-thickness side strip: rebuild the boundary quads between the front/back shells
      if (entry.sideMesh && entry.sidePairs && entry.shellM) {
        const nrm = entry.geometry.getAttribute('normal') as THREE.BufferAttribute;
        const narr = nrm.array as Float32Array;
        const sp = entry.sideMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
        const out = sp.array as Float32Array;
        const t = entry.shellM;
        let o = 0;
        for (let k = 0; k + 1 < entry.sidePairs.length; k += 2) {
          const a = entry.sidePairs[k], b = entry.sidePairs[k + 1];
          const ax = arr[a * 3], ay = arr[a * 3 + 1], az = arr[a * 3 + 2];
          const bx = arr[b * 3], by = arr[b * 3 + 1], bz = arr[b * 3 + 2];
          const nax = narr[a * 3] * t, nay = narr[a * 3 + 1] * t, naz = narr[a * 3 + 2] * t;
          const nbx = narr[b * 3] * t, nby = narr[b * 3 + 1] * t, nbz = narr[b * 3 + 2] * t;
          // front a, front b, back b — then front a, back b, back a
          out[o++] = ax + nax; out[o++] = ay + nay; out[o++] = az + naz;
          out[o++] = bx + nbx; out[o++] = by + nby; out[o++] = bz + nbz;
          out[o++] = bx - nbx; out[o++] = by - nby; out[o++] = bz - nbz;
          out[o++] = ax + nax; out[o++] = ay + nay; out[o++] = az + naz;
          out[o++] = bx - nbx; out[o++] = by - nby; out[o++] = bz - nbz;
          out[o++] = ax - nax; out[o++] = ay - nay; out[o++] = az - naz;
        }
        sp.needsUpdate = true;
        entry.sideMesh.geometry.computeVertexNormals();
      }

      // Flat (default) badges are baked into the material and need no per-frame work. Billboard
      // sprites, if present, get parked at the piece's (live) centroid to face the camera.
      const label = this.pieceLabels.find((l) => l.pieceId === entry.pieceId);
      if (!label || entry.count === 0) continue;
      label.obj.position.set(cx / entry.count, cy / entry.count, cz / entry.count);
    }
    this.overlays.updatePositions(global);
  }

  private clearClothMeshes() {
    this.clearSnapshot(); // a ghost from the old drape would be stale once pieces rebuild
    this.overlays.clearPrepared(); // particle indices die with the meshes
    for (const m of this.triangleOverlays) { this.clothGroup.remove(m); (m.material as THREE.Material).dispose(); }
    this.triangleOverlays = [];
    for (const e of this.clothMeshes) {
      this.viewport.picking.unregister(e.mesh);
      this.clothGroup.remove(e.mesh);
      e.geometry.dispose();
      disposeGarmentMaterial(e.mesh.material as THREE.Material);
      if (e.sideMesh) {
        this.clothGroup.remove(e.sideMesh);
        e.sideMesh.geometry.dispose();
        (e.sideMesh.material as THREE.Material).dispose();
      }
    }
    this.clothMeshes = [];
    for (const b of this.clothBackMeshes) { this.clothGroup.remove(b); disposeGarmentMaterial(b.material as THREE.Material); }
    this.clothBackMeshes = [];
    for (const l of this.pieceLabels) {
      this.overlays.removePieceLabel(l.overlayId);
    }
    this.pieceLabels = [];
  }

  /** Render a rounded "Name face side" badge to a canvas texture (+ its aspect ratio). */
  private makeLabelTexture(text: string): { tex: THREE.CanvasTexture; aspect: number } {
    const pad = 16, fontPx = 28;
    const c = document.createElement('canvas');
    const probe = c.getContext('2d')!;
    probe.font = `600 ${fontPx}px "Noto Sans", sans-serif`;
    c.width = Math.ceil(probe.measureText(text).width) + pad * 2;
    c.height = fontPx + pad * 2;
    const ctx = c.getContext('2d')!;
    ctx.font = `600 ${fontPx}px "Noto Sans", sans-serif`;
    const r = 14;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(c.width, 0, c.width, c.height, r);
    ctx.arcTo(c.width, c.height, 0, c.height, r);
    ctx.arcTo(0, c.height, 0, 0, r);
    ctx.arcTo(0, 0, c.width, 0, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(245,245,245,0.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(100,100,100,0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#222';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, c.width / 2, c.height / 2 + 1);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return { tex, aspect: c.width / c.height };
  }

  /** A camera-facing billboard sprite badge (used only in 'billboard' label mode). */
  private makeLabel(text: string): { obj: THREE.Object3D; aspect: number } {
    const { tex, aspect } = this.makeLabelTexture(text);
    const H = 0.035; // world height of the label (meters) — kept subtle, like the source
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(H * aspect, H, 1);
    return { obj: sprite, aspect };
  }

  /**
   * Per-piece badge baked into the cloth surface, mirroring the original renderer's drawCenteredLabel:
   * ~10mm text shrunk to fit within 90%×60% of the piece, two stacked lines on a translucent rounded
   * plate. Drawn in the piece's pattern-bbox UV space (0..1); mirror instances pre-flip horizontally.
   */
  private makeBakedLabelTexture(text: string, wMM: number, hMM: number, mirror: boolean): THREE.CanvasTexture {
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const pxPerMM = Math.min(Math.max(1536 / Math.max(wMM, hMM), 1), 8);
    const W = Math.max(8, Math.round(wMM * pxPerMM));
    const H = Math.max(8, Math.round(hMM * pxPerMM));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); } // cancel the mirror instance's negated U

    const font = 'Noto Sans, sans-serif';
    const maxW = W * 0.9, maxH = H * 0.6;
    let w = Math.max(10, 10 * pxPerMM); // ~10mm cap-height text, like the source
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const measure = () => { ctx.font = `300 ${w}px ${font}`; let m = 0; for (const ln of lines) m = Math.max(m, ctx.measureText(ln).width); return m; };
    let textW = measure();
    let lineH = w * 1.2;
    let blockH = lineH * lines.length;
    const k = Math.min(1, textW > 0 ? maxW / textW : 1, blockH > 0 ? maxH / blockH : 1);
    if (k < 1) { w = Math.max(8, w * k); textW = measure(); lineH = w * 1.2; blockH = lineH * lines.length; }

    const pad = Math.max(6, w * 0.35);
    const bw = textW + pad * 2, bh = blockH + pad * 1.4;
    const r = Math.max(4, Math.min(bw, bh) * 0.12);
    const cx = W / 2, cy = H / 2;
    this.roundRectPath(ctx, cx - bw / 2, cy - bh / 2, bw, bh, r);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fill();
    ctx.lineWidth = Math.max(1, Math.round(Math.max(1, w * 0.06)));
    ctx.strokeStyle = '#000000';
    ctx.stroke();
    ctx.fillStyle = '#000000';
    ctx.font = `300 ${w}px ${font}`;
    let y = cy - blockH / 2 + lineH / 2;
    for (const ln of lines) { ctx.fillText(ln, cx, y); y += lineH; }

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    return tex;
  }

  private roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    const rr = Math.min(r, w / 2, h / 2);
    if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(x, y, w, h, rr); return; }
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /** Toggle the garment piece labels on/off. */
  setShowLabels(on: boolean): void {
    this.showLabels = on;
    this.applyLabelVisibility();
  }

  /** Switch label style between camera-facing (billboard) and baked-into-fabric (flat). */
  setLabelMode(mode: 'billboard' | 'flat'): void {
    if (mode === this.labelMode) return;
    this.labelMode = mode;
    this.applyLabelVisibility();
  }

  /**
   * Show the right badge per mode without rebuilding: baked badges live in the material shader
   * (toggled via the uLabelOpacity uniform), billboard badges are sprites (toggled via visibility).
   */
  private applyLabelVisibility(): void {
    const flat = this.labelMode === 'flat';
    for (const e of this.clothMeshes) {
      const opacity = this.showLabels && e.mesh.visible && flat ? 1 : 0;
      for (const m of [e.mesh.material, e.backMesh?.material]) {
        const u = (m as THREE.Material | undefined)?.userData?.labelUniforms as { uLabelOpacity: { value: number } } | undefined;
        if (u) u.uLabelOpacity.value = opacity;
      }
    }
    for (const l of this.pieceLabels) {
      const mesh = this.clothMeshes.find((e) => e.pieceId === l.pieceId)?.mesh;
      l.obj.visible = this.showLabels && !flat && (mesh ? mesh.visible : true);
    }
    this.invalidate();
  }

  private lastClothPositions: Float32Array | null = null;

  setPose(name: string | null) {
    this.avatar?.setPose(name);
    // body moved: refresh cylinders + collision grid (cloth keeps current positions)
    if (this.avatar && this.sim) {
      this.sim.rebuildBodyGrid(this.avatar.vertexPositions, this.avatar.indices);
    }
    this.invalidate();
  }

  poseNames(): string[] {
    return this.avatar?.poseNames() ?? [];
  }

  webgpuAvailable(): boolean {
    return isWebGPUAvailable();
  }

  private async ensureSim(): Promise<ClothSimulation | null> {
    if (this.sim) return this.sim;
    if (!this.prepared) return null;
    if (!this.device) this.device = await requestDevice();
    if (!this.device) throw new Error('WebGPU is unavailable');
    this.sim = new ClothSimulation(this.device, this.prepared);
    const simulation = this.sim;
    this.simRunner = new SolverRunner({
      async step(_dt: number): Promise<void> {
        await simulation.step();
      },
      read(out?: Float32Array): Float32Array {
        if (!out || out.length !== simulation.positions.length) return simulation.positions.slice();
        out.set(simulation.positions);
        return out;
      },
      state: () => ({ positions: simulation.positions }),
      reset: () => simulation.resetToSaved(),
      dispose: () => undefined
    });
    this.disposeSimFrame = this.simRunner.onFrame(({ positions }) => {
      if (!this.simulating || this.disposed) {
        this.simRunner?.stop();
        return;
      }
      this.applyClothPositions(positions);
      if (this.adaptFramesLeft > 0 && --this.adaptFramesLeft === 0) {
        this.sim?.reanchorToSettled();
        this.sim?.setSelfCollision(true);
        this.bodyDirty = false;
        this.baseBodyKey = this.lastBodyKey;
      }
    });
    return this.sim;
  }

  /** The body-cylinder name a sim piece is arranged on (strips the mirror-instance suffix). */
  private cylinderNameForPiece(pieceId: string): string | null {
    const baseId = pieceId.replace(/#M$/, '');
    const piece = this.pattern?.pieces.find((p) => p.id === baseId);
    const name = piece?.settings3d.arrangement.cylinderName;
    return name && !piece?.settings3d.arrangement.use2DPosition ? name : null;
  }

  /** Run the live cloth simulation from the current state (requires WebGPU). */
  async simulate(): Promise<void> {
    if (this.simulating) return;
    try {
      const sim = await this.ensureSim();
      if (!sim) return;
      if (this.bodyDirty && this.baseCylinders && this.pattern) {
        // Body changed: re-fit the cached drape onto the new body via CYLINDER COORDINATES — decompose
        // each particle into (u, v, radial standoff) on the OLD body's cylinder and re-project onto the
        // NEW body's cylinder. This deforms the drape coherently with the body (tracks size/pose), with
        // no physics re-settle, so it can't splay/curl the way per-piece rigid fit or free settling did.
        const cylName = this.cylinderNameForPiece.bind(this);
        const refit = cylinderRefit(sim.positions, this.prepared!.simData.pieces, cylName, this.baseCylinders, this.cylinders);
        sim.seedAndHold(refit, this.holdAnchor());
        this.applyClothPositions(refit);
        sim.setSelfCollision(true);
        this.adaptFramesLeft = 0;
        this.bodyDirty = false;
        this.baseBodyKey = this.lastBodyKey;
        this.baseCylinders = this.cylinders; // the new body is now the base for future edits
      } else if (this.bodyDirty) {
        // Fallback (no base cylinders captured): soft-anchor adaptation.
        sim.setSelfCollision(false);
        sim.setAnchorScale(0.3);
        this.adaptFramesLeft = 90;
      } else {
        // No change: softly hold the cached (settled) drape with self-collision on. A gentle hold
        // (not a rigid pin) lets the cloth settle/respond like a live sim while staying faithful to
        // the source's drape and not curling the free waistband edge.
        sim.setSelfCollision(true);
        sim.setAnchorScale(this.holdAnchor());
        this.adaptFramesLeft = 0;
      }
      this.liveAnchorScale = this.bodyDirty ? 0.3 : this.holdAnchor(); // restore after a grab
      this.userSimulating = true; // user-started: keep running across grab/release
      this.simulating = true;
      this.onStatus('simulating');
      void this.runSimLoop();
    } catch (e) {
      this.simulating = false;
      this.releaseSimulationLease?.();
      this.releaseSimulationLease = null;
      this.onStatus('error', e instanceof Error ? e.message : String(e));
    }
  }

  private runSimLoop(): void {
    if (!this.releaseSimulationLease) {
      this.releaseSimulationLease = this.viewport.acquireRenderLease('cloth-solver');
    }
    this.simRunner?.start();
  }

  stopSimulation() {
    const wasUser = this.userSimulating;
    this.simulating = false;
    this.simRunner?.stop();
    this.releaseSimulationLease?.();
    this.releaseSimulationLease = null;
    this.userSimulating = false;
    if (wasUser) {
      // Weld settled seams (counterpart particles within 2 mm snap to their midpoint — the
      // original's snapSeamPointsToCounterparts) and grade the drape before baking it.
      const pos = this.sim?.positions ?? this.prepared?.simData.positions;
      if (pos) {
        this.weldSeamCounterparts(pos);
        this.applyClothPositions(pos);
        this.lastStretchError = this.computeStretchError(pos);
      }
    }
    if (this.pattern) this.onStatus('ready');
    // Bake the settled drape so it can be persisted (re-open shows the new drape instantly, and
    // body re-fits chain off the latest result rather than the stale authored blob).
    if (wasUser) { try { this.onDrapeSettled(this.extractSavedPositions()); } catch { /* ignore */ } }
  }

  private lastStretchError: number | null = null;

  /** RMS relative stretch error over all stretch constraints at the last user-run stop (the
   *  original's calculateErrors): 0 = every edge at rest length. Null until a sim has run. */
  getStretchError(): number | null {
    return this.lastStretchError;
  }

  private weldSeamCounterparts(pos: Float32Array): number {
    if (!this.prepared) return 0;
    const s = this.prepared.simData.seams;
    const n = this.prepared.simData.particleCount;
    const TOL2 = 0.002 * 0.002; // 2 mm
    let welded = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < 4; j++) {
        const p = s[i * 4 + j];
        if (p <= i) continue; // each symmetric pair once
        const dx = pos[i * 4] - pos[p * 4];
        const dy = pos[i * 4 + 1] - pos[p * 4 + 1];
        const dz = pos[i * 4 + 2] - pos[p * 4 + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 <= 0 || d2 > TOL2) continue;
        const mx = (pos[i * 4] + pos[p * 4]) / 2;
        const my = (pos[i * 4 + 1] + pos[p * 4 + 1]) / 2;
        const mz = (pos[i * 4 + 2] + pos[p * 4 + 2]) / 2;
        pos[i * 4] = mx; pos[i * 4 + 1] = my; pos[i * 4 + 2] = mz;
        pos[p * 4] = mx; pos[p * 4 + 1] = my; pos[p * 4 + 2] = mz;
        welded++;
      }
    }
    return welded;
  }

  private computeStretchError(pos: Float32Array): number | null {
    if (!this.prepared) return null;
    let sum = 0, count = 0;
    for (const group of this.prepared.simData.stretchColors) {
      for (let i = 0; i < group.count; i++) {
        const a = group.edges[i * 4], b = group.edges[i * 4 + 1], rest = group.edges[i * 4 + 2];
        if (rest <= 1e-9) continue;
        const dx = pos[a * 4] - pos[b * 4];
        const dy = pos[a * 4 + 1] - pos[b * 4 + 1];
        const dz = pos[a * 4 + 2] - pos[b * 4 + 2];
        const rel = (Math.sqrt(dx * dx + dy * dy + dz * dz) - rest) / rest;
        sum += rel * rel;
        count++;
      }
    }
    return count ? Math.sqrt(sum / count) : null;
  }

  /** Per-piece settled positions in the savedPositions format (stride-5: x2d,y2d in mm; x3d,y3d,z3d
   *  in m), keyed by base piece id. 2D comes from positions2d (meters→mm); 3D from the live drape.
   *  Mirror instances (#M) are skipped — savedPositions belongs to the base piece. */
  extractSavedPositions(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    if (!this.prepared) return out;
    const sd = this.prepared.simData;
    const pos = this.sim?.positions ?? sd.positions;
    for (const piece of sd.pieces) {
      if (piece.pieceId.endsWith('#M')) continue;
      const arr = new Array(piece.count * 5);
      for (let i = 0; i < piece.count; i++) {
        const g = piece.start + i;
        const plan = worldToDoc(new THREE.Vector3(
          sd.positions2d[g * 4],
          sd.positions2d[g * 4 + 1],
          0
        ));
        arr[i * 5] = plan.x;
        arr[i * 5 + 1] = plan.y;
        arr[i * 5 + 2] = pos[g * 4];
        arr[i * 5 + 3] = pos[g * 4 + 1];
        arr[i * 5 + 4] = pos[g * 4 + 2];
      }
      out[piece.pieceId] = arr;
    }
    return out;
  }

  /** Reset particles to the cached/settled drape. */
  resetSimulation() {
    this.stopSimulation();
    if (this.sim) { this.sim.resetToSaved(); this.applyClothPositions(this.sim.positions); }
    else if (this.prepared) this.applyClothPositions(this.prepared.simData.positions);
  }

  /** "Arrange" — return the garment to its settled drape on the body. */
  arrange() {
    this.resetSimulation();
  }

  // ---- Pre-simulation arrangement editor -----------------------------------------------------
  // Enter a mode where each garment piece is shown in its flat-on-body layout and can be selected
  // and moved/rotated with a transform gizmo (on or off the body) before draping.

  getMode(): SceneMode {
    return this.mode;
  }

  /** true while the piece-edit groups were seeded from the live drape (Move mode) vs the flat layout. */
  private arrangeFromDrape = false;
  private arrangeTransformMode: 'translate' | 'rotate' = 'translate';

  /** Enter arrange mode: show pieces flat-on-body, each individually selectable + movable. */
  enterArrangeMode(): void {
    if (this.mode === 'arrange' || !this.prepared || !this.pattern) return;
    this.stopSimulation();
    this.arrangeFromDrape = false;
    this.buildPieceEditGroups(this.prepared.simData.arrangedPositions); // stride-4 world (flat-on-body)
  }

  /**
   * Enter "Move pieces" mode: each *draped* piece becomes an individually selectable rigid solid you
   * can translate/rotate with the gizmo, in place on the body. Pressing Play (Drape) eases the moved
   * pieces back to the settled drape — they "fly back" because the sim's anchors stay at that drape.
   */
  enterManipulateMode(): void {
    if (this.mode === 'arrange' || !this.prepared || !this.pattern) return;
    this.stopSimulation();
    this.arrangeFromDrape = true;
    // Seed from the freshest drape: the live sim if any, else the last applied positions, else cached.
    const base = this.sim?.positions ?? this.lastClothPositions ?? this.prepared.simData.positions;
    this.buildPieceEditGroups(base);
  }

  /** Build the per-piece movable groups (centroid origin + local geometry) from stride-4 `base`. */
  private buildPieceEditGroups(base: Float32Array): void {
    this.mode = 'arrange';
    this.clothGroup.visible = false; // hide the live (single) draped meshes while editing per-piece
    this.scene.add(this.arrangeGroup);

    const flat = this.pattern!.settings3d.lightingMode === 'flat';
    const matById = new Map<string, Material>();
    for (const m of this.pattern!.materials) matById.set(m.id, m);

    for (const piece of this.prepared!.simData.pieces) {
      const c = new THREE.Vector3();
      for (let i = 0; i < piece.count; i++) {
        const g = piece.start + i;
        c.x += base[g * 4]; c.y += base[g * 4 + 1]; c.z += base[g * 4 + 2];
      }
      c.multiplyScalar(1 / Math.max(1, piece.count));
      const baseLocal = new Float32Array(piece.count * 3);
      const pos = new Float32Array(piece.count * 3);
      for (let i = 0; i < piece.count; i++) {
        const g = piece.start + i;
        const lx = base[g * 4] - c.x, ly = base[g * 4 + 1] - c.y, lz = base[g * 4 + 2] - c.z;
        baseLocal[i * 3] = lx; baseLocal[i * 3 + 1] = ly; baseLocal[i * 3 + 2] = lz;
        pos[i * 3] = lx; pos[i * 3 + 1] = ly; pos[i * 3 + 2] = lz;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(piece.uv.slice(), 2));
      geo.setIndex(piece.triangles.map((g) => g - piece.start));
      geo.computeVertexNormals();
      // Bake the same name badges as the drape view so pieces keep their labels while being moved.
      const srcPiece = this.pattern!.pieces.find((p) => p.id === piece.pieceId);
      const name = srcPiece?.name ?? 'Piece';
      const { face, back } = this.buildPieceLabelTextures(geo, piece.uv, piece.count, piece.pieceId, name);
      const labelOpacity = this.showLabels && this.labelMode === 'flat' ? 1 : 0;
      const labelFlipFace = piece.pieceId.includes('#M') !== !!srcPiece?.settings3d.flipNormals;
      const mat = createGarmentMaterial(matById.get(piece.materialId), flat, { labelTexture: face, labelTextureBack: back, labelOpacity, labelFlipFace });
      mat.wireframe = this.showTriangles;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      const group = new THREE.Group();
      group.position.copy(c);
      group.add(mesh);
      group.visible = !this.pattern!.pieces.find((p) => p.id === piece.pieceId)?.hidden;
      this.arrangeGroup.add(group);
      this.viewport.picking.register(mesh, piece.pieceId, 'piece', ['face']);
      this.arrangeEntries.push({ pieceId: piece.pieceId, start: piece.start, count: piece.count, group, mesh, baseLocal });
    }

    this.viewport.gizmos.setMode(this.arrangeTransformMode);
    this.viewport.gizmos.setSpace('local');
    this.selectArrange(-1);
  }

  /** Select an arrange piece by index (-1 clears). Highlights it and attaches the gizmo. */
  private selectArrange(idx: number, emit = true): void {
    if (this.selectedArrange >= 0 && this.selectedArrange < this.arrangeEntries.length) {
      const prev = this.arrangeEntries[this.selectedArrange].mesh.material as THREE.MeshPhysicalMaterial;
      prev.emissive.setHex(0x000000);
    }
    this.selectedArrange = idx;
    if (idx >= 0 && idx < this.arrangeEntries.length) {
      const e = this.arrangeEntries[idx];
      const m = e.mesh.material as THREE.MeshPhysicalMaterial;
      m.emissive.setHex(0x1d4ed8); // blue selection tint
      m.emissiveIntensity = 0.4;
      this.viewport.gizmos.attach(e.group, this.arrangeTransformMode);
      this.highlightId = e.pieceId;
      this.emitModeChange(e.pieceId);
      if (emit) this.onSelectPiece(e.pieceId);
    } else {
      this.viewport.gizmos.detach();
      this.emitModeChange(null);
    }
    this.invalidate();
  }

  /** Fire onModeChange with the current mode + edit kind (arrange vs in-place manipulate). */
  private emitModeChange(selectedPieceId: string | null): void {
    const kind = this.mode === 'arrange' ? (this.arrangeFromDrape ? 'manipulate' : 'arrange') : null;
    this.onModeChange(this.mode, selectedPieceId, kind);
  }

  /** Gizmo mode while arranging. */
  setArrangeTransformMode(m: 'translate' | 'rotate'): void {
    this.arrangeTransformMode = m;
    this.viewport.gizmos.setMode(m);
    this.invalidate();
  }

  /** Global stride-4 seed positions = each piece's flat-on-body base transformed by its gizmo. */
  private arrangedSeed(): Float32Array {
    const out = this.prepared!.simData.positions.slice(); // keep invMass in .w
    const v = new THREE.Vector3();
    for (const e of this.arrangeEntries) {
      e.group.updateMatrixWorld(true);
      for (let i = 0; i < e.count; i++) {
        v.set(e.baseLocal[i * 3], e.baseLocal[i * 3 + 1], e.baseLocal[i * 3 + 2]).applyMatrix4(e.group.matrixWorld);
        const g = e.start + i;
        out[g * 4] = v.x; out[g * 4 + 1] = v.y; out[g * 4 + 2] = v.z;
      }
    }
    return out;
  }

  /** Leave arrange mode without draping; restore the previous drape view. */
  exitArrangeMode(): void {
    if (this.mode !== 'arrange') return;
    this.clearArrangementGhost();
    this.selectArrange(-1);
    this.viewport.gizmos.detach();
    for (const e of this.arrangeEntries) {
      this.viewport.picking.unregister(e.mesh);
      this.arrangeGroup.remove(e.group);
      e.mesh.geometry.dispose();
      disposeGarmentMaterial(e.mesh.material as THREE.Material);
    }
    this.arrangeEntries = [];
    this.scene.remove(this.arrangeGroup);
    this.clothGroup.visible = true;
    this.mode = 'view';
    this.arrangeFromDrape = false;
    this.emitModeChange(null);
    this.invalidate();
  }

  /** Drape from the current arrangement: seed the sim with the moved pieces and simulate. */
  async simulateFromArrangement(): Promise<void> {
    if (this.mode !== 'arrange' || !this.prepared) return;
    const fromDrape = this.arrangeFromDrape;
    const seed = this.arrangedSeed();
    this.exitArrangeMode();
    const sim = await this.ensureSim();
    if (!sim) { this.applyClothPositions(seed); return; }
    sim.resetTo(seed);
    this.applyClothPositions(seed);
    if (fromDrape) {
      // Move mode: the anchors still target the settled drape, so a soft hold eases the displaced
      // pieces back into place — they "fly back" — then the live sim keeps running until stopped.
      sim.setSelfCollision(true);
      sim.setAnchorScale(this.holdAnchor());
      this.liveAnchorScale = this.holdAnchor();
      this.userSimulating = true; // stays live across grabs; Stop bakes the result
    } else {
      // Flat-arrangement drape: free settle from the user's layout (no cached drape applies);
      // self-collision off avoids the free-settle curl, matching the interactive-drag behaviour.
      sim.setAnchorScale(0);
      sim.setSelfCollision(false);
      this.userSimulating = false; // one-shot settle: grab→freeze on release
    }
    this.bodyDirty = false;
    this.adaptFramesLeft = 0;
    this.simulating = true;
    this.onStatus('simulating');
    void this.runSimLoop();
  }

  setAvatarVisible(v: boolean) {
    if (this.avatar?.mesh) this.avatar.mesh.visible = v;
    this.invalidate();
  }

  setClothVisible(v: boolean) {
    this.clothGroup.visible = v;
    this.invalidate();
  }

  /** Overlay the cloth triangle mesh (wireframe). */
  // showTriangles overlays a flat pale-yellow wireframe on each piece (the original's distinct
  // debug material) instead of switching the lit PBR material to wireframe; back meshes hide so
  // the topology reads cleanly.
  private triangleOverlays: THREE.Mesh[] = [];

  setShowTriangles(v: boolean) {
    this.showTriangles = v;
    this.invalidate();
    for (const m of this.triangleOverlays) {
      this.clothGroup.remove(m);
      (m.material as THREE.Material).dispose();
    }
    this.triangleOverlays = [];
    for (const e of this.clothMeshes) {
      if (v) {
        // Triangle debug mode hides the actual garment so only the wireframe topology is visible.
        e.mesh.visible = false;
        if (e.backMesh) e.backMesh.visible = false;
        if (e.sideMesh) e.sideMesh.visible = false;
        if (!e.baseVisible) continue;
        const overlay = new THREE.Mesh(e.geometry, new THREE.MeshBasicMaterial({ color: 0xffeeaa, wireframe: true, transparent: true, opacity: 0.9, depthTest: true }));
        overlay.frustumCulled = false;
        overlay.renderOrder = 5;
        overlay.visible = true;
        this.clothGroup.add(overlay);
        this.triangleOverlays.push(overlay);
      } else {
        // Restore the garment to the visibility dictated by the pattern's hidden flag.
        e.mesh.visible = e.baseVisible;
        if (e.backMesh) e.backMesh.visible = e.baseVisible;
        if (e.sideMesh) e.sideMesh.visible = e.baseVisible;
      }
    }
    if (!v) this.applyLabelVisibility();
  }

  /** Live snapshot of the solver config (the panel reads this to seed its controls). */
  getSimConfig(): SimConfig {
    return { ...SIM_CONFIG };
  }

  /**
   * Update solver parameters. Anchor/self-collision are uniform writes (apply live); the rest are
   * baked into the compute shaders at build time, so we rebuild the sim from the current drape and
   * resume — the cloth keeps its shape and the new params take effect immediately.
   */
  async setSimConfig(partial: Partial<SimConfig>): Promise<void> {
    const keys = Object.keys(partial) as Array<keyof SimConfig>;
    const changed = keys.some((key) => {
      const next = partial[key];
      const current = SIM_CONFIG[key];
      return Array.isArray(next) && Array.isArray(current)
        ? next.length !== current.length || next.some((value, index) => value !== current[index])
        : next !== current;
    });
    if (!changed) return;
    Object.assign(SIM_CONFIG, partial);
    // deltaT is derived from timeStep/subSteps (the shaders bake it), so keep it in sync.
    if ('timeStep' in partial || 'subSteps' in partial) {
      SIM_CONFIG.deltaT = SIM_CONFIG.timeStep / Math.max(1, SIM_CONFIG.subSteps);
    }
    if (this.sim) this.sim.setSelfCollision(SIM_CONFIG.handleSelfCollisions);
    // Params that change shader code need a rebuilt engine; preserve the live positions across it.
    // (timeStep/subSteps/max/minVelocity are baked as WGSL constants; useBending gates the bend pass.)
    const bakedKeys: (keyof SimConfig)[] = ['gravity', 'globalDamping', 'localDamping', 'nearDamping', 'simulationThickness', 'edgeThickness', 'seamStrength', 'selfCollisionFriction', 'externalCollisionFriction', 'seamIterations', 'handleExternalCollisions', 'timeStep', 'subSteps', 'maxVelocity', 'minVelocity', 'useBending'];
    if (!this.sim || !bakedKeys.some((k) => k in partial)) return;
    const pos = this.sim.positions.slice();
    const wasSim = this.simulating;
    this.simulating = false; // halt the loop without firing onDrapeSettled
    this.simRunner?.stop();
    await Promise.resolve();
    this.disposeSimFrame?.();
    this.disposeSimFrame = null;
    this.simRunner?.dispose();
    this.simRunner = null;
    this.sim.dispose();
    this.sim = null;
    const sim = await this.ensureSim();
    if (!sim) return;
    sim.resetTo(pos);
    this.applyClothPositions(pos);
    sim.setSelfCollision(SIM_CONFIG.handleSelfCollisions);
    if (wasSim) {
      sim.setAnchorScale(this.liveAnchorScale);
      this.simulating = true;
      this.userSimulating = true;
      this.onStatus('simulating');
      void this.runSimLoop();
    }
  }

  // ---- Frozen snapshot: a translucent "ghost" of the drape at a moment, as a reference overlay ----
  private snapshotGroup: THREE.Group | null = null;

  /** Freeze the current drape as a translucent ghost reference (replaces any previous one). */
  freezeSnapshot(opacity = 0.35): void {
    this.clearSnapshot();
    if (!this.clothMeshes.length) return;
    const group = new THREE.Group();
    for (const e of this.clothMeshes) {
      const src = e.geometry.getAttribute('position') as THREE.BufferAttribute;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute((src.array as Float32Array).slice(), 3));
      if (e.geometry.index) geo.setIndex(Array.from(e.geometry.index.array as ArrayLike<number>));
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: 0x4f9cff, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      group.add(mesh);
    }
    this.scene.add(group);
    this.snapshotGroup = group;
    this.invalidate();
  }

  clearSnapshot(): void {
    if (!this.snapshotGroup) return;
    this.scene.remove(this.snapshotGroup);
    for (const c of this.snapshotGroup.children) {
      const m = c as THREE.Mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.snapshotGroup = null;
    this.invalidate();
  }

  setSnapshotOpacity(o: number): void {
    if (!this.snapshotGroup) return;
    for (const c of this.snapshotGroup.children) ((c as THREE.Mesh).material as THREE.MeshStandardMaterial).opacity = o;
    this.invalidate();
  }

  hasSnapshot(): boolean {
    return !!this.snapshotGroup;
  }

  // ---- Arrangement preview ghost (the original's ensureArrangementPreviewGhost): hovering a
  // marker with a piece selected shows a transparent clone of the piece at that placement. ----
  private arrangementGhost: THREE.Mesh | null = null;

  private clearArrangementGhost(): void {
    if (!this.arrangementGhost) return;
    this.scene.remove(this.arrangementGhost);
    this.arrangementGhost.geometry.dispose();
    (this.arrangementGhost.material as THREE.Material).dispose();
    this.arrangementGhost = null;
    this.invalidate();
  }

  private updateArrangementGhost(marker: { cylinderName: string; uDegrees: number; v: number } | null): void {
    this.clearArrangementGhost();
    if (!marker || this.selectedArrange < 0 || !this.prepared || !this.pattern) return;
    const entry = this.arrangeEntries[this.selectedArrange];
    if (!entry) return;
    const piece = this.pattern.pieces.find((p) => p.id === entry.pieceId.replace(/#M$/, ''));
    const sp = this.prepared.simData.pieces.find((p) => p.pieceId === entry.pieceId);
    if (!piece || !sp) return;
    // candidate placement: the piece's arrangement re-seated on the hovered marker
    const arr = {
      ...piece.settings3d.arrangement,
      cylinderName: marker.cylinderName, uDegrees: marker.uDegrees, v: marker.v,
      uOffsetMm: 0, vOffsetMm: 0, use2DPosition: false, positionChanged: false
    };
    const p2d = this.prepared.simData.positions2d;
    const pts = new Array<{ x: number; y: number }>(sp.count);
    for (let i = 0; i < sp.count; i++) {
      const g = sp.start + i;
      pts[i] = worldToDoc(new THREE.Vector3(p2d[g * 4], p2d[g * 4 + 1], 0));
    }
    const pos3 = arrangeParticles(pts, arr, this.cylinders.get(marker.cylinderName) ?? null, { flipNormals: piece.settings3d.flipNormals });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos3, 3));
    geo.setIndex(sp.triangles.map((g) => g - sp.start));
    const mat = new THREE.MeshBasicMaterial({ color: 0x0ea5e9, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
    this.arrangementGhost = new THREE.Mesh(geo, mat);
    this.arrangementGhost.frustumCulled = false;
    this.arrangementGhost.renderOrder = 6;
    this.scene.add(this.arrangementGhost);
    this.invalidate();
  }

  /** Toggle the 3D seam overlay (lines between sewn edges). */
  setShowSeams(on: boolean): void {
    this.overlays.setShowSeams(on);
  }

  /** A selected seam displays (emphasized) even when "Show seams" is off. */
  setSelectedSeam(seamId: string | null): void {
    this.overlays.setSelectedSeam(seamId);
  }

  // 3D seam-tool semantics and raw edge-run picking stay here; SeamerOverlays owns rendering.
  private seamToolState: SeamToolState | null = null;
  private seamToolHover: SeamPick | null = null;
  private lastSeamHoverAt = 0;
  /** A 3D edge click while a seam tool is active; the component routes it through the shared tool. */
  onSeamEdgePick: (pick: SeamPick) => void = () => {};

  /** Push the shared seam-tool selection into the 3D overlay (null = tool inactive). */
  setSeamToolState(state: SeamToolState | null, kind: 'single' | 'multi' = 'single'): void {
    this.seamToolState = state ? { from: [...state.from], to: [...state.to], phase: state.phase } : null;
    if (!state) this.seamToolHover = null;
    this.overlays.setSeamToolState(this.seamToolState, kind);
  }

  /** Raycast the garment and resolve the nearest piece-edge run + click position along it. */
  private pickSeamEdge(event: PointerEvent): SeamPick | null {
    if (!this.prepared || this.clothMeshes.length === 0) return null;
    const hits = this.viewport.picking.raycast(event, {
      objects: this.clothMeshes.map((entry) => entry.mesh),
      recursive: false
    });
    const hit = hits[0];
    if (!hit) return null;
    const entry = this.clothMeshes.find((e) => e.mesh === hit.object);
    if (!entry) return null;
    const pos = this.lastClothPositions ?? this.prepared.simData.positions;
    let bestKey: string | null = null;
    let bestRun: number[] | null = null;
    let bestIdx = 0;
    let bd = Infinity;
    for (const [key, run] of this.prepared.simData.edgeRuns) {
      if (run.length < 2) continue;
      if (run[0] < entry.start || run[0] >= entry.start + entry.count) continue; // other instance
      for (let i = 0; i < run.length; i++) {
        const g = run[i];
        const dx = pos[g * 4] - hit.point.x;
        const dy = pos[g * 4 + 1] - hit.point.y;
        const dz = pos[g * 4 + 2] - hit.point.z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bd) { bd = d; bestKey = key; bestRun = run; bestIdx = i; }
      }
    }
    if (!bestKey || !bestRun) return null;
    // accept hits within ~2.5 particle spacings of the edge (else the click was mid-panel)
    const a = bestRun[0], b = bestRun[1];
    const spacing = Math.hypot(pos[a * 4] - pos[b * 4], pos[a * 4 + 1] - pos[b * 4 + 1], pos[a * 4 + 2] - pos[b * 4 + 2]);
    if (Math.sqrt(bd) > Math.max(0.025, spacing * 2.5)) return null;
    const cut = bestKey.lastIndexOf('::');
    let edgeKey = bestKey.slice(cut + 2);
    const mirrored = edgeKey.endsWith('#M');
    if (mirrored) edgeKey = edgeKey.slice(0, -2);
    // click nearer the run's end ⇒ reversed (same inference as the 2D tool)
    return { id: edgeKey, mirrored, reversed: bestIdx / Math.max(1, bestRun.length - 1) > 0.5 };
  }

  clearBodyMeasurement(): void {
    this.overlays.clearBodyMeasurement();
  }

  /** Show (or toggle off) a measurement's on-mesh segment. Returns whether it is now visible. */
  showBodyMeasurement(name: string): boolean {
    return this.overlays.showBodyMeasurement(name);
  }

  /** Animated fly-to framing a body measurement (the original's avatar zoomToMeasurement, 700 ms):
   *  uses the per-measurement cameraSettings shipped in the base model. */
  zoomToBodyMeasurement(name: string): boolean {
    const cam = this.avatar?.measurementCamera(name);
    if (!cam) return false;
    void this.flyCamera(
      new THREE.Vector3(cam.position[0], cam.position[1], cam.position[2]),
      new THREE.Vector3(cam.target[0], cam.target[1], cam.target[2]),
      700
    );
    return true;
  }

  /** Animate the camera to an orthographic-style preset around the current target. */
  setCameraView(view: 'front' | 'back' | 'left' | 'right' | 'top' | 'reset'): void {
    let toPos: THREE.Vector3;
    let toTgt: THREE.Vector3;
    if (view === 'reset') {
      toPos = new THREE.Vector3(0.5, 0.9, 1.6);
      toTgt = new THREE.Vector3(0, 0.9, 0);
    } else {
      toTgt = this.controls.target.clone();
      const dist = this.camera.position.distanceTo(toTgt) || 1.8;
      const off = new THREE.Vector3();
      if (view === 'front') off.set(0, 0, dist);
      else if (view === 'back') off.set(0, 0, -dist);
      else if (view === 'left') off.set(-dist, 0, 0);
      else if (view === 'right') off.set(dist, 0, 0);
      else off.set(0, dist, 0.001); // top (tiny z avoids a degenerate up vector)
      toPos = toTgt.clone().add(off);
    }
    void this.flyCamera(toPos, toTgt, 450);
  }

  private async flyCamera(
    position: THREE.Vector3,
    target: THREE.Vector3,
    duration: number
  ): Promise<void> {
    const release = this.viewport.acquireRenderLease('camera-flight');
    try {
      await this.viewport.camera.flyTo(position, target, duration);
      this.queueCameraSave();
    } finally {
      release();
    }
  }

  /** Camera field of view (degrees). */
  getCameraFov(): number {
    return this.viewport.camera.getFov();
  }
  setCameraFov(deg: number): void {
    this.viewport.camera.setFov(deg);
    this.invalidate();
    this.queueCameraSave();
  }

  /** Capture the current 3D view as a PNG data URL. Renders a fresh frame first, then reads the
   *  canvas in the same tick (so it works without preserveDrawingBuffer). */
  captureImage(): string {
    this.refreshPostSettings();
    return this.viewport.captureImage();
  }

  /** Export the avatar + draped garment as an OBJ download. */
  exportOBJ(): string {
    const exporter = new OBJExporter();
    return exporter.parse(this.buildExportGroup());
  }

  /** Export the avatar + draped garment as binary STL (e.g. for 3D printing/CAD). */
  async exportSTL(): Promise<DataView> {
    const { STLExporter } = await import('three/addons/exporters/STLExporter.js');
    const exporter = new STLExporter();
    return exporter.parse(this.buildExportGroup(), { binary: true }) as DataView;
  }

  /** Detached snapshot of the live avatar + draped garment for shared scene exporters. */
  exportScene(): THREE.Group {
    return this.buildExportGroup();
  }

  /** Avatar + visible cloth meshes cloned into a detached group with current world matrices. */
  private buildExportGroup(): THREE.Group {
    const group = new THREE.Group();
    if (this.avatar?.mesh && this.avatar.mesh.visible) group.add(this.avatar.mesh.clone());
    for (const e of this.clothMeshes) if (e.baseVisible) group.add(e.mesh.clone());
    group.updateMatrixWorld(true);
    return group;
  }

  /** Toggle the named arrangement-point markers (the source's arrangement point overlay). */
  setShowArrangementPoints(on: boolean): void {
    this.overlays.setShowArrangementPoints(on);
  }

  /** Show the given distance measurements on the draped garment (endpoints in plan mm). */
  setMeasurements(defs: MeasurementOverlayDef[]): void {
    this.overlays.setMeasurements(defs);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.simulating = false;
    this.releaseSimulationLease?.();
    this.releaseSimulationLease = null;
    this.releaseGizmoLease?.();
    this.releaseGizmoLease = null;
    clearTimeout(this.cameraSaveTimer);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener('resize', this.onResize);
    this.controls.removeEventListener('end', this.handleControlsEnd);
    this.controls.removeEventListener('start', this.handleControlsStart);
    if (this.mode === 'arrange') this.exitArrangeMode();
    for (const dispose of this.gizmoDisposers) dispose();
    this.disposeSimFrame?.();
    this.simRunner?.dispose();
    this.sim?.dispose();
    this.clearClothMeshes();
    this.overlays.dispose();
    this.avatar?.dispose();
    this.lighting.dispose();
    this.viewport.dispose();
  }
}
