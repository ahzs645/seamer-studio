import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
// Compact samples inherit immutable topology/source geometry only, never runtime observations.
export const IMMUTABLE_SAMPLE_FIELDS = ['id','fixture','provenance','inputSha256','inputOrder','sourceFingerprints','spacingMm','sourceFitRevision','sourceAssemblyRevision','sourceFitFingerprint','sourceBodyMetadata','pattern','cuffEdges','seamPairs','seams','stitchCount','freshPositions','sourceArrangedPositions','arrangedPositions','bodyPositions','bodyIndices','joints','bodyAnatomicalReferences','clothTriangles','pieces','automaticPose','assemblySupport','simulatedSecondsPerFrame','simulationConfig','contactPolicy','benchmarkPolicy','freshness','sourceStaging','arrangementSourceStaging','collisionSeamDictionary','sourceStretchPolicy','sourceAssemblyRequired','sourcePhysicalMembrane','sourcePhysicalMaterialPolicy','sourcePhysicalMaterialPreparationPolicy','sourcePhysicalMaterialPolicySha256','sourceJointEnginePolicy','sourceJointPressureBinding','sourceExecutionBinding','sourceDeltaPolicy','bodySourceFingerprints','bodyReplayContract','materialGeometryLineage'];
export async function readFrozenSample(file) {
    const sample = JSON.parse(await readFile(file,'utf8'));
    if (!sample.staticSource) return sample;
    const source = JSON.parse(await readFile(resolve(dirname(file),sample.staticSource),'utf8'));
    if (source.staticSource) throw Error('Nested static sample references are not supported');
    const common = Object.fromEntries(IMMUTABLE_SAMPLE_FIELDS.filter(k=>k in source).map(k=>[k,source[k]]));
    for (const key of IMMUTABLE_SAMPLE_FIELDS) if (key in sample && JSON.stringify(sample[key]) !== JSON.stringify(common[key])) throw Error('Sample changed immutable '+key);
    return { ...common, ...sample };
}
