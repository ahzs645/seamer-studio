// Seamer's four N8AO controls are persisted document semantics. The engine owns the composer,
// Bokeh/SMAA/Output passes, sizing, and fallback; this adapter keeps the real N8AO pass app-owned.

import * as THREE from 'three';
import { N8AOPass } from 'n8ao';
import type { AoPassFactory } from '@atelier/viewport';

/** Lossless N8AO adapter for ViewportOptions.aoPassFactory. */
export const createSeamerAoPass: AoPassFactory = ({ scene, camera }) => {
  const ao = new N8AOPass(scene, camera);
  ao.setDisplayMode('Combined');
  ao.configuration.aoRadius = 0.15;
  ao.configuration.distanceFalloff = 1;
  ao.configuration.intensity = 3;
  ao.configuration.aoSamples = 16;
  // OutputPass handles final gamma correction; N8AO should not double-correct.
  ao.configuration.gammaCorrection = false;

  return {
    pass: ao,
    // N8AOPass renders scene beauty itself, so the engine must not prepend RenderPass.
    replacesRenderPass: true,
    apply(settings) {
      ao.enabled = settings.enabled;
      if (typeof settings.intensity === 'number' && Number.isFinite(settings.intensity)) {
        ao.configuration.intensity = THREE.MathUtils.clamp(settings.intensity, 0, 5);
      }
      ao.configuration.aoRadius =
        typeof settings.radius === 'number' && settings.radius > 0
          ? settings.radius
          : 0.15;
      ao.configuration.distanceFalloff =
        typeof settings.falloff === 'number' && settings.falloff > 0
          ? settings.falloff
          : 1;
    },
    setSize(width, height) {
      ao.setSize(width, height);
    },
    dispose() {
      ao.dispose();
    }
  };
};
