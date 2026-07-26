// Seamer keeps N8AO app-side because its four controls are persisted document semantics.
// This can move behind Viewport once the engine accepts an aoPassFactory/custom composer hook.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { N8AOPass } from 'n8ao';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

export interface SeamerPostSettings {
  aoEnabled?: boolean;
  aoIntensity?: number;
  aoRadius?: number;
  aoFalloff?: number;
  bokehFStop?: number;
}

interface BokehUniforms {
  aperture: THREE.IUniform<number>;
  maxblur: THREE.IUniform<number>;
  focus: THREE.IUniform<number>;
}

interface RenderOptions {
  bokehFStop: number;
  focusDistance: number;
  fov: number;
  allowBokeh: boolean;
}

/** Lossless N8AO + Bokeh + SMAA chain with the production guarded fallback. */
export class SeamerPostFX {
  private composer: EffectComposer | null = null;
  private aoPass: N8AOPass | null = null;
  private bokehPass: BokehPass | null = null;
  private enabled = true;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    width: number,
    height: number
  ) {
    this.build(width, height);
  }

  apply(settings: SeamerPostSettings): number {
    if (this.aoPass) {
      this.aoPass.enabled = settings.aoEnabled !== false;
      if (typeof settings.aoIntensity === 'number' && Number.isFinite(settings.aoIntensity)) {
        this.aoPass.configuration.intensity = THREE.MathUtils.clamp(settings.aoIntensity, 0, 5);
      }
      this.aoPass.configuration.aoRadius =
        typeof settings.aoRadius === 'number' && settings.aoRadius > 0
          ? settings.aoRadius
          : 0.15;
      this.aoPass.configuration.distanceFalloff =
        typeof settings.aoFalloff === 'number' && settings.aoFalloff > 0
          ? settings.aoFalloff
          : 1;
    }
    const fStop =
      typeof settings.bokehFStop === 'number' && settings.bokehFStop > 0
        ? settings.bokehFStop
        : 0;
    if (this.bokehPass) {
      this.bokehPass.enabled = fStop > 0;
      const uniforms = this.bokehPass.uniforms as BokehUniforms;
      uniforms.aperture.value = fStop > 0 ? Math.min(0.05, 0.025 / fStop) : 0;
      uniforms.maxblur.value = 0.01;
    }
    return fStop;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  setQuality(pixelRatio: number, samples: number, width: number, height: number): void {
    if (!this.composer) return;
    this.composer.renderTarget1.samples = samples;
    this.composer.renderTarget2.samples = samples;
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  resize(width: number, height: number): void {
    this.composer?.setSize(width, height);
  }

  render(options: RenderOptions): void {
    if (this.bokehPass) {
      this.bokehPass.enabled = options.bokehFStop > 0 && options.allowBokeh;
      if (this.bokehPass.enabled) {
        const uniforms = this.bokehPass.uniforms as BokehUniforms;
        uniforms.focus.value = options.focusDistance;
        const focal = 18 / Math.tan(THREE.MathUtils.degToRad(options.fov / 2));
        uniforms.aperture.value =
          (focal / Math.max(0.7, options.bokehFStop) / 36) * 0.012;
        uniforms.maxblur.value = 0.01;
      }
    }
    if (this.composer && this.enabled) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    try {
      this.composer?.dispose();
    } catch {
      // Some partially-created addon passes throw while cleaning up.
    }
    this.composer = null;
    this.aoPass = null;
    this.bokehPass = null;
  }

  private build(width: number, height: number): void {
    try {
      const composer = new EffectComposer(this.renderer);
      const ao = new N8AOPass(this.scene, this.camera, width, height);
      ao.setDisplayMode('Combined');
      ao.configuration.aoRadius = 0.15;
      ao.configuration.distanceFalloff = 1;
      ao.configuration.intensity = 3;
      ao.configuration.aoSamples = 16;
      // OutputPass handles final gamma correction; N8AO should not double-correct.
      ao.configuration.gammaCorrection = false;
      composer.addPass(ao);
      const bokeh = new BokehPass(this.scene, this.camera, {
        focus: 1,
        aperture: 0,
        maxblur: 0.01
      });
      bokeh.enabled = false;
      composer.addPass(bokeh);
      // r181 sizes SMAA through EffectComposer.setSize(); its constructor has no dimensions.
      composer.addPass(new SMAAPass());
      composer.addPass(new OutputPass());
      this.composer = composer;
      this.aoPass = ao;
      this.bokehPass = bokeh;
    } catch (error) {
      this.dispose();
      console.warn('Post-processing unavailable, using direct render:', error);
    }
  }
}
