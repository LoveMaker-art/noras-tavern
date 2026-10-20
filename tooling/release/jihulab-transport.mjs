import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {publicationChannelObjects,verifyPublishedCoreAnchor} from './system-release.mjs';

const origin='https://jihulab.com';
const immutableKey=/^releases\/(v\d+\.\d+\.\d+(?:-beta\.\d+)?)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;
const channelKey=/^channels\/(stable|beta|launcher-stable)\.json$/;
const maxAssetBytes=2*1024*1024*1024;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const failure=(message,code='JIHULAB_TRANSPORT_FAILED')=>Object.assign(new Error(`JihuLab ${message}`),{code});

function protectedBytes(file,label,limit) {
    assert.ok(typeof file==='string'&&path.isAbsolute(file),`JihuLab ${label} must be an absolute protected file`);
    // Opening without following a symlink also closes the lstat/open race.
    let descriptor;
    try {
        descriptor=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
        const stat=fs.fstatSync(descriptor);
        assert.ok(stat.isFile(),`JihuLab ${label} must be a regular file without a link`);
        assert.equal(stat.mode&0o777,0o600,`JihuLab ${label} must have private 0600 permissions`);
        if(typeof process.getuid==='function')assert.equal(stat.uid,process.getuid(),`JihuLab ${label} has a different owner`);
        assert.ok(stat.size>0&&stat.size<=limit,`JihuLab ${label} exceeds its size limit`);
        const bytes=fs.readFileSync(descriptor);
        assert.ok(bytes.length===stat.size&&bytes.length<=limit,`JihuLab ${label} changed while reading`);
        return bytes;
    } catch(error) {
        if(error.code==='ELOOP')throw failure(`${label} must be a regular file without a link`);
        if(error.code)throw failure(`cannot read protected ${label}`);
        throw error;
    } finally {if(descriptor!==undefined)fs.closeSync(descriptor);}
}
function publisherIdentity(config) {
    assert.ok(config&&typeof config==='object'&&!Array.isArray(config),'Invalid JihuLab publisher configuration');
    assert.ok(Object.keys(config).every(key=>['projectId','projectPath','packageName','branch','tokenFile','immutablePolicy'].includes(key)),
        'Unknown JihuLab publisher configuration field');
    assert.ok(Number.isSafeInteger(config.projectId)&&config.projectId>0,'Invalid JihuLab project identity');
    assert.match(config.projectPath,/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}\/)+[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/);
    assert.ok(config.projectPath.split('/').every(part=>!['.','..'].includes(part)&&!part.endsWith('.lock')),'Invalid JihuLab project path');
    assert.match(config.packageName,/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/);
    assert.match(config.branch,/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    assert.ok(!config.branch.includes('..')&&!/(?:\.|\.lock)$/.test(config.branch),'Invalid JihuLab branch');
    if(config.tokenFile!==undefined)assert.ok(typeof config.tokenFile==='string'&&path.isAbsolute(config.tokenFile),'Invalid JihuLab protected token file');
    assert.ok(config.immutablePolicy===undefined||['namespace','inventory-single-publisher'].includes(config.immutablePolicy),
        'Invalid JihuLab immutable publishing policy');
    return {...config};
}
// Config contains identity and a protected token-file path, never token bytes.
export function loadJihuUploadConfig(configPath) {
    let config;
    try {config=JSON.parse(protectedBytes(configPath,'publisher configuration',16384).toString('utf8'));}
    catch(error) {if(error instanceof SyntaxError)throw failure('invalid publisher configuration JSON');throw error;}
    return publisherIdentity(config);
}
function reader() {
    const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
    const file=['launcher/desktop/release-sources.js','ops/installer/desktop/release-sources.js']
        .map(name=>path.join(root,name)).find(name=>fs.existsSync(name));
    assert.ok(file,'Missing shared JihuLab release source validator');
    return createRequire(import.meta.url)(file);
}
function abortable(promise,signal) {
    const pending=Promise.resolve(promise);
    if(signal.aborted){pending.catch(()=>{});return Promise.reject(signal.reason);}
    return new Promise((resolve,reject)=>{
        const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
        pending.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    });
}
function deadline(timeout,signal) {
    assert.ok(Number.isSafeInteger(timeout)&&timeout>0,'Invalid JihuLab deadline');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(failure('absolute request deadline','JIHULAB_TIMEOUT')),timeout);
    return {signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal,
        close:()=>clearTimeout(timer),abort:reason=>controller.abort(reason)};
}
// Cleanup must not extend the request deadline when an underlying cancel
// implementation never settles. All rejection paths remain observed.
function cancel(response) {try {response?.body?.cancel()?.catch(()=>{});}catch {}}
async function bodyBytes(response,signal,limit) {
    assert.ok(response.body,'JihuLab response body is missing');
    const chunks=[],iterator=response.body[Symbol.asyncIterator]();let size=0,done=false;
    try {
        for(;;){const next=await abortable(iterator.next(),signal);if(next.done){done=true;break;}
            const chunk=Buffer.from(next.value);size+=chunk.length;
            assert.ok(size<=limit,'JihuLab response exceeds its size limit');chunks.push(chunk);}
        return Buffer.concat(chunks,size);
    } finally {if(!done)iterator.return?.().catch(()=>{});}
}
function objectIdentity(object,{channel=false,maxSize=maxAssetBytes}={}) {
    assert.ok(object&&typeof object==='object','Invalid JihuLab sealed object');
    assert.match(object.key,channel?channelKey:immutableKey);
    assert.ok(channel?object.phase==='channel':['asset','catalogue'].includes(object.phase),'Invalid JihuLab object phase');
    assert.ok(Number.isSafeInteger(object.size)&&object.size>0&&object.size<=maxSize,'Invalid JihuLab sealed object size');
    assert.match(object.sha256,/^[a-f0-9]{64}$/);
}
function version(tag) {
    const match=/^v(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(tag);
    assert.ok(match,'Invalid JihuLab channel version');
    const numbers=[Number(match[1]),Number(match[2]),Number(match[3]),match[4]===undefined?1:0,Number(match[4]||0)];
    assert.ok(numbers.every(Number.isSafeInteger),'Invalid JihuLab channel version range');return numbers;
}
function channelReleases(bytes,channel,launcher=false) {
    let value;try {value=JSON.parse(bytes.toString('utf8'));}catch {throw failure('invalid channel JSON');}
    assert.equal(Array.isArray(value),channel==='beta'||launcher,'Invalid JihuLab channel shape');
    const releases=Array.isArray(value)?value:[value];assert.ok(releases.length>0,'Empty JihuLab beta channel');
    for(const item of releases) {
        assert.ok(item&&item.draft===false&&item.prerelease===(channel==='beta'),'Invalid JihuLab channel release');
        version(item.tag_name);assert.equal(item.tag_name.includes('-beta.'),channel==='beta','Invalid JihuLab channel release version');
    }
    return releases;
}

/** Real IO seams for jihulabProvider; source must come from build-owned roots.
 * All public verification is anonymous. Authenticated API calls never follow
 * redirects. The default requires namespace-enforced duplicate rejection.
 * Explicit inventory mode requires one serialized publisher for every writer;
 * unresolved attempts must be investigated before restarting a publisher job.
 * Inventory checks do not atomically prevent concurrent manual owner writes.
 */
export function createJihuTransport(input,{source,fetcher=fetch,privateToken,log=console.log,totalTimeout=120000,
    uploadTimeout=1800000,maxJsonBytes=4*1024*1024,maxChannelBytes=1024*1024,maxInventoryPages=50,maxInventoryItems=5000}={}) {
    const config=publisherIdentity(typeof input==='string'?loadJihuUploadConfig(input):input);
    const shared=reader();
    assert.ok(source,'A build-owned JihuLab source configuration is required');
    let selected;try {selected=shared.validateSources({schema:1,mirrors:[source]})[0];}
    catch {throw failure('invalid build-owned source configuration');}
    const projectApi=`${origin}/api/v4/projects/${config.projectId}`;
    assert.equal(selected.provider,'jihulab','Different JihuLab source provider');
    assert.equal(selected.baseUrl,`${projectApi}/packages/generic/${config.packageName}/`,'JihuLab source root differs from publisher identity');
    assert.equal(selected.channelBaseUrl,`${origin}/${config.projectPath}/-/raw/${config.branch}/`,'JihuLab channel root differs from publisher identity');
    for(const [name,value] of Object.entries({totalTimeout,uploadTimeout,maxJsonBytes,maxChannelBytes,maxInventoryPages,maxInventoryItems}))
        assert.ok(Number.isSafeInteger(value)&&value>0,`Invalid JihuLab ${name}`);
    assert.ok(maxInventoryPages<=100&&maxInventoryItems<=10000,'JihuLab inventory limits exceed their hard bounds');
    const inventoryPolicy=config.immutablePolicy==='inventory-single-publisher';
    assert.equal(typeof fetcher,'function','Missing JihuLab fetch implementation');
    const token=privateToken??protectedBytes(config.tokenFile,'private token',16384).toString('utf8').trim();
    assert.ok(typeof token==='string'&&token.length>0&&token.length<=16384&&!/[\s\x00-\x1f\x7f]/.test(token),'Invalid JihuLab private token');
    const snapshots=new WeakMap(),attemptedUploads=new Set();
    const publicUrl=key=>{
        assert.ok(immutableKey.test(key)||channelKey.test(key),'Invalid JihuLab public object key');
        if(channelKey.test(key))return selected.channelBaseUrl+key;
        assert.match(key,immutableKey);return selected.baseUrl+key.replace(/^releases\//,'');
    };
    // The returned stream owns its deadline until it is consumed or cancelled.
    async function readPublic(key,activeFetcher=fetcher,timeout=totalTimeout,{method='GET',signal,revalidate=false,...extra}={}) {
        assert.ok(['GET','HEAD'].includes(method)&&Object.keys(extra).length===0,'Invalid JihuLab public read options');
        const url=publicUrl(key),budget=deadline(timeout,signal);let response,wrapped;
        try {
            response=await abortable(shared.readSource(activeFetcher,{...selected,url},url,{method,signal:budget.signal,
                headers:{'Accept-Encoding':'identity',...(revalidate?{'Cache-Control':'no-cache'}:{})}}),budget.signal);
            if(!response.body){budget.close();return response;}
            const iterator=response.body[Symbol.asyncIterator]();
            const stream=new ReadableStream({
                async pull(controller) {
                    try {const next=await abortable(iterator.next(),budget.signal);
                        if(next.done){budget.close();controller.close();}else controller.enqueue(next.value);
                    } catch(error){budget.close();iterator.return?.().catch(()=>{});controller.error(error);}
                },
                cancel(reason){budget.close();budget.abort(reason);iterator.return?.().catch(()=>{});},
            });
            wrapped=new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
            Object.defineProperty(wrapped,'url',{value:response.url||url});return wrapped;
        } catch(error) {budget.close();if(!wrapped)await cancel(response);throw error;}
    }
    async function api(url,{method='GET',body,authenticated=true,timeout=totalTimeout,allowed=[200],signal}={}) {
        const target=new URL(url);
        assert.ok(target.origin===origin&&!target.username&&!target.password&&!target.hash
            && (target.pathname===`/api/v4/projects/${config.projectId}`
                ||target.pathname.startsWith(`/api/v4/projects/${config.projectId}/`)
                ||target.pathname==='/api/graphql'),'Invalid JihuLab authenticated API root');
        const budget=deadline(timeout,signal);let response;
        try {
            for(let attempt=0; ;attempt++) {
                response=await abortable(fetcher(target.href,{method,redirect:'manual',signal:budget.signal,
                    headers:{'Accept-Encoding':'identity',...(authenticated?{'PRIVATE-TOKEN':token}:{}),
                        ...(body!==undefined?{'Content-Type':typeof body==='string'?'application/json':'application/octet-stream'}:{}),
                        ...(typeof body!=='string'&&body!==undefined?{'Content-Length':String(body.sealedSize)}:{})},
                    ...(body!==undefined?{body,...(typeof body==='string'?{}:{duplex:'half'})}:{})}),budget.signal);
                if(response.url&&response.url!==target.href)throw failure('API response left its requested site');
                log(`jihulab API ${method} ${target.pathname} HTTP ${response.status}`);
                // Retry only read-only HTTP failures, within the original deadline.
                // A PUT/POST may already have taken effect and must never be replayed here.
                if(method==='GET'&&body===undefined&&[500,502,503,504].includes(response.status)&&attempt<3) {
                    await cancel(response);response=undefined;
                    await pause(250*2**attempt,undefined,{signal:budget.signal});continue;
                }
                if(!allowed.includes(response.status))throw failure(`API ${method} ${target.pathname} HTTP ${response.status}`,
                    response.status>=300&&response.status<400?'JIHULAB_API_REDIRECT':'JIHULAB_API_HTTP');
                if(response.status===404){await cancel(response);return {status:404,value:null};}
                const bytes=await bodyBytes(response,budget.signal,maxJsonBytes);
                let value;try {value=JSON.parse(bytes.toString('utf8'));}catch {throw failure('invalid bounded API JSON');}
                return {status:response.status,value,nextPage:response.headers.get('x-next-page')};
            }
        } catch(error) {
            if(budget.signal.aborted)throw budget.signal.reason;
            if(error.code?.startsWith('JIHULAB_')||error.code==='ERR_ASSERTION')throw error;
            throw failure(`API ${method} ${target.pathname} request failed`);
        } finally {budget.close();await cancel(response);}
    }
    async function preflight() {
        const {value:project}=await api(projectApi,{authenticated:false});
        assert.ok(project&&project.id===config.projectId&&project.path_with_namespace===config.projectPath
            &&project.visibility==='public'&&project.default_branch===config.branch,'JihuLab project public identity differs');
        const namespace=config.projectPath.slice(0,config.projectPath.lastIndexOf('/'));
        assert.ok(project.namespace?.full_path===namespace,'Different JihuLab project namespace');
        // Anonymous project responses omit several settings on JihuLab.com.
        // Read actual authenticated settings rather than interpreting omissions.
        const {value:authenticated}=await api(projectApi);
        assert.ok(authenticated?.id===config.projectId&&authenticated.path_with_namespace===config.projectPath,
            'Different JihuLab authenticated project identity');
        if(Object.hasOwn(authenticated,'archived'))assert.ok(authenticated.archived===false,'JihuLab project is archived');
        if(Object.hasOwn(authenticated,'packages_enabled'))assert.ok(authenticated.packages_enabled===true,'JihuLab package registry is disabled');
        if(Object.hasOwn(authenticated,'package_registry_access_level'))assert.ok(['enabled','public'].includes(authenticated.package_registry_access_level),
            'JihuLab package registry availability is restricted');
        if(!Object.hasOwn(authenticated,'packages_enabled')&&!Object.hasOwn(authenticated,'package_registry_access_level')) {
            const {value:packages}=await api(projectApi+'/packages?package_type=generic&per_page=1');
            assert.ok(Array.isArray(packages),'Cannot confirm JihuLab package registry availability');
        }
        // An explicit protected publisher configuration may choose the
        // controlled single-publisher protocol below. It does not claim that
        // JihuLab atomically rejects a concurrent manual duplicate upload.
        if(inventoryPolicy)return project;
        // Generic duplicate policy is namespace-level, not project-level.
        // https://docs.gitlab.cn/docs/jh/user/packages/generic_packages/
        const query=`query { namespace(fullPath: ${JSON.stringify(namespace)}) { fullPath packageSettings { genericDuplicatesAllowed genericDuplicateExceptionRegex } } }`;
        const {value}=await api(`${origin}/api/graphql`,{method:'POST',body:JSON.stringify({query})});
        assert.ok(value&&!value.errors,'Cannot verify JihuLab namespace duplicate policy');
        assert.ok(value.data?.namespace,'JihuLab namespace package policy is unavailable; immutable publishing requires a readable namespace policy with Owner access');
        assert.ok(value.data.namespace.fullPath===namespace,'Cannot verify JihuLab namespace duplicate policy identity');
        const settings=value.data.namespace.packageSettings;
        assert.ok(settings?.genericDuplicatesAllowed===false&&['',null].includes(settings.genericDuplicateExceptionRegex),
            'JihuLab immutable publishing requires disabled generic duplicates with no exception policy');
        return project;
    }
    const packageStatuses=['default','hidden','processing','error','pending_destruction','deprecated'];
    async function inventoryPages(url,signal) {
        const rows=[];
        for(let page=1;page<=maxInventoryPages;page++) {
            const target=new URL(url);target.searchParams.set('per_page','100');target.searchParams.set('page',String(page));
            const {value,nextPage}=await api(target.href,{signal});
            assert.ok(Array.isArray(value)&&value.length<=100,'Invalid JihuLab inventory page');
            rows.push(...value);assert.ok(rows.length<=maxInventoryItems,'JihuLab inventory item limit exceeded');
            if(nextPage!==null) {
                if(nextPage==='')return rows;
                assert.ok(/^[1-9][0-9]*$/.test(nextPage)&&Number(nextPage)===page+1,'Invalid JihuLab inventory pagination');
            } else if(value.length<100)return rows;
        }
        throw failure('inventory pagination limit exceeded');
    }
    async function inventory(tag,signal) {
        version(tag);const packages=[],ids=new Set();
        for(const status of packageStatuses) {
            const url=new URL(projectApi+'/packages');
            for(const [key,value] of Object.entries({package_type:'generic',package_name:config.packageName,package_version:tag,status}))
                url.searchParams.set(key,value);
            for(const row of await inventoryPages(url.href,signal)) {
                // The name query is fuzzy. Validate returned identity fields
                // before doing the exact client-side match, never treat missing
                // fields or an unknown state as a known absent package.
                assert.ok(row&&Number.isSafeInteger(row.id)&&row.id>0&&typeof row.name==='string'&&row.name.length>0
                    &&typeof row.version==='string'&&row.version.length>0&&typeof row.package_type==='string'
                    &&row.package_type.length>0&&row.status===status,'Invalid JihuLab package inventory identity or status');
                if(row.name!==config.packageName||row.version!==tag||row.package_type!=='generic')continue;
                assert.ok(!ids.has(row.id),'Duplicate JihuLab package inventory identity');ids.add(row.id);packages.push(row);
            }
        }
        assert.ok(packages.length<=1,'Duplicate JihuLab inventory packages for the exact name and version');
        if(!packages.length)return [];
        assert.ok(packages[0].status==='default','JihuLab inventory package is processing, hidden, or otherwise unavailable');
        const files=await inventoryPages(`${projectApi}/packages/${packages[0].id}/package_files`,signal),fileIds=new Set();
        for(const file of files) {
            assert.ok(file&&Number.isSafeInteger(file.id)&&file.id>0&&file.package_id===packages[0].id
                &&typeof file.file_name==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file.file_name)
                &&Number.isSafeInteger(file.size)&&file.size>0&&file.size<=maxAssetBytes
                &&typeof file.file_sha256==='string'&&/^[a-f0-9]{64}$/.test(file.file_sha256),
                'Invalid JihuLab file inventory identity, size, or SHA-256');
            assert.ok(!fileIds.has(file.id),'Duplicate JihuLab file inventory id');fileIds.add(file.id);
        }
        return files;
    }
    function matchesInventory(object,files,{allowMissing=false,publication}={}) {
        const [,tag,name]=immutableKey.exec(object.key),matches=files.filter(file=>file.file_name===name);
        assert.ok(matches.length<=1,'Duplicate JihuLab inventory files for the exact name');
        if(!matches.length){assert.ok(allowMissing,'JihuLab inventory object is missing');return 'missing';}
        assert.ok(matches[0].size===object.size&&matches[0].file_sha256===object.sha256,'Different JihuLab inventory object size or SHA-256');
        if(publication&&tag===publication.plan.tag) {
            const expected=publication.plan.objects.filter(item=>item.phase!=='channel'&&immutableKey.exec(item.key)?.[1]===tag)
                .map(item=>immutableKey.exec(item.key)[2]);
            assert.ok(new Set(expected).size===expected.length&&files.length===expected.length
                &&files.every(file=>expected.includes(file.file_name))&&new Set(files.map(file=>file.file_name)).size===files.length,
                'Different JihuLab inventory asset closure or unexpected file');
        }
        return 'matching';
    }
    async function verifyIdentity(object,options={}) {
        objectIdentity(object);if(!inventoryPolicy)return;
        const budget=deadline(totalTimeout);
        try {return matchesInventory(object,await inventory(immutableKey.exec(object.key)[1],budget.signal),options);}
        finally {budget.close();}
    }
    async function verifyPreparedIdentities(p) {
        if(!inventoryPolicy)return;
        const budget=deadline(totalTimeout),versions=new Map();
        try {
            for(const object of p.plan.objects.filter(item=>item.phase!=='channel')) {
                objectIdentity(object);const tag=immutableKey.exec(object.key)[1];
                if(!versions.has(tag))versions.set(tag,await inventory(tag,budget.signal));
                matchesInventory(object,versions.get(tag),{publication:p});
            }
        } finally {budget.close();}
    }
    async function verifyObject(object,{fetcher:activeFetcher=fetcher,totalTimeout:timeout=object?.size>8*1024*1024?uploadTimeout:totalTimeout}={}) {
        objectIdentity(object,{channel:object.phase==='channel',maxSize:object.phase==='channel'?maxChannelBytes:maxAssetBytes});
        const budget=deadline(timeout);let response,done=false;
        try {
            response=await readPublic(object.key,activeFetcher,timeout,{signal:budget.signal,revalidate:true});
            assert.equal(response.status,200,`JihuLab object unavailable HTTP ${response.status}`);
            assert.ok(response.body,'JihuLab object body is missing');
            const hash=crypto.createHash('sha256');let size=0;
            const iterator=response.body[Symbol.asyncIterator]();
            try {
                for(;;){const next=await abortable(iterator.next(),budget.signal);if(next.done){done=true;break;}
                    const chunk=Buffer.from(next.value);size+=chunk.length;
                    assert.ok(size<=object.size,'JihuLab public object size is too large');hash.update(chunk);}
            } finally {if(!done)iterator.return?.().catch(()=>{});}
            assert.equal(size,object.size,'JihuLab public object size is incomplete');
            assert.equal(hash.digest('hex'),object.sha256,'Different JihuLab public object SHA-256');
            return {size,sha256:object.sha256};
        } finally {budget.close();if(!done)await cancel(response);}
    }
    async function sealedFile(object,{channel=false,snapshot=false}={}) {
        objectIdentity(object,{channel,maxSize:channel?maxChannelBytes:maxAssetBytes});
        assert.ok(typeof object.file==='string'&&path.isAbsolute(object.file),'JihuLab sealed object requires an absolute local file');
        const descriptor=await fs.promises.open(object.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
        let snapshotRoot,snapshotDescriptor;
        try {
            const stat=await descriptor.stat();assert.ok(stat.isFile()&&stat.size===object.size,'JihuLab sealed local file size changed');
            if(snapshot) {
                snapshotRoot=await fs.promises.mkdtemp(path.join(os.tmpdir(),'nora-jihulab-upload-'));
                await fs.promises.chmod(snapshotRoot,0o700);
                snapshotDescriptor=await fs.promises.open(path.join(snapshotRoot,'payload'),'wx+',0o600);
            }
            const hash=crypto.createHash('sha256'),chunks=[];let size=0;
            for await(const bytes of descriptor.createReadStream({start:0,autoClose:false})) {
                size+=bytes.length;assert.ok(size<=object.size,'JihuLab sealed local file size changed');hash.update(bytes);
                if(channel)chunks.push(bytes);
                if(snapshotDescriptor)for(let offset=0;offset<bytes.length;) {
                    const {bytesWritten}=await snapshotDescriptor.write(bytes,offset,bytes.length-offset);
                    assert.ok(bytesWritten>0,'JihuLab sealed snapshot write stalled');offset+=bytesWritten;
                }
            }
            assert.equal(size,object.size,'JihuLab sealed local file size changed');
            assert.equal(hash.digest('hex'),object.sha256,'JihuLab sealed local file SHA-256 changed');
            if(snapshotDescriptor) {
                await snapshotDescriptor.chmod(0o400);await descriptor.close();
                const saved=snapshotDescriptor,root=snapshotRoot;
                return {descriptor:saved,cleanup:async()=>{
                    try {await saved.close();}finally {await fs.promises.rm(root,{recursive:true,force:true});}
                }};
            }
            return {descriptor,...(channel?{bytes:Buffer.concat(chunks,size)}:{})};
        } catch(error){
            await descriptor.close();await snapshotDescriptor?.close();
            if(snapshotRoot)await fs.promises.rm(snapshotRoot,{recursive:true,force:true});throw error;
        }
    }
    async function immutableExists(object) {
        const response=await readPublic(object.key,fetcher,totalTimeout,{method:'HEAD',revalidate:true});
        try {
            if([404,410].includes(response.status))return false;
            assert.equal(response.status,200,`Cannot inspect JihuLab immutable object HTTP ${response.status}`);
        } finally {await cancel(response);}
        await verifyObject(object);return true;
    }
    async function upload(object,{immutable,onUploadAttempt}={}) {
        objectIdentity(object);assert.equal(immutable,true,'JihuLab only uploads immutable generic objects');
        assert.ok(onUploadAttempt===undefined||typeof onUploadAttempt==='function','Invalid JihuLab upload intent callback');
        assert.ok(!object.reference,'Cannot upload a referenced JihuLab immutable object');
        const local=await sealedFile(object,{snapshot:true});
        try {
            await preflight();
            const identity=inventoryPolicy?await verifyIdentity(object,{allowMissing:true}):null;
            const exists=await immutableExists(object);
            if(inventoryPolicy)assert.ok(exists===(identity==='matching'),'JihuLab inventory and public object identity disagree');
            if(exists)return;
            assert.ok(!inventoryPolicy||!attemptedUploads.has(object.key),'JihuLab previous upload attempt is unresolved; refusing another PUT');
            await onUploadAttempt?.();
            attemptedUploads.add(object.key);
            const body=local.descriptor.createReadStream({start:0,autoClose:false});body.sealedSize=object.size;
            let uploadError;
            try {await api(publicUrl(object.key),{method:'PUT',body,timeout:uploadTimeout,allowed:[201]});}
            catch(error) {uploadError=error;}
            finally {body.destroy();}
            if(inventoryPolicy) {
                // PUT is attempted once. A committed response loss is accepted
                // only when inventory uniqueness and anonymous full bytes both
                // prove the sealed result; any ambiguity blocks the channel.
                await verifyIdentity(object);await verifyObject(object);
                if(uploadError)log('jihulab immutable upload resolved by unique inventory and anonymous full SHA-256');
            } else if(uploadError) {
                // A network failure can arrive after creation. Never retry PUT:
                // only the full anonymous readback can resolve that ambiguity.
                try {await verifyObject(object);}catch {throw uploadError;}
                log('jihulab immutable upload resolved by verified anonymous readback');
            }
        } finally {await local.cleanup();}
    }
    function pointers(p,object) {
        assert.ok(p?.plan&&['stable','beta'].includes(p.plan.channel),'Invalid JihuLab publication channel');
        version(p.plan.tag);assert.equal(p.plan.channel,p.plan.tag.includes('-beta.')?'beta':'stable');
        const objects=publicationChannelObjects(p.plan);
        if(object!==undefined)assert.equal(object,objects[0],'Different JihuLab sealed pointer identity');
        for(const target of objects)objectIdentity(target,{channel:true,maxSize:maxChannelBytes});
        return objects;
    }
    const repositoryUrl=object=>`${projectApi}/repository/files/${encodeURIComponent(object.key)}`;
    async function repositorySnapshot(object) {
        const url=repositoryUrl(object)+`?ref=${encodeURIComponent(config.branch)}`;
        const response=await api(url,{allowed:[200,404]});
        if(response.status===404) {
            // Auth failures must not masquerade as missing paths. A matching
            // public-project preflight plus anonymous 404 confirms absence.
            const anonymous=await api(url,{authenticated:false,allowed:[200,404]});
            assert.equal(anonymous.status,404,'JihuLab channel authentication differs from public repository');
            return {missing:true};
        }
        const value=response.value;
        assert.ok(value&&value.file_path===object.key&&value.ref===config.branch&&value.encoding==='base64'
            &&Number.isSafeInteger(value.size)&&value.size>0&&value.size<=maxChannelBytes,'Invalid JihuLab repository channel metadata');
        assert.ok(typeof value.last_commit_id==='string'&&/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.last_commit_id),
            'Invalid JihuLab repository channel commit identity');
        assert.equal(typeof value.content,'string','Invalid JihuLab repository channel content');
        const encoded=value.content.replace(/[\r\n]/g,''),bytes=Buffer.from(encoded,'base64');
        assert.ok(bytes.toString('base64')===encoded,'Invalid JihuLab repository channel base64');
        assert.equal(bytes.length,value.size,'Different JihuLab repository channel size');
        const digest=sha(bytes);assert.ok(typeof value.content_sha256==='string'&&/^[a-f0-9]{64}$/.test(value.content_sha256)
            &&digest===value.content_sha256,'Different JihuLab repository channel SHA-256');
        return {missing:false,commit:value.last_commit_id,sha256:digest,bytes};
    }
    function validatePromotion(p,object,current,targetBytes) {
        const launcher=object.key==='channels/launcher-stable.json';
        const target=channelReleases(targetBytes,p.plan.channel,launcher);
        assert.equal(target.length,1,'JihuLab sealed channel must identify one target release');
        assert.equal(target[0].tag_name,p.plan.tag,'JihuLab sealed channel has a different target release');
        if(current.missing)return;
        const desired=version(p.plan.tag);
        for(const release of channelReleases(current.bytes,p.plan.channel,launcher)) {
            const old=version(release.tag_name),different=old.findIndex((number,index)=>number!==desired[index]);
            assert.ok(different<0||old[different]<desired[different],'Refusing to downgrade JihuLab channel');
            assert.ok(release.tag_name!==p.plan.tag||current.sha256===object.sha256,
                'JihuLab same release version has a conflicting sealed channel identity');
        }
    }
    async function targetBytes(object) {
        const local=await sealedFile(object,{channel:true});try {return local.bytes;}finally {await local.descriptor.close();}
    }
    const checkCoreAnchor=async p=>verifyPublishedCoreAnchor(p.plan,async key=>{
        const response=await readPublic(key,fetcher,totalTimeout,{revalidate:true});
        assert.equal(response.status,200,'Cannot verify published core anchor');
        const budget=deadline(totalTimeout);try{return await bodyBytes(response,budget.signal,4*1024*1024);}finally{budget.close();}
    });
    const channelPromotion={
        async check(p) {
            const objects=pointers(p);await checkCoreAnchor(p);
            const bytes=await Promise.all(objects.map(targetBytes));await preflight();
            await verifyPreparedIdentities(p);
            const entries=[];
            for(const [index,object] of objects.entries()){
                const current=await repositorySnapshot(object);validatePromotion(p,object,current,bytes[index]);
                entries.push({key:object.key,sha256:object.sha256,current});
            }
            snapshots.set(p,{tag:p.plan.tag,entries});
        },
        async promote(object,p) {
            const objects=pointers(p,object);await checkCoreAnchor(p);const baseline=snapshots.get(p);
            assert.ok(baseline&&baseline.tag===p.plan.tag&&baseline.entries.length===objects.length
                &&objects.every((target,index)=>target.key===baseline.entries[index].key&&target.sha256===baseline.entries[index].sha256),
                'JihuLab channel promotion requires a matching checked snapshot');
            const bytes=await Promise.all(objects.map(targetBytes));await preflight();await verifyPreparedIdentities(p);
            const currents=[];
            for(const [index,target] of objects.entries()){
                const current=await repositorySnapshot(target),previous=baseline.entries[index].current;
                assert.ok(current.missing===previous.missing
                    &&(current.missing||current.commit===previous.commit&&current.sha256===previous.sha256),
                    'JihuLab channel compare-and-swap conflict: checked snapshot changed');
                validatePromotion(p,target,current,bytes[index]);currents.push(current);
            }
            if(objects.length===2){
                if(objects.some((target,index)=>currents[index].missing||currents[index].sha256!==target.sha256)){
                    // One repository commit applies both sealed file actions. Each
                    // existing file carries its own CAS identity; concurrent create
                    // or update rejects the complete commit, never half the pair.
                    const actions=objects.map((target,index)=>({action:currents[index].missing?'create':'update',
                        file_path:target.key,encoding:'base64',content:bytes[index].toString('base64'),
                        ...(currents[index].missing?{}:{last_commit_id:currents[index].commit})}));
                    const {value}=await api(`${projectApi}/repository/commits`,{method:'POST',allowed:[201],body:JSON.stringify({
                        branch:config.branch,commit_message:`Publish Nora Tavern ${p.plan.channel} ${p.plan.tag}`,actions})});
                    assert.ok(typeof value?.id==='string'&&/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.id),
                        'Invalid JihuLab channel commit receipt');
                }
            }else if(currents[0].missing||currents[0].sha256!==object.sha256) {
                const current=currents[0];
                const body={branch:config.branch,commit_message:`Publish Nora Tavern ${p.plan.channel} ${p.plan.tag}`,
                    encoding:'base64',content:bytes[0].toString('base64'),...(current.missing?{}:{last_commit_id:current.commit})};
                const {value}=await api(repositoryUrl(object),{method:current.missing?'POST':'PUT',body:JSON.stringify(body),
                    allowed:[current.missing?201:200]});
                assert.ok(value?.file_path===object.key&&value.branch===config.branch,'Different JihuLab channel mutation receipt');
            }
            for(const target of objects)await verifyObject(target);
        },
        async verify(object,p) {const objects=pointers(p,object);await checkCoreAnchor(p);for(const target of objects)await verifyObject(target);},
    };
    return {preflight,upload,readPublic,verifyObject,verifyIdentity,verifyPreparedIdentities,channelPromotion};
}
