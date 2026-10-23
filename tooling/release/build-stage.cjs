// Same-run stage handoff only. Checkpoints never authorize publication.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const stages = ['source', 'runtime', 'package'];
const platforms = ['darwin-arm64', 'darwin-x64', 'win32-x64'];
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const name = (stage, platform) => {assert.ok(stages.includes(stage) && platforms.includes(platform));return `nora-stage-${stage}-${platform}`;};
const labels={'darwin-arm64':'macos-15, darwin, arm64, pack:mac:arm64','darwin-x64':'macos-15-intel, darwin, x64, pack:mac:x64','win32-x64':'windows-latest, win32, x64, pack:win:x64'};
const jobName = (stage, platform) => `build (${labels[platform]}) / ${stage==='build'?'acceptance':stage} (${platform})`;
const previous = stage => stages.slice(0,stages.indexOf(stage));
const checked = (command, args, options = {}) => execFileSync(command, args,
    {encoding:'utf8', timeout:120000, maxBuffer:32*1024*1024, ...options}).trim();
async function hashFile(file) {const hash=crypto.createHash('sha256');for await(const bytes of fs.createReadStream(file))hash.update(bytes);return hash.digest('hex');}
const verifierPython = () => process.env.NORA_STAGE_PYTHON || 'python';
function context(env=process.env) {
    const platform=`${process.platform}-${process.arch}`;assert.ok(platforms.includes(platform));
    assert.match(env.GITHUB_SHA||'',/^[a-f0-9]{40}$/);assert.match(env.GITHUB_REPOSITORY||'',/^[\w.-]+\/[\w.-]+$/);
    for(const key of ['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT'])assert.match(env[key]||'',/^[1-9][0-9]*$/);
    for(const key of ['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT'])assert.ok(Number.isSafeInteger(Number(env[key])),'Unsafe workflow identity');
    assert.equal(checked('git',['rev-parse','HEAD']),env.GITHUB_SHA,'Stage source differs');
    assert.equal(checked('git',['status','--porcelain','--untracked-files=no']),'','Stage source is dirty');
    const options=JSON.parse(env.NORA_STAGE_OPTIONS||'null');assert.ok(options&&typeof options==='object'&&!Array.isArray(options));
    assert.match(env.ACCEPTANCE_BASELINE_TAG||'',/^(?:EMPTY|v\d+\.\d+\.\d+)$/,'Missing selected acceptance baseline');
    const environment={imageOS:env.ImageOS||os.platform(),imageVersion:env.ImageVersion||os.version(),kernel:os.release(),node:process.version,
        python:checked(verifierPython(),['-I','-B','-c','import sys;print(sys.version)']),platform};
    return {repository:env.GITHUB_REPOSITORY,commit:env.GITHUB_SHA,runId:Number(env.GITHUB_RUN_ID),
        attempt:Number(env.GITHUB_RUN_ATTEMPT),platform,baseline:env.ACCEPTANCE_BASELINE_TAG,options:canonical(options),environment};
}
function environmentIdentity(environment) {
    assert.ok(environment&&typeof environment==='object'&&!Array.isArray(environment),'Missing stage environment');
    assert.deepEqual(Object.keys(environment).sort(),['imageOS','imageVersion','kernel','node','platform','python']);
    for(const value of Object.values(environment))assert.ok(typeof value==='string'&&value.trim().length>0&&value.length<=1024,'Invalid stage environment field');
    // Hosted image batches rotate between fresh workers. Preserve their exact
    // versions in receipts, while qualifying the same OS/kernel and pinned tools.
    return Object.fromEntries(Object.entries(environment).filter(([key])=>key!=='imageVersion'));
}
function verifyContext(receipt, expected, stage) {
    assert.equal(receipt.schema,'nora-build-stage/1');assert.equal(receipt.stage,stage);
    for(const key of ['repository','commit','runId','platform','baseline'])assert.equal(receipt.context[key],expected[key],`Stage ${key} differs`);
    assert.match(receipt.context.baseline||'',/^(?:EMPTY|v\d+\.\d+\.\d+)$/);
    assert.ok(Number.isSafeInteger(receipt.context.attempt)&&receipt.context.attempt>0&&receipt.context.attempt<=expected.attempt,'Invalid producer attempt');
    assert.deepEqual(receipt.context.options,expected.options,'Stage inputs differ');
    assert.deepEqual(environmentIdentity(receipt.context.environment),environmentIdentity(expected.environment),'Stage execution environment changed; rerun the affected producer');
    assert.match(receipt.archive.sha256,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(receipt.archive.size)&&receipt.archive.size>0);
    assert.deepEqual(receipt.inputs.map(input=>input.stage),previous(stage),'Incomplete stage dependencies');
}
function verifyArtifact(item, expected, stage, repositoryId) {
    assert.ok(Number.isSafeInteger(repositoryId)&&repositoryId>0,'Missing repository identity');
    assert.equal(item.name,name(stage,expected.platform));assert.equal(item.expired,false);
    assert.ok(Number.isSafeInteger(item.id)&&item.id>0);assert.match(item.digest||'',/^sha256:[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(item.size_in_bytes)&&item.size_in_bytes>0);
    const run=item.workflow_run;assert.equal(run.id,expected.runId);assert.equal(run.head_sha,expected.commit);
    assert.equal(run.repository_id,repositoryId);assert.equal(run.head_repository_id,repositoryId);
}
const required = {
    source:['Require launcher source stability before preparing runtimes','Check release source contracts before preparing runtimes',
        'Check installation source contracts before preparing runtimes','Require chat backup safety tests'],
    runtime:['Verify native launcher test prerequisites','Verify actual sealed Hermes cold initialization without dependency installs'],
    package:['Test release channels and update rollback','Test installation diagnostics on the target platform',
        'Verify actual lightweight update archive','Assemble full installers from the same verified payload'],
};
function verifyJob(job, expected, stage) {
    assert.ok(job,'Missing producer job');assert.equal(job.name,jobName(stage,expected.platform));
    assert.ok(Number.isSafeInteger(job.id)&&job.id>0,'Invalid producer job identity');
    assert.equal(job.run_id,expected.runId);assert.equal(job.head_sha,expected.commit);
    assert.equal(job.status,'completed');assert.equal(job.conclusion,'success','Producer did not succeed');
    assert.ok(Array.isArray(job.steps)&&job.steps.every(step=>!['failure','cancelled','timed_out','action_required'].includes(step.conclusion)),'Failed producer step');
    const gates=[...required[stage]];
    if(stage==='package')gates.push(expected.platform==='win32-x64'
        ?'Test Windows installation and managed update with legacy path limits':'Test real fresh installation and managed update before desktop packaging');
    for(const gate of gates){const matches=job.steps.filter(step=>step.name===gate);assert.equal(matches.length,1,`Missing or duplicate stage gate: ${gate}`);
        assert.equal(matches[0].status,'completed');assert.equal(matches[0].conclusion,'success',`Stage gate did not pass: ${gate}`);}
}
const api = endpoint => JSON.parse(checked('gh',['api',endpoint]));
function producerJobs(receipt, expected, query=api) {
    const pages=query(`repos/${expected.repository}/actions/runs/${expected.runId}/attempts/${receipt.context.attempt}/jobs?per_page=100`);
    assert.equal(pages.total_count,pages.jobs.length,'Incomplete producer jobs');
    const jobs=pages.jobs.filter(job=>job.name===jobName(receipt.stage,expected.platform));assert.equal(jobs.length,1,'Ambiguous producer job');
    assert.equal(jobs[0].run_attempt,receipt.context.attempt,'Producer attempt differs');
    verifyJob(jobs[0],expected,receipt.stage);return jobs[0];
}
// Tar preserves executable modes and relative framework links. Neither a runner
// home nor a live installation is archived. Every restore validates all members
// before extraction, in a new scratch directory (Python's data filter also checks
// links against the actual extraction target).
const tarScript = `import json,pathlib,sys,tarfile,shutil,posixpath,re
mode,archive,rootfile=sys.argv[1:4]
spec=json.load(open(rootfile,encoding='utf-8'));roots={k:pathlib.Path(v) for k,v in spec['roots'].items()}
if mode=='seal':
 with tarfile.open(archive,'w') as t:
  def keep(info):
   p=pathlib.PurePosixPath(info.name)
   builder=re.match(r'^workspace/release/[^/]+/nora-tavern-launcher/desktop/node_modules(?:/(.*))?$',info.name)
   if builder:
    relative=builder.group(1) or '';required='app-builder-lib/templates/nsis/installSection.nsh'
    # The final setup gate reads this exact pinned template; builder dependency
    # trees remain excluded from the checkpoint.
    if not ((info.isdir() and (not relative or required.startswith(relative+'/'))) or (info.isfile() and relative==required)):return None
   assert info.isfile() or info.isdir() or info.issym() or info.islnk(),'Special stage member'
   return info
  for scope,relative in spec['entries']:
   p=roots[scope]/relative
   if p.exists():t.add(p,arcname=scope+'/'+relative,filter=keep)
else:
 target=pathlib.Path(spec['scratch']);target.mkdir()
 with tarfile.open(archive) as t:
  members=t.getmembers();assert len(members)<=500000 and sum(m.size for m in members)<=30*1024**3
  seen=set()
  for m in members:
   p=pathlib.PurePosixPath(m.name);key=str(p).casefold()
   assert p.parts and p.parts[0] in roots and not p.is_absolute() and '..' not in p.parts
   assert '\\\\' not in m.name and ':' not in m.name and key not in seen;seen.add(key)
   assert m.isfile() or m.isdir() or m.issym() or m.islnk()
   assert any(str(p)==a or str(p).startswith(a+'/') for a in spec['allowed']),'Unexpected stage path'
   if m.issym() or m.islnk():
    assert not pathlib.PurePosixPath(m.linkname).is_absolute() and '\\\\' not in m.linkname and ':' not in m.linkname
    link=posixpath.normpath(posixpath.join(str(p.parent),m.linkname) if m.issym() else m.linkname)
    assert any(link==a or link.startswith(a+'/') for a in spec['allowed']),'Stage link escapes its restored scope'
  t.extractall(target,filter='data')
 def merge(src,dst):
  if not dst.exists() and not dst.is_symlink():dst.parent.mkdir(parents=True,exist_ok=True);shutil.move(str(src),str(dst));return
  assert src.is_dir() and dst.is_dir() and not src.is_symlink() and not dst.is_symlink(),'Refusing to overwrite a stage target'
  for child in src.iterdir():merge(child,dst/child.name)
 for scope,dest in roots.items():
  source=target/scope
  if not source.exists():continue
  for entry in source.iterdir():
   out=dest/entry.name
   merge(entry,out)
`;
function entries(stage, root, temp, options) {
    if(stage==='source')return [['temporary','test-impact.json']];
    if(stage==='runtime')return [['temporary','hermes-runtime'],['temporary','nora-hermes-cold-init-acceptance.json'],...(options.launcher_baseline_tag?[['temporary','launcher-baseline']]:[])];
    const result=[['workspace','release']];
    const reports=['nora-upgrade-baseline-acceptance.json'];
    for(const file of reports)if(fs.existsSync(path.join(temp,file)))result.push(['temporary',file]);
    const base=path.join(temp,'nora-operation-acceptance');
    if(fs.existsSync(base))for(const file of fs.readdirSync(base,{recursive:true,withFileTypes:true})){
        if(file.isFile()&&/^(?:harness-result\.json|harness-.*\.log|baseline-preparation\.json|checkpoint\.json|observed\.json|finished-status\.json|native-.*-actions\.json|preparation\.log)$/.test(file.name))
            result.push(['temporary',path.relative(temp,path.join(file.parentPath,file.name))]);
    }
    if(options.app_only)for(const file of ['nora-upgrade-baseline','nora-upgrade-baseline-launcher'])result.push(['temporary',file]);
    else if(fs.existsSync(path.join(temp,'nora-upgrade-baseline/baseline-source-receipt.json')))result.push(['temporary','nora-upgrade-baseline/baseline-source-receipt.json']);
    return result;
}
async function deliveryFiles(root) {
    const output={};const release=path.join(root,'release');
    for(const item of fs.readdirSync(release,{recursive:true,withFileTypes:true})){
        if(!item.isFile())continue;const file=path.join(item.parentPath,item.name),relative=path.relative(release,file).split(path.sep).join('/');
        if(!(/\/desktop\/dist\/(?:Nora-Tavern-|nora-launcher-)[^/]+$/.test('/'+relative)||/\/system-assets\/[^/]+$/.test('/'+relative)))continue;
        assert.ok(!output[item.name],'Duplicate delivered basename');output[item.name]={size:fs.statSync(file).size,sha256:await hashFile(file)};
    }
    return output;
}
async function seal(stage, output, {root=process.cwd(),temp=process.env.RUNNER_TEMP,expected=context()}={}) {
    assert.ok(stages.includes(stage));assert.ok(path.isAbsolute(root)&&path.isAbsolute(temp));
    assert.ok(!fs.existsSync(output),'Checkpoint already exists');fs.mkdirSync(output,{recursive:true});
    const list=entries(stage,root,temp,expected.options);assert.ok(list.length);
    for(const scope of stage==='source'?['test-impact.json']:stage==='runtime'?['hermes-runtime']:[])
        assert.ok(fs.existsSync(path.join(temp,scope)),`Missing complete stage input: ${scope}`);
    if(stage==='source'){
        const impact=JSON.parse(fs.readFileSync(path.join(temp,'test-impact.json')));
        assert.equal(impact.source?.commit,expected.commit,'Selection belongs to another source');assert.match(impact.planDigest||'',/^[a-f0-9]{64}$/);
        if(expected.options.force_full_regression)assert.equal(impact.full,true,'Forced full qualification was lost');
    }
    if(stage==='package')assert.ok(fs.existsSync(path.join(root,'release')),'Missing package tree');
    const delivery=stage==='package'?await deliveryFiles(root):null;
    if(delivery)assert.ok(Object.keys(delivery).length,'No complete delivered package files');
    const spec=path.join(output,'archive-spec.json');fs.writeFileSync(spec,JSON.stringify({roots:{workspace:root,temporary:temp},entries:list}));
    const archive=path.join(output,'state.tar');checked(verifierPython(),['-I','-B','-c',tarScript,'seal',archive,spec],{timeout:1200000});fs.unlinkSync(spec);
    const inputs=previous(stage).map(input=>({stage:input,...JSON.parse(fs.readFileSync(path.join(temp,`nora-stage-input-${input}.json`))).artifact}));
    if(delivery)assert.deepEqual(await deliveryFiles(root),delivery,'Product changed during stage sealing');
    const receipt={schema:'nora-build-stage/1',stage,context:expected,inputs,delivery,archive:{size:fs.statSync(archive).size,sha256:await hashFile(archive)}};
    fs.writeFileSync(path.join(output,'checkpoint.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});return receipt;
}
const artifactPages = expected => JSON.parse(checked('gh',['api','--paginate','--slurp',`repos/${expected.repository}/actions/runs/${expected.runId}/artifacts?per_page=100`]));
function dependencyProofs(receipt,temp) {
    for(const input of receipt.inputs){const actual=JSON.parse(fs.readFileSync(path.join(temp,`nora-stage-input-${input.stage}.json`))).artifact;
        assert.deepEqual(input,{stage:input.stage,...actual},'Upstream stage changed; rerun the affected downstream producer');}
}
async function restore(stage,{root=process.cwd(),temp=process.env.RUNNER_TEMP,expected=context(),query=api,pages=artifactPages,download}={}) {
    assert.ok(stages.includes(stage));const scratch=fs.mkdtempSync(path.join(temp,`nora-stage-${stage}-`));
    const run=query(`repos/${expected.repository}/actions/runs/${expected.runId}`);
    assert.equal(run.id,expected.runId);assert.equal(run.head_sha,expected.commit);assert.equal(run.repository.full_name,expected.repository);
    assert.equal(run.head_repository.id,run.repository.id);assert.equal(run.path,'.github/workflows/build-integrated-launcher.yml');
    const inventory=pages(expected);assert.ok(Array.isArray(inventory)&&inventory.every(page=>Array.isArray(page.artifacts)));
    const items=inventory.flatMap(page=>page.artifacts).filter(item=>item.name===name(stage,expected.platform));assert.equal(items.length,1,'Missing or ambiguous stage artifact');
    const item=items[0];verifyArtifact(item,expected,stage,run.repository.id);
    const {downloadArchive,verifyArchive,extractScript}=require('./reuse-windows-build.cjs');
    const zip=path.join(scratch,'stage.zip');await (download||downloadArchive)(item,expected.repository,zip);await verifyArchive(zip,item);
    const unpack=path.join(scratch,'bundle');checked(verifierPython(),['-I','-B','-c',extractScript,zip,unpack]);
    assert.deepEqual(fs.readdirSync(unpack).sort(),['checkpoint.json','state.tar']);
    const receipt=JSON.parse(fs.readFileSync(path.join(unpack,'checkpoint.json')));verifyContext(receipt,expected,stage);
    dependencyProofs(receipt,temp);
    const producer=producerJobs(receipt,expected,query),archive=path.join(unpack,'state.tar');
    assert.equal(fs.statSync(archive).size,receipt.archive.size);assert.equal(await hashFile(archive),receipt.archive.sha256);
    const allowed=stage==='source'?['temporary/test-impact.json']:stage==='runtime'?['temporary/hermes-runtime','temporary/nora-hermes-cold-init-acceptance.json',...(expected.options.launcher_baseline_tag?['temporary/launcher-baseline']:[])]:[
        'workspace/release','temporary/nora-operation-acceptance','temporary/nora-upgrade-baseline-acceptance.json',
        ...(expected.options.app_only?['temporary/nora-upgrade-baseline','temporary/nora-upgrade-baseline-launcher']:['temporary/nora-upgrade-baseline/baseline-source-receipt.json'])];
    const spec=path.join(scratch,'restore-spec.json');fs.writeFileSync(spec,JSON.stringify({roots:{workspace:root,temporary:temp},allowed,scratch:path.join(scratch,'restored')}));
    checked(verifierPython(),['-I','-B','-c',tarScript,'restore',archive,spec],{timeout:1200000});
    const proof={schema:'nora-stage-input/1',stage,artifact:{id:item.id,name:item.name,size:item.size_in_bytes,digest:item.digest},receipt,producer:{id:producer.id,attempt:receipt.context.attempt}};
    fs.writeFileSync(path.join(temp,`nora-stage-input-${stage}.json`),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
    if(stage==='source'){
        const impact=JSON.parse(fs.readFileSync(path.join(temp,'test-impact.json')));assert.equal(impact.schema,'nora-test-impact/1');
        assert.equal(impact.source?.commit,expected.commit,'Selection belongs to another source');assert.match(impact.planDigest||'',/^[a-f0-9]{64}$/);
        for(const field of ['full','ui','content','tavern'])assert.equal(typeof impact[field],'boolean');
        if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,['full','ui','content','tavern'].map(key=>`${key}=${impact[key]}`).join('\n')+'\n');
    }
    fs.rmSync(scratch,{recursive:true,force:true});return proof;
}
async function provenance(temp=process.env.RUNNER_TEMP,root=process.cwd(),environment=context().environment) {
    const inputs=stages.map(stage=>JSON.parse(fs.readFileSync(path.join(temp,`nora-stage-input-${stage}.json`))));
    assert.deepEqual(await deliveryFiles(root),inputs[2].receipt.delivery,'Accepted product differs from sealed package');
    const value={schema:'nora-build-stages/1',inputs,acceptanceEnvironment:environment};
    fs.writeFileSync(path.join(temp,'nora-build-stages.json'),JSON.stringify(value,null,2)+'\n',{flag:'wx'});return value;
}
function stageArtifacts(artifacts) {return artifacts.artifacts.filter(item=>/^nora-stage-(?:source|runtime|package)-(?:darwin-arm64|darwin-x64|win32-x64)$/.test(item.name));}
function verifyStageEvidence(value,run,artifacts,jobs,platform) {
    assert.equal(value.schema,'nora-build-stages/1');assert.deepEqual(value.inputs.map(input=>input.stage),stages);
    const expected={...value.inputs[0].receipt.context,attempt:run.run_attempt};
    assert.equal(expected.repository,run.repository.full_name);assert.equal(expected.runId,run.id);assert.equal(expected.commit,run.head_sha);assert.equal(expected.platform,platform);
    assert.equal(run.head_repository.id,run.repository.id);assert.equal(jobs.total_count,jobs.jobs.length,'Incomplete job listing');
    assert.deepEqual(environmentIdentity(value.acceptanceEnvironment),environmentIdentity(expected.environment),'Final acceptance environment differs');
    for(const input of value.inputs){
        verifyContext(input.receipt,expected,input.stage);
        const matches=artifacts.artifacts.filter(item=>item.id===input.artifact.id);assert.equal(matches.length,1,'Missing original stage artifact');
        const item=matches[0];verifyArtifact(item,expected,input.stage,run.repository.id);
        assert.deepEqual(input.artifact,{id:item.id,name:item.name,size:item.size_in_bytes,digest:item.digest});
        const producers=jobs.jobs.filter(job=>job.name===jobName(input.stage,platform)&&job.run_attempt===input.receipt.context.attempt);
        assert.equal(producers.length,1,'Ambiguous producer attempt');assert.equal(producers[0].id,input.producer.id);
        assert.equal(input.producer.attempt,input.receipt.context.attempt);verifyJob(producers[0],expected,input.stage);
        for(const dependency of input.receipt.inputs){const original=value.inputs.find(other=>other.stage===dependency.stage);
            assert.deepEqual(dependency,{stage:dependency.stage,...original.artifact},'Stage dependency changed');}
    }
    const delivery=value.inputs[2].receipt.delivery;assert.ok(delivery&&Object.keys(delivery).length,'Missing sealed product inventory');return delivery;
}
function allJobs(repository,runId) {
    assert.match(repository,/^[\w.-]+\/[\w.-]+$/);assert.match(String(runId),/^[1-9][0-9]*$/);assert.ok(Number.isSafeInteger(Number(runId)));
    const pages=JSON.parse(checked('gh',['api','--paginate','--slurp',`repos/${repository}/actions/runs/${runId}/jobs?filter=all&per_page=100`]));
    assert.ok(Array.isArray(pages)&&pages.every(page=>Array.isArray(page.jobs)));
    const jobs=pages.flatMap(page=>page.jobs);return {total_count:jobs.length,jobs};
}
function allArtifacts(repository,runId) {
    const artifacts=artifactPages({repository,runId}).flatMap(page=>page.artifacts);return {total_count:artifacts.length,artifacts};
}
function verifyFinalJob(jobs,run,platform) {
    let matches=jobs.jobs.filter(job=>job.name===jobName('build',platform));
    const attempt=Math.max(...matches.map(job=>job.run_attempt||1));matches=matches.filter(job=>(job.run_attempt||1)===attempt);assert.equal(matches.length,1,'Missing or ambiguous final stage');
    const job=matches[0];assert.equal(job.run_id,run.id);assert.equal(job.head_sha,run.head_sha);assert.equal(job.status,'completed');assert.equal(job.conclusion,'success');
    assert.ok(job.steps.every(step=>!['failure','cancelled','timed_out','action_required'].includes(step.conclusion)),'Failed final step');
    const gates=['Verify stage provenance and unchanged product before delivery','Verify real APP production module closure and executor receipts',
        'Verify packaged network modules in native Chromium','Verify packaged Nora images and instructions','Preserve isolated operation acceptance evidence','Upload launcher'];
    if(platform==='win32-x64')gates.push('Test the actual Windows setup and installed application');
    for(const name of gates){const selected=job.steps.filter(step=>step.name===name);assert.equal(selected.length,1,`Missing final gate: ${name}`);
        assert.equal(selected[0].status,'completed');assert.equal(selected[0].conclusion,'success',`Final gate did not pass: ${name}`);}
}
async function verifyPublishedStages(delivery,acceptance,run,artifacts,{query=api,readJobs=allJobs,readArtifacts=allArtifacts}={}) {
    const jobs=readJobs(run.repository.full_name,run.id),hasStages=jobs.jobs.some(job=>platforms.some(platform=>job.name===jobName('source',platform)));
    assert.ok(jobs.total_count>0&&jobs.total_count===jobs.jobs.length,'Missing or incomplete source jobs');
    if(!hasStages){assert.equal(stageArtifacts(artifacts).length,0,'Stage artifacts have no producer');return {mode:'legacy'};}
    const proofs=fs.readdirSync(acceptance,{recursive:true}).filter(file=>path.basename(file)==='nora-build-stages.json');
    const reuse=fs.readdirSync(acceptance,{recursive:true}).filter(file=>path.basename(file)==='nora-verified-windows-reuse.json');
    assert.ok(reuse.length<=1,'Duplicate Windows reuse proof');let reused;
    async function originalWindows() {
        if(reused)return reused;
        assert.equal(reuse.length,1,'Missing verified Windows reuse proof');
        const retained=JSON.parse(fs.readFileSync(path.join(acceptance,reuse[0])));assert.equal(retained.schema,'nora-verified-windows-reuse/1');
        assert.equal(retained.commit,run.head_sha);assert.ok(Number.isSafeInteger(retained.sourceRun)&&retained.sourceRun>0&&retained.sourceRun!==run.id);
        const source=query(`repos/${run.repository.full_name}/actions/runs/${retained.sourceRun}`);
        assert.equal(source.head_repository.id,source.repository.id);assert.equal(source.path,run.path);
        const sourceArtifacts=readArtifacts(run.repository.full_name,retained.sourceRun),sourceJobs=readJobs(run.repository.full_name,retained.sourceRun);
        const accepted=require('./reuse-windows-build.cjs').verifySource(source,sourceArtifacts,sourceJobs,
            {commit:run.head_sha,repository:run.repository.full_name,runId:retained.sourceRun});
        assert.deepEqual(retained.artifacts,accepted.map(item=>({id:item.id,name:item.name,size:item.size_in_bytes,digest:item.digest})),'Windows reuse source artifacts changed');
        assert.ok(retained.files&&Object.keys(retained.files).length,'Missing reused Windows product inventory');
        for(const [name,identity] of Object.entries(retained.files)){
            assert.equal(path.basename(name),name);const target=path.join(delivery,name);
            assert.equal(fs.statSync(target).size,identity.size,'Reused Windows product size differs');
            assert.equal(await hashFile(target),identity.sha256,'Reused Windows product differs');
        }
        reused={source,sourceArtifacts,sourceJobs};return reused;
    }
    const seen=new Set();
    if(proofs.length===2&&reuse.length===1){
        const original=await originalWindows();
        assert.equal(stageArtifacts(original.sourceArtifacts).length,0,'Staged Windows source still requires its original stage proof');
        assert.ok(!original.sourceJobs.jobs.some(job=>job.name===jobName('source','win32-x64')),'Staged Windows proof cannot be downgraded');
        seen.add('win32-x64');
    }else assert.equal(proofs.length,3,'Every staged platform requires its original stage proof');
    for(const file of proofs){const proof=JSON.parse(fs.readFileSync(path.join(acceptance,file))),ctx=proof.inputs?.[0]?.receipt?.context;
        assert.ok(ctx&&platforms.includes(ctx.platform)&&!seen.has(ctx.platform),'Duplicate or invalid stage platform');seen.add(ctx.platform);
        let source=run,sourceArtifacts=artifacts,sourceJobs=jobs;
        if(ctx.runId!==run.id){
            assert.equal(ctx.platform,'win32-x64','Only existing verified Windows reuse may cross runs');
            ({source,sourceArtifacts,sourceJobs}=await originalWindows());assert.equal(source.id,ctx.runId);
        }else if(ctx.platform==='win32-x64')assert.equal(reuse.length,0,'Unused Windows reuse proof');
        const inventory=verifyStageEvidence(proof,source,sourceArtifacts,sourceJobs,ctx.platform);
        verifyFinalJob(sourceJobs,source,ctx.platform);
        for(const [name,identity] of Object.entries(inventory)){
            assert.equal(path.basename(name),name);const target=path.join(delivery,name);
            assert.equal(fs.statSync(target).size,identity.size,'Published product size differs from package stage');
            assert.equal(await hashFile(target),identity.sha256,'Published product differs from package stage');
        }
    }
    assert.deepEqual([...seen].sort(),[...platforms].sort(),'Every platform requires successful original acceptance');
    return {mode:'staged',platforms:[...seen].sort()};
}
module.exports={stages,platforms,name,jobName,context,verifyContext,verifyArtifact,verifyJob,producerJobs,hashFile,tarScript,entries,seal,restore,provenance,deliveryFiles,required,stageArtifacts,verifyStageEvidence,verifyPublishedStages,verifyFinalJob,allJobs};
if(require.main===module){
    const [command,stage,output]=process.argv.slice(2);
    Promise.resolve().then(()=>command==='seal'?seal(stage,output):command==='restore'?restore(stage):command==='provenance'?provenance():assert.fail('Use seal, restore or provenance'))
        .catch(error=>{console.error(error);process.exitCode=1;});
}
