export { artworkSurfaceProblem, vectorDesignProblem } from '@seamer/pattern-model';
import { artworkPlacementProblem, type PieceArtwork, artworkSurfaceProblem, vectorDesignProblem, type VectorArtworkDesign, type Vec2 } from '@seamer/pattern-model';

/** Enumerate only copies intersecting the draft bounding box; excessive repeats fail visibly.
 * No silent truncation, so a preview and exported placement cannot disagree. */
export function artworkRepeatTiles(item: PieceArtwork, bounds: { minX:number; maxX:number; minY:number; maxY:number }): PieceArtwork[] {
  if (!item.repeat) return [item];
  if (artworkSurfaceProblem(item) || artworkPlacementProblem(item)) return [];
  const { gapXmm, gapYmm, mode } = item.repeat;
  const stepX = item.widthMm + gapXmm, stepY = item.heightMm + gapYmm;
  const corners = [[bounds.minX,bounds.minY],[bounds.maxX,bounds.minY],[bounds.maxX,bounds.maxY],[bounds.minX,bounds.maxY]];
  const radians = -item.rotation * Math.PI / 180;
  const local = corners.map(([x,y]) => ({ x: (x-item.x)*Math.cos(radians)-(y-item.y)*Math.sin(radians), y:(x-item.x)*Math.sin(radians)+(y-item.y)*Math.cos(radians) }));
  const x0 = Math.floor(Math.min(...local.map(p=>p.x))/stepX)-1, x1 = Math.ceil(Math.max(...local.map(p=>p.x))/stepX)+1;
  const y0 = Math.floor(Math.min(...local.map(p=>p.y))/stepY)-1, y1 = Math.ceil(Math.max(...local.map(p=>p.y))/stepY)+1;
  if ((x1-x0+1)*(y1-y0+1)>2048) throw Error('Repeat exceeds 2048 tiles on this piece. Increase the tile size or spacing.');
  const tiles: PieceArtwork[]=[];
  for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++) {
    const dx=(x+(mode==='brick' && Math.abs(y%2)===1?.5:0))*stepX;
    const dy=(y+(mode==='half-drop' && Math.abs(x%2)===1?.5:0))*stepY;
    const angle=item.rotation*Math.PI/180;
    const center={x:item.x+dx*Math.cos(angle)-dy*Math.sin(angle),y:item.y+dx*Math.sin(angle)+dy*Math.cos(angle)};
    tiles.push({...item,x:center.x,y:center.y,repeat:undefined});
  }
  return tiles;
}

/** Structured primitives only: never parse, display or execute external SVG markup. */
export function paintVectorDesign(context: CanvasRenderingContext2D, design: VectorArtworkDesign): void {
  const problem=vectorDesignProblem(design); if(problem) throw Error(problem);
  context.clearRect(0,0,design.width,design.height);
  for(const s of design.shapes) {
    context.fillStyle=s.fill; context.strokeStyle=s.stroke; context.lineWidth=s.strokeWidth;
    context.beginPath();
    if(s.kind==='rectangle') context.rect(s.x,s.y,s.width,s.height);
    if(s.kind==='ellipse') context.ellipse(s.x+s.width/2,s.y+s.height/2,s.width/2,s.height/2,0,0,Math.PI*2);
    if(s.kind==='line') {context.moveTo(s.x,s.y);context.lineTo(s.x+s.width,s.y+s.height);}
    if(s.kind==='text') {context.font=`${Math.max(1,s.height)}px sans-serif`;context.fillText(s.text??'',s.x,s.y+s.height,s.width);}
    else {if(s.kind!=='line')context.fill();if(s.strokeWidth>0)context.stroke();}
  }
}

export function polygonBounds(points: readonly Vec2[]) {
  return {minX:Math.min(...points.map(p=>p.x)),maxX:Math.max(...points.map(p=>p.x)),minY:Math.min(...points.map(p=>p.y)),maxY:Math.max(...points.map(p=>p.y))};
}

const tintCache = new Map<string, HTMLCanvasElement>();
/** Tint only the raster alpha mask, leaving the underlying fabric untouched. */
export function artworkInkImage(image: HTMLImageElement, tint?: string): CanvasImageSource {
  if(!tint || !/^#[0-9a-f]{6}$/i.test(tint)) return image;
  const key=`${image.src}:${tint}`; const cached=tintCache.get(key); if(cached)return cached;
  const canvas=document.createElement('canvas'); canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
  const context=canvas.getContext('2d');if(!context)return image;
  context.drawImage(image,0,0);context.globalCompositeOperation='source-in';context.fillStyle=tint;context.fillRect(0,0,canvas.width,canvas.height);
  if(tintCache.size>=8)tintCache.delete(tintCache.keys().next().value!);tintCache.set(key,canvas);return canvas;
}
