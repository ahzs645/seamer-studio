import type { Pattern } from './pattern';
import type { PieceArtwork } from './artwork';
import type { ColorwayState } from './colorways';

export interface AppearanceVersion {
  id: string; name: string; createdAt: string;
  materials: Pattern['materials'];
  pieces: Array<{id: string; materialId: string}>;
  colorways?: ColorwayState;
  artwork?: PieceArtwork[];
}
export interface AppearanceHistory { versions: AppearanceVersion[] }

export function saveAppearanceVersion(pattern: Pattern, id: string, name: string, createdAt: string): Pattern {
  if(!name.trim())throw Error('Give this appearance version a name.');
  if(!Number.isFinite(Date.parse(createdAt)))throw Error('Appearance version needs a valid timestamp.');
  if(pattern.appearanceHistory?.versions.some(version=>version.id===id))throw Error('Appearance version ID already exists.');
  if((pattern.appearanceHistory?.versions.length??0)>=8)throw Error('Keep up to eight appearance versions. Remove one before saving another.');
  const version: AppearanceVersion={id,name:name.trim().slice(0,200),createdAt,materials:structuredClone(pattern.materials),pieces:pattern.pieces.map(piece=>({id:piece.id,materialId:piece.materialId})),colorways:structuredClone(pattern.colorways),artwork:structuredClone(pattern.artwork)};
  const history={versions:[...(pattern.appearanceHistory?.versions??[]),version]};validateAppearanceHistory(history);
  return {...pattern,appearanceHistory:history,hasChanged:true};
}
export function restoreAppearanceVersion(pattern: Pattern, id: string): Pattern {
  const version=pattern.appearanceHistory?.versions.find(item=>item.id===id);if(!version)return pattern;
  const materialIds=new Set(version.materials.map(material=>material.id));
  const assignments=new Map(version.pieces.map(piece=>[piece.id,piece.materialId]));
  // New pieces retain their current material; restored sources must also remain available.
  const retained=pattern.materials.filter(material=>pattern.pieces.some(piece=>!assignments.has(piece.id)&&piece.materialId===material.id)&&!materialIds.has(material.id));
  return {...pattern,materials:structuredClone([...version.materials,...retained]),pieces:pattern.pieces.map(piece=>assignments.has(piece.id)?{...piece,materialId:assignments.get(piece.id)!}:piece),colorways:structuredClone(version.colorways),artwork:structuredClone(version.artwork),hasChanged:true};
}
export function removeAppearanceVersion(pattern: Pattern, id: string): Pattern {
  return {...pattern,appearanceHistory:{versions:(pattern.appearanceHistory?.versions??[]).filter(item=>item.id!==id)},hasChanged:true};
}

import { artworkSourceBytes, validateArtworkSurface, MAX_ARTWORK_PIXELS, MAX_ARTWORK_PROJECT_BYTES, MAX_ARTWORK_SOURCE_BYTES } from './artwork';

