<script lang="ts">
  import { paintVectorDesign, vectorDesignProblem } from '$lib/utils/artworkSurface';
  import type { VectorArtworkDesign, ArtworkSource } from '@seamer/pattern-model';
  let { oncreate, disabled=false, initialDesign }: {initialDesign?:VectorArtworkDesign;oncreate:(source:ArtworkSource,design:VectorArtworkDesign)=>void;disabled?:boolean}=$props();
  let design=$state<VectorArtworkDesign>({width:512,height:512,shapes:[]});
  let kind=$state<'rectangle'|'ellipse'|'line'|'text'>('rectangle');
  let fill=$state('#8b5cf6'), stroke=$state('#111827'), text=$state('SEAMER');
  let x=$state(32),y=$state(32),width=$state(240),height=$state(160),strokeWidth=$state(0);
  let canvas:HTMLCanvasElement;
  let error=$state('');
  $effect(()=>{design=initialDesign?structuredClone(initialDesign):{width:512,height:512,shapes:[]};});
  $effect(()=>{if(canvas){const context=canvas.getContext('2d');if(context)paintVectorDesign(context,design);}});
  function add(){const next={...design,shapes:[...design.shapes,{kind,x,y,width,height,fill,stroke,strokeWidth,text:kind==='text'?text:undefined}]};const problem=vectorDesignProblem(next);if(problem){error=problem;return;}design=next;error='';}
  function create(){if(!design.shapes.length)return;const problem=vectorDesignProblem(design);if(problem){error=problem;return;}oncreate({dataUrl:canvas.toDataURL('image/png'),mimeType:'image/png',pixelWidth:design.width,pixelHeight:design.height},$state.snapshot(design));}
</script>
<details class="rounded-lg border border-base-300 p-2" data-testid="vector-artwork-editor">
  <summary class="text-xs font-medium cursor-pointer">Create vector artwork</summary>
  <p class="text-[11px] opacity-60 mt-1">Draw local primitives and save an embedded PNG with its editable design. No external SVG code is loaded.</p>
  <canvas bind:this={canvas} width={design.width} height={design.height} class="w-full bg-base-200 mt-2" aria-label="Vector artwork preview"></canvas>
  <div class="grid grid-cols-2 gap-2 text-xs mt-2">
    <label>Shape<select class="select select-xs w-full" bind:value={kind}><option value="rectangle">Rectangle</option><option value="ellipse">Ellipse</option><option value="line">Line</option><option value="text">Text</option></select></label>
    <label>Fill<input type="color" bind:value={fill} aria-label="Vector fill colour" /></label>
    <label>X<input type="number" class="input input-xs w-full" bind:value={x} /></label><label>Y<input type="number" class="input input-xs w-full" bind:value={y} /></label>
    <label>Width<input type="number" class="input input-xs w-full" min="0" bind:value={width} /></label><label>Height / font size<input type="number" class="input input-xs w-full" min="0" bind:value={height} /></label>
    <label>Stroke<input type="color" bind:value={stroke} /></label><label>Stroke width<input type="number" class="input input-xs w-full" min="0" max="100" bind:value={strokeWidth} /></label>
  </div>
  {#if kind==='text'}<label class="text-xs">Text<input class="input input-xs w-full" maxlength="200" bind:value={text} /></label>{/if}
  <div class="flex flex-wrap gap-1 mt-2"><button class="btn btn-xs" {disabled} onclick={add}>Add shape</button><button class="btn btn-xs btn-ghost" disabled={disabled||!design.shapes.length} onclick={()=>design={...design,shapes:design.shapes.slice(0,-1)}}>Undo shape</button><button class="btn btn-xs btn-primary" disabled={disabled||!design.shapes.length} onclick={create}>Add vector print</button></div>
  {#if error}<p role="alert" class="text-xs text-error">{error}</p>{/if}
</details>
