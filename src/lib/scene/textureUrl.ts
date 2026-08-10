/**
 * Candidate URLs for a material texture.
 *
 * Legacy SeamScape projects store absolute media.seamscape.com URLs. The public
 * template archive ships those same files under /templates/textures, while
 * user-added mirrors historically lived under /textures. Try both local,
 * same-origin locations before the original URL so canvas-backed piece maps
 * remain readable and work offline.
 */
export function textureUrlCandidates(url: string, pathsBase = ''): string[] {
  if (url.startsWith('data:') || url.startsWith('blob:')) return [url];
  if (url.startsWith('/')) {
    const local = pathsBase && !url.startsWith(`${pathsBase}/`) ? `${pathsBase}${url}` : url;
    return [local];
  }

  const file = url.split('/').pop()?.split('?')[0] ?? '';
  if (!file) return [url];
  return [
    `${pathsBase}/templates/textures/${file}`,
    `${pathsBase}/textures/${file}`,
    url
  ];
}

/** Assign the first candidate and advance on load failure. */
export function loadImageFromCandidates(img: HTMLImageElement, candidates: readonly string[]): void {
  let index = 0;
  img.onerror = () => {
    index += 1;
    if (index < candidates.length) img.src = candidates[index];
  };
  if (candidates.length) img.src = candidates[0];
}
