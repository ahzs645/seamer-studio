<script lang="ts">
  // Live 3D preview of a fabric material on a draped cloth swatch (the original's MaterialPreview3D
  // rendered /3d/fabric.obj, which isn't in the asset mirror — a sine-displaced plane gives the same
  // soft-fold read). Transparent background, 5-light rig, wheel zoom, exposure 1.6.
  import { onMount, onDestroy } from 'svelte';
  import * as THREE from 'three';
  import type { Material } from '@seamer/pattern-model';
  import { createGarmentMaterial, disposeGarmentMaterial } from '$lib/scene/materials';

  let { material }: { material: Material } = $props();

  let el: HTMLDivElement;
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let mesh: THREE.Mesh | null = null;
  let raf = 0;
  let zoom = 1;

  /** Soft-folded square swatch, 500 mm across, with mm-scaled UVs (garment materials tile in mm). */
  function drapedClothGeometry(): THREE.BufferGeometry {
    const size = 0.5; // meters
    const geo = new THREE.PlaneGeometry(size, size, 48, 48);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      pos.setZ(i, 0.022 * Math.sin(x * 18 + 1.2) * Math.cos(y * 14) + 0.012 * Math.sin(y * 26));
    }
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * size * 1000, uv.getY(i) * size * 1000);
    geo.computeVertexNormals();
    return geo;
  }

  function applyMaterial(m: Material) {
    if (!mesh) return;
    const old = mesh.material as THREE.Material;
    mesh.material = createGarmentMaterial(m, false);
    disposeGarmentMaterial(old);
  }

  onMount(() => {
    const w = el.clientWidth || 200;
    const h = 140;
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.6;
    el.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(36, w / h, 0.01, 10);
    camera.position.set(0, 0.12, 0.62);
    camera.lookAt(0, 0, 0);

    // the original's 5-light rig: ambient + hemisphere + key + two colored fills
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(1, 1.4, 1.2);
    scene.add(key);
    const warm = new THREE.DirectionalLight(0xfff0d8, 0.5);
    warm.position.set(-1.2, 0.6, 0.4);
    scene.add(warm);
    const cool = new THREE.DirectionalLight(0xdce6ff, 0.4);
    cool.position.set(0.4, -0.4, -1);
    scene.add(cool);

    mesh = new THREE.Mesh(drapedClothGeometry(), createGarmentMaterial(material, false));
    mesh.rotation.x = -0.45;
    scene.add(mesh);

    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!renderer || !scene || !camera || !mesh) return;
      mesh.rotation.z += 0.0035; // slow turntable
      camera.position.setLength(0.62 / zoom);
      renderer.render(scene, camera);
    };
    loop();
  });

  // live-update the swatch when the edited material changes
  $effect(() => { applyMaterial(material); });

  onDestroy(() => {
    cancelAnimationFrame(raf);
    if (mesh) {
      mesh.geometry.dispose();
      disposeGarmentMaterial(mesh.material as THREE.Material);
    }
    renderer?.dispose();
    renderer = null;
  });
</script>

<div
  bind:this={el}
  class="w-full h-[140px] rounded bg-base-300/40 overflow-hidden"
  onwheel={(e) => { e.preventDefault(); zoom = Math.max(0.6, Math.min(3, zoom * (e.deltaY > 0 ? 0.92 : 1.08))); }}
></div>
