import type { Pattern } from '@seamer/pattern-model';
import { activeGarmentCodeBody } from '@seamer/avatar';
import type { ApprovedGatherEvidence, GatherBuildScope } from '@seamer/cloth-sim';
import { sourceGatherIdentity } from '@seamer/cloth-sim';
import { convertGarmentCodePattern, isGarmentCodeFormat } from './importGarmentCode';

export const GATHER_EVIDENCE_REVISION = 'garmentcode-resolved-gather-evidence-v1';
export const CANONICAL_ENCODING = 'typed-json-ieee754-f64be-v1';
type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fail(message: string): never { throw Error(`Unverified source gathering: ${message}`); }
function tagged(value: unknown,canonical=true): unknown {
  if(value===null)return ['z'];
  if(typeof value==='boolean')return ['b',value];
  if(typeof value==='string')return ['s',value];
  if(typeof value==='number') {
    if(!Number.isFinite(value))fail('nonfinite provenance number');
    const bytes=new Uint8Array(8);new DataView(bytes.buffer).setFloat64(0,value,false);
    return ['n',Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('')];
  }
  if(Array.isArray(value))return ['a',value.map(item=>tagged(item,canonical))];
  if(object(value))return ['o',(canonical?Object.keys(value).sort():Object.keys(value)).map(key=>[key,tagged(value[key],canonical)])];
  fail('unsupported provenance value');
}
/** Persist exact source numbers AND panel dictionary order. Ordinary JSON stringify loses -0,
 * and canonical sorting would change GC_Piece numbering on reimport. This is data, never code. */
