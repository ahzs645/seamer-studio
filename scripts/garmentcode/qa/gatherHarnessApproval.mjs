/** Explicit caller approval of validated source data; document claims never grant trust. */
export async function resolveHarnessGatherApproval(raw,pattern,{requested=false,trust},validator,encode) {
 if(!requested||raw?.properties?.garmentcode_gather_evidence===undefined)return {scope:undefined,provenance:null,trustSha256:null};
 // Capture caller trust and raw/model identity before WebCrypto awaits inside the validator.
 const capturedTrust=structuredClone(trust),capturedRaw=structuredClone(raw),patternBefore=JSON.stringify(pattern);
 const approved=await validator(capturedRaw,pattern,{origin:'explicit-authored-import',...capturedTrust});
 if(!approved.provenance||!approved.scope.enabled||!approved.scope.approvedEvidence?.seams.length)
  throw Error('Explicit source gathering requires verified pinned program, body, cuts and resolved design evidence.');
 const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'
  ?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(capturedTrust)));
 if(JSON.stringify(pattern)!==patternBefore)throw Error('The source body or garment changed while approving gathering.');
 const source=pattern.garmentCodeSource;if(!source)throw Error('Verified source import metadata is missing.');
 source.gatherProvenance=approved.provenance;source.gatherSourceDocument=encode(capturedRaw);
 return {scope:approved.scope,provenance:structuredClone(approved.provenance),trustSha256:Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('')};
}
