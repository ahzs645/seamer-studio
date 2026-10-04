from pathlib import Path
import hashlib,json,zipfile,datetime,re,os
BASE=Path('/workspace');OUT=BASE/'work/push-checkpoint-packaging'
NAMES=[
'source-body6-calibration-owner-reseal-integration','source-body6-seven-preparation-owner-resealed-candidate',
'source-seven-postframe-fit-qa-body6-owned-runtime','source-physical-app-main-adoption-yield-review',
'source-physical-app-owner-scoped-callback-sealed-review','source169-body6-yielding-sveltekit-delivery-review',
'source169-chromium-cpu-worker-harness-yielding-main-review',
'source-seeded-finite895-component-bound-persistent-anchor-kernels',
'source-finite-feature-component-browser169-worker-contexts-candidate','source-all-phase-joint-engine-moving-sat-seams',
'source-frame-commit-portable-validator-moving-sat','source-pressure-friction-whole-provider-priority-ordering-body-bounded-capture',
'source-joint-whole-engine-driver-priority-body6-proposal','physical-frame-receipt-portable',
'source-pressure-friction-integration-exclusive','source-membrane-runtime-integration-impulse-noalias',
'source-joint-row128-csr-packer-parenthesized','source-seeded-numerical-kernel-primitives-packer-bound',
'source-physical-anchor-arena-review-progress3','source-joint-executed-topology-anchor-integration',
'source-moving-original-seam-plane-reference','source-moving-original-seam-sat-reference','source-moving-indexed-point-plane-reference',
'source-final-native-hand-cuff-rational-reference','source-seven-postframe-fit-qa-native-wrist-runtime','root-component-approvals']
ROOTS=[BASE/'work'/n for n in NAMES]
# No mutable active application files are swept. Source outside these owned roots
# is taken only through exact recorded review/dependency hashes.
blocked={'node_modules','.git','.svelte-kit','.pnpm','__pycache__','compiled','dist','bundles','build','build-output','test-results','playwright-report'}
code_ext={'.ts','.tsx','.mts','.mjs','.js','.jsx','.py','.wgsl','.svelte','.css','.scss','.html','.sh','.d.ts','.d.mts'}
json_names={'review-pins.json','runtime-manifest.json','driver-pins.json','provider-adapter-manifest.json','component-artifact.json','qa-input-bindings.json','scaffold-progress.json','body6-cpu-handoff.json','build-provenance.json','package.json','tsconfig.json','jsconfig.json','code-identity.json','post-freeze-164-review-hold.json'}
manifest_like=re.compile(r'(?:manifest|review-pins|criteria|policy|approval|receipt-schema|scope-config)',re.I)
refs={};manifest_rows=[];candidate_paths=set();excluded={};declared={}
def digest(data):return hashlib.sha256(data).hexdigest()
def safe_reason(p):
 parts=set(p.parts)
 name=p.name.lower()
 if p.is_symlink():return 'symlink-not-followed'
 if parts&blocked or any(x.startswith('compiled-') or x.startswith('compiled_') for x in parts):return 'dependency-or-generated-compiled-tree'
 if p.name=='sourcePhysicalProduction.mjs':return 'generated-vendor-production-bundle'
 if name.startswith('.env') or name in {'.npmrc','.netrc','.pypirc'} or any(x in name for x in ['credentials','secret','cookie','token-cache']):return 'secret-or-local-credential-config'
 if p.suffix.lower() in {'.har','.pdf','.zip','.7z','.tar','.gz','.node','.bin','.v8','.png','.jpg','.jpeg','.webp','.gif','.mp4','.woff','.woff2','.ttf','.lock','.log'}:return 'binary-upload-runtime-evidence-or-log'
 if p.stat().st_size>1024*1024:return 'over-1MiB-source-or-context-payload'
 if p.suffix.lower()=='.json':
  if not any(p.is_relative_to(root) for root in ROOTS) and p.name not in {'package.json','tsconfig.json','jsconfig.json'}:return 'historical-dependency-manifest-reference-only'
  if p.parent.name=='root-component-approvals' or p.name in json_names or manifest_like.search(p.name):return None
  return 'json-not-small-manifest-criteria-or-source-config'
 if p.suffix.lower() in code_ext:
  if any(x in name for x in ['.bundle.','bundled','browser-entry.mjs','app-entry.mjs','whole-provider-app.mjs']):return 'generated-bundle-name'
  return None
 if p.suffix.lower()=='.md' or name in {'license','license.md','license.txt','copying','notice','notice.txt'} or p.suffix.lower() in {'.license','.notice'}:return None
 if p.name in {'Makefile','Dockerfile'}:return None
 return 'not-source-shader-test-config-license-or-notice'
