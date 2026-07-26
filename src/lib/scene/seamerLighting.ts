// Seamer keeps its analyzed key-light semantics and themed stage app-side while LightingRig owns
// direct-light lifecycles, HDRI loading, PMREM conversion, URL caching, and environment disposal.

import * as THREE from 'three';
import {
  ResourceScope,
  type DirectionalLightSpec,
  type LightingRig
} from '@atelier/viewport';
import { isDarkTheme, onThemeChange } from '$lib/utils/theme';

const HDRI: Readonly<Record<string, string>> = {
  studio1: '/3d/hdri/photo_studio_london_hall_1k.hdr',
  studio2: '/3d/hdri/studio_small_08_1k.hdr',
  sunset: '/3d/hdri/cedar_bridge_sunset_1_1k.hdr'
};

const ENV_RIGS: Readonly<Record<string, readonly DirectionalLightSpec[]>> = {
  studio1: [
    { position: [2, 3, 2], color: 0xffffff, intensity: 2, castShadow: true },
    { position: [-2.5, 2, -1], color: 0xe8ecf5, intensity: 0.8 },
    { position: [0, 2.5, -3], color: 0xffffff, intensity: 1 }
  ],
  studio2: [
    { position: [3, 4, 1], color: 0xfff4e0, intensity: 1.8, castShadow: true },
    { position: [-3, 2, 2], color: 0xdfe8ff, intensity: 0.7 },
    { position: [0, 3, -3], color: 0xffffff, intensity: 0.9 }
  ],
  sunset: [
    { position: [-4, 1.5, 3], color: 0xffb070, intensity: 2.2, castShadow: true },
    { position: [3, 2, -2], color: 0x7088b8, intensity: 0.6 },
    { position: [0, 2, -4], color: 0xffd0a0, intensity: 0.8 }
  ]
};

const FLAT_RIG: readonly DirectionalLightSpec[] = [
  { position: [5, 15, 10], color: 0xffffff, intensity: 2.35, castShadow: true },
  { position: [-5, 10, -5], color: 0xfff3a6, intensity: 1.05 },
  { position: [0, 10, -10], color: 0xffffff, intensity: 0.85 }
];

export class SeamerLighting {
  private readonly resources = new ResourceScope();
  private readonly ambient: THREE.AmbientLight;
  private readonly floor: THREE.Mesh;
  private readonly grid: THREE.GridHelper;
  private lightingMode = 'flat';
  private themeExposure = 1;
  private shadowMapSize = 2048;
  private activeSpecs: readonly DirectionalLightSpec[] = FLAT_RIG;
  private readonly analyzedSpecs = new Map<string, readonly DirectionalLightSpec[]>();
  private disposed = false;
  private readonly themeUnsub: () => void;

  constructor(
    private readonly rig: LightingRig,
    private readonly scene: THREE.Scene,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly invalidate: () => void
  ) {
    this.ambient = new THREE.AmbientLight(0xffffff, 1.25);
    this.scene.add(this.ambient);

    const floorMaterial = this.resources.track(new THREE.MeshStandardMaterial({
      color: '#c7ccd4',
      roughness: 0.9,
      metalness: 0,
      depthWrite: false
    }));
    this.floor = new THREE.Mesh(
      this.resources.track(new THREE.PlaneGeometry(100, 100)),
      floorMaterial
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    // Grid opacity is driven by the theme palette in applySceneTheme.
    this.grid = new THREE.GridHelper(20, 20, 0x151515, 0x151515);
    this.resources.track(this.grid.geometry);
    const gridMaterials = Array.isArray(this.grid.material)
      ? this.grid.material
      : [this.grid.material];
    for (const material of gridMaterials) this.resources.track(material);
    this.grid.position.y = 0.002;
    this.scene.add(this.grid);

    this.applySceneTheme(isDarkTheme());
    this.themeUnsub = onThemeChange(() => this.applySceneTheme(isDarkTheme()));
    this.applyFlatRig();
  }

  setMode(requestedMode: string, isMobile: boolean): string {
    const mode = isMobile && HDRI[requestedMode] ? 'flat' : requestedMode;
    this.lightingMode = mode;
    const url = HDRI[mode];
    this.grid.visible = !url;
    if (!url) {
      // Starting a zero-intensity room request cancels any HDRI still loading. LightingRig has no
      // clearEnvironment() call, so the scene escape hatch then restores direct-light-only mode.
      this.scene.environment = null;
      void this.rig.setEnvironment('room', 0).then(() => {
        if (this.disposed || this.lightingMode !== mode) return;
        this.scene.environment = null;
        this.invalidate();
      });
      this.renderer.toneMappingExposure = this.themeExposure;
      this.applyFlatRig();
      this.invalidate();
      return mode;
    }

    this.renderer.toneMappingExposure = 1;
    this.ambient.intensity = 0;
    this.activeSpecs = this.withShadowSize(
      this.analyzedSpecs.get(url) ?? ENV_RIGS[mode] ?? []
    );
    this.rig.setLights(this.activeSpecs);
    void this.rig.setEnvironment({
      hdri: url,
      analyzeLights: (texture, analyzedUrl) => {
        const image = texture.image as unknown as {
          data?: Float32Array;
          width?: number;
          height?: number;
        };
        if (
          !(image.data instanceof Float32Array)
          || typeof image.width !== 'number'
          || typeof image.height !== 'number'
        ) {
          return this.activeSpecs;
        }
        const analyzed = analyzeHdriLights(
          { data: image.data, width: image.width, height: image.height },
          3
        );
        this.analyzedSpecs.set(analyzedUrl, analyzed);
        this.activeSpecs = this.withShadowSize(
          analyzed
        );
        return this.activeSpecs;
      }
    }).then(() => {
      if (this.disposed || this.lightingMode !== mode) return;
      // LightingRig caches the analyzer result before app shadow sizing can change. Reapply the
      // app-owned specs so revisiting a cached HDRI keeps the current shadow-map preference.
      this.activeSpecs = this.withShadowSize(
        this.analyzedSpecs.get(url) ?? ENV_RIGS[mode] ?? []
      );
      this.rig.setLights(this.activeSpecs);
      this.invalidate();
    });
    this.invalidate();
    return mode;
  }

  setShadowMapSize(size: number): void {
    const next = Math.max(1, Math.round(size));
    if (next === this.shadowMapSize) return;
    this.shadowMapSize = next;
    this.activeSpecs = this.withShadowSize(this.activeSpecs);
    this.rig.setLights(this.activeSpecs);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.themeUnsub();
    this.scene.remove(this.ambient);
    this.ambient.dispose();
    this.scene.remove(this.floor);
    this.scene.remove(this.grid);
    this.resources.release();
  }

  private applyFlatRig(): void {
    this.ambient.intensity = 1.25;
    this.activeSpecs = this.withShadowSize(FLAT_RIG);
    this.rig.setLights(this.activeSpecs);
  }

  private withShadowSize(
    specs: readonly DirectionalLightSpec[]
  ): readonly DirectionalLightSpec[] {
    return specs.map((spec) => ({
      ...spec,
      position: [spec.position[0], spec.position[1], spec.position[2]],
      ...(spec.castShadow ? { shadowMapSize: this.shadowMapSize } : {})
    }));
  }

  private applySceneTheme(dark: boolean): void {
    const background = dark ? '#1a202b' : '#d5dae4';
    const floor = dark ? '#27313f' : '#c7ccd4';
    const grid = dark ? '#5a6475' : '#151515';
    const gridOpacity = dark ? 0.28 : 0.1;
    this.rig.setBackground(background);
    // The source uses linear fog to dissolve the stage gradually.
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.color.set(background);
      this.scene.fog.near = 10;
      this.scene.fog.far = 45;
    } else {
      this.scene.fog = new THREE.Fog(background, 10, 45);
    }
    this.themeExposure = dark ? 1.05 : 1;
    if (this.lightingMode === 'flat') {
      this.renderer.toneMappingExposure = this.themeExposure;
    }
    (this.floor.material as THREE.MeshStandardMaterial).color.set(floor);
    const materials = Array.isArray(this.grid.material)
      ? this.grid.material
      : [this.grid.material];
    for (const material of materials) {
      material.color.set(grid);
      material.opacity = gridOpacity;
      material.transparent = true;
    }
    this.invalidate();
  }
}

