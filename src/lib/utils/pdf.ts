// Minimal self-contained vector PDF writer — no dependency. Emits multi-page PDFs of stroked
// polylines + Helvetica text labels at true millimetre scale, with optional dashed strokes and
// page tiling. Built specifically for pattern / cutting-marker output (the original used pdfkit; a
// vector-line use case doesn't justify a ~360 kB dependency, and this is unit-tested).

export interface Vec2 { x: number; y: number }

const MM_TO_PT = 72 / 25.4; // 1 mm in PostScript points

export interface PdfStroke {
  color?: [number, number, number]; // 0..1 RGB
  width?: number; // pt
  dash?: [number, number]; // [on, off] in pt
}

/** A polyline in PDF *page* space already (pt, origin bottom-left, y up). */
interface PageStroke { pts: Vec2[]; closed: boolean; style: PdfStroke }
interface PageText { x: number; y: number; size: number; text: string; color?: [number, number, number]; anchor?: 'start' | 'middle' | 'end'; rotation?: number }
interface PdfPage { widthPt: number; heightPt: number; strokes: PageStroke[]; texts: PageText[] }

function esc(s: string): string {
  // PDF literal string escaping; drop non-Latin1 so byte offsets stay exact.
  return s.replace(/[\\()]/g, (m) => '\\' + m).replace(/[^\x20-\x7e]/g, '');
}

function pageContent(page: PdfPage): string {
  const out: string[] = [];
  for (const s of page.strokes) {
    if (s.pts.length < 2) continue;
    const c = s.style.color ?? [0, 0, 0];
    out.push(`${c[0].toFixed(3)} ${c[1].toFixed(3)} ${c[2].toFixed(3)} RG`);
    out.push(`${(s.style.width ?? 0.5).toFixed(2)} w`);
    out.push(s.style.dash ? `[${s.style.dash[0]} ${s.style.dash[1]}] 0 d` : `[] 0 d`);
    out.push(`${s.pts[0].x.toFixed(2)} ${s.pts[0].y.toFixed(2)} m`);
    for (let i = 1; i < s.pts.length; i++) out.push(`${s.pts[i].x.toFixed(2)} ${s.pts[i].y.toFixed(2)} l`);
    out.push(s.closed ? 'h S' : 'S');
  }
  for (const t of page.texts) {
    if (!t.text) continue;
    const c = t.color ?? [0, 0, 0];
    // approximate Helvetica advance (~0.5em) for anchoring
    const w = t.text.length * t.size * 0.5;
    const dx = t.anchor === 'middle' ? -w / 2 : t.anchor === 'end' ? -w : 0;
    out.push('BT', `${c[0].toFixed(3)} ${c[1].toFixed(3)} ${c[2].toFixed(3)} rg`, `/F1 ${t.size.toFixed(2)} Tf`);
    if (t.rotation) {
      const a = (t.rotation * Math.PI) / 180, cos = Math.cos(a).toFixed(5), sin = Math.sin(a).toFixed(5);
      out.push(`${cos} ${sin} ${(-Number(sin)).toFixed(5)} ${cos} ${t.x.toFixed(2)} ${t.y.toFixed(2)} Tm`);
      out.push(`${dx.toFixed(2)} 0 Td`);
    } else {
      out.push(`1 0 0 1 ${(t.x + dx).toFixed(2)} ${t.y.toFixed(2)} Tm`);
    }
    out.push(`(${esc(t.text)}) Tj`, 'ET');
  }
  return out.join('\n');
}

