/** Temporary sewing support acts only on Y. It never pins X/Z or changes inverse mass. */
export function assemblySupportWGSL(): string {
  return /* wgsl */ `
struct SupportParams { particleCount: u32, relaxation: f32, maxCorrection: f32, pad: f32 };
@group(0) @binding(0) var<storage, read_write> positions: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> targets: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: SupportParams;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.particleCount || positions[i].w <= 0.0 || targets[i].y <= 0.0) { return; }
  let correction = clamp((targets[i].x - positions[i].y) * targets[i].y * params.relaxation,
    -params.maxCorrection, params.maxCorrection);
  positions[i].y += correction;
}`;
}
