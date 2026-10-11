/** User-authored production document. A released status is a document label, not fit certification. */
export interface TechPackMetadata {
  styleCode: string;
  brand: string;
  season: string;
  revision: string;
  status: 'draft' | 'sampling' | 'released';
  supplier: string;
  currency: string;
  notes: string;
}
export interface TechPackSize {
  id: string;
  name: string;
}
/** Explicitly entered values in the referenced production POM's unit. No automatic grading. */
export interface TechPackSizeMeasurement {
  target: number | null;
  actual: number | null;
  notes: string;
}
export interface TechPackConstruction {
  id: string;
  title: string;
  pieceId: string | null;
  instruction: string;
}
export interface TechPackCosting {
  id: string;
  name: string;
  procurementId: string | null;
  materialId: string | null;
  supplier: string;
  sku: string;
  /** Used for standalone/material rows. Linked procurement rows use their live BOM quantity/unit. */
  quantity: number | null;
  unit: string;
  unitCost: number | null;
  notes: string;
}
export interface TechPackDocument {
  metadata: TechPackMetadata;
  sizes: TechPackSize[];
  sampleSizeId: string | null;
  sizeMeasurements: Record<string, Record<string, TechPackSizeMeasurement>>;
  construction: TechPackConstruction[];
  costing: TechPackCosting[];
}
export function createTechPack(): TechPackDocument {
  return {
    metadata: { styleCode: '', brand: '', season: '', revision: '', status: 'draft', supplier: '', currency: 'USD', notes: '' },
    sizes: [], sampleSizeId: null, sizeMeasurements: {}, construction: [], costing: []
  };
}
