#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const [auditPath, outputPath] = process.argv.slice(2);
if (!auditPath || !outputPath) {
  console.error('Usage: node scripts/build-compatibility-report-artifact.mjs <audit.json> <artifact.json>');
  process.exit(1);
}

const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
const title = 'SeamScape public pattern compatibility audit';
const sourceId = 'compatibility-audit';
const archiveId = 'public-pattern-archive';
const browserId = 'studio-ui-verification';
const statusLabel = (status) => status === 'pass' ? 'Pass' : status === 'fail' ? 'Fail' : 'Accepted (2D)';
const sqlValue = (value) => typeof value === 'number'
  ? String(value)
  : `'${String(value).replaceAll("'", "''")}'`;
const valuesSql = (rows, fields, alias) => `SELECT * FROM (VALUES\n${rows
  .map((row) => `  (${fields.map((field) => sqlValue(row[field])).join(', ')})`)
  .join(',\n')}\n) AS ${alias}(${fields.join(', ')})`;

const pathSummary = [
  ['Direct legacy .ssp', 'directLegacy'],
  ['Current Raw JSON', 'rawInterpretation'],
  ['Experimental combined', 'combinedInterpretation']
].map(([path, key]) => ({
  path,
  accepted_patterns: audit.meaningful[key].acceptedPatterns,
  source_3d_build_pass: audit.meaningful[key].source3dBuildPass,
  source_3d_patterns: audit.meaningful[key].source3dPatterns,
  source_2d_mode_preserved: audit.meaningful[key].source2dModePreserved,
  seams_retained: audit.meaningful[key].totals.seams,
  source_seams: audit.cohort.seams,
  variables_retained: audit.meaningful[key].totals.variables,
  source_variables: audit.cohort.variables,
  cached_vertices_retained: audit.meaningful[key].totals.cached3dVertices,
  source_cached_vertices: audit.cohort.cached3dVertices,
  missing_material_references: audit.meaningful[key].missingMaterials
}));

const seamRows = audit.results
  .filter((result) => result.sourceCounts.seams > 0)
  .map((result) => ({
    order: result.order,
    pattern: result.name,
    source_seams: result.sourceCounts.seams,
    raw_seams: result.rawInterpretation.counts.seams,
    combined_seams: result.combinedInterpretation.counts.seams,
    raw_retention_pct: Math.round(result.rawInterpretation.counts.seams / result.sourceCounts.seams * 1000) / 10,
    combined_retention_pct: Math.round(result.combinedInterpretation.counts.seams / result.sourceCounts.seams * 1000) / 10,
    direct_build: statusLabel(result.directLegacy.build.status),
    raw_build: statusLabel(result.rawInterpretation.build.status),
    combined_build: statusLabel(result.combinedInterpretation.build.status)
  }));

const patternRows = audit.results.map((result) => ({
  order: result.order,
  pattern: result.name,
  source_mode: result.sourceEnable3d ? '3D enabled' : '2D only',
  source_pieces: result.sourceCounts.pieces,
  source_seams: result.sourceCounts.seams,
  source_variables: result.sourceCounts.variables,
  direct_outcome: statusLabel(result.directLegacy.build.status),
  raw_outcome: statusLabel(result.rawInterpretation.build.status),
  raw_pieces: result.rawInterpretation.counts.pieces,
  raw_seams: result.rawInterpretation.counts.seams,
  combined_outcome: statusLabel(result.combinedInterpretation.build.status),
  combined_pieces: result.combinedInterpretation.counts.pieces,
  combined_seams: result.combinedInterpretation.counts.seams,
  combined_missing_materials: result.combinedInterpretation.integrity.missingMaterials,
  source_cached_vertices: result.sourceCounts.cached3dVertices,
  combined_cached_vertices: result.combinedInterpretation.counts.cached3dVertices
}));

