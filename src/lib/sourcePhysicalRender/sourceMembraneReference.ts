/** Isolated Float64 CPU reference. No GPU/runtime dependency or garment defaults. */
export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
export type Mat3 = readonly [Vec3, Vec3, Vec3];
export interface TriangleMaterial {
  ids: readonly [number, number, number];
  areaM2: number;
  shapeGradientsPerM: readonly [Vec2, Vec2, Vec2];
  sheetTensorNPerM: Mat3;
  compliancePerJoule: Mat3;
}
export interface MembraneInput {
  restPointsM: readonly Vec2[];
  triangles: readonly (readonly [number, number, number])[];
  grainDirections: readonly Vec2[];
  densityKgPerM2: number;
  sheetTensorNPerM: Mat3;
  capturedInverseMass: readonly number[];
  benchmarkId: string;
  parameterProvenance: string;
}
export interface PreparedMembrane {
  triangles: readonly TriangleMaterial[];
  physicalMassesKg: readonly number[];
  inverseMassPerKg: readonly number[];
  totalMassKg: number;
  firstMomentKgM: Vec2;
  policy: Readonly<Record<string, unknown>>;
}
const frozen2 = (x: number, y: number): Vec2 => Object.freeze([x, y]) as Vec2;
const frozen3 = (x: number, y: number, z: number): Vec3 => Object.freeze([x, y, z]) as Vec3;
const matrix = (a: readonly (readonly number[])[]): Mat3 => {if(a.length!==3)throw Error('Finite3x3 matrix required');a.forEach(row=>finiteVector(row,3,'matrix'));return Object.freeze(a.map(row => frozen3(row[0], row[1], row[2]))) as Mat3;};
const zero = (): Vec3 => frozen3(0, 0, 0);
const dot = (a: Vec3, b: Vec3): number => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const add = (a: Vec3, b: Vec3): Vec3 => frozen3(a[0]+b[0],a[1]+b[1],a[2]+b[2]);
const scale = (a: Vec3, k: number): Vec3 => frozen3(a[0]*k,a[1]*k,a[2]*k);
function finiteVector(a: readonly number[], length: number, label: string): void {
  if (a.length!==length || !a.every(Number.isFinite)) throw Error('Invalid finite '+label);
}
function positive(x: number, label: string): void { if (!(Number.isFinite(x)&&x>0)) throw Error('Explicit positive SI '+label+' required'); }
function cholesky(a: Mat3): number[][] {
  if(a.length!==3)throw Error('3x3 tensor required');
  for(let i=0;i<3;i++){finiteVector(a[i],3,'tensor');for(let j=0;j<3;j++)if(a[i][j]!==a[j][i])throw Error('Symmetric tensor required');}
  const l=Array.from({length:3},()=>[0,0,0]);
  for(let i=0;i<3;i++)for(let j=0;j<=i;j++){
    let s=a[i][j];for(let k=0;k<j;k++)s-=l[i][k]*l[j][k];
    if(i===j){if(!(s>0&&Number.isFinite(s)))throw Error('Positive definite tensor required');l[i][j]=Math.sqrt(s);}
    else l[i][j]=s/l[j][j];
  }
  return l;
}
function solveWithCholesky(l: number[][], b: Vec3): Vec3 {
  const y=[0,0,0],x=[0,0,0];
  for(let i=0;i<3;i++){let s=b[i];for(let j=0;j<i;j++)s-=l[i][j]*y[j];y[i]=s/l[i][i];}
  for(let i=2;i>=0;i--){let s=y[i];for(let j=i+1;j<3;j++)s-=l[j][i]*x[j];x[i]=s/l[i][i];}
  finiteVector(x,3,'linear solution');return frozen3(x[0],x[1],x[2]);
}
export function solveSPD(a: Mat3,b: Vec3): Vec3 {finiteVector(b,3,'right hand side');return solveWithCholesky(cholesky(a),b);}
export function inverseSPD(a: Mat3): Mat3 {
  const l=cholesky(a),inverseL=Array.from({length:3},()=>[0,0,0]);
  for(let col=0;col<3;col++)for(let i=0;i<3;i++){
    let s=i===col?1:0;for(let j=0;j<i;j++)s-=l[i][j]*inverseL[j][col];inverseL[i][col]=s/l[i][i];
  }
  const inverse=Array.from({length:3},(_,i)=>Array.from({length:3},(_,j)=>inverseL.reduce((s,row)=>s+row[i]*row[j],0)));
  inverse.forEach(row=>finiteVector(row,3,'inverse tensor'));return matrix(inverse);
}
export function prepareMembrane(input: MembraneInput): PreparedMembrane {
  positive(input.densityKgPerM2,'density');
  if(!input.benchmarkId||!input.parameterProvenance)throw Error('Explicit benchmark and parameter provenance required');
  if(!input.restPointsM.length||input.restPointsM.some(p=>p.length!==2||!p.every(Number.isFinite)))throw Error('Finite SI cut coordinates required');
  if(input.grainDirections.length!==input.triangles.length||!input.triangles.length)throw Error('Explicit grain for every triangle required');
  if(input.capturedInverseMass.length!==input.restPointsM.length||input.capturedInverseMass.some(w=>!Number.isFinite(w)||w<0))throw Error('Captured fixed mobility mask required');
  const tensor=matrix(input.sheetTensorNPerM),inverse=inverseSPD(tensor),masses=Array(input.restPointsM.length).fill(0) as number[];
  const triangles=input.triangles.map((ids,t): TriangleMaterial=>{
    if(ids.length!==3||new Set(ids).size!==3||ids.some(i=>!Number.isInteger(i)||i<0||i>=input.restPointsM.length))throw Error('Valid distinct triangle indices required');
    const [a,b,c]=ids.map(i=>input.restPointsM[i]),d1=frozen2(b[0]-a[0],b[1]-a[1]),d2=frozen2(c[0]-a[0],c[1]-a[1]),g=input.grainDirections[t];finiteVector(g,2,'grain');const gl=Math.hypot(...g);positive(gl,'grain length');
    const gx=g[0]/gl,gy=g[1]/gl,m00=d1[0]*gx+d1[1]*gy,m01=d2[0]*gx+d2[1]*gy,m10=-d1[0]*gy+d1[1]*gx,m11=-d2[0]*gy+d2[1]*gx,det=m00*m11-m01*m10;
    const shapeQuality=Math.abs(det)/(Math.hypot(...d1)*Math.hypot(...d2));
    if(!(Number.isFinite(shapeQuality)&&shapeQuality>1e-12))throw Error('Degenerate or numerically singular rest triangle');
    const area=Math.abs(det)/2,i00=m11/det,i01=-m01/det,i10=-m10/det,i11=m00/det;
    const grad=Object.freeze([frozen2(-i00-i10,-i01-i11),frozen2(i00,i01),frozen2(i10,i11)]) as readonly[Vec2,Vec2,Vec2];
    for(const id of ids)masses[id]+=input.densityKgPerM2*area/3;
    return Object.freeze({ids:Object.freeze([...ids]) as readonly[number,number,number],areaM2:area,shapeGradientsPerM:grad,sheetTensorNPerM:tensor,compliancePerJoule:matrix(inverse.map(row=>row.map(v=>v/area)))});
  });
  if(masses.some(m=>!(m>0&&Number.isFinite(m))))throw Error('Positive incident physical mass required for every particle');
  const weights=masses.map((m,i)=>input.capturedInverseMass[i]===0?0:1/m);weights.forEach(w=>{if(!Number.isFinite(w))throw Error('Unusable inverse physical mass');});
  const policy=Object.freeze({revision:'source-si-objective-triangle-reference-v1',validationStatus:'isolated-cpu-and-primitive-benchmark-only',runtimePromotionAllowed:false,benchmarkId:input.benchmarkId,parameterProvenance:input.parameterProvenance,densityKgPerM2:input.densityKgPerM2,sheetTensorNPerM:tensor,restPointsM:Object.freeze(input.restPointsM.map(p=>frozen2(...p))),triangleIds:Object.freeze(triangles.map(t=>t.ids)),grainDirections:Object.freeze(input.grainDirections.map(g=>frozen2(...g))),fixedMobilityMask:Object.freeze(input.capturedInverseMass.map(w=>w===0)),strain:'Green [E11,E22,2E12] in authored grain coordinates',energy:'area0/2 * strain^T * sheetTensor[N/m] * strain',compliance:'inverse(area0*sheetTensor) [1/J]',mass:'sum incident rest triangle density*area/3 [kg]',lambda:'reset per physical prediction, coupled accumulation within repeated material iterations',lambdaUnits:'kg*m^2; physical energy multiplier=lambda/dt^2[J]',solver:'Float64 sequential triangle reference, exact3x3SPD Cholesky solve, no damping/contact/sewing'});
  return Object.freeze({triangles:Object.freeze(triangles),physicalMassesKg:Object.freeze(masses),inverseMassPerKg:Object.freeze(weights),totalMassKg:masses.reduce((s,m)=>s+m,0),firstMomentKgM:frozen2(...[0,1].map(k=>masses.reduce((s,m,i)=>s+m*input.restPointsM[i][k],0)) as [number,number]),policy});
}
export interface TriangleEvaluation {
  deformationColumns: readonly [Vec3, Vec3];
  strain: Vec3;
  strainGradients: readonly (readonly [Vec3,Vec3,Vec3])[];
  energyJ: number;
  energyGradientsN: readonly Vec3[];
}
export function evaluateTriangle(triangle: TriangleMaterial, positionsM: readonly Vec3[]): TriangleEvaluation {
  const points=triangle.ids.map(i=>positionsM[i]);points.forEach(p=>{if(!p)throw Error('Missing triangle position');finiteVector(p,3,'position');});
  const d1=add(points[1],scale(points[0],-1)),d2=add(points[2],scale(points[0],-1)),cross=frozen3(d1[1]*d2[2]-d1[2]*d2[1],d1[2]*d2[0]-d1[0]*d2[2],d1[0]*d2[1]-d1[1]*d2[0]);
  const quality=Math.hypot(...cross)/(Math.hypot(...d1)*Math.hypot(...d2));if(!(Number.isFinite(quality)&&quality>1e-12))throw Error('Degenerate current triangle has no reference material certificate');
  const f0=add(scale(d1,triangle.shapeGradientsPerM[1][0]),scale(d2,triangle.shapeGradientsPerM[2][0])),f1=add(scale(d1,triangle.shapeGradientsPerM[1][1]),scale(d2,triangle.shapeGradientsPerM[2][1])),strain=frozen3((dot(f0,f0)-1)/2,(dot(f1,f1)-1)/2,dot(f0,f1));
  finiteVector(strain,3,'strain');
  const gradients=triangle.shapeGradientsPerM.map(([a,b])=>Object.freeze([scale(f0,a),scale(f1,b),add(scale(f1,a),scale(f0,b))]) as readonly[Vec3,Vec3,Vec3]);
  const stress=frozen3(...triangle.sheetTensorNPerM.map(row=>dot(row,strain)) as [number,number,number]);
  const energy=triangle.areaM2*dot(strain,stress)/2;if(!Number.isFinite(energy))throw Error('Unusable membrane energy');
  const energyGradients=gradients.map(row=>row.reduce((s,g,a)=>add(s,scale(g,triangle.areaM2*stress[a])),zero()));
  gradients.forEach(row=>row.forEach(g=>finiteVector(g,3,'strain gradient')));energyGradients.forEach(g=>finiteVector(g,3,'energy gradient'));
  return{deformationColumns:[f0,f1],strain,strainGradients:gradients,energyJ:energy,energyGradientsN:energyGradients};
}
export function iterateTriangle(triangle: TriangleMaterial,positionsM: readonly Vec3[],inverseMassPerKg: readonly number[],dtSeconds:number,lambdaKgM2:Vec3): {positionsM:Vec3[];lambdaKgM2:Vec3;deltaLambdaKgM2:Vec3;normalMatrix:Mat3} {
  positive(dtSeconds,'physical timestep');finiteVector(lambdaKgM2,3,'lambda');
  if(positionsM.length!==inverseMassPerKg.length||inverseMassPerKg.some(w=>!Number.isFinite(w)||w<0))throw Error('Valid physical inverse masses required');
  const e=evaluateTriangle(triangle,positionsM),alpha=matrix(triangle.compliancePerJoule.map(row=>row.map(v=>v/(dtSeconds*dtSeconds))));
  const h=matrix(alpha.map((row,a)=>row.map((v,b)=>v+triangle.ids.reduce((s,id,i)=>s+inverseMassPerKg[id]*dot(e.strainGradients[i][a],e.strainGradients[i][b]),0))));
  const rhs=frozen3(...[0,1,2].map(a=>-e.strain[a]-dot(alpha[a],lambdaKgM2)) as [number,number,number]),delta=solveSPD(h,rhs),next=positionsM.map(p=>frozen3(...p));
  triangle.ids.forEach((id,i)=>{if(inverseMassPerKg[id]===0)return;const correction=e.strainGradients[i].reduce((s,g,a)=>add(s,scale(g,inverseMassPerKg[id]*delta[a])),zero());next[id]=add(next[id],correction);finiteVector(next[id],3,'corrected position');});
  return{positionsM:next,lambdaKgM2:add(lambdaKgM2,delta),deltaLambdaKgM2:delta,normalMatrix:h};
}
export function materialForces(prepared: PreparedMembrane,positionsM:readonly Vec3[],lambdaKgM2:readonly Vec3[],dtSeconds:number): Vec3[] {
  positive(dtSeconds,'physical timestep');if(lambdaKgM2.length!==prepared.triangles.length)throw Error('Exact per-triangle lambda required');const forces=positionsM.map(()=>zero());
  prepared.triangles.forEach((tri,t)=>{finiteVector(lambdaKgM2[t],3,'lambda');const e=evaluateTriangle(tri,positionsM);tri.ids.forEach((id,i)=>{forces[id]=add(forces[id],e.strainGradients[i].reduce((s,g,a)=>add(s,scale(g,lambdaKgM2[t][a]/(dtSeconds*dtSeconds))),zero()));});});return forces;
}
export function solvePrediction(prepared:PreparedMembrane,predictedPositionsM:readonly Vec3[],dtSeconds:number,iterations:number): {positionsM:Vec3[];lambdaKgM2:Vec3[];materialForcesN:Vec3[]} {
  positive(dtSeconds,'physical timestep');if(!Number.isInteger(iterations)||iterations<1||iterations>1024)throw Error('Explicit bounded iteration count required');if(predictedPositionsM.length!==prepared.inverseMassPerKg.length)throw Error('Exact mesh positions required');predictedPositionsM.forEach(p=>finiteVector(p,3,'prediction'));
  let positions=predictedPositionsM.map(p=>frozen3(...p));const lambdas=prepared.triangles.map(()=>zero());
  for(let iteration=0;iteration<iterations;iteration++)for(let t=0;t<prepared.triangles.length;t++){const result=iterateTriangle(prepared.triangles[t],positions,prepared.inverseMassPerKg,dtSeconds,lambdas[t]);positions=result.positionsM;lambdas[t]=result.lambdaKgM2;}
  return{positionsM:positions,lambdaKgM2:lambdas,materialForcesN:materialForces(prepared,positions,lambdas,dtSeconds)};
}
export function fixedSupportReactions(prepared:PreparedMembrane,materialForcesN:readonly Vec3[],externalForcesN:readonly Vec3[]):Vec3[] {
  if(materialForcesN.length!==prepared.physicalMassesKg.length||externalForcesN.length!==materialForcesN.length)throw Error('Every nodal force, including fixed masses, required');
  return materialForcesN.map((f,i)=>{finiteVector(f,3,'material force');finiteVector(externalForcesN[i],3,'external force');return prepared.inverseMassPerKg[i]===0?scale(add(f,externalForcesN[i]),-1):zero();});
}
