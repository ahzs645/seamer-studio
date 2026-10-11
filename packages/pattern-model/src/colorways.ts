import type { Material, Pattern, TextureSlot } from './pattern';

export interface ColorwayPiece {
  /** A real project fabric. Geometry is never copied into a colorway. */
  materialId: string;
  frontColor?: string;
  backColor?: string;
}
export interface NamedColorway {
  id: string;
  name: string;
  pieces: Record<string, ColorwayPiece>;
}
export interface ColorwayState {
  activeId: string | null;
  variants: NamedColorway[];
  /** Tint-copy id -> original fabric id. This is project lineage, not a supplier/catalog claim. */
  generatedMaterialSources: Record<string, string>;
}
export interface ColorwayResult {
  pattern: Pattern;
  errors: string[];
}

const colorPattern = /^#[0-9a-f]{6}$/i;
const uid = () => crypto.randomUUID();
const emptyState = (): ColorwayState => ({ activeId: null, variants: [], generatedMaterialSources: {} });

export function captureColorwayPieces(pattern: Pattern): NamedColorway['pieces'] {
  const materials = new Map(pattern.materials.map(material => [material.id, material]));
  return Object.fromEntries(pattern.pieces.map(piece => {
    const material = materials.get(piece.materialId);
    return [piece.id, {
      materialId: piece.materialId,
      ...(material?.frontTexture?.color ? { frontColor: material.frontTexture.color } : {}),
      ...(material?.useSeparateBackSide && material.backTexture?.color ? { backColor: material.backTexture.color } : {})
    }];
  }));
}

/** Preserve live Fabric-panel assignments/tints before any variant operation. */
function captureActive(pattern: Pattern): ColorwayState {
  const state = pattern.colorways ?? emptyState();
  return {
    ...state,
    generatedMaterialSources: { ...state.generatedMaterialSources },
    variants: state.variants.map(variant => variant.id === state.activeId
      ? { ...variant, pieces: captureColorwayPieces(pattern) } : variant)
  };
}

export function colorwayProblems(pattern: Pattern, variant: NamedColorway): string[] {
  const pieces = new Set(pattern.pieces.map(piece => piece.id));
  const materials = new Set(pattern.materials.map(material => material.id));
  const problems: string[] = [];
  for (const [pieceId, override] of Object.entries(variant.pieces)) {
    if (!pieces.has(pieceId)) problems.push(`Piece ${pieceId} no longer exists.`);
    if (override.materialId && !materials.has(override.materialId)) problems.push(`Fabric ${override.materialId} for ${pattern.pieces.find(piece => piece.id === pieceId)?.name ?? pieceId} no longer exists.`);
    if (override.frontColor !== undefined && !colorPattern.test(override.frontColor)) problems.push(`Invalid front color for ${pieceId}.`);
    if (override.backColor !== undefined && !colorPattern.test(override.backColor)) problems.push(`Invalid back color for ${pieceId}.`);
    if (!override.materialId && (override.frontColor || override.backColor)) problems.push(`Choose a fabric before tinting ${pieceId}.`);
  }
  return problems;
}

function slot(color: string): TextureSlot {
  return { url: '', mediaId: null, color, scale: 100, normalUrl: '', normalMediaId: null, normalMapScale: 100, opacityUrl: '', opacityMediaId: null, opacityMapScale: 100 };
}

function trimGenerated(pattern: Pattern, state: ColorwayState): Pattern {
  const used = new Set(pattern.pieces.map(piece => piece.materialId));
  for (const variant of state.variants) for (const override of Object.values(variant.pieces)) used.add(override.materialId);
  const removed = new Set(Object.keys(state.generatedMaterialSources).filter(id => !used.has(id)));
  return {
    ...pattern,
    materials: pattern.materials.filter(material => !removed.has(material.id)),
    colorways: { ...state, generatedMaterialSources: Object.fromEntries(Object.entries(state.generatedMaterialSources).filter(([id]) => !removed.has(id))) },
    hasChanged: true
  };
}