def note_ref(p,h,origin):
 key=str(p);refs.setdefault(key,{'originalPath':key,'sha256':h,'declaredBy':[]})
 if origin not in refs[key]['declaredBy']:refs[key]['declaredBy'].append(origin)
 # Conflicting epochs sharing one mutable path are reference-only.
 if key in declared and declared[key]!=h:declared[key]=None
 elif key not in declared:declared[key]=h
for root in ROOTS:
 if not root.is_dir():raise RuntimeError('Missing selected root '+str(root))
 for p in root.rglob('*'):
  if p.is_file() and not p.is_symlink():candidate_paths.add(p)
 for filename in ['review-pins.json','runtime-manifest.json','driver-pins.json']:
  p=root/filename
  if not p.is_file():continue
  b=p.read_bytes();m=json.loads(b)
  manifest_rows.append({'root':str(root),'manifest':str(p),'sha256':digest(b),'byteLength':len(b),'scope':m.get('scope',m.get('kind',m.get('schema'))),'frozenReferenceOnlyNotNewApproval':True})
  for key in ['files','externalDependencyFiles','runtimeSnapshotFiles','heldEvidenceFiles','dependencyFiles']:
   entries=m.get(key,{})
   if isinstance(entries,dict): pairs=entries.items()
   elif isinstance(entries,list):pairs=((x.get('path'),x.get('sha256')) for x in entries if isinstance(x,dict))
   else:continue
   for name,h in pairs:
    if isinstance(name,str) and name.startswith('/workspace/') and isinstance(h,str) and re.fullmatch('[a-f0-9]{64}',h):
     dep=Path(name);note_ref(dep,h,str(p))
     if dep.is_file() and not dep.is_symlink() and safe_reason(dep) is None:
      # Owned snapshots and exact source math dependencies only; mutable app code
      # gets a content check and is omitted if it no longer matches that epoch.
      candidate_paths.add(dep)
# Preserve local dependency licenses beside any captured exact source dependency.
for p in list(candidate_paths):
 for parent in [p.parent,*list(p.parents)[:3]]:
  if str(parent) in {'/','/workspace'}:continue
  for pattern in ['LICENSE*','NOTICE*','*.LICENSE','*.NOTICE']:
   for license in parent.glob(pattern):
    if license.is_file() and not license.is_symlink() and license.stat().st_size<=1024*1024 and 'node_modules' not in license.parts:candidate_paths.add(license)
entries=[];archive=OUT/'reviewed-source-checkpoint.zip';captured_before={};canonical_entries={}
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for p in sorted(candidate_paths,key=str):
  reason=safe_reason(p)
  if reason:excluded[str(p)]={'reason':reason,'byteLength':p.stat().st_size};continue
  b=p.read_bytes();h=digest(b);expected=declared.get(str(p),'unrecorded-local-current-source')
  if expected is None:
   # A root-local latest selected copy can still be archived at its own hash;
   # external mutable epoch collisions must remain references only.
   if not any(p.is_relative_to(root) for root in ROOTS):
    excluded[str(p)]={'reason':'multiple-frozen-epochs-reference-one-path','currentSha256':h,'byteLength':len(b)};continue
  elif expected!='unrecorded-local-current-source' and expected!=h:
   excluded[str(p)]={'reason':'current-bytes-differ-from-referenced-frozen-epoch','currentSha256':h,'declaredSha256':expected,'byteLength':len(b)};continue
  rel=str(p.relative_to(BASE));arc=canonical_entries.get(h,'source-checkpoint/'+rel)
  if h not in canonical_entries:z.writestr(arc,b);canonical_entries[h]=arc
  captured_before[str(p)]=h
  entries.append({'archivePath':arc,'originalPath':str(p),'sha256':h,'byteLength':len(b),'declaredFrozenSha256':None if expected in [None,'unrecorded-local-current-source'] else expected,'status':'unfinished-unapproved-driver' if 'source-joint-whole-engine-driver-priority-body6-proposal' in str(p) else 'archived-isolated-review-source-not-active-production'})
 # Packaging program itself is part of the reproducible source inventory.
 p=OUT/'package-source-checkpoint.py';b=p.read_bytes();h=digest(b);arc='source-checkpoint/work/push-checkpoint-packaging/package-source-checkpoint.py';z.writestr(arc,b);captured_before[str(p)]=h;entries.append({'archivePath':arc,'originalPath':str(p),'sha256':h,'byteLength':len(b),'status':'checkpoint-packaging-source'})
