// PBR materials for the garment pieces and the body avatar, following the original renderer.

import * as THREE from 'three';
import type { Material } from '@seamer/pattern-model';
import { createSurfaceMaterial } from '@atelier/viewport';

export interface GarmentMatOpts {
  /** render only this face (default DoubleSide) — used to split front/back when a back texture is set */
  side?: THREE.Side;
  /** use the material's backTexture slot instead of frontTexture */
  back?: boolean;
  /** per-piece "Name / face side" badge baked into the lit surface (deforms + shades with the cloth) */
  labelTexture?: THREE.Texture;
  /** "Name / back side" badge shown on the reverse face (read-correct from behind); falls back to labelTexture */
  labelTextureBack?: THREE.Texture;
  /** badge opacity (0 hides it); toggled live via mat.userData.labelUniforms.uLabelOpacity */
  labelOpacity?: number;
  /** mirror instances have X-negated geometry (reversed winding), which inverts gl_FrontFacing — set
   *  true so the "face side" badge still lands on the outward surface. */
  labelFlipFace?: boolean;
  /** pre-baked per-piece map (print anchored at origin + rotated by grain + internal lines). When
   *  set it replaces the plain tiled slot image; its offset/repeat already map mm UVs onto it. */
  pieceMap?: THREE.Texture;
  /** visual shell offset along the vertex normal (meters, signed): visualizationThickness/2 pushes
   *  the front face out and the back face in so the fabric reads with depth. */
  shellOffset?: number;
}

/** True when this material wants its back face rendered with a different texture. */
export function hasSeparateBack(material: Material | undefined): boolean {
  return !!(material?.useSeparateBackSide && material.backTexture);
}

