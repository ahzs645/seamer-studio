/** Synchronous SHA256 is used before ANY GPU allocation; WebCrypto independently binds preparation. */
const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
const rotate = (x: number, n: number) => (x >>> n) | (x << (32 - n));
export function sha256UTF8(text: string): string {
  const input = new TextEncoder().encode(text), padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  padded.set(input); padded[input.length] = 0x80;
  const view = new DataView(padded.buffer), bitLength = input.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000), false); view.setUint32(padded.length - 4, bitLength >>> 0, false);
  const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]), w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      w[i] = w[i - 16] + (rotate(a,7)^rotate(a,18)^(a>>>3)) + w[i - 7] + (rotate(b,17)^rotate(b,19)^(b>>>10));
    }
    let [a,b,c,d,e,f,g,j] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (j + (rotate(e,6)^rotate(e,11)^rotate(e,25)) + ((e&f)^((~e)&g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotate(a,2)^rotate(a,13)^rotate(a,22)) + ((a&b)^(a&c)^(b&c))) >>> 0;
      j=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    [a,b,c,d,e,f,g,j].forEach((v,i) => { h[i] += v; });
  }
  return Array.from(h, v => v.toString(16).padStart(8,'0')).join('');
}

/** Copy all prepared source data; SharedArrayBuffer views become private ordinary buffers. */
export function snapshotMaterialInput<T>(input: T): T {
  if (input === null || typeof input !== 'object') {
    if (typeof input === 'function' || typeof input === 'symbol') throw Error('Non-data source preparation unsupported');
    return input;
  }
  if (ArrayBuffer.isView(input)) {
    const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice();
    if (input instanceof DataView) return new DataView(bytes.buffer) as T;
    const constructor = input.constructor as { new(buffer: ArrayBuffer): ArrayBufferView };
    return new constructor(bytes.buffer) as T;
  }
  if (input instanceof ArrayBuffer || typeof SharedArrayBuffer !== 'undefined' && input instanceof SharedArrayBuffer) return new Uint8Array(input).slice().buffer as T;
  if (input instanceof Map) return new Map(Array.from(input, ([k,v]) => [snapshotMaterialInput(k),snapshotMaterialInput(v)])) as T;
  if (input instanceof Set) return new Set(Array.from(input, snapshotMaterialInput)) as T;
  if (Array.isArray(input)) return input.map(snapshotMaterialInput) as T;
  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw Error('Plain prepared data required');
  return Object.fromEntries(Object.entries(input).map(([k,v]) => [k,snapshotMaterialInput(v)])) as T;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, v => v.toString(16).padStart(2,'0')).join('');
/** Exact signed-zero/typed-bit and dictionary-order binding of the actual executed preparation. */
export function materialContextJSON(input: unknown): string {
  const encode = (value: unknown): unknown => {
    if (typeof value === 'number') return { float64: hex(new Uint8Array(Float64Array.of(value).buffer)) };
    if (value === undefined) return { undefined: true };
    if (value === null || typeof value !== 'object') return value;
    if (ArrayBuffer.isView(value)) return { type:value.constructor.name,bytes:hex(new Uint8Array(value.buffer,value.byteOffset,value.byteLength)) };
    if (value instanceof ArrayBuffer || typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) return { type:value.constructor.name,bytes:hex(new Uint8Array(value)) };
    if (value instanceof Map) return { map:Array.from(value, ([k,v]) => [encode(k),encode(v)]) };
    if (value instanceof Set) return { set:Array.from(value,encode) };
    if (Array.isArray(value)) return value.map(encode);
    return Object.fromEntries(Object.keys(value).sort().map(k => [k,encode((value as Record<string,unknown>)[k])]));
  };
  const root = input && typeof input === 'object' && !Array.isArray(input) ? Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'sourcePhysicalMembrane')) : input;
  return JSON.stringify(encode(root));
}
