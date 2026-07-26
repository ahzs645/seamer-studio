// Seamer's production lighting extends the engine contract with analyzed HDRI key lights,
// retry/backoff, and theme-specific floor/grid styling. It stays app-side until LightingRig can
// express those behaviors without a visual delta.

import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { ResourceScope } from '@atelier/viewport';
import { isDarkTheme, onThemeChange } from '$lib/utils/theme';

interface EnvLight {
  dir: [number, number, number];
  color: number | [number, number, number];
  intensity: number;
}

interface AnalyzedLight {
  dir: [number, number, number];
  color: [number, number, number];
  intensity: number;
}

const HDRI: Readonly<Record<string, string>> = {
  studio1: '/3d/hdri/photo_studio_london_hall_1k.hdr',
  studio2: '/3d/hdri/studio_small_08_1k.hdr',
  sunset: '/3d/hdri/cedar_bridge_sunset_1_1k.hdr'
};

const ENV_RIGS: Readonly<Record<string, EnvLight[]>> = {
  studio1: [
    { dir: [2, 3, 2], color: 0xffffff, intensity: 2 },
    { dir: [-2.5, 2, -1], color: 0xe8ecf5, intensity: 0.8 },
    { dir: [0, 2.5, -3], color: 0xffffff, intensity: 1 }
  ],
  studio2: [
    { dir: [3, 4, 1], color: 0xfff4e0, intensity: 1.8 },
    { dir: [-3, 2, 2], color: 0xdfe8ff, intensity: 0.7 },
    { dir: [0, 3, -3], color: 0xffffff, intensity: 0.9 }
  ],
  sunset: [
    { dir: [-4, 1.5, 3], color: 0xffb070, intensity: 2.2 },
    { dir: [3, 2, -2], color: 0x7088b8, intensity: 0.6 },
    { dir: [0, 2, -4], color: 0xffd0a0, intensity: 0.8 }
  ]
};

