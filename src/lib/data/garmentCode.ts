export const GARMENTCODE_PRESETS = [
  { id: 't-shirt', label: 'T-shirt' },
  { id: 'hoodie', label: 'Hoodie' },
  { id: 'skirt', label: 'Skirt' },
  { id: 'pants', label: 'Pants' },
  { id: 'dress', label: 'Dress' }
] as const;

export type GarmentCodePreset = typeof GARMENTCODE_PRESETS[number]['id'];

export interface GarmentCodeRequest {
  preset: GarmentCodePreset;
  body: Record<string, number>;
  design: Record<string, unknown>;
}

export const GARMENTCODE_EXAMPLES = [
  { file: 'shirt_mean_specification.json', label: 'GarmentCode Shirt' },
  { file: 'hoody_mean_specification.json', label: 'GarmentCode Hoodie' },
  { file: 'dress_pencil_specification.json', label: 'GarmentCode Dress' },
  { file: 'js_mean_all_specification.json', label: 'GarmentCode Jumpsuit' }
] as const;
