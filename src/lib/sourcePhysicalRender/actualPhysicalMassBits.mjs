/** Exact SI byte-hex -> U32LE context. Does not change W or normalize -0. */
export function actualPhysicalInverseMassBits(sim){
 const n=sim?.particleCount,q=sim?.positions,hex=sim?.sourcePhysicalMembrane?.policy?.physicalInverseMassBitsFloat32;
 if(!Number.isSafeInteger(n)||n<1||!(q instanceof Float32Array)||q.length!==n*4)throw Error('Actual prepared SI particle array required');
 if(typeof hex!=='string'||hex.length!==n*8||!/^[0-9a-f]+$/.test(hex))throw Error('Exact lowercase inverse-mass byte hex required');
 const bytes=new Uint8Array(n*4);for(let i=0;i<bytes.length;i++)bytes[i]=parseInt(hex.slice(i*2,i*2+2),16);
 const policy=new DataView(bytes.buffer),actual=new DataView(q.buffer,q.byteOffset,q.byteLength),bits=new Uint32Array(n);
 for(let p=0;p<n;p++){const w=policy.getFloat32(p*4,true);if(!Number.isFinite(w)||w<0)throw Error('Finite nonnegative SI inverse mass required');bits[p]=policy.getUint32(p*4,true);if(bits[p]!==actual.getUint32(p*16+12,true))throw Error('Actual prepared W differs from exact SI policy bits');}
 return bits;
}
