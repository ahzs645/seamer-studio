// Fabric physics + appearance presets — the offline equivalent of the original application's
// "Material preset" dropdown. Selecting a preset applies these values; editing any slider afterwards
// marks the material "Custom" again. UI-scale stretch/bend are 0..100; PBR values 0..1.

export interface MaterialPreset {
  name: string;
  stretchWarpValue: number;
  stretchWeftValue: number;
  bendValue: number;
  thickness: number; // mm
  weight: number; // g/m²
  roughness: number;
  metalness: number;
  specularIntensity: number;
}

export const MATERIAL_PRESETS: MaterialPreset[] = [
  { name: 'Cotton poplin', stretchWarpValue: 8, stretchWeftValue: 10, bendValue: 22, thickness: 0.4, weight: 120, roughness: 0.85, metalness: 0, specularIntensity: 0.3 },
  { name: 'Denim', stretchWarpValue: 5, stretchWeftValue: 6, bendValue: 55, thickness: 0.9, weight: 340, roughness: 0.9, metalness: 0, specularIntensity: 0.2 },
  { name: 'Jersey knit', stretchWarpValue: 55, stretchWeftValue: 70, bendValue: 8, thickness: 0.6, weight: 180, roughness: 0.8, metalness: 0, specularIntensity: 0.25 },
  { name: 'Silk charmeuse', stretchWarpValue: 12, stretchWeftValue: 14, bendValue: 6, thickness: 0.2, weight: 80, roughness: 0.3, metalness: 0.05, specularIntensity: 0.85 },
  { name: 'Wool flannel', stretchWarpValue: 15, stretchWeftValue: 18, bendValue: 35, thickness: 0.8, weight: 280, roughness: 0.92, metalness: 0, specularIntensity: 0.15 },
  { name: 'Chiffon', stretchWarpValue: 18, stretchWeftValue: 20, bendValue: 4, thickness: 0.12, weight: 45, roughness: 0.45, metalness: 0, specularIntensity: 0.5 },
  { name: 'Canvas / duck', stretchWarpValue: 3, stretchWeftValue: 4, bendValue: 70, thickness: 1.0, weight: 400, roughness: 0.95, metalness: 0, specularIntensity: 0.1 },
  { name: 'Leather', stretchWarpValue: 6, stretchWeftValue: 6, bendValue: 60, thickness: 1.2, weight: 450, roughness: 0.6, metalness: 0.05, specularIntensity: 0.5 },
  { name: 'Satin', stretchWarpValue: 10, stretchWeftValue: 12, bendValue: 14, thickness: 0.3, weight: 110, roughness: 0.25, metalness: 0.1, specularIntensity: 0.9 }
];

export function getPreset(name: string | null | undefined): MaterialPreset | null {
  return name ? MATERIAL_PRESETS.find((p) => p.name === name) ?? null : null;
}