const sources = [
  {
    id: sourceId,
    label: 'Reproducible 20-pattern compatibility audit',
    path: auditPath,
    query: {
      id: 'audit-public-pattern-compatibility',
      language: 'JavaScript',
      description: 'Runs each archived project through direct legacy, current Raw JSON, and experimental combined conversion, then validates 3D buildability and semantic counts.',
      tables_used: ['manifest.json', 'project.ssp', 'project.json', 'raw.json'],
      metric_definitions: [
        'Accepted pattern: 3D validation passes, or the source is intentionally 2D-only and no 3D validation applies.',
        'Source 3D build pass: assertPatternBuildable3d succeeds for a source project with enable3d enabled.',
        'Seams retained: count of imported seam records, compared with 180 source seam records.',
        'Exact seam-bearing pattern: an imported pattern retains the same seam count as the source; this checks count, not geometric correctness.',
        'Cached vertices: vertices preserved from legacy saved mesh snapshots; the bundled pencil-skirt preset is excluded from source cache totals.'
      ]
    }
  },
  {
    id: archiveId,
    label: 'Archived SeamScape public patterns',
    path: auditPath.replace(/compatibility-audit\.json$/, 'manifest.json'),
    query: {
      description: 'Twenty public SeamScape pattern records with decoded project, raw export, metadata, and thumbnail when available.',
      language: 'JSON'
    }
  },
  {
    id: browserId,
    label: 'Local Studio UI verification',
    query: {
      description: 'Representative imports performed in the local Studio on 2026-08-09: Black Dress direct legacy, sleeveless dress Raw JSON, and T-shirt basic Raw JSON.',
      language: 'Browser interaction'
    }
  }
];
const widgetSource = (id, label, description, sql) => ({
  id,
  label,
  path: auditPath,
  query: {
    id,
    language: 'SQL',
    description,
    sql,
    tables_used: ['inline audited rows'],
    metric_definitions: sources[0].query.metric_definitions
  }
});

