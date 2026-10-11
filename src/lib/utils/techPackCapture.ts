/** Bounded PNG capture admission; renderer captures are PNG. Read IHDR before any decoder allocates. */
export function checkedTechPackCapture(dataUrl: string): string | null {
  if (typeof dataUrl !== 'string' || dataUrl.length > 4_000_000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) return null;
  try {
    const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1, dataUrl.indexOf(',') + 1 + 44)), c => c.charCodeAt(0));
    if (bytes.length < 24 || [137, 80, 78, 71, 13, 10, 26, 10].some((value, index) => bytes[index] !== value) || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') return null;
    const view = new DataView(bytes.buffer); if (view.getUint32(8) !== 13) return null; const width = view.getUint32(16), height = view.getUint32(20);
    return width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16 * 1024 * 1024 ? dataUrl : null;
  } catch { return null; }
}
