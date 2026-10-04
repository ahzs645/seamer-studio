/** Bound the library to the actually visible screen below its measured popup top.
 * visualViewport offset includes a panned/keyboard-constrained mobile viewport. */
export function libraryPanelMaxHeight(panelTop: number, viewportHeight: number, viewportTop = 0): number | null {
  if (![panelTop, viewportHeight, viewportTop].every(Number.isFinite) || viewportHeight <= 0) return null;
  return Math.max(0, viewportTop + viewportHeight - Math.max(panelTop, viewportTop) - 8);
}

/** Keep the sticky Close row reachable when keyboard panning moves the visual viewport. */
export function libraryPanelViewport(panelTop: number, viewportHeight: number, viewportTop = 0): { top: number; maxHeight: number } | null {
  if (libraryPanelMaxHeight(panelTop, viewportHeight, viewportTop) === null) return null;
  const bottom = viewportTop + viewportHeight - 8;
  let top = Math.max(panelTop, viewportTop + 8);
  if (bottom - top < 96) top = Math.max(viewportTop + 8, bottom - 160);
  return { top, maxHeight: Math.max(0, bottom - top) };
}