/** Extract the brightest directional regions of an equirect HDR. */
function analyzeHdriLights(
  image: { data: Float32Array; width: number; height: number },
  count: number
): DirectionalLightSpec[] {
  const gridWidth = 32;
  const gridHeight = 16;
  const stride = image.data.length / (image.width * image.height) >= 4 ? 4 : 3;
  const cells: Array<{ lum: number; r: number; g: number; b: number }> = [];
  for (let cy = 0; cy < gridHeight; cy++) {
    for (let cx = 0; cx < gridWidth; cx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let samples = 0;
      const x0 = Math.floor((cx * image.width) / gridWidth);
      const x1 = Math.floor(((cx + 1) * image.width) / gridWidth);
      const y0 = Math.floor((cy * image.height) / gridHeight);
      const y1 = Math.floor(((cy + 1) * image.height) / gridHeight);
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const offset = (y * image.width + x) * stride;
          r += image.data[offset];
          g += image.data[offset + 1];
          b += image.data[offset + 2];
          samples++;
        }
      }
      if (samples > 0) {
        r /= samples;
        g /= samples;
        b /= samples;
      }
      cells.push({ lum: 0.2126 * r + 0.7152 * g + 0.0722 * b, r, g, b });
    }
  }

  const picked: number[] = [];
  const result: DirectionalLightSpec[] = [];
  let maxLum = 0;
  for (const cell of cells) maxLum = Math.max(maxLum, cell.lum);
  if (maxLum <= 0) return result;
  for (let rank = 0; rank < count; rank++) {
    let best = -1;
    let bestLum = -1;
    for (let index = 0; index < cells.length; index++) {
      if (cells[index].lum <= bestLum) continue;
      const cx = index % gridWidth;
      const cy = Math.floor(index / gridWidth);
      const near = picked.some((pickedIndex) => {
        const px = pickedIndex % gridWidth;
        const py = Math.floor(pickedIndex / gridWidth);
        const dx = Math.min(Math.abs(px - cx), gridWidth - Math.abs(px - cx));
        return dx <= 3 && Math.abs(py - cy) <= 2;
      });
      if (near) continue;
      best = index;
      bestLum = cells[index].lum;
    }
    if (best < 0) break;
    picked.push(best);
    const cell = cells[best];
    const cx = (best % gridWidth + 0.5) / gridWidth;
    const cy = (Math.floor(best / gridWidth) + 0.5) / gridHeight;
    const phi = cy * Math.PI;
    const theta = cx * 2 * Math.PI - Math.PI;
    const maximum = Math.max(cell.r, cell.g, cell.b) || 1;
    result.push({
      position: [
        Math.sin(phi) * Math.sin(theta) * 5,
        Math.max(0.5, Math.cos(phi) * 5),
        Math.sin(phi) * Math.cos(theta) * 5
      ],
      color: [cell.r / maximum, cell.g / maximum, cell.b / maximum],
      intensity: rank === 0 ? 2 : 0.5 + cell.lum / maxLum,
      castShadow: rank === 0
    });
  }
  return result;
}
