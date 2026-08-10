#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';

const [archivePath, outputJsonPath, outputMarkdownPath] = process.argv.slice(2);
if (!archivePath || !outputJsonPath || !outputMarkdownPath) {
  console.error('Usage: node scripts/audit-simulator-parity.mjs <archive-dir> <output.json> <output.md>');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(archivePath, 'manifest.json'), 'utf8'));
const canonicalPencilSkirt = JSON.parse(readFileSync('static/templates/pencil-skirt.json', 'utf8'));
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });

const typedBytes = (array) => Buffer.from(array.buffer, array.byteOffset, array.byteLength);
const digestSimData = (simData) => {
  const hash = createHash('sha256');
  for (const array of [
    simData.positions2d,
    simData.triangles,
    simData.seams,
    simData.particleLayers,
    ...simData.stretchColors.flatMap((group) => [group.edges, group.props]),
    ...simData.bendColors.flatMap((group) => [group.edges, group.props])
  ]) hash.update(typedBytes(array));
  return hash.digest('hex');
};

const owningPiece = (pattern, pathId) => pattern.pieces.find((piece) =>
  [...piece.mainPaths, ...piece.internalPaths].some((path) => path.id === pathId)
);

const resolveRun = (pattern, simData, reference) => {
  const piece = owningPiece(pattern, reference.id);
  if (!piece) return null;
  const run = simData.edgeRuns.get(
    `${piece.id}::${reference.id}${reference.mirrored ? '#M' : ''}`
  );
  if (!run?.length) return null;
  return reference.reversed ? run.slice().reverse() : run.slice();
};

const endpointAudit = (pattern, simData) => {
  let referencedEndpoints = 0;
  let pairedEndpoints = 0;
  let missingRuns = 0;
  for (const seam of pattern.seams) {
    const record = simData.seamPairsBySeam.find((candidate) => candidate.seamId === seam.id);
    const fromPairs = record?.pairs.filter((_value, index) => index % 2 === 0) ?? [];
    const toPairs = record?.pairs.filter((_value, index) => index % 2 === 1) ?? [];
    for (const [references, pairs] of [[seam.fromPaths, fromPairs], [seam.toPaths, toPairs]]) {
      for (const reference of references) {
        const run = resolveRun(pattern, simData, reference);
        if (!run) {
          missingRuns++;
          continue;
        }
        referencedEndpoints += 2;
        if (pairs.includes(run[0])) pairedEndpoints++;
        if (pairs.includes(run.at(-1))) pairedEndpoints++;
      }
    }
  }
  return {
    referencedEndpoints,
    pairedEndpoints,
    endpointCoverage: referencedEndpoints ? pairedEndpoints / referencedEndpoints : 1,
    missingRuns
  };
};

const countConstraints = (groups) => groups.reduce((total, group) => total + group.count, 0);