export function encodeOriginalGatherDocument(value:unknown):{encoding:'lossless-ieee754-json-tree-v1';value:unknown} {
  return {encoding:'lossless-ieee754-json-tree-v1',value:tagged(value,false)};
}
export function decodeOriginalGatherDocument(input:unknown):unknown {
  if(!object(input)||input.encoding!=='lossless-ieee754-json-tree-v1')fail('unsupported saved source encoding');
  function decode(value:unknown):unknown {
    if(!Array.isArray(value))fail('malformed saved source');
    if(value[0]==='z'&&value.length===1)return null;
    if(value.length!==2)fail('malformed saved source');
    if(value[0]==='b'&&typeof value[1]==='boolean')return value[1];
    if(value[0]==='s'&&typeof value[1]==='string')return value[1];
    if(value[0]==='n'&&typeof value[1]==='string'&&/^[a-f0-9]{16}$/.test(value[1])) {
      const bytes=Uint8Array.from(value[1].match(/../g)!,word=>parseInt(word,16));
      const number=new DataView(bytes.buffer).getFloat64(0,false);if(!Number.isFinite(number))fail('nonfinite saved source');return number;
    }
    if(value[0]==='a'&&Array.isArray(value[1]))return value[1].map(decode);
    if(value[0]==='o'&&Array.isArray(value[1])) {
      const result:Record<string,unknown>=Object.create(null);
      for(const row of value[1]) {
        if(!Array.isArray(row)||row.length!==2||typeof row[0]!=='string'||Object.hasOwn(result,row[0]))fail('duplicate/malformed saved source key');
        result[row[0]]=decode(row[1]);
      }
      return result;
    }
    fail('malformed saved source value');
  }
  return decode(input.value);
}
export async function canonicalSha256(value: unknown): Promise<string> {
  const bytes=new TextEncoder().encode(JSON.stringify(tagged(value)));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
}
/** SHA the exact source-cut identity already checked synchronously by the CPU refiner. */
export async function sourceCutSha256(pattern: Pattern): Promise<string> {
  return canonicalSha256(JSON.parse(sourceGatherIdentity(pattern)));
}
export interface GatherTrust {
  /** Supplied by the server bridge integration, never inferred from an uploaded document. */
  origin: 'trusted-generator-response' | 'explicit-authored-import';
  upstreamRevision: string;
  /** Deployment-owned hashes of the actual pinned Python sources; no garment-name allowlist. */
  programSha256: Readonly<Record<string,string>>;
}
export interface ValidatedGatherProvenance {
  revision: typeof GATHER_EVIDENCE_REVISION;
  encoding: typeof CANONICAL_ENCODING;
  evidenceSha256: string;
  sourcePatternSha256: string;
  sourceCutSha256: string;
  programSetSha256: string;
  upstreamRevision: string;
  origin: GatherTrust['origin'];
  seams: { seamId:string; longSide:0|1 }[];
}
/** Hashes are integrity bindings, not signatures. Caller trust is explicit and stays outside raw documents. */
export async function approveGeneratedGather(raw: unknown, pattern: Pattern, trust?: GatherTrust): Promise<{
  scope: GatherBuildScope; provenance: ValidatedGatherProvenance | null;
}> {
  const inactive={scope:{enabled:false,sourceBodyActive:false},provenance:null};
  if(!trust)return inactive;
  // Digests bind one immutable observation, never a mixture across awaits.
  raw=decodeOriginalGatherDocument(encodeOriginalGatherDocument(raw));
  pattern=JSON.parse(JSON.stringify(pattern)) as Pattern; trust=structuredClone(trust);
  if(!['trusted-generator-response','explicit-authored-import'].includes(trust.origin))fail('approval origin is not authorized');
  if(!isGarmentCodeFormat(raw)||!pattern.garmentCodeSource)fail('source document is missing');
  const evidence=raw.properties?.garmentcode_gather_evidence;
  if(evidence===undefined)return inactive;
  if(!object(evidence)||evidence.revision!==GATHER_EVIDENCE_REVISION||evidence.encoding!==CANONICAL_ENCODING)fail('unsupported evidence schema');
  if(evidence.upstreamRevision!==trust.upstreamRevision)fail('upstream revision differs from deployment');
  const {evidenceSha256,...unsigned}=evidence;
  if(typeof evidenceSha256!=='string'||await canonicalSha256(unsigned)!==evidenceSha256)fail('evidence digest does not match');
  if(await canonicalSha256(raw.pattern)!==evidence.sourcePatternSha256)fail('source cuts or stitches changed');
  if(await canonicalSha256(raw.properties?.garmentcode_body)!==await canonicalSha256(evidence.sourceBody))fail('source body differs');
  if(!object(evidence.resolvedDesign)||!object(evidence.sourceBody)||typeof evidence.preset!=='string')fail('resolved generator inputs are missing');
  if(!Array.isArray(evidence.programs)||!evidence.programs.length)fail('program provenance is missing');
  const programs=evidence.programs.map(value=>{
    if(!object(value)||typeof value.path!=='string'||typeof value.sha256!=='string'
      ||trust.programSha256[value.path]!==value.sha256)fail('a program checksum is not pinned');
    return {path:value.path,sha256:value.sha256};
  });
  if(new Set(programs.map(p=>p.path)).size!==programs.length)fail('duplicate program provenance');
  if(!programs.some(p=>p.path==='pygarment/garmentcode/interface.py')||!programs.some(p=>p.path==='pygarment/garmentcode/connector.py'))fail('Interface/stitching implementation is not bound');
  if(!Array.isArray(evidence.stitches))fail('resolved gather interfaces are missing');
  const seen=new Set<number>();
  const seams=evidence.stitches.map(row=>{
    if(!object(row)||!Number.isInteger(row.stitchIndex)||typeof row.stitchIndex!=='number'
      ||(row.longSide!==0&&row.longSide!==1)||row.evidence!=='actual-resolved-upstream-Interface.ruffle')fail('invalid resolved gather record');
    if(seen.has(row.stitchIndex))fail('duplicate resolved gather record');seen.add(row.stitchIndex);
    const stitch=raw.pattern.stitches?.[row.stitchIndex];
    if(!Array.isArray(stitch)||!Array.isArray(row.sides)||row.sides.length!==2)fail('gather record references a missing stitch');
    const sides=row.sides.map((side,index)=>{
      if(!object(side)||!object(stitch[index])||side.panel!==stitch[index].panel||side.edge!==stitch[index].edge
        ||typeof side.ruffleCoefficient!=='number'||!Number.isFinite(side.ruffleCoefficient)||side.ruffleCoefficient<=0
        ||typeof side.sourceArcLength!=='number'||!Number.isFinite(side.sourceArcLength)||side.sourceArcLength<=0
        ||JSON.stringify(side.sourceMaterialInterval)!=='[0,1]')fail('gather record does not bind the original cut edge');
      return {coefficient:side.ruffleCoefficient,length:side.sourceArcLength};
    });
    const long=row.longSide,short=1-long;
    if(sides[long].coefficient<=sides[short].coefficient+1e-3||sides[long].length<=sides[short].length)fail('claimed long side is not a resolved gather');
    const ratio=sides[long].length/sides[short].length,ruffle=sides[long].coefficient/sides[short].coefficient;
    if(Math.abs(ratio-ruffle)>Math.max(ratio,ruffle)*.002)fail('resolved gather ratio disagrees with its material lengths');
    if(typeof row.programPath!=='string'||!programs.some(p=>p.path===row.programPath)
      ||!Array.isArray(row.stylePath)||!row.stylePath.length||row.stylePath.some(p=>typeof p!=='string'))fail('resolved style path is not bound');
    const seamId=`GC_Seam${row.stitchIndex}`;
    if(!pattern.seams.some(s=>s.id===seamId))fail('imported seam dictionary differs');
    return {seamId,longSide:long as 0|1};
  });
  const cutSha=await sourceCutSha256(pattern),programSha=await canonicalSha256(programs);
  if(cutSha!==await sourceCutSha256(convertGarmentCodePattern(raw,'binding validation')))fail('imported cut or world placement differs from the source document');
  const approved:ApprovedGatherEvidence={sourceIdentity:sourceGatherIdentity(pattern),sourceIdentitySha256:cutSha,sourceIdentityEncoding:CANONICAL_ENCODING,
    upstreamProgramSha256:programSha,provenance:'pinned-upstream-gather-interface',seams,
    generation:{upstreamPrograms:programs,resolvedDesign:structuredClone(evidence.resolvedDesign),sourceBody:structuredClone(evidence.sourceBody),
      stylePath:evidence.stitches.map(row=>(row as ObjectValue).stylePath).map(path=>(path as string[]).join('/')).join(';')}};
  return {scope:{enabled:true,sourceBodyActive:!!activeGarmentCodeBody(pattern.body),approvedEvidence:approved},
    provenance:{revision:GATHER_EVIDENCE_REVISION,encoding:CANONICAL_ENCODING,evidenceSha256,sourcePatternSha256:evidence.sourcePatternSha256 as string,
      sourceCutSha256:cutSha,programSetSha256:programSha,upstreamRevision:trust.upstreamRevision,origin:trust.origin,seams}};
}
/** Hash before synchronous prepare/render install. Untrusted ordinary imports remain unchanged. */
export async function convertGeneratedGarmentCodeWithGather(value: unknown,name:string,trust?:GatherTrust) {
  const pattern=convertGarmentCodePattern(value,name);
  const approval=await approveGeneratedGather(value,pattern,trust);
  return {pattern,...approval};
}
