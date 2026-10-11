import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { createEmptyPattern, restoreAppearanceVersion, saveAppearanceVersion, type Pattern } from '@seamer/pattern-model';
import { createSSPArchive, readSSPEnvelope, sspToPattern } from './ssp';
const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const template=JSON.parse(readFileSync(new URL('../../../static/templates/pencil-skirt.json',import.meta.url),'utf8')) as Pattern;
it('archives historical uploaded/downloaded fabric maps, deduplicates pixels and restores without any network',async()=>{
  const document=createEmptyPattern();
  const material=structuredClone(template.materials[0]);material.id='history-fabric';
  material.frontTexture={...material.frontTexture!,url:'blob:old-uploaded-fabric',sourceMode:'uploaded',normalUrl:'/old-downloaded-normal.png',normalSourceMode:'downloaded'};
  material.backTexture={...material.backTexture!,url:'/explicitly-linked-fabric.png',sourceMode:'linked',normalUrl:'',opacityUrl:''};document.materials=[material];
  const saved=saveAppearanceVersion(document,'appearance','Historical fabric','2026-10-11');
  const current={...saved,materials:[]};
  const fetcher=vi.fn(async()=>new Response(Uint8Array.from(Buffer.from(pixel,'base64')),{headers:{'content-type':'image/png'}}));
  const exported=await createSSPArchive(current,{fetcher:fetcher as typeof fetch});
  expect(exported.manifest.unresolvedAssets).toEqual([]);expect(exported.manifest.assetCount).toBe(1);
  expect(fetcher.mock.calls).toHaveLength(2);
  const envelope=(await readSSPEnvelope(exported.blob))!;
  const archived=envelope.pattern.appearanceHistory!.versions[0].materials[0];
  expect(archived.frontTexture?.url).toBe('ssp-asset://asset-1');expect(archived.frontTexture?.normalUrl).toBe('ssp-asset://asset-1');
  expect(archived.backTexture?.url).toBe('/explicitly-linked-fabric.png');
  const noNetwork=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Offline'));
  try {const imported=await sspToPattern(exported.blob),restored=restoreAppearanceVersion(imported,'appearance');
    expect(restored.materials[0].frontTexture?.url).toBe(`data:image/png;base64,${pixel}`);
    expect(restored.materials[0].frontTexture?.normalUrl).toBe(`data:image/png;base64,${pixel}`);
    expect(noNetwork).not.toHaveBeenCalled();expect(current.appearanceHistory!.versions[0].materials[0].frontTexture?.url).toBe('blob:old-uploaded-fabric');
  }finally{noNetwork.mockRestore();}
});
it('reports an unavailable historical fabric as unresolved rather than claiming an offline archive',async()=>{
  const document=createEmptyPattern(),material=structuredClone(template.materials[0]);
  material.frontTexture={...material.frontTexture!,url:'blob:unavailable-history',sourceMode:'uploaded',normalUrl:'',opacityUrl:''};material.backTexture=null;document.materials=[material];
  const saved=saveAppearanceVersion(document,'v','Unavailable map','2026-10-11');
  const archived=await createSSPArchive({...saved,materials:[]},{fetcher:vi.fn(async()=>new Response('',{status:404})) as typeof fetch});
  expect(archived.manifest.unresolvedAssets).toEqual(['blob:unavailable-history']);
  expect((await sspToPattern(archived.blob)).appearanceHistory!.versions[0].materials[0].frontTexture?.url).toBe('blob:unavailable-history');
});
