import { describe, expect, it, vi } from 'vitest';
import { artworkGesture, artworkGestureCanStart } from './artworkGestures';
import { artworkRepeatTiles, artworkSurfaceProblem, vectorDesignProblem, paintVectorDesign } from './artworkSurface';
import { validateAppearanceHistory, validateArtworkSurface, createEmptyPattern, saveAppearanceVersion, restoreAppearanceVersion, removeAppearanceVersion, type PieceArtwork, type VectorArtworkDesign } from '@seamer/pattern-model';
const print:PieceArtwork={id:'a',pieceId:'p',name:'Print',dataUrl:'data:image/png;base64,AAAA',mimeType:'image/png',pixelWidth:2,pixelHeight:2,x:20,y:30,widthMm:20,heightMm:10,rotation:0,opacity:1};

describe('surface editing gestures and printable repeats',()=>{
  it('preserves source and draft dimensions during translate; rotates and proportionally resizes around center',()=>{
    const moved=artworkGesture(print,'translate',{x:21,y:32},{x:26,y:29});expect(moved).toMatchObject({x:25,y:27,widthMm:20,heightMm:10,dataUrl:print.dataUrl});
    const rotated=artworkGesture(print,'rotate',{x:30,y:30},{x:20,y:40});expect(rotated.rotation).toBeCloseTo(90);expect(rotated.x).toBe(20);
    const resized=artworkGesture(print,'resize',{x:30,y:30},{x:40,y:30});expect(resized.widthMm).toBe(40);expect(resized.heightMm).toBe(20);
    expect(artworkGesture(print,'resize',{x:20,y:30},{x:50,y:50})).toBe(print);
    expect(artworkGesture(print,'translate',{x:NaN,y:0},{x:1,y:1})).toBe(print);
  });
  it('offsets brick and half-drop repeats in the rotated canonical frame',()=>{
    const bounds={minX:0,maxX:100,minY:0,maxY:100};
    const brick=artworkRepeatTiles({...print,rotation:90,repeat:{mode:'brick',gapXmm:0,gapYmm:0}},bounds);
    expect(brick.some(tile=>Math.abs(tile.x-10)<1e-8&&Math.abs(tile.y-40)<1e-8)).toBe(true);
    const halfDrop=artworkRepeatTiles({...print,repeat:{mode:'half-drop',gapXmm:0,gapYmm:0}},bounds);
    expect(halfDrop.some(tile=>tile.x===40&&tile.y===35)).toBe(true);
    expect(()=>artworkRepeatTiles({...print,widthMm:.01,heightMm:.01,repeat:{mode:'grid',gapXmm:0,gapYmm:0}},bounds)).toThrow(/2048/);
  });
  it('rejects unsupported print zones and executable vector input',()=>{
    expect(artworkSurfaceProblem({...print,zone:[{x:0,y:0},{x:1,y:0},{x:0,y:NaN}]})).toMatch(/finite/);
    expect(artworkSurfaceProblem({...print,treatment:{blend:'multiply',tint:'url(javascript:alert(1))'}})).toMatch(/hex/);
    const design:VectorArtworkDesign={width:512,height:512,shapes:[{kind:'text',x:1,y:2,width:100,height:20,fill:'#000000',stroke:'#ffffff',strokeWidth:0,text:'<script>alert(1)</script>'}]};
    const context={clearRect:vi.fn(),beginPath:vi.fn(),fillText:vi.fn()};paintVectorDesign(context as unknown as CanvasRenderingContext2D,design);
    expect(context.fillText).toHaveBeenCalledWith('<script>alert(1)</script>',1,22,100);
    expect(vectorDesignProblem({...design,shapes:[{...design.shapes[0],kind:'script' as 'text'}]})).toMatch(/supported/);
  });
});

describe('real named appearance restoration',()=>{
  it('restores prints and fabric while retaining newer geometry and drape, independently of snapshots',()=>{
    const before=createEmptyPattern();before.artwork=[print];before.materials=[];
    const saved=saveAppearanceVersion(before,'v','First','2026-10-11T00:00:00Z');
    const edited={...saved,artwork:[{...print,x:99}],points:[{id:'new',x:12,y:16,name:'new'}]};
    const restored=restoreAppearanceVersion(edited,'v');expect(restored.artwork?.[0].x).toBe(20);expect(restored.points).toBe(edited.points);expect(restored.settings3d).toBe(edited.settings3d);
    restored.artwork![0].x=888;expect(restored.appearanceHistory?.versions[0].artwork?.[0].x).toBe(20);
    expect(removeAppearanceVersion(restored,'v').appearanceHistory?.versions).toEqual([]);
  });
  it('requires names, valid dates and bounded histories instead of silently pruning',()=>{
    let document=createEmptyPattern();expect(()=>saveAppearanceVersion(document,'a',' ','2026-10-11')).toThrow(/name/);
    expect(()=>saveAppearanceVersion(document,'a','Version','invalid')).toThrow(/timestamp/);
    for(let i=0;i<8;i++)document=saveAppearanceVersion(document,String(i),'Version','2026-10-11');
    expect(()=>saveAppearanceVersion(document,'9','Version','2026-10-11')).toThrow(/eight/);
  });
});

it('rejects malicious structured appearance history before restore',()=>{
  const saved=saveAppearanceVersion(createEmptyPattern(),'v','Safe','2026-10-11');
  expect(()=>validateAppearanceHistory({...saved.appearanceHistory,versions:[{...saved.appearanceHistory!.versions[0],pieces:[{id:'p',materialId:{bad:true}}]}]})).toThrow();
  expect(()=>validateAppearanceHistory({...saved.appearanceHistory,versions:[{...saved.appearanceHistory!.versions[0],artwork:[{...print,vectorDesign:{width:512,height:512,shapes:[{kind:'script'}]}}]}]})).toThrow();
  expect(()=>validateArtworkSurface({...print,repeat:null})).toThrow();
  expect(()=>validateArtworkSurface({...print,zone:{length:3}})).toThrow();
});

it('invalid repair placements and nonfinite source UV never capture an artwork gesture',()=>{
  for(const patch of [{widthMm:0},{heightMm:0},{widthMm:-1},{widthMm:NaN},{opacity:2}]){
    const broken={...print,...patch};expect(artworkGestureCanStart(broken,{x:print.x,y:print.y})).toBe(false);
    expect(artworkGesture(broken,'resize',{x:print.x,y:print.y},{x:90,y:90})).toBe(broken);
  }
  expect(artworkGestureCanStart(print,{x:Infinity,y:0})).toBe(false);
  expect(artworkGestureCanStart({...print,widthMm:30},{x:print.x,y:print.y})).toBe(true);
});