const manifest = {
  version: 1,
  title,
  description: 'Compatibility, semantic fidelity, and failure-mode comparison of Seamer Studio import paths across 20 public SeamScape patterns.',
  surface: 'report',
  generatedAt: audit.generatedAt,
  sources,
  blocks: [
    { id: 'title', type: 'markdown', body: `# ${title}`, sourceId },
    {
      id: 'technical-summary',
      type: 'markdown',
      sourceId,
      body: '## Technical summary\n\nNo current path is both broadly loadable and semantically faithful. The direct `.ssp` path preserves the original graph exactly but only 2 of 12 source-3D patterns pass the current triangulation gate. The current Raw JSON path accepts 16 of 20 patterns, yet keeps only 12 of 180 seams and 5 of 90 variables, expands 112 source pieces into 132 explicit pieces, discards both TOOBIGPANTS mesh caches, and turns every 2D-only source into a 3D project. The experimental combined path recovers 162 seams and all 30,298 legacy cached vertices, but accepts only 14 patterns and leaves 60 piece-to-material references unresolved.'
    },
    {
      id: 'headline-metrics',
      type: 'markdown',
      sourceId,
      body: '### Headline metrics\n\n- **16 / 20** patterns accepted by the current Raw JSON importer.\n- **2 / 12** source-3D projects build through the exact legacy `.ssp` path.\n- **12 / 180** source seams survive the current Raw JSON importer.\n- **162 / 180** source seams survive the experimental combined converter.\n- **0 / 8** 2D-only sources remain 2D-only in either interpretation converter.'
    },
    { id: 'path-comparison-heading', type: 'markdown', body: '## Import-path comparison', sourceId },
    { id: 'path-comparison-chart', type: 'chart', chartId: 'path-acceptance-chart' },
    {
      id: 'fidelity-findings',
      type: 'markdown',
      sourceId,
      body: '## Semantic fidelity findings\n\nThe Raw importer is a sampled-geometry approximation, not a lossless interpretation engine. It flattens mirror/copy semantics into extra pieces, generally does not reconstruct seams or variables, synthesizes materials, and enables 3D unconditionally. The combined converter restores more legacy records but maps seams mainly by piece name and path index, so duplicated/mirrored pieces and changed edge segmentation remain fragile. Its material replacement also removes the synthesized fallback when a source has an empty material library, producing 60 unresolved references.'
    },
    { id: 'seam-chart', type: 'chart', chartId: 'seam-retention-chart' },
    {
      id: 'ui-verification',
      type: 'markdown',
      sourceId: browserId,
      body: '## Representative Studio verification\n\nThe local UI reproduced the batch results. **Black Dress** imported directly from `.ssp` with 7 pieces and 13 seams. **Sleeveless fit and flare dress** imported through Raw JSON, but changed from 8 pieces and 12 seams to 10 pieces and 0 seams. **T-shirt - basic**, a 2D-only source, was rejected because Raw conversion enabled 3D and triangulation failed on the Front piece. The failed import left the previous project intact.'
    },
    { id: 'pattern-matrix-heading', type: 'markdown', body: '## Pattern-by-pattern matrix', sourceId },
    { id: 'pattern-matrix', type: 'table', tableId: 'pattern-results-table' },
    {
      id: 'failure-modes',
      type: 'markdown',
      sourceId,
      body: '## Failure modes\n\nThe repeated hard failure is `Delaunator could not recover all polygon constraints without an incomplete mesh`. Direct legacy import exposes this in 10 of 12 source-3D projects. Raw sampling often bypasses it by replacing the construction graph with a dense perimeter, but this is why the import can look successful while losing seams, variables, and instance semantics. Restoring legacy seam segmentation in the combined path reintroduces some incompatible constraints, reducing 3D build passes from 9 to 7 among the 12 source-3D projects.'
    },
    {
      id: 'recommendations',
      type: 'markdown',
      sourceId,
      body: '## Recommended engine direction\n\n1. Preserve the decoded legacy graph as an archival/editable layer, while using sampled perimeter geometry as a separate render/triangulation layer.\n2. Map seam spans geometrically by coordinates or normalized arc length rather than by piece name plus path index.\n3. Preserve the source 2D/3D mode; do not force 2D drafts through 3D validation.\n4. Keep a synthesized fallback material when the source material library is empty.\n5. Retain variables and formulas even when the live render mesh comes from sampled geometry.\n6. Distinguish “can display a saved mesh snapshot” from “can re-triangulate and simulate”; allow an authoritative snapshot when the construction graph cannot rebuild.\n7. Turn these 20 public patterns into a regression corpus with acceptance, semantic-retention, reference-integrity, and snapshot tests.'
    },
    {
      id: 'methodology',
      type: 'markdown',
      sourceId,
      body: '## Methodology\n\nEach archived pattern was tested against three routes: exact `.ssp` decoding followed by the current 3D build assertion; the current Studio Raw JSON converter; and the experimental converter that combines Raw perimeter geometry with legacy project metadata. The audit compared piece, seam, material, variable, and cached-vertex totals; checked dangling seam references and missing materials; and recorded build status. Counts establish retention, not geometric equivalence. Representative UI imports were then performed in the local Studio.'
    },
    {
      id: 'limitations',
      type: 'markdown',
      sourceId,
      body: '## Limitations and robustness\n\nThis is a complete census of the 20 archived public patterns, not a sample, but it only reflects the current working tree and this legacy corpus. A matching count does not prove that seam orientation, edge span, formulas, or mesh coordinates are correct. The combined converter is experimental and is not wired into the Studio import menu. Visual verification covered three representative cases; the remaining outcomes were exercised programmatically through the same converter and build-validation modules.'
    },
    {
      id: 'further-questions',
      type: 'markdown',
      sourceId,
      body: '## Further questions\n\n- Should legacy projects open in a compatibility mode even when they cannot be re-simulated?\n- Is a saved legacy mesh authoritative enough to bypass live triangulation on initial load?\n- Which legacy formula features must stay editable versus merely preserved for round-trip export?\n- Should mirror/copy relationships remain first-class instances in Seamer, or be expanded only in the render layer?'
    }
  ],
  charts: [
    {
      id: 'path-acceptance-chart',
      title: 'Patterns accepted by import path',
      description: 'The Raw importer accepts the most patterns, while direct legacy acceptance includes eight intentional 2D-only projects.',
      type: 'bar',
      dataset: 'path_summary',
      encodings: {
        x: { field: 'path', type: 'nominal', title: 'Import path' },
        y: { field: 'accepted_patterns', type: 'quantitative', title: 'Patterns accepted' }
      },
      options: { orientation: 'vertical', grouping: 'grouped', valueLabels: true },
      source: widgetSource(
        'path-acceptance-source',
        'Import-path acceptance totals',
        'Exact audited acceptance totals for the three compatibility routes.',
        valuesSql(pathSummary, ['path', 'accepted_patterns', 'source_3d_build_pass', 'source_3d_patterns'], 'path_summary')
      )
    },
    {
      id: 'seam-retention-chart',
      title: 'Seam retention in seam-bearing patterns',
      description: 'The combined converter restores most seam counts; Raw JSON only restores the canonical pencil-skirt preset.',
      type: 'bar',
      dataset: 'seam_retention',
      encodings: {
        x: { field: 'pattern', type: 'nominal', title: 'Pattern' },
        y: { fields: ['raw_retention_pct', 'combined_retention_pct'], type: 'quantitative', title: 'Source seams retained (%)' }
      },
      options: { orientation: 'horizontal', grouping: 'grouped', valueLabels: true },
      source: widgetSource(
        'seam-retention-source',
        'Per-pattern seam retention',
        'Exact seam counts and retention percentages for all seam-bearing archived patterns.',
        valuesSql(seamRows, ['order', 'pattern', 'source_seams', 'raw_seams', 'combined_seams', 'raw_retention_pct', 'combined_retention_pct'], 'seam_retention')
      )
    }
  ],
  tables: [
    {
      id: 'pattern-results-table',
      title: 'All 20 archived public patterns',
      description: 'Exact source counts and the observed output of each compatibility path.',
      dataset: 'pattern_results',
      defaultSort: { field: 'order', direction: 'asc' },
      columns: [
        { field: 'order', label: '#', type: 'number' },
        { field: 'pattern', label: 'Pattern', type: 'text' },
        { field: 'source_mode', label: 'Source mode', type: 'text' },
        { field: 'source_pieces', label: 'Source pieces', type: 'number' },
        { field: 'source_seams', label: 'Source seams', type: 'number' },
        { field: 'direct_outcome', label: 'Direct .ssp', type: 'text' },
        { field: 'raw_outcome', label: 'Raw result', type: 'text' },
        { field: 'raw_pieces', label: 'Raw pieces', type: 'number' },
        { field: 'raw_seams', label: 'Raw seams', type: 'number' },
        { field: 'combined_outcome', label: 'Combined result', type: 'text' },
        { field: 'combined_seams', label: 'Combined seams', type: 'number' },
        { field: 'combined_missing_materials', label: 'Missing materials', type: 'number' }
      ],
      source: widgetSource(
        'pattern-results-source',
        'All pattern compatibility outcomes',
        'Exact audited outcomes and semantic counts for all 20 archived patterns.',
        valuesSql(patternRows, ['order', 'pattern', 'source_mode', 'source_pieces', 'source_seams', 'direct_outcome', 'raw_outcome', 'raw_pieces', 'raw_seams', 'combined_outcome', 'combined_seams', 'combined_missing_materials'], 'pattern_results')
      )
    }
  ]
};

const payload = {
  surface: 'report',
  manifest,
  snapshot: {
    version: 1,
    status: 'ready',
    generatedAt: audit.generatedAt,
    datasets: {
      path_summary: pathSummary,
      seam_retention: seamRows,
      pattern_results: patternRows
    }
  },
  sources
};

writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(outputPath);
