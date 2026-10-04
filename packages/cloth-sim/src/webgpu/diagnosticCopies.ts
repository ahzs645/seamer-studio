/** Default-off diagnostic copy. Integer bits are retained, including packed seed state. */
export function captureUint32WordsWGSL(): string {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> destination: array<u32>;
struct Params { sample: u32, p0: u32, p1: u32, p2: u32 }
@group(0) @binding(2) var<uniform> params: Params;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if(gid.x>=arrayLength(&source)) { return; }
  destination[params.sample*arrayLength(&source)+gid.x]=source[gid.x];
}`;
}
