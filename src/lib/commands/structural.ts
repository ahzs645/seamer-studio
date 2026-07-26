// Small structural mutators for gaps whose data existed in the model but had no operation/UI:
// variable reorder + enum options, layer rename + style override, background-image locks, and
// text/image layer assignment. All pure (Pattern, args) => Pattern.

import type { Pattern, Variable, Layer } from '@seamer/pattern-model';

// --- Variables ---------------------------------------------------------------

/** Move a variable to a new index in the variables list. */
export function variableReorder(p: Pattern, variableId: string, toIndex: number): Pattern {
  const from = p.variables.findIndex((v) => v.id === variableId);
  if (from < 0) return p;
  const arr = [...p.variables];
  const [moved] = arr.splice(from, 1);
  const to = Math.max(0, Math.min(arr.length, toIndex));
  arr.splice(to, 0, moved);
  return { ...p, variables: arr, hasChanged: true };
}

/** Set the enum option list for a variable (used when type === 'enum'). */
export function variableSetOptions(p: Pattern, variableId: string, options: unknown[]): Pattern {
  return {
    ...p,
    variables: p.variables.map((v) => (v.id === variableId ? { ...v, options: [...options] } : v)),
    hasChanged: true
  };
}

/** Patch arbitrary fields of a variable (type / value / description / visibility / editability). */
export function variableUpdate(p: Pattern, variableId: string, patch: Partial<Variable>): Pattern {
  return {
    ...p,
    variables: p.variables.map((v) => (v.id === variableId ? { ...v, ...patch } : v)),
    hasChanged: true
  };
}

// --- Layers ------------------------------------------------------------------

/** Rename a layer (the Default layer can be renamed too, only its deletion is blocked). */
export function layerRename(p: Pattern, layerId: string, name: string): Pattern {
  return {
    ...p,
    layers: p.layers.map((l) => (l.id === layerId ? { ...l, name } : l)),
    hasChanged: true
  };
}

/** A per-layer style override applied to elements that don't set their own style. */
export type LayerLineStyle = 'solid' | 'dashed' | 'dotted' | 'dash-dot' | 'dash-dot-dot';

export interface LayerStyle {
  color?: string; // hex stroke/fill override (light theme)
  colorDark?: string; // dark-theme override (falls back to `color`)
  lineWidth?: number; // px
  dashed?: boolean; // legacy boolean (lineStyle wins when set)
  lineStyle?: LayerLineStyle; // the original's full line-style vocabulary
  opacity?: number; // 0..1
}

/** Canvas dash pattern for a layer style (legacy `dashed` maps to 'dashed'). */
export function layerDashPattern(style: LayerStyle | null | undefined): number[] {
  const s = style?.lineStyle ?? (style?.dashed ? 'dashed' : 'solid');
  switch (s) {
    case 'dashed': return [6, 4];
    case 'dotted': return [1.5, 3];
    case 'dash-dot': return [8, 3, 1.5, 3];
    case 'dash-dot-dot': return [8, 3, 1.5, 3, 1.5, 3];
    default: return [];
  }
}

/** Resolve the layer stroke color for the current theme. */
export function layerStrokeColor(style: LayerStyle | null | undefined, dark: boolean): string | undefined {
  return dark ? (style?.colorDark ?? style?.color) : style?.color;
}

/** Set or clear (pass null) a layer's style override. */
export function layerSetStyle(p: Pattern, layerId: string, style: LayerStyle | null): Pattern {
  return {
    ...p,
    layers: p.layers.map((l) => (l.id === layerId ? { ...l, style } : l)) as Layer[],
    hasChanged: true
  };
}

// --- Background image ---------------------------------------------------------

/** Background-image lock + dimension update. `lockAspect` keeps width/height proportional when one
 *  is set; `locked` freezes the image from canvas drag/resize. */
export function imageUpdate(
  p: Pattern,
  imageId: string,
  patch: { width?: number; height?: number; rotation?: number; opacity?: number; locked?: boolean; lockAspect?: boolean; layerId?: string }
): Pattern {
  return {
    ...p,
    images: p.images.map((img) => {
      if (img.id !== imageId) return img;
      const next = { ...img } as typeof img;
      const aspect = img.width && img.height ? img.width / img.height : 1;
      const keep = patch.lockAspect ?? (img.lockAspect as boolean | undefined) ?? false;
      if (patch.width !== undefined) {
        next.width = patch.width;
        if (keep && aspect) next.height = patch.width / aspect;
      }
      if (patch.height !== undefined) {
        next.height = patch.height;
        if (keep && aspect && patch.width === undefined) next.width = patch.height * aspect;
      }
      if (patch.rotation !== undefined) next.rotation = patch.rotation;
      if (patch.opacity !== undefined) next.opacity = patch.opacity;
      if (patch.locked !== undefined) next.locked = patch.locked;
      if (patch.lockAspect !== undefined) next.lockAspect = patch.lockAspect;
      if (patch.layerId !== undefined) next.layerId = patch.layerId;
      return next;
    }),
    hasChanged: true
  };
}

// --- Text --------------------------------------------------------------------

/** Patch a text annotation (content / style / layer assignment). */
export function textUpdate(
  p: Pattern,
  textId: string,
  patch: { value?: string; fontSize?: number; color?: string; align?: 'left' | 'center' | 'right'; rotation?: number; layerId?: string }
): Pattern {
  return {
    ...p,
    texts: p.texts.map((t) => (t.id === textId ? { ...t, ...patch } : t)),
    hasChanged: true
  };
}
