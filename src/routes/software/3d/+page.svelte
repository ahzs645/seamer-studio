<script lang="ts">
</script>

<svelte:head>
  <title>3D Simulation — Seamer</title>
</svelte:head>

<div class="px-4 py-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold font-lexend mb-6">3D Simulation</h1>
  <div class="prose max-w-none">
    <p class="text-lg">
      See your pattern as a garment before you cut. Seamer triangulates your 2D pieces,
      arranges them around a measurement-driven avatar, sews them along their seams, and
      drapes them with a real-time GPU cloth simulation.
    </p>

    <h2 class="text-2xl font-bold mt-8">How it works</h2>
    <ol class="list-decimal pl-6 space-y-2">
      <li><strong>Triangulate</strong> — each closed piece is meshed at a configurable particle resolution.</li>
      <li><strong>Arrange</strong> — pieces attach to body cylinders (torso, arms, legs) with angular and axial placement, or lay flat.</li>
      <li><strong>Sew</strong> — seam definitions pull matching edges together, including mirrored left/right pairs.</li>
      <li><strong>Simulate</strong> — a GPU solver drapes the cloth with gravity, stretch (warp/weft), bending stiffness, thickness, and weight per material.</li>
    </ol>

    <h2 class="text-2xl font-bold mt-8">Materials that behave like fabric</h2>
    <p>
      Each material carries simulation parameters (stretch, bend, thickness, weight in g/m²)
      and PBR rendering properties (textures with physical tile scale, normal maps, roughness,
      opacity). A chiffon drapes like chiffon; a denim stands like denim.
    </p>

    <h2 class="text-2xl font-bold mt-8">Rendering</h2>
    <ul class="list-disc pl-6 space-y-2">
      <li>Multiple lighting modes: flat, HDRI, studio, and sunset environments</li>
      <li>Ambient occlusion, anti-aliasing, and depth-of-field controls</li>
      <li>Toggle seams, triangles, and arrangement points for debugging</li>
      <li>Self-collision handling and per-piece collision layers</li>
    </ul>

    <h2 class="text-2xl font-bold mt-8">The avatar</h2>
    <p>
      The body is reconstructed from real measurements using a statistical body model —
      see <a href="/bodydbl" class="link link-primary">Body Double</a> for details.
      Fit checks happen on the body the garment is actually for.
    </p>
  </div>

  <div class="mt-10 text-center">
    <a href="/studio" class="btn btn-accent btn-lg">Try It in the Studio</a>
  </div>
</div>
