import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyPattern } from '@seamer/pattern-model';
import { PerspectiveCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CameraRig, cameraRigInternal } from '../../../../atelier/packages/viewport/src/camera';
import { PatternRenderer } from './scene3d';

vi.mock('./seamerLighting', () => ({ SeamerLighting: vi.fn() }));
vi.mock('./pieceTexture', () => ({ createPieceTexture: vi.fn(), pieceNeedsBake: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function rig(source = true) {
  const renderer = Object.create(PatternRenderer.prototype) as PatternRenderer;
  const pattern = createEmptyPattern();
  pattern.settings3d.sourceCameraFraming = 'viewport';
  pattern.settings3d.cameraPosition = [.65, 1.24, 3.56];
  pattern.settings3d.controlsTarget = [0, .95, .025];
  let current = { position: pattern.settings3d.cameraPosition, target: pattern.settings3d.controlsTarget, fov: 54.43 };
  const camera = new PerspectiveCamera(54.43);
  const target = new Vector3(...current.target);
  camera.position.fromArray(current.position);
  const setState = vi.fn((state: typeof current) => { current = state; camera.fov = state.fov;
    camera.position.fromArray(state.position); target.fromArray(state.target); });
  const setFov = vi.fn((fov: number) => { current = { ...current, fov }; camera.fov = fov; });
  const body = new Float32Array([-.685, 0, -.16, .685, 1.76, .13]);
  Object.assign(renderer, { pattern, prepared: { collisionSafety: source,
    simData: { positions: new Float32Array([-.75, .05, .2, 1, .75, 1.5, -.2, 1]) } },
    avatar: { vertexPositions: body }, camera,
    controls: { target },
    container: { getBoundingClientRect: () => ({ width: 390, height: 671, left: 0, top: 0 }), closest: () => null, querySelectorAll: () => [] },
    viewport: { camera: { getState: () => current, setState, setFov } }, invalidate: vi.fn(),
    flyCamera: vi.fn(), queueCameraSave: vi.fn() });
  return { renderer, pattern, setState, current: () => current };
}

describe('renderer source camera intent', () => {
  it('keeps fresh source geometry clear of a newly visible reassembly notice', () => {
    const { renderer, pattern, current } = rig();
    let noticeVisible = false;
    const notice = { getClientRects: () => [{}], getBoundingClientRect: () => ({ left: 480, right: 800, top: 48, bottom: 90, width: 320, height: 42 }) };
    const query = vi.fn((selector: string) => selector.includes('.scene-status-notice') && noticeVisible ? [notice] : []);
    Object.assign(renderer, { container: { getBoundingClientRect: () => ({ width: 1280, height: 620, left: 0, top: 0 }),
      closest: () => ({ querySelectorAll: query }) } });
    renderer.applyCameraSettings(pattern);
    noticeVisible = true; renderer.refreshSourceCameraFit();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('.scene-status-notice'));
    const camera = new PerspectiveCamera(current().fov, 1280 / 620, .01, 100);
    camera.position.fromArray(current().position); camera.lookAt(new Vector3(...current().target)); camera.updateMatrixWorld();
    for (const point of [[-.685, 0, -.16], [.685, 1.76, .13], [-.75, .05, .2], [.75, 1.5, -.2]]) {
      const p = new Vector3(...point).project(camera), x = (p.x + 1) * 640, y = (1 - p.y) * 310;
      expect(x >= 480 && x <= 800 && y >= 48 && y <= 90).toBe(false);
      expect(y).toBeGreaterThan(90);
    }
  });


  it('fits a fresh active source using actual avatar and cloth, without irrelevant scene objects', () => {
    const { renderer, pattern, current } = rig();
    Object.assign(renderer, { cylinders: new Map([['irrelevant', { position: [100, 100, 100] }]]) });
    renderer.applyCameraSettings(pattern);
    expect(current().position[2]).toBeLessThan(pattern.settings3d.cameraPosition[2]);
    const camera = new PerspectiveCamera(current().fov, 390 / 671, .01, 100);
    camera.position.fromArray(current().position); camera.lookAt(new Vector3(...current().target)); camera.updateMatrixWorld();
    for (const p of [[-.685, 0, -.16], [.685, 1.76, .13], [-.75, .05, .2], [.75, 1.5, -.2]]) {
      const projected = new Vector3(...p).project(camera);
      expect(Math.abs(projected.x)).toBeLessThan(1); expect(Math.abs(projected.y)).toBeLessThan(1);
    }
  });
  it.each([false, true])('preserves an explicitly saved camera, source active=%s', source => {
    const { renderer, pattern, current } = rig(source);
    delete pattern.settings3d.sourceCameraFraming;
    renderer.applyCameraSettings(pattern);
    expect(current().position).toEqual(pattern.settings3d.cameraPosition);
    renderer.refreshSourceCameraFit();
    expect(current().position).toEqual(pattern.settings3d.cameraPosition);
  });
  it('preserves a cache camera even if an older document retained the import marker', () => {
    const { renderer, pattern, current } = rig();
    pattern.pieces = [{ settings3d: { savedPositions: [0, 0, .1, .2, .3] } }] as typeof pattern.pieces;
    renderer.applyCameraSettings(pattern);
    expect(current().position).toEqual(pattern.settings3d.cameraPosition);
  });
  it('never auto-fits native/inactive source imports', () => {
    const { renderer, pattern, current } = rig(false);
    renderer.applyCameraSettings(pattern);
    expect(current().position).toEqual(pattern.settings3d.cameraPosition);
  });
  it('retains an explicit user orbit during subsequent settings effects and resize', () => {
    const { renderer, pattern, setState, current } = rig();
    renderer.applyCameraSettings(pattern);
    Object.assign(renderer, { sourceCameraUserControlled: true, sourceCameraAutomatic: false });
    renderer.setCameraState([2, 2, 2], [0, 1, 0], 54.43);
    setState.mockClear();
    renderer.applyCameraSettings(pattern); renderer.refreshSourceCameraFit();
    expect(setState).not.toHaveBeenCalled(); expect(current().position).toEqual([2, 2, 2]);
    const newPattern = { ...pattern, id: 'new-import' };
    Object.assign(renderer, { pattern: newPattern });
    renderer.applyCameraSettings(newPattern);
    expect(setState).toHaveBeenCalledOnce();
  });
  it('honors an explicit same-id fresh import after the previous document was orbited', () => {
    const { renderer, pattern, current } = rig();
    Object.assign(renderer, { sourceCameraPatternId: pattern.id, sourceCameraUserControlled: true });
    renderer.setCameraState([2, 2, 2], [0, 1, 0], 54.43);
    renderer.beginCameraDocument(); renderer.applyCameraSettings(pattern);
    expect(current().position).not.toEqual([2, 2, 2]);
    expect(current().position[2]).toBeLessThan(pattern.settings3d.cameraPosition[2]);
  });
  it('uses the imported FOV initially, then Reset respects a slider change before persistence', () => {
    const { renderer, pattern, current } = rig();
    pattern.settings3d.cameraFov = 47;
    renderer.applyCameraSettings(pattern);
    expect(current().fov).toBe(47);
    renderer.setCameraFov(37);
    expect(pattern.settings3d.cameraFov).toBe(47); // The saved model has not received its debounce.
    renderer.applyCameraSettings(pattern); renderer.refreshSourceCameraFit();
    expect(current().fov).toBe(37); // User camera intent survives a settings echo and resize.
    renderer.setCameraView('reset');
    expect(current().fov).toBe(37);
    const camera = new PerspectiveCamera(current().fov, 390 / 671, .01, 100);
    camera.position.fromArray(current().position); camera.lookAt(new Vector3(...current().target)); camera.updateMatrixWorld();
    for (const p of [[-.685, 0, -.16], [.685, 1.76, .13], [-.75, .05, .2], [.75, 1.5, -.2]]) {
      const projected = new Vector3(...p).project(camera);
      expect(Math.abs(projected.x)).toBeLessThan(1); expect(Math.abs(projected.y)).toBeLessThan(1);
    }
  });
  it('measures sibling controls outside the canvas action and leaves a drawer camera unchanged', () => {
    const { renderer, pattern, current } = rig();
    let drawer = false;
    const obstacle = { getClientRects: () => [{}], getBoundingClientRect: () => drawer
      ? { left: 30, right: 382, top: 8, bottom: 603, width: 352, height: 595 }
      : { left: 75, right: 382, top: 611, bottom: 663, width: 307, height: 52 } };
    Object.assign(renderer, { container: { getBoundingClientRect: () => ({ width: 390, height: 671, left: 0, top: 0 }),
      closest: () => ({ querySelectorAll: () => [obstacle] }), querySelectorAll: () => { throw new Error('Controls are siblings, not canvas descendants'); } } });
    renderer.applyCameraSettings(pattern);
    const before = structuredClone(current());
    drawer = true; renderer.refreshSourceCameraFit();
    expect(current()).toEqual(before);
    drawer = false; renderer.refreshSourceCameraFit();
    expect(current()).toEqual(before);
  });
  it('uses source Reset fit while keeping the native preset unchanged', () => {
    const source = rig(); source.renderer.setCameraView('reset');
    expect(source.current().position[2]).toBeLessThan(source.pattern.settings3d.cameraPosition[2]);
    expect((source.renderer as unknown as { flyCamera: ReturnType<typeof vi.fn> }).flyCamera).not.toHaveBeenCalled();
    const native = rig(false); native.renderer.setCameraView('reset');
    expect((native.renderer as unknown as { flyCamera: ReturnType<typeof vi.fn> }).flyCamera)
      .toHaveBeenCalledWith(new Vector3(.5, .9, 1.6), new Vector3(0, .9, 0), 450);
  });
});


describe('explicit source garment camera focus', () => {
  const published = () => new Float32Array([-.3, .7, .12, 1, .3, 1.05, -.1, 1]);

  it('zooms the same frozen published q without camera writeback, geometry/visibility changes or inferred assembly success', () => {
    vi.useFakeTimers();
    const { renderer, pattern, current } = rig();
    const cloth = published(), body = new Float32Array([-.685, 0, -.16, .685, 1.76, .13]), mesh = { visible: true }, writeback = vi.fn();
    const saved = structuredClone(pattern), initialCloth = cloth.slice(), initialBody = body.slice();
    Object.assign(renderer, { lastClothPositions: cloth, avatar: { vertexPositions: body, mesh },
      frozenDisplay: { positions: cloth.slice() }, sourceCameraAutomatic: true, sourceCameraUserControlled: false,
      cameraWritebackEnabled: false, onCameraChanged: writeback, queueCameraSave:
        (PatternRenderer.prototype as unknown as { queueCameraSave: () => void }).queueCameraSave });
    const previousDistance = new Vector3(...current().position).distanceTo(new Vector3(...current().target));
    expect(renderer.zoomToGarment()).toBe(true);
    expect(new Vector3(...current().position).distanceTo(new Vector3(...current().target))).toBeLessThan(previousDistance);
    vi.advanceTimersByTime(1000);
    expect(writeback).not.toHaveBeenCalled(); expect(pattern).toEqual(saved);
    expect(cloth).toEqual(initialCloth); expect(body).toEqual(initialBody); expect(mesh.visible).toBe(true);
    const intent = renderer as unknown as { sourceCameraAutomatic: boolean; sourceCameraUserControlled: boolean; cameraWritebackEnabled: boolean; frozenDisplay: {positions: Float32Array} };
    expect(intent.sourceCameraAutomatic).toBe(true); expect(intent.sourceCameraUserControlled).toBe(false); expect(intent.cameraWritebackEnabled).toBe(false);
    expect(intent.frozenDisplay.positions).toEqual(initialCloth);
    const camera = new PerspectiveCamera(current().fov, 390 / 671, .01, 100);
    camera.position.fromArray(current().position); camera.lookAt(new Vector3(...current().target)); camera.updateMatrixWorld();
    for (let n = 0; n < cloth.length; n += 4) {
      const p = new Vector3(cloth[n], cloth[n+1], cloth[n+2]).project(camera);
      expect(Math.abs(p.x)).toBeLessThan(1); expect(Math.abs(p.y)).toBeLessThan(1);
    }
  });

  it('zooms actual published cloth using the current orbit and FOV, keeping body and geometry untouched', () => {
    const { renderer, pattern, current } = rig();
    const cloth = published(), before = cloth.slice();
    const body = new Float32Array([-.685, 0, -.16, .685, 1.76, .13]);
    const root = { visible: true };
    const draft = new Float32Array([100, 100, 100, 1, -100, -100, -100, 1]);
    Object.assign(renderer, { avatar: { vertexPositions: body, root }, lastClothPositions: cloth,
      prepared: { collisionSafety: true, simData: { positions: draft } },
      sim: { positions: new Float32Array([200, 200, 200, 1]), sourceAssemblyComplete: false } });
    renderer.applyCameraSettings(pattern);
    renderer.setCameraState([2, 1.8, 3], [0, .8, 0], 37);
    const direction = new Vector3(...current().position).sub(new Vector3(...current().target)).normalize();
    const previousDistance = new Vector3(...current().position).distanceTo(new Vector3(...current().target));
    expect(renderer.zoomToGarment()).toBe(true);
    const next = current();
    expect(next.fov).toBe(37);
    const fittedDirection = new Vector3(...next.position).sub(new Vector3(...next.target)).normalize();
    expect(fittedDirection.distanceTo(direction)).toBeLessThan(1e-12);
    expect(new Vector3(...next.position).distanceTo(new Vector3(...next.target))).toBeLessThan(previousDistance);
    const camera = new PerspectiveCamera(next.fov, 390 / 671, .01, 100);
    camera.position.fromArray(next.position); camera.lookAt(new Vector3(...next.target)); camera.updateMatrixWorld();
    for (let i = 0; i < cloth.length; i += 4) {
      const projected = new Vector3(cloth[i], cloth[i + 1], cloth[i + 2]).project(camera);
      expect(Math.abs(projected.x)).toBeLessThan(1); expect(Math.abs(projected.y)).toBeLessThan(1);
    }
    expect(cloth).toEqual(before); expect(root.visible).toBe(true);
    expect(body).toEqual(new Float32Array([-.685, 0, -.16, .685, 1.76, .13]));
    expect(draft).toEqual(new Float32Array([100, 100, 100, 1, -100, -100, -100, 1]));
    expect((renderer as unknown as { sim: { sourceAssemblyComplete: boolean } }).sim.sourceAssemblyComplete).toBe(false);
  });

  it('persists explicit garment focus and preserves it through settings/overlay changes until whole-body Reset', () => {
    const { renderer, pattern, current, setState } = rig();
    Object.assign(renderer, { lastClothPositions: published() });
    renderer.applyCameraSettings(pattern);
    expect(renderer.zoomToGarment()).toBe(true);
    const focused = structuredClone(current()); setState.mockClear();
    renderer.applyCameraSettings(pattern); renderer.refreshSourceCameraFit();
    expect(current()).toEqual(focused); expect(setState).not.toHaveBeenCalled();
    expect((renderer as unknown as { queueCameraSave: ReturnType<typeof vi.fn> }).queueCameraSave).toHaveBeenCalled();
    renderer.setCameraView('reset');
    expect(current()).not.toEqual(focused);
    const camera = new PerspectiveCamera(current().fov, 390 / 671, .01, 100);
    camera.position.fromArray(current().position); camera.lookAt(new Vector3(...current().target)); camera.updateMatrixWorld();
    for (const point of [[-.685, 0, -.16], [.685, 1.76, .13]]) {
      const projected = new Vector3(...point).project(camera);
      expect(Math.abs(projected.x)).toBeLessThan(1); expect(Math.abs(projected.y)).toBeLessThan(1);
    }
  });

  it('measures safe controls after a drawer closes without changing the camera while the drawer obscures it', () => {
    const { renderer, current } = rig();
    Object.assign(renderer, { lastClothPositions: published() });
    let drawer = true;
    const measured = { getClientRects: () => [{}], getBoundingClientRect: () => drawer
      ? { left: 30, right: 382, top: 8, bottom: 603, width: 352, height: 595 }
      : { left: 75, right: 382, top: 611, bottom: 663, width: 307, height: 52 } };
    Object.assign(renderer, { container: { getBoundingClientRect: () => ({ width: 390, height: 671, left: 0, top: 0 }),
      closest: () => ({ querySelectorAll: () => [measured] }) } });
    const before = structuredClone(current());
    expect(renderer.zoomToGarment()).toBe(false); expect(current()).toEqual(before);
    drawer = false; expect(renderer.zoomToGarment()).toBe(true);
    const next = current(), camera = new PerspectiveCamera(next.fov, 390 / 671, .01, 100);
    camera.position.fromArray(next.position); camera.lookAt(new Vector3(...next.target)); camera.updateMatrixWorld();
    for (const point of [[-.3, .7, .12], [.3, 1.05, -.1]]) {
      const projected = new Vector3(...point).project(camera);
      expect((1 - projected.y) * 671 / 2).toBeLessThan(603);
    }
  });

  it.each([null, new Float32Array(), new Float32Array([NaN, 1, 0, 1]), new Float32Array([0, 1, 0])])('refuses absent, malformed or nonfinite published cloth without substituting prepared/candidate coordinates', values => {
      const { renderer, current } = rig();
      Object.assign(renderer, { lastClothPositions: values });
      const before = structuredClone(current());
      expect(renderer.zoomToGarment()).toBe(false); expect(current()).toEqual(before);
      expect((renderer as unknown as { queueCameraSave: ReturnType<typeof vi.fn> }).queueCameraSave).not.toHaveBeenCalled();
    });

  it('leaves native source-inactive camera behavior unchanged', () => {
    const { renderer, current } = rig(false);
    Object.assign(renderer, { lastClothPositions: published() });
    const before = structuredClone(current());
    expect(renderer.zoomToGarment()).toBe(false); expect(current()).toEqual(before);
  });
});

type PersistenceInternals = {
  beginUserCameraChange(): void;
  persistUserCameraChange(): void;
  queueCameraSave(): void;
  cameraSaveTimer?: ReturnType<typeof setTimeout>;
};

describe('actual camera changes after pointer-up remain persistent', () => {
  it.each([false, true])('persists the last real pose below the normal OrbitControls event epsilon, source=%s', source => {
    vi.useFakeTimers();
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { renderer, pattern } = rig(source);
    delete (renderer as unknown as { queueCameraSave?: unknown }).queueCameraSave;
    delete pattern.settings3d.sourceCameraFraming;
    const cameraRig = new CameraRig();
    Object.assign(renderer, { viewport: { camera: cameraRig }, camera: cameraRig.camera,
      controls: cameraRig.controls });
    renderer.applyCameraSettings(pattern);
    const internal = renderer as unknown as PersistenceInternals;
    cameraRig.controls.addEventListener('start', () => internal.beginUserCameraChange());
    cameraRig.controls.addEventListener('change', () => internal.persistUserCameraChange());
    cameraRig.controls.addEventListener('end', () => internal.queueCameraSave());
    renderer.onCameraChanged = (position, target, fov) => {
      pattern.settings3d.cameraPosition = position; pattern.settings3d.controlsTarget = target;
      pattern.settings3d.cameraFov = fov; renderer.applyCameraSettings(pattern);
    };
    cameraRig.controls.dispatchEvent({ type: 'start' });
    (cameraRig.controls as unknown as { _rotateLeft(angle: number): void })._rotateLeft(.4);
    cameraRig.controls.update(); cameraRig.controls.dispatchEvent({ type: 'end' });
    let moving = true;
    for (let frame = 1; frame < 200 && moving; frame++) {
      now = frame * (1_000 / 60); moving = cameraRig[cameraRigInternal].update();
      vi.advanceTimersByTime(1_000 / 60);
    }
    expect(moving).toBe(false); vi.advanceTimersByTime(650);
    expect(cameraRig.camera.position.distanceTo(new Vector3(...pattern.settings3d.cameraPosition))).toBeLessThan(1e-12);
    now += 4_000; expect(cameraRig[cameraRigInternal].update()).toBe(false);
    expect(cameraRig.camera.position.distanceTo(new Vector3(...pattern.settings3d.cameraPosition))).toBeLessThan(1e-12);
    cameraRig.dispose();
  });

  it.each([false, true])('persists a slow rendered orbit through the real settings echo, source=%s', source => {
    vi.useFakeTimers();
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { renderer, pattern } = rig(source);
    delete (renderer as unknown as { queueCameraSave?: unknown }).queueCameraSave;
    delete pattern.settings3d.sourceCameraFraming;
    const cameraRig = new CameraRig();
    Object.assign(renderer, { viewport: { camera: cameraRig }, camera: cameraRig.camera,
      controls: cameraRig.controls });
    renderer.applyCameraSettings(pattern);
    const internal = renderer as unknown as PersistenceInternals;
    cameraRig.controls.addEventListener('start', () => internal.beginUserCameraChange());
    cameraRig.controls.addEventListener('change', () => internal.persistUserCameraChange());
    cameraRig.controls.addEventListener('end', () => internal.queueCameraSave());
    const saved = vi.fn((position: [number, number, number], target: [number, number, number], fov: number) => {
      pattern.settings3d.cameraPosition = position; pattern.settings3d.controlsTarget = target;
      pattern.settings3d.cameraFov = fov; renderer.applyCameraSettings(pattern);
    });
    renderer.onCameraChanged = saved;
    cameraRig.controls.dispatchEvent({ type: 'start' });
    (cameraRig.controls as unknown as { _rotateLeft(angle: number): void })._rotateLeft(.4);
    cameraRig.controls.update(); cameraRig.controls.dispatchEvent({ type: 'end' });
    vi.advanceTimersByTime(650); expect(saved).toHaveBeenCalledOnce();
    // A settings echo must not cancel the remaining actual orbit impulse.
    const early = cameraRig.camera.position.clone();
    now = 4_000; cameraRig[cameraRigInternal].update();
    expect(cameraRig.camera.position.distanceTo(early)).toBeGreaterThan(.01);
    vi.advanceTimersByTime(650);
    expect(saved).toHaveBeenCalledTimes(2);
    now = 8_000; expect(cameraRig[cameraRigInternal].update()).toBe(false);
    expect(cameraRig.camera.position.distanceTo(new Vector3(...pattern.settings3d.cameraPosition))).toBeLessThan(1e-7);
    expect(pattern.settings3d.sourceCameraFraming).toBeUndefined();
    // An externally edited checkpoint remains authoritative despite a previous writeback.
    pattern.settings3d.cameraPosition = [2, 2, 2]; renderer.applyCameraSettings(pattern);
    expect(cameraRig.camera.position.distanceTo(new Vector3(2, 2, 2))).toBeLessThan(1e-12);
    cameraRig.dispose();
  });

  function persistenceRig(source: boolean) {
    const r = rig(source);
    // Use the actual renderer debounce and actual OrbitControls camera math, without a GPU.
    delete (r.renderer as unknown as { queueCameraSave?: unknown }).queueCameraSave;
    const internal = r.renderer as unknown as PersistenceInternals;
    const camera = (r.renderer as unknown as { camera: PerspectiveCamera }).camera;
    const root = new EventTarget();
    const element = Object.assign(new EventTarget(), { getRootNode: () => root,
      style: { touchAction: '' }, clientWidth: 390, clientHeight: 671 }) as unknown as HTMLElement;
    const controls = new OrbitControls(camera, element);
    controls.target.fromArray(r.pattern.settings3d.controlsTarget);
    controls.enableDamping = true; controls.dampingFactor = .1;
    Object.assign(r.renderer, { controls });
    controls.addEventListener('start', () => internal.beginUserCameraChange());
    controls.addEventListener('change', () => internal.persistUserCameraChange());
    controls.addEventListener('end', () => internal.queueCameraSave());
    const saved = vi.fn(); r.renderer.onCameraChanged = saved;
    return { ...r, internal, camera, controls, saved };
  }

  it.each([false, true])('captures genuine damping changes after an earlier end-only save, source=%s', source => {
    vi.useFakeTimers();
    const { controls, camera, saved } = persistenceRig(source);
    controls.dispatchEvent({ type: 'start' });
    // This is OrbitControls' own pointer-rotation impulse, not a fabricated camera snapshot.
    (controls as unknown as { _rotateLeft(angle: number): void })._rotateLeft(.4);
    controls.update(); controls.dispatchEvent({ type: 'end' });
    vi.advanceTimersByTime(650);
    expect(saved).toHaveBeenCalledOnce();
    const first = saved.mock.calls[0][0];
    for (let i = 0; i < 12; i++) { controls.update(); vi.advanceTimersByTime(100); }
    expect(camera.position.distanceTo(new Vector3(...first))).toBeGreaterThan(.01);
    vi.advanceTimersByTime(600);
    expect(saved).toHaveBeenCalledTimes(2);
    expect(saved.mock.calls[1][0]).toEqual(camera.position.toArray());
    expect(saved.mock.calls[1][1]).toEqual(controls.target.toArray());
    controls.dispose();
  });

  it.each([false, true])('does not treat an initial programmatic camera as user input, source=%s', source => {
    vi.useFakeTimers();
    const { renderer, pattern, controls, saved } = persistenceRig(source);
    renderer.applyCameraSettings(pattern);
    controls.update(); vi.advanceTimersByTime(800);
    expect(saved).not.toHaveBeenCalled();
    expect(pattern.settings3d.sourceCameraFraming).toBe('viewport');
    controls.dispose();
  });

  it('cancels a pending user write when an explicit new document begins', () => {
    vi.useFakeTimers();
    const { renderer, controls, saved } = persistenceRig(true);
    controls.dispatchEvent({ type: 'start' }); controls.dispatchEvent({ type: 'end' });
    renderer.beginCameraDocument(); controls.update(); vi.advanceTimersByTime(800);
    expect(saved).not.toHaveBeenCalled(); controls.dispose();
  });

  it('persists the actual final preset view after animation changes, without premature callbacks', async () => {
    vi.useFakeTimers();
    const { renderer, camera, controls, saved } = persistenceRig(false);
    delete (renderer as unknown as { flyCamera?: unknown }).flyCamera;
    const release = vi.fn();
    Object.assign((renderer as unknown as { viewport: object }).viewport, { acquireRenderLease: () => release });
    Object.assign((renderer as unknown as { viewport: { camera: object } }).viewport.camera, {
      flyTo: (position: Vector3, target: Vector3, duration: number) => new Promise<void>(resolve => {
        setTimeout(() => { camera.position.copy(position); controls.target.copy(target); controls.update(); resolve(); }, duration);
      })
    });
    renderer.setCameraView('front');
    await vi.advanceTimersByTimeAsync(450);
    expect(release).toHaveBeenCalledOnce(); expect(saved).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(saved).toHaveBeenCalledOnce(); expect(saved.mock.calls[0][0]).toEqual(camera.position.toArray());
    expect(saved.mock.calls[0][1]).toEqual(controls.target.toArray()); controls.dispose();
  });
});
