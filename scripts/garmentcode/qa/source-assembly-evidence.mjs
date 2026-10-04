/** Source assembly eligibility is required by actual source provenance, not
 * exclusively by a legacy stretch solver. A caller cannot opt out with false.
 * Native artifacts without source provenance retain their existing behavior. */
export function requiresSourceAssemblyEvidence(...records) {
    return records.some(record => record != null && (
        record.sourceAssemblyRequired === true
        || record.sourceStretchPolicy != null
        || record.sourcePhysicalMembrane != null
        || record.sourcePhysicalMaterialPolicy != null
        || record.sourcePhysicalMaterialPolicySha256 != null
        || record.sourcePhysicalMaterialPreparationPolicy != null
        || record.sourceDeltaPolicy != null
        || record.sourceJointEnginePolicy != null
        || record.sourceJointPressureBinding != null
        || record.sourceExecutionBinding != null
        || record.sourceStaging != null
        || record.arrangementSourceStaging != null
        || record.sourceBodyMetadata != null
        || record.pattern?.garmentCodeSource != null
    ));
}