for p,h in captured_before.items():
 if digest(Path(p).read_bytes())!=h:raise RuntimeError('Source changed while packaging: '+p)
with zipfile.ZipFile(archive) as z:
 for row in entries:
  b=z.read(row['archivePath'])
  if digest(b)!=row['sha256'] or len(b)!=row['byteLength']:raise RuntimeError('Archive mismatch '+row['archivePath'])
if archive.stat().st_size>=20*1024*1024:raise RuntimeError('Compressed checkpoint exceeds20MiB; split before repo handoff')
for row in refs.values():
 row['archived']=row['originalPath'] in captured_before
 row['exclusionReason']=excluded.get(row['originalPath'],{}).get('reason','not-selected-or-non-source-runtime-reference') if not row['archived'] else None
detail={'schema':'isolated-reviewed-source-checkpoint-full-path-inventory-v1','scope':'source-only archived implementation/review checkpoint; no live SOURCE profile promotion','files':entries,'selectedRoots':[str(p) for p in ROOTS],'originalFrozenManifests':manifest_rows,'beforeAfterSourceHashesEqual':True,'zipContentsReloadHashesEqual':True,'identicalSourceBytesShareCanonicalArchiveEntry':True,'compiledBundlesAndLargeEvidenceExcluded':True,'fullFitPasses':0,'requiredGarments':7,'initialBodySelfGuardsPassed':7,'targetedOperatorGpuCasesPassed':3,'body6Live':False,'newFiniteContextAndSameOwnerBridgePending':True,'latestDelivery164PostFreezeHoldPreserved':True}
reference_detail={'schema':'source-checkpoint-excluded-runtime-reference-index-v1','notStandaloneProduction':True,'references':list(refs.values()),'excluded':excluded}
def compact(v):return (json.dumps(v,separators=(',',':'))+'\n').encode()
detail_bytes=compact(detail);reference_bytes=compact(reference_detail)
with zipfile.ZipFile(archive,'a',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 z.writestr('checkpoint-metadata/full-path-inventory.json',detail_bytes)
 z.writestr('checkpoint-metadata/excluded-and-referenced-dependencies.json',reference_bytes)
if archive.stat().st_size>=20_000_000:raise RuntimeError('Complete compressed checkpoint exceeds20MB; split archive')
summary={'schema':'isolated-reviewed-source-checkpoint-inventory-summary-v1','createdUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'archive':archive.name,'archiveSha256':digest(archive.read_bytes()),'archiveBytes':archive.stat().st_size,'indexedOriginalSourcePaths':len(entries),'canonicalSourceEntries':len(canonical_entries)+1,'uncompressedIndexedSourceBytes':sum(r['byteLength'] for r in entries),'fullPathInventory':{'archiveEntry':'checkpoint-metadata/full-path-inventory.json','sha256':digest(detail_bytes),'byteLength':len(detail_bytes)},'excludedReferenceIndex':{'archiveEntry':'checkpoint-metadata/excluded-and-referenced-dependencies.json','sha256':digest(reference_bytes),'byteLength':len(reference_bytes)},'originalFrozenManifests':manifest_rows,'beforeAfterSourceHashesEqual':True,'zipContentsReloadHashesEqual':True,'sourceOnly':True,'notStandaloneProduction':True,'body6Live':False,'newFiniteContextAndSameOwnerBridgePending':True,'fullFitPasses':0,'requiredGarments':7,'initialBodySelfGuardsPassed':7,'targetedOperatorGpuCasesPassed':3,'latestDelivery164PostFreezeHoldPreserved':True}
(OUT/'inventory.json').write_text(json.dumps(summary,indent=2)+'\n')
(OUT/'excluded-and-referenced-dependencies.json').unlink(missing_ok=True)
print(json.dumps({'archive':str(archive),'archiveBytes':archive.stat().st_size,'archiveSha256':summary['archiveSha256'],'sourcePaths':len(entries),'canonicalSourceEntries':summary['canonicalSourceEntries'],'inventoryBytes':(OUT/'inventory.json').stat().st_size,'inventorySha256':digest((OUT/'inventory.json').read_bytes()),'exactBeforeAfterAndZipReload':True}))