/** Assemble PDF pages into bytes with exact cross-reference offsets. */
export function buildPdf(pages: PdfPage[]): Uint8Array {
  const objects: string[] = []; // 1-indexed body, objects[i] is object (i+1)
  const add = (body: string) => objects.push(body) && objects.length; // returns obj number

  const fontNum = 1 + 2 + pages.length * 2; // reserve: catalog(1), pages(2), then per page [page, content]; font last
  // We'll lay out: 1 catalog, 2 pages-tree, then for each page: page obj + content obj, then font.
  const catalogNum = 1, pagesNum = 2;
  const pageObjNums: number[] = [];
  let n = 2;
  for (let i = 0; i < pages.length; i++) { pageObjNums.push(++n); ++n; } // page, content
  const realFontNum = ++n;

  objects[catalogNum - 1] = `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`;
  objects[pagesNum - 1] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageObjNums.map((p) => `${p} 0 R`).join(' ')}] >>`;
  pages.forEach((page, i) => {
    const pageObj = pageObjNums[i], contentObj = pageObj + 1;
    const content = pageContent(page);
    objects[pageObj - 1] = `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${page.widthPt.toFixed(2)} ${page.heightPt.toFixed(2)}] /Resources << /Font << /F1 ${realFontNum} 0 R >> >> /Contents ${contentObj} 0 R >>`;
    objects[contentObj - 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  objects[realFontNum - 1] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  void fontNum; void add;

  // Serialise with byte-offset tracking (Latin1).
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  const byteLen = (s: string) => { let len = 0; for (let i = 0; i < s.length; i++) len += s.charCodeAt(i) > 0xff ? 1 : 1; return len; };
  for (let i = 0; i < objects.length; i++) {
    offsets[i] = byteLen(body);
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 0; i < objects.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  body += xref;
  body += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  const bytes = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) bytes[i] = body.charCodeAt(i) & 0xff;
  return bytes;
}

// --- High-level: mm polylines → tiled PDF ------------------------------------

export interface MmPoly { pts: Vec2[]; closed: boolean; style: PdfStroke }
export interface MmText { x: number; y: number; sizeMm: number; text: string; color?: [number, number, number]; anchor?: 'start' | 'middle' | 'end'; rotation?: number }

export const PAGE_SIZES_MM: Record<string, [number, number]> = {
  A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841], A0: [841, 1189], Letter: [215.9, 279.4]
};

export interface PdfLayoutOpts {
  /** page size key, or explicit [w,h] mm. Default 'A4'. */
  page?: keyof typeof PAGE_SIZES_MM | [number, number];
  marginMm?: number; // printable margin, default 10
  tile?: boolean; // split across pages, default true
  landscape?: boolean;
  title?: string;
  overlapMm?: number; // tile overlap, default 0
  cropMarks?: boolean; // default true when tiling
  /** output scale factor (1 = true scale). Applied to the content before tiling. */
  scale?: number;
}

/** How many tiles a content box needs for a given printable area (shared by PDF + tiled print). */
export function tilePageCount(
  contentWmm: number,
  contentHmm: number,
  opts: { pageWmm: number; pageHmm: number; marginMm?: number; overlapMm?: number }
): { cols: number; rows: number; total: number } {
  const margin = opts.marginMm ?? 10;
  const overlap = opts.overlapMm ?? 0;
  const usableW = Math.max(10, opts.pageWmm - margin * 2);
  const usableH = Math.max(10, opts.pageHmm - margin * 2);
  const cols = Math.max(1, Math.ceil((contentWmm - overlap) / (usableW - overlap)));
  const rows = Math.max(1, Math.ceil((contentHmm - overlap) / (usableH - overlap)));
  return { cols, rows, total: cols * rows };
}

/** Render mm-space polylines (y up) into a (tiled) PDF, returning bytes. */
export function polylinesToPDF(polys: MmPoly[], texts: MmText[], opts: PdfLayoutOpts = {}): Uint8Array {
  let [pw, ph] = Array.isArray(opts.page) ? opts.page : PAGE_SIZES_MM[opts.page ?? 'A4'];
  if (opts.landscape) [pw, ph] = [ph, pw];
  const margin = opts.marginMm ?? 10;
  const overlap = opts.overlapMm ?? 0;
  const tile = opts.tile ?? true;

  // output scale (1 = true scale): applied to the content geometry before tiling
  const sc = opts.scale ?? 1;
  if (sc !== 1) {
    polys = polys.map((p) => ({ ...p, pts: p.pts.map((v) => ({ x: v.x * sc, y: v.y * sc })) }));
    texts = texts.map((t) => ({ ...t, x: t.x * sc, y: t.y * sc, sizeMm: t.sizeMm * sc }));
  }

  // content bbox (mm)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polys) for (const v of p.pts) { minX = Math.min(minX, v.x); minY = Math.min(minY, v.y); maxX = Math.max(maxX, v.x); maxY = Math.max(maxY, v.y); }
  for (const t of texts) { minX = Math.min(minX, t.x); maxX = Math.max(maxX, t.x); minY = Math.min(minY, t.y); maxY = Math.max(maxY, t.y); }
  if (!isFinite(minX)) { minX = minY = 0; maxX = maxY = 100; }
  const contentW = maxX - minX, contentH = maxY - minY;

  const usableW = pw - margin * 2, usableH = ph - margin * 2;
  const counted = tilePageCount(contentW, contentH, { pageWmm: pw, pageHmm: ph, marginMm: margin, overlapMm: overlap });
  const pagesWide = tile ? counted.cols : 1;
  const pagesHigh = tile ? counted.rows : 1;

  // when not tiling, scale to fit one page
  const fit = !tile ? Math.min(usableW / Math.max(contentW, 1e-3), usableH / Math.max(contentH, 1e-3), 1) : 1;
  const pages: PdfPage[] = [];

  for (let ty = 0; ty < pagesHigh; ty++) {
    for (let tx = 0; tx < pagesWide; tx++) {
      // mm origin of this tile within the content
      const tileMinX = tile ? minX + tx * (usableW - overlap) : minX;
      const tileMaxY = tile ? maxY - ty * (usableH - overlap) : maxY;
      // mm→page-pt: page y is up. Place content so tileMinX maps to left margin and tileMaxY to top margin.
      const toPage = (v: Vec2): Vec2 => ({
        x: (margin + (v.x - tileMinX) * fit) * MM_TO_PT,
        y: (ph - margin - (tileMaxY - v.y) * fit) * MM_TO_PT
      });
      const strokes: PageStroke[] = polys.map((p) => ({ pts: p.pts.map(toPage), closed: p.closed, style: { ...p.style, width: (p.style.width ?? 0.5) } }));
      const pTexts: PageText[] = texts.map((t) => { const pos = toPage({ x: t.x, y: t.y }); return { x: pos.x, y: pos.y, size: Math.max(4, t.sizeMm * MM_TO_PT * fit), text: t.text, color: t.color, anchor: t.anchor, rotation: t.rotation }; });
      // page furniture
      if ((opts.cropMarks ?? tile) && (pagesWide > 1 || pagesHigh > 1)) {
        const m = margin * MM_TO_PT, W = pw * MM_TO_PT, H = ph * MM_TO_PT, t = 8;
        const reg: PageStroke = { pts: [], closed: false, style: { color: [0.6, 0.6, 0.6], width: 0.4 } };
        const mk = (a: Vec2, b: Vec2) => strokes.push({ pts: [a, b], closed: false, style: reg.style });
        mk({ x: m, y: H - m }, { x: m + t, y: H - m }); mk({ x: m, y: H - m }, { x: m, y: H - m - t });
        mk({ x: W - m, y: m }, { x: W - m - t, y: m }); mk({ x: W - m, y: m }, { x: W - m, y: m + t });
        pTexts.push({ x: W / 2, y: m / 2, size: 7, text: `${opts.title ?? 'Pattern'} — page ${ty * pagesWide + tx + 1}/${pagesWide * pagesHigh} (col ${tx + 1}, row ${ty + 1})`, anchor: 'middle' });
      }
      pages.push({ widthPt: pw * MM_TO_PT, heightPt: ph * MM_TO_PT, strokes, texts: pTexts });
    }
  }
  return buildPdf(pages);
}