function applyVariant(pattern: Pattern, state: ColorwayState, variant: NamedColorway): ColorwayResult {
  const errors = colorwayProblems(pattern, variant);
  if (errors.length) return { pattern, errors };
  const materials = new Map(pattern.materials.map(material => [material.id, material]));
  const generated = { ...state.generatedMaterialSources };
  const pieces = pattern.pieces.map(piece => {
    const override = variant.pieces[piece.id];
    if (!override) return piece; // New geometry retains its current fabric; no invented assignment.
    const source = materials.get(override.materialId);
    if (!source) return { ...piece, materialId: override.materialId }; // Explicitly unassigned.
    const needsFront = override.frontColor !== undefined && override.frontColor.toLowerCase() !== source.frontTexture?.color?.toLowerCase();
    const needsBack = override.backColor !== undefined && (!source.useSeparateBackSide || override.backColor.toLowerCase() !== source.backTexture?.color?.toLowerCase());
    if (!needsFront && !needsBack) return { ...piece, materialId: source.id };
    const id = `colorway_${variant.id}_${piece.id}`;
    // One actual material per tinted variant/piece. Reusing the id bounds repeated edits.
    const copy: Material = {
      ...structuredClone(source), id, name: `${source.name.replace(/ · Colorway$/, '')} · Colorway`,
      frontTexture: override.frontColor === undefined ? structuredClone(source.frontTexture)
        : { ...(structuredClone(source.frontTexture) ?? slot(override.frontColor)), color: override.frontColor },
      backTexture: override.backColor === undefined ? structuredClone(source.backTexture)
        : { ...(structuredClone(source.backTexture ?? source.frontTexture) ?? slot(override.backColor)), color: override.backColor },
      useSeparateBackSide: override.backColor !== undefined ? true : source.useSeparateBackSide
    };
    // Preserve linked asset/version metadata and all physics from the current fabric.
    generated[id] = generated[source.id] ?? source.id;
    materials.set(id, copy);
    return { ...piece, materialId: id };
  });
  return { pattern: trimGenerated({ ...pattern, pieces, materials: [...materials.values()] }, { ...state, activeId: variant.id, generatedMaterialSources: generated }), errors: [] };
}

export function createColorway(pattern: Pattern, name: string, newId: () => string = uid): Pattern {
  const label = name.trim();
  if (!label) return pattern;
  let state = captureActive(pattern);
  if (!state.variants.length) {
    const baseline = { id: newId(), name: 'Original', pieces: captureColorwayPieces(pattern) };
    state = { ...state, activeId: baseline.id, variants: [baseline] };
  }
  const variant = { id: newId(), name: label, pieces: captureColorwayPieces(pattern) };
  return trimGenerated(pattern, { ...state, activeId: variant.id, variants: [...state.variants, variant] });
}

export function switchColorway(pattern: Pattern, id: string): ColorwayResult {
  const state = captureActive(pattern);
  const variant = state.variants.find(variant => variant.id === id);
  if (!variant) return { pattern, errors: ['This colorway no longer exists.'] };
  return applyVariant(pattern, state, variant);
}

export function renameColorway(pattern: Pattern, id: string, name: string): Pattern {
  if (!name.trim() || !pattern.colorways?.variants.some(variant => variant.id === id)) return pattern;
  const state = captureActive(pattern);
  return trimGenerated(pattern, { ...state, variants: state.variants.map(variant => variant.id === id ? { ...variant, name: name.trim() } : variant) });
}

export function duplicateColorway(pattern: Pattern, id: string, newId: () => string = uid): Pattern {
  const state = captureActive(pattern);
  const source = state.variants.find(variant => variant.id === id);
  if (!source) return pattern;
  const variant = { ...structuredClone(source), id: newId(), name: `${source.name} copy` };
  return trimGenerated(pattern, { ...state, variants: [...state.variants, variant] });
}

export function deleteColorway(pattern: Pattern, id: string): Pattern {
  const state = captureActive(pattern);
  if (!state.variants.some(variant => variant.id === id)) return pattern;
  // Keep the displayed fabrics when deleting the active variant. Never silently switch looks.
  return trimGenerated(pattern, { ...state, activeId: state.activeId === id ? null : state.activeId, variants: state.variants.filter(variant => variant.id !== id) });
}

export function updateColorwayPiece(pattern: Pattern, variantId: string, pieceId: string, override: ColorwayPiece): ColorwayResult {
  const state = captureActive(pattern);
  const variant = state.variants.find(variant => variant.id === variantId);
  if (!variant) return { pattern, errors: ['Choose a saved colorway before editing.'] };
  const next = { ...variant, pieces: { ...variant.pieces, [pieceId]: override } };
  const nextState = { ...state, variants: state.variants.map(variant => variant.id === variantId ? next : variant) };
  if (variantId === state.activeId) return applyVariant(pattern, nextState, next);
  // Missing references may be repaired one at a time while editing an inactive variant.
  return { pattern: trimGenerated(pattern, nextState), errors: [] };
}

export function removeColorwayPiece(pattern: Pattern, variantId: string, pieceId: string): Pattern {
  const state = captureActive(pattern);
  return trimGenerated(pattern, { ...state, variants: state.variants.map(variant => {
    if (variant.id !== variantId) return variant;
    const pieces = { ...variant.pieces }; delete pieces[pieceId];
    return { ...variant, pieces };
  }) });
}