try {
  const imports = await server.ssrLoadModule('/src/lib/utils/importSimplePattern.ts');
  const simulator = await server.ssrLoadModule('/packages/cloth-sim/src/simulator.ts');
  const config = await server.ssrLoadModule('/packages/cloth-sim/src/config.ts');
  const results = [];

  for (const archived of manifest.patterns) {
    const folder = join(archivePath, archived.folder);
    const source = JSON.parse(readFileSync(join(folder, 'project.json'), 'utf8'));
    const raw = JSON.parse(readFileSync(join(folder, 'raw.json'), 'utf8'));
    const source3dEnabled = source.enable3d !== false;
    const canonical = imports.isCanonicalPencilSkirtExport(raw) ? canonicalPencilSkirt : undefined;
    let pattern;
    let importError = null;
    try {
      pattern = imports.convertSimplePatternWithLegacyProject(raw, source, canonical);
      if (source3dEnabled) imports.assertPatternBuildable3d(pattern);
    } catch (error) {
      importError = error instanceof Error ? error.message : String(error);
    }

    const warnings = [];
    let prepared = null;
    let simulationError = null;
    if (source3dEnabled && pattern && !importError) {
      const originalWarn = console.warn;
      console.warn = (...args) => warnings.push(args.map(String).join(' '));
      try {
        prepared = simulator.prepareCloth({
          pattern,
          avatarVertices: new Float32Array(),
          avatarIndices: new Uint32Array(),
          cylinders: new Map()
        });
      } catch (error) {
        simulationError = error instanceof Error ? error.message : String(error);
      } finally {
        console.warn = originalWarn;
      }
    }

    const simData = prepared?.simData;
    const endpoints = simData ? endpointAudit(pattern, simData) : null;
    const mismatchWarnings = warnings.filter((warning) => /particle count mismatch|no particles|no owning piece|no particles in the sim mesh/i.test(warning));
    results.push({
      order: archived.order,
      name: archived.name,
      source3dEnabled,
      sourcePieces: source.pieces?.length ?? 0,
      sourceSeams: source.seams?.length ?? 0,
      importedSeams: pattern?.seams?.length ?? 0,
      sourceSavedParticles: (source.pieces ?? []).reduce((total, piece) =>
        total + Math.floor((piece.settings3d?.savedPositions?.length ?? 0) / 5), 0),
      importStatus: importError ? 'fail' : 'pass',
      importError,
      simulationStatus: !source3dEnabled ? 'not-applicable' : simulationError ? 'fail' : simData ? 'pass' : 'not-applicable',
      simulationError,
      particles: simData?.particleCount ?? 0,
      triangles: simData?.triangleCount ?? 0,
      stretchConstraints: simData ? countConstraints(simData.stretchColors) : 0,
      bendConstraints: simData ? countConstraints(simData.bendColors) : 0,
      simulatedSeams: simData?.seamPairsBySeam.length ?? 0,
      seamPairs: simData?.seamPairsBySeam.reduce((total, seam) => total + seam.pairs.length / 2, 0) ?? 0,
      endpointAudit: endpoints,
      mismatchWarnings,
      warningCount: warnings.length,
      solverInputDigest: simData ? digestSimData(simData) : null
    });
  }

  const aggregate = {
    patterns: results.length,
    source3dPatterns: results.filter((result) => result.source3dEnabled).length,
    importPass: results.filter((result) => result.importStatus === 'pass').length,
    simulationPass: results.filter((result) => result.simulationStatus === 'pass').length,
    simulationFail: results.filter((result) => result.simulationStatus === 'fail').length,
    notApplicable: results.filter((result) => result.simulationStatus === 'not-applicable').length,
    sourceSeams: results.reduce((total, result) => total + result.sourceSeams, 0),
    source3dSeams: results.filter((result) => result.source3dEnabled)
      .reduce((total, result) => total + result.sourceSeams, 0),
    imported3dSeams: results.filter((result) => result.source3dEnabled)
      .reduce((total, result) => total + result.importedSeams, 0),
    simulatedSeams: results.reduce((total, result) => total + result.simulatedSeams, 0),
    missingRuns: results.reduce((total, result) => total + (result.endpointAudit?.missingRuns ?? 0), 0),
    referencedEndpoints: results.reduce((total, result) => total + (result.endpointAudit?.referencedEndpoints ?? 0), 0),
    pairedEndpoints: results.reduce((total, result) => total + (result.endpointAudit?.pairedEndpoints ?? 0), 0),
    mismatchWarnings: results.reduce((total, result) => total + result.mismatchWarnings.length, 0)
  };
  aggregate.endpointCoverage = aggregate.referencedEndpoints
    ? aggregate.pairedEndpoints / aggregate.referencedEndpoints
    : 1;

  const audit = {
    generatedAt: new Date().toISOString(),
    target: 'SeamScape XPBD WebGPU defaults',
    defaults: {
      particleDistanceMm: 10,
      timeStep: config.SIM_CONFIG.timeStep,
      subSteps: config.SIM_CONFIG.subSteps,
      gravity: config.SIM_CONFIG.gravity,
      minVelocity: config.SIM_CONFIG.minVelocity,
      maxVelocity: config.SIM_CONFIG.maxVelocity,
      seamStrength: config.SIM_CONFIG.seamStrength
    },
    aggregate,
    patterns: results
  };
  writeFileSync(outputJsonPath, `${JSON.stringify(audit, null, 2)}\n`);

  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  const rows = results.map((result) =>
    `| ${result.order} | ${result.name.replaceAll('|', '\\|')} | ${result.importStatus} | ${result.simulationStatus} | ${result.particles} | ${result.simulatedSeams}/${result.importedSeams}/${result.sourceSeams} | ${result.endpointAudit ? percent(result.endpointAudit.endpointCoverage) : '—'} | ${result.mismatchWarnings.length} |`
  );
  const markdown = `# SeamScape XPBD solver-input parity audit

This audit runs the archived public patterns through the combined legacy importer and the CPU-side
mesh/constraint preparation used by Seamer's WebGPU XPBD engine. A digest records every deterministic
solver input so future changes can be compared without relying on a screenshot.

- Import pass: ${aggregate.importPass}/${aggregate.patterns}
- Simulation preparation pass: ${aggregate.simulationPass}/${aggregate.source3dPatterns} source-3D patterns
- Seam definitions preserved by the importer: ${aggregate.imported3dSeams}/${aggregate.source3dSeams}
- Imported seam definitions simulated: ${aggregate.simulatedSeams}/${aggregate.imported3dSeams}
- Referenced seam endpoints paired: ${aggregate.pairedEndpoints}/${aggregate.referencedEndpoints} (${percent(aggregate.endpointCoverage)})
- Missing edge runs: ${aggregate.missingRuns}
- Particle-count/missing-run warnings: ${aggregate.mismatchWarnings}
- Source defaults: 10 mm particles, 16 ms frames, 40 substeps, minimum velocity 0 m/s

| # | Pattern | Import | Sim prep | Particles | Seams (sim/import/source) | Endpoint coverage | Mismatch warnings |
|---:|---|---|---|---:|---:|---:|---:|
${rows.join('\n')}

The digest in the JSON report covers 2D particle positions, triangles, seam adjacency, collision
layers, and all stretch/bend constraint buffers. It is a solver-input regression key, not a claim
that AVBD or browser/GPU performance is reproduced.
`;
  writeFileSync(outputMarkdownPath, markdown);
  console.log(JSON.stringify({ outputJsonPath, outputMarkdownPath, aggregate }, null, 2));
} finally {
  await server.close();
}