export class SeamerLighting {
  private readonly resources = new ResourceScope();
  private readonly lightRig: THREE.Object3D[] = [];
  private readonly lightRigBase: number[] = [];
  private readonly envCache = new Map<string, THREE.Texture>();
  private readonly hdriLightCache = new Map<string, AnalyzedLight[]>();
  private envRig: THREE.DirectionalLight[] = [];
  private pmrem: THREE.PMREMGenerator | null = null;
  private floor: THREE.Mesh;
  private grid: THREE.GridHelper;
  private lightingMode = 'flat';
  private themeExposure = 1;
  private disposed = false;
  private readonly themeUnsub: () => void;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly invalidate: () => void,
    private readonly lowEnd: () => boolean
  ) {
    this.setupLights();
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
  }

  setMode(requestedMode: string, isMobile: boolean): string {
    const mode = isMobile && HDRI[requestedMode] ? 'flat' : requestedMode;
    this.lightingMode = mode;
    const url = HDRI[mode];
    this.grid.visible = !url;
    this.invalidate();
    if (!url) {
      this.scene.environment = null;
      this.renderer.toneMappingExposure = this.themeExposure;
      this.lightRig.forEach((light, index) => {
        if (light instanceof THREE.Light) light.intensity = this.lightRigBase[index];
      });
      this.clearEnvRig();
      return mode;
    }
    this.renderer.toneMappingExposure = 1;
    for (const light of this.lightRig) {
      if (light instanceof THREE.Light) light.intensity = 0;
    }
    this.applyEnvLightRig(ENV_RIGS[mode] ?? []);
    const cached = this.envCache.get(url);
    if (cached) {
      this.scene.environment = cached;
      this.applyAnalyzedRig(url, mode);
      return mode;
    }
    this.loadHdri(url, mode, 0);
    return mode;
  }

  setShadowMapSize(size: number): void {
    const key = this.lightRig[0];
    if (key instanceof THREE.DirectionalLight && key.shadow.mapSize.width !== size) {
      key.shadow.mapSize.set(size, size);
      key.shadow.map?.dispose();
      key.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.themeUnsub();
    this.scene.environment = null;
    this.clearEnvRig();
    for (const light of this.lightRig) {
      this.scene.remove(light);
      if (light instanceof THREE.Light) light.dispose();
    }
    for (const texture of this.envCache.values()) texture.dispose();
    this.envCache.clear();
    this.pmrem?.dispose();
    this.scene.remove(this.floor);
    this.scene.remove(this.grid);
    this.resources.release();
  }

  private setupLights(): void {
    const key = new THREE.DirectionalLight(0xffffff, 2.35);
    key.position.set(5, 15, 10);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const camera = key.shadow.camera;
    camera.near = 0.1;
    camera.far = 50;
    camera.left = -10;
    camera.right = 10;
    camera.top = 10;
    camera.bottom = -10;
    key.shadow.bias = 0.0005;
    key.shadow.normalBias = 0.03;
    const fill = new THREE.DirectionalLight(0xfff3a6, 1.05);
    fill.position.set(-5, 10, -5);
    const rim = new THREE.DirectionalLight(0xffffff, 0.85);
    rim.position.set(0, 10, -10);
    const ambient = new THREE.AmbientLight(0xffffff, 1.25);
    this.lightRig.push(key, fill, rim, ambient);
    this.lightRigBase.push(...this.lightRig.map((light) =>
      light instanceof THREE.Light ? light.intensity : 0
    ));
    for (const light of this.lightRig) this.scene.add(light);
  }

  private loadHdri(url: string, mode: string, attempt: number): void {
    if (!this.pmrem) {
      this.pmrem = new THREE.PMREMGenerator(this.renderer);
      this.pmrem.compileEquirectangularShader();
    }
    new RGBELoader().setDataType(THREE.FloatType).load(url, (hdr) => {
      if (this.disposed || !this.pmrem) {
        hdr.dispose();
        return;
      }
      // Analyze BEFORE PMREM consumes the texel data.
      const image = hdr.image as unknown as {
        data: Float32Array;
        width: number;
        height: number;
      };
      if (image?.data) this.hdriLightCache.set(url, analyzeHdriLights(image, 3));
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      const environment = this.pmrem.fromEquirectangular(hdr).texture;
      hdr.dispose();
      this.envCache.set(url, environment);
      if (this.lightingMode === mode) {
        this.scene.environment = environment;
        this.applyAnalyzedRig(url, mode);
        this.invalidate();
      }
    }, undefined, () => {
      if (this.disposed || attempt >= 3) return;
      setTimeout(() => {
        if (this.lightingMode === mode) this.loadHdri(url, mode, attempt + 1);
      }, 1000 * Math.pow(1.5, attempt));
    });
  }

  private clearEnvRig(): void {
    for (const light of this.envRig) {
      this.scene.remove(light);
      light.dispose();
    }
    this.envRig = [];
  }

  private applyEnvLightRig(rig: readonly EnvLight[]): void {
    this.clearEnvRig();
    rig.forEach((spec, index) => {
      const light = new THREE.DirectionalLight(
        Array.isArray(spec.color) ? new THREE.Color(...spec.color) : spec.color,
        spec.intensity
      );
      light.position.set(...spec.dir);
      if (index === 0) {
        light.castShadow = true;
        const size = this.lowEnd() ? 512 : 2048;
        light.shadow.mapSize.set(size, size);
        const camera = light.shadow.camera;
        camera.near = 0.1;
        camera.far = 50;
        camera.left = -10;
        camera.right = 10;
        camera.top = 10;
        camera.bottom = -10;
        light.shadow.bias = 0.0005;
        light.shadow.normalBias = 0.03;
      }
      this.scene.add(light);
      this.envRig.push(light);
    });
    this.invalidate();
  }

  private applyAnalyzedRig(url: string, mode: string): void {
    const analyzed = this.hdriLightCache.get(url);
    if (!analyzed?.length || this.lightingMode !== mode) return;
    this.applyEnvLightRig(analyzed);
  }

  private applySceneTheme(dark: boolean): void {
    const background = dark ? '#1a202b' : '#d5dae4';
    const floor = dark ? '#27313f' : '#c7ccd4';
    const grid = dark ? '#5a6475' : '#151515';
    const gridOpacity = dark ? 0.28 : 0.1;
    if (this.scene.background instanceof THREE.Color) this.scene.background.set(background);
    else this.scene.background = new THREE.Color(background);
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
): AnalyzedLight[] {
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
  const result: AnalyzedLight[] = [];
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
      dir: [
        Math.sin(phi) * Math.sin(theta) * 5,
        Math.max(0.5, Math.cos(phi) * 5),
        Math.sin(phi) * Math.cos(theta) * 5
      ],
      color: [cell.r / maximum, cell.g / maximum, cell.b / maximum],
      intensity: rank === 0 ? 2 : 0.5 + cell.lum / maxLum
    });
  }
  return result;
}