/** History is imported data: check its entire tree before a restoration can enter the editor. */
export function validateAppearanceHistory(value: unknown): void {
  const record=(item:unknown):Record<string,unknown>=>{if(!item||typeof item!=='object'||Array.isArray(item)||![Object.prototype,null].includes(Object.getPrototypeOf(item)))throw Error('Invalid appearance history object.');return item as Record<string,unknown>;};
  const string=(item:unknown,empty=false)=>{if(typeof item!=='string'||(!empty&&!item.trim()))throw Error('Invalid appearance history string.');return item;};
  const rows=(item:unknown,max:number)=>{if(!Array.isArray(item)||item.length>max)throw Error('Invalid appearance history array.');const ids=new Set<string>();return item.map(row=>{const object=record(row),id=string(object.id);if(ids.has(id))throw Error('Duplicate appearance history record ID.');ids.add(id);return object;});};
  let nodes=0;
  const tree=(item:unknown,depth=0):void=>{
    if(++nodes>100000||depth>20)throw Error('Appearance history exceeds the structural limit.');
    if(typeof item==='number'&&!Number.isFinite(item))throw Error('Appearance history contains a nonfinite number.');
    if(typeof item==='string'&&item.length>3_000_000)throw Error('Appearance history string exceeds the source limit.');
    if(item===null||item===undefined||typeof item==='string'||typeof item==='number'||typeof item==='boolean')return;
    if(Array.isArray(item)){if(item.length>10000)throw Error('Appearance history array exceeds limit.');item.forEach(child=>tree(child,depth+1));return;}
    Object.values(record(item)).forEach(child=>tree(child,depth+1));
  };
  tree(value);
  const history=record(value),sources=new Set<string>();let bytes=0;
  for(const version of rows(history.versions,8)) {
    const name=string(version.name);if(name.length>200)throw Error('Appearance version name exceeds 200 characters.');
    if(!Number.isFinite(Date.parse(string(version.createdAt))))throw Error('Invalid appearance version timestamp.');
    for(const material of rows(version.materials,1000)) {
      string(material.name,true);
      if(typeof material.useSeparateBackSide!=='boolean')throw Error('Invalid appearance material backside flag.');
      for(const key of ['stretchWarpValue','stretchWeftValue','bendValue','thickness','weight','roughness','metalness','specularIntensity','opacity','normalScale','alphaCutoff'])
        if(typeof material[key]!=='number'||!Number.isFinite(material[key]))throw Error(`Invalid appearance material ${key}.`);
      for(const key of ['visualizationThickness','shrinkageHorizontalPercentage','shrinkageVerticalPercentage'])
        if(material[key]!==undefined&&(typeof material[key]!=='number'||!Number.isFinite(material[key])))throw Error(`Invalid appearance material ${key}.`);
      for(const key of ['libraryItemId','libraryUpdatedAt'])if(material[key]!==null)string(material[key],true);
      if(material.libraryVersion!==null&&(typeof material.libraryVersion!=='number'||!Number.isFinite(material.libraryVersion)))throw Error('Invalid appearance material library version.');
      if(material.currentPreset!==undefined&&material.currentPreset!==null)string(material.currentPreset,true);
      for(const key of ['frontTexture','backTexture']){
        if(material[key]===null)continue;
        const slot=record(material[key]);
        for(const key of ['url','normalUrl','opacityUrl'])string(slot[key],true);
        if(!/^#[0-9a-f]{6}$/i.test(string(slot.color)))throw Error('Invalid appearance material colour.');
        for(const key of ['scale','normalMapScale','opacityMapScale'])if(typeof slot[key]!=='number'||!Number.isFinite(slot[key]))throw Error('Invalid appearance texture scale.');
        if((slot.scale as number)<=0)throw Error('Appearance texture repeat scale must be positive.');
        for(const key of ['mediaId','normalMediaId','opacityMediaId'])if(slot[key]!==null)string(slot[key],true);
        for(const key of ['sourceMode','normalSourceMode','opacitySourceMode'])if(slot[key]!==undefined&&!['linked','uploaded','downloaded'].includes(string(slot[key])))throw Error('Invalid appearance texture source mode.');
        for(const key of ['sourceUrl','normalSourceUrl','opacitySourceUrl'])if(slot[key]!==undefined)string(slot[key],true);
      }
    }
    for(const piece of rows(version.pieces,10000))string(piece.materialId,true);
    if(version.colorways!==undefined){const state=record(version.colorways);if(state.activeId!==null)string(state.activeId);
      for(const [id,source]of Object.entries(record(state.generatedMaterialSources))){string(id);string(source);}
      for(const variant of rows(state.variants,1000)){string(variant.name,true);for(const [id,value]of Object.entries(record(variant.pieces))){string(id);const override=record(value);string(override.materialId,true);for(const key of ['frontColor','backColor'])if(override[key]!==undefined&&!/^#[0-9a-f]{6}$/i.test(string(override[key])))throw Error('Invalid appearance colorway colour.');}}
    }
    if(version.artwork!==undefined)for(const row of rows(version.artwork,1000)){
      string(row.pieceId);string(row.name,true);const source=string(row.dataUrl,true);
      if(!['image/png','image/jpeg','image/webp'].includes(string(row.mimeType)))throw Error('Invalid appearance artwork MIME.');
      for(const key of ['x','y','widthMm','heightMm','rotation','opacity'])if(typeof row[key]!=='number'||!Number.isFinite(row[key]))throw Error('Invalid appearance artwork placement.');
      for(const key of ['pixelWidth','pixelHeight'])if(!Number.isInteger(row[key])||(row[key] as number)<1||(row[key] as number)>8192)throw Error('Invalid appearance artwork dimensions.');
      if((row.pixelWidth as number)*(row.pixelHeight as number)>MAX_ARTWORK_PIXELS)throw Error('Appearance artwork exceeds pixel limit.');
      validateArtworkSurface(row);
      if(/^data:/i.test(source)&&!sources.has(source)){sources.add(source);const size=artworkSourceBytes(source);if(size>MAX_ARTWORK_SOURCE_BYTES)throw Error('Appearance image exceeds 2 MiB.');bytes+=size;}
    }
  }
  if(bytes>MAX_ARTWORK_PROJECT_BYTES)throw Error('Appearance history exceeds 8 MiB of unique embedded images.');
}
