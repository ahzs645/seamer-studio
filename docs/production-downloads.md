# Production downloads

Tech Pack generates standalone HTML, PDF and OOXML XLSX files locally from an immutable document snapshot. PDF/XLSX include current resolved POM targets, entered or linked actuals, body charts and mapping, authored grades, procurement, live costing quantities, explicit dated exchange quotes, marker provenance, mesh-capture provenance, approval state, artwork placement and construction instructions. Missing inputs remain unspecified; stale markers do not contribute current costing quantities.

Every colorway image is freshly rendered from actual piece outlines, material tints and validated artwork. The shared artwork painter includes repeat modes, polygon zones and ink treatments, including rasterized vector designs. These are labeled flat front-face production references, separate from photographed or simulated fit evidence. Construction captures embed the actual current garment view with a capture time, source version and label.

Pieces added after a saved colorway retain their current fabric when that variant has no saved assignment for them, matching variant activation. Explicit saved assignments still apply, including unassigned or missing fabric references. Exporting the active variant uses current assignments and tints.

XLSX uses typed numeric cells and inline string cells. User text never becomes a spreadsheet formula. Image media and drawing relationships are embedded in the workbook. PDF embeds the licensed DejaVu Sans font from the local deployment; the font uses no remote request. Explicitly linked raster fabric textures try local mirrors first, then their authored HTTP(S) source with CORS, omitted credentials/referrer, a timeout and a streamed 3 MB byte cap. Provider failures produce visible mockup warnings. Characters absent from that font appear as `?`; the download status and a PDF page report substitutions. HTML and XLSX preserve original text.

Captures accept bounded PNG images with validated PNG headers and dimensions. Raster artwork requires source validation, real image decoding and matching declared dimensions before mockup painting. SVG and executable content are excluded; artwork and captured views must remain embedded rasters. Authored fabric links have the bounded download policy above.

Image and reference warnings are included with their variant or view in PDF warning pages and the XLSX Export warnings sheet. Download status reports the warning count; a completed download can contain a documented flat-tint fallback or unavailable artwork source.

Focused unit coverage checks actual PDF parsing, OOXML archive contents/images, numeric totals, formula safety, unknown conversion states and oversized/corrupt image rejection. Browser coverage verifies downloadable files, captured garment images, fresh red/blue variant pixels and document preservation.