/** Garment material — MeshPhysicalMaterial, double-sided cloth, color or texture from the slot. */
export function createGarmentMaterial(material: Material | undefined, flat: boolean, opts: GarmentMatOpts = {}): THREE.MeshPhysicalMaterial {
  const dRough = flat ? 0 : 0.08;
  const pSpec = flat ? 1 : 0.65;
  const slot = opts.back ? (material?.backTexture ?? material?.frontTexture) : material?.frontTexture;
  const color = slot?.color ?? '#6b7a8f';
  const mat = createSurfaceMaterial({
    color,
    roughness: Math.min(1, (material?.roughness ?? 0.8) + dRough),
    metalness: material?.metalness ?? 0.1,
    specularIntensity: (material?.specularIntensity ?? 0.25) * pSpec,
    opacity: material?.opacity ?? 1,
    alphaCutoff: (material?.alphaCutoff ?? 0) > 0 ? material!.alphaCutoff : 0,
    doubleSided: (opts.side ?? THREE.DoubleSide) === THREE.DoubleSide
  });
  mat.side = opts.side ?? THREE.DoubleSide;
  mat.shadowSide = THREE.DoubleSide;
  // Note: the source garment material does not set sheen/clearcoat/ior; keep MeshPhysicalMaterial defaults.

  // Texture maps. UVs are in mm, so repeat = 1/scale tiles every `scale` mm. Best-effort loads
  // (remote media may be unavailable offline / CORS-blocked) — failures keep the solid color/no-map.
  if (opts.pieceMap) {
    // baked per-piece map: grain-aligned print + internal lines, mm→bbox transform already on it
    mat.map = opts.pieceMap;
    mat.color.set('#ffffff');
  }
  if (slot) {
    const scale = slot.scale && slot.scale > 0 ? slot.scale : 100;
    const loader = new THREE.TextureLoader();
    const tile = (tex: THREE.Texture, srgb: boolean) => {
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(1 / scale, 1 / scale);
    };
    if (slot.url && !opts.pieceMap) {
      loader.load(slot.url, (tex) => {
        tile(tex, true);
        mat.map = tex; mat.color.set('#ffffff'); mat.needsUpdate = true;
      }, undefined, () => {});
    }
    // Normal map — gives the fabric weave depth under the new image-based lighting (linear, not sRGB).
    if (slot.normalUrl) {
      loader.load(slot.normalUrl, (tex) => {
        tile(tex, false);
        const ns = material?.normalScale ?? slot.normalMapScale ?? 1;
        mat.normalMap = tex; mat.normalScale = new THREE.Vector2(ns, ns); mat.needsUpdate = true;
      }, undefined, () => {});
    }
    // Opacity / cutwork map — alphaMap drives per-texel transparency (lace, eyelets, sheers).
    if (slot.opacityUrl) {
      loader.load(slot.opacityUrl, (tex) => {
        tile(tex, false);
        mat.alphaMap = tex; mat.transparent = true; mat.needsUpdate = true;
      }, undefined, () => {});
    }
  }

  // Piece-name badge: composited into the lit diffuse colour using a per-piece `uvLabel` attribute
  // (0..1 across the piece's pattern bbox). Because it lives in the surface shading — not a floating
  // plane — it deforms with the cloth, shades under the scene lights, and tiles under the weave normal.
  // The optional shell offset (visual fabric thickness) shares the same compile hook.
  const hasShell = opts.shellOffset !== undefined;
  const shellU = { value: opts.shellOffset ?? 0 };
  if (hasShell) mat.userData.shellUniform = shellU;
  if (opts.labelTexture || hasShell) {
    const uniforms = {
      uLabelMap: { value: opts.labelTexture ?? null },
      uLabelMapBack: { value: opts.labelTextureBack ?? opts.labelTexture ?? null },
      uLabelOpacity: { value: opts.labelOpacity ?? 1 },
      uLabelFlip: { value: opts.labelFlipFace ? 1 : 0 }
    };
    if (opts.labelTexture) mat.userData.labelUniforms = uniforms;
    // Distinguish injected programs from plain garment programs with identical parameters,
    // so three's program cache doesn't hand a label-less material the label shader (or vice versa).
    mat.customProgramCacheKey = () => `garment${opts.labelTexture ? '-label' : ''}${hasShell ? '-shell' : ''}`;
    mat.onBeforeCompile = (shader) => {
      if (hasShell) {
        shader.uniforms.uShellOffset = shellU;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uShellOffset;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n\ttransformed += objectNormal * uShellOffset;');
      }
      if (!opts.labelTexture) return;
      shader.uniforms.uLabelMap = uniforms.uLabelMap;
      shader.uniforms.uLabelMapBack = uniforms.uLabelMapBack;
      shader.uniforms.uLabelOpacity = uniforms.uLabelOpacity;
      shader.uniforms.uLabelFlip = uniforms.uLabelFlip;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 uvLabel;\nvarying vec2 vUvLabel;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvUvLabel = uvLabel;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uLabelMap;\nuniform sampler2D uLabelMapBack;\nuniform float uLabelOpacity;\nuniform float uLabelFlip;\nvarying vec2 vUvLabel;')
        .replace('#include <map_fragment>', `#include <map_fragment>
        {
          // Cloth fronts wind inward, so the outward (fabric face) surface is normally back-facing —
          // show the "face side" badge there, the read-correct "back side" badge on the reverse.
          // Mirror instances (X-negated, reversed winding) invert gl_FrontFacing, so uLabelFlip swaps it.
          bool outward = (uLabelFlip > 0.5) ? gl_FrontFacing : !gl_FrontFacing;
          vec4 lbl = outward ? texture2D(uLabelMap, vUvLabel) : texture2D(uLabelMapBack, vUvLabel);
          vec3 lblLin = pow(lbl.rgb, vec3(2.2)); // sRGB canvas -> linear, matched to the lit pipeline
          diffuseColor.rgb = mix(diffuseColor.rgb, lblLin, lbl.a * uLabelOpacity);
        }`);
    };
  }
  return mat;
}

/** Dispose a garment material and the textures it owns (map/normal/alpha + baked label badge). */
export function disposeGarmentMaterial(material: THREE.Material): void {
  const m = material as THREE.MeshPhysicalMaterial;
  m.map?.dispose();
  m.normalMap?.dispose();
  m.alphaMap?.dispose();
  const u = m.userData?.labelUniforms as { uLabelMap: { value: THREE.Texture | null }; uLabelMapBack: { value: THREE.Texture | null } } | undefined;
  u?.uLabelMap.value?.dispose();
  if (u && u.uLabelMapBack.value !== u.uLabelMap.value) u.uLabelMapBack.value?.dispose();
  m.dispose();
}

/** Skin-like avatar material (the original's updateBodyMaterial: sheen tinted from the body color,
 *  a whisper of transmission + IOR for the waxy sub-surface read). */
export function createAvatarMaterial(bodyColor: string): THREE.MeshPhysicalMaterial {
  const base = new THREE.Color(bodyColor || '#b58a6a');
  return new THREE.MeshPhysicalMaterial({
    color: base,
    roughness: 0.55,
    metalness: 0,
    clearcoat: 0.25,
    clearcoatRoughness: 0.45,
    sheen: 0.15,
    sheenRoughness: 0.6,
    sheenColor: base.clone().offsetHSL(0, -0.04, 0.02),
    transmission: 0.02,
    thickness: 0.4,
    ior: 1.38,
    reflectivity: 0.2,
    envMapIntensity: 0.6,
    specularIntensity: 0.35,
    specularColor: new THREE.Color('#f5ede2'),
    side: THREE.DoubleSide
  });
}
