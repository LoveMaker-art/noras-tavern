import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const stages = new Set(['seal', 'prepare', 'promote', 'all']);
const inside = (root, file) => { const relative = path.relative(root, file); return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
function regular(file) {
    assert.ok(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), `Expected regular sealed file: ${file}`);
}
export async function fileDigest(file) {
    regular(file); const digest = crypto.createHash('sha256'); let size = 0;
    for await (const bytes of fs.createReadStream(file)) { digest.update(bytes); size += bytes.length; }
    return {size, sha256: digest.digest('hex')};
}
function atomic(file, value) {
    assert.ok(!fs.lstatSync(path.dirname(file)).isSymbolicLink(), 'Linked state directory');
    if(fs.existsSync(file))regular(file);
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, json(value)); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    try { fs.renameSync(temporary, file); } finally { fs.rmSync(temporary, {force:true}); }
}
function directory(root) { const stat=fs.lstatSync(root);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink(),'Linked or invalid publication directory'); }
function identity(plan) {
    assert.equal(plan.schema, 'nora-publication-plan/1');
    assert.match(plan.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    assert.match(plan.tag, /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/);
    assert.match(plan.commit, /^[a-f0-9]{40}$/);
    assert.ok(['full', 'components'].includes(plan.mode));
    assert.ok(['legacy', 'shared'].includes(plan.assetMode));
    assert.equal(plan.channel, plan.tag.includes('-beta.') ? 'beta' : 'stable');
    assert.ok(Number.isFinite(Date.parse(plan.publishedAt)));
    assert.equal(typeof plan.body, 'string');
    assert.match(plan.sourceRun, /^(?:local|[1-9][0-9]*)$/);
    assert.ok(plan.objects.length >= 3);
    const names = new Set();
    for (const object of plan.objects) {
        assert.match(object.sha256, /^[a-f0-9]{64}$/);
        assert.ok(Number.isSafeInteger(object.size) && object.size > 0);
        assert.ok(!names.has(object.key), 'Duplicate sealed object'); names.add(object.key);
        const sourceTag = object.assetReleaseTag || plan.tag;
        assert.match(sourceTag, /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/);
        const phase = object.key === `channels/${plan.channel}.json` ? 'channel'
            : object.key === `releases/${plan.tag}/release.json` ? 'catalogue'
            : object.key.startsWith(`releases/${sourceTag}/`) ? 'asset' : null;
        assert.ok(phase && phase === object.phase, 'Invalid sealed phase/identity');
        assert.match(object.key, /^(?:releases\/v\d+\.\d+\.\d+(?:-beta\.\d+)?\/[A-Za-z0-9][A-Za-z0-9._-]*|channels\/(?:stable|beta)\.json)$/);
        assert.ok(['asset', 'state'].includes(object.location));
        assert.equal(typeof object.relativePath, 'string');
        assert.ok(object.relativePath && !path.isAbsolute(object.relativePath) && !object.relativePath.split(/[\\/]/).includes('..'));
        assert.ok(!object.reference || (phase === 'asset' && plan.assetMode === 'shared' && sourceTag !== plan.tag));
        if(object.reference)assert.match(object.sourceCommit,/^[a-f0-9]{40}$/);
    }
    assert.equal(plan.objects.at(-1).phase, 'channel');
    assert.equal(plan.objects.at(-2).phase, 'catalogue');
}

// Paths in the signed-by-digest plan are portable across CI runners. Progress is
// separate: a failed transfer cannot change the catalogue date or asset bytes.
export async function sealPublication(distribution, {root, stateDir, repository, sourceRun = 'local', publisherCommit = '', assetMode = 'legacy'} = {}) {
    root = path.resolve(root); stateDir = path.resolve(stateDir);
    assert.ok(!inside(root, stateDir) && root !== stateDir, 'State must be outside release assets');
    assert.ok(!fs.existsSync(path.join(stateDir, 'publication-plan.json')), 'Sealed plan already exists; use --resume');
    fs.mkdirSync(stateDir, {recursive: true, mode: 0o700});
    directory(root);directory(stateDir);
    const plan = {schema: 'nora-publication-plan/1', repository, sourceRun: String(sourceRun),
        tag: distribution.plan.tag, commit: distribution.plan.commit, mode: distribution.plan.mode,
        channel: distribution.plan.channel, assetMode, publishedAt: distribution.release.published_at,
        body: distribution.release.body, objects: []};
    for (const object of distribution.plan.objects) {
        const location = inside(root, object.file) ? 'asset' : 'state';
        const directory = location === 'asset' ? root : stateDir;
        assert.ok(inside(directory, object.file), 'Generated objects must reside inside the state directory');
        const bytes = await fileDigest(object.file);
        assert.equal(bytes.size, object.size); assert.equal(bytes.sha256, object.sha256);
        const {file, ...metadata} = object;
        plan.objects.push({...metadata, location, relativePath: path.relative(directory, file).split(path.sep).join('/')});
    }
    identity(plan);
    const planId = hash(json(plan));
    atomic(path.join(stateDir, 'publication-plan.json'), plan);
    atomic(path.join(stateDir, 'publication-state.json'), {schema: 'nora-publication-state/1', planId,
        repository, tag: plan.tag, commit: plan.commit, sourceRun: plan.sourceRun,
        publishers: publisherCommit ? [publisherCommit] : [], status: 'sealed', sources: {
            sourceforge: {objects: {}, ready: false, promoted: false}, github: {objects: {}, ready: false, promoted: false}},
        updatedAt: new Date().toISOString()});
    return loadPublication({root, stateDir, repository, tag: plan.tag, commit: plan.commit, mode: plan.mode, sourceRun});
}

export async function loadPublication({root, stateDir, repository, tag, commit, mode, sourceRun, assetMode, expectedPlanId} = {}) {
    root = path.resolve(root); stateDir = path.resolve(stateDir);
    assert.ok(!inside(root, stateDir) && root !== stateDir, 'State must be outside release assets');
    directory(root);directory(stateDir);
    for (const name of ['publication-plan.json', 'publication-state.json']) regular(path.join(stateDir, name));
    const plan = JSON.parse(fs.readFileSync(path.join(stateDir, 'publication-plan.json')));
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'publication-state.json')));
    identity(plan);
    assert.equal(state.schema, 'nora-publication-state/1');
    assert.equal(state.planId, hash(json(plan)), 'Sealed plan digest differs from checkpoint');
    if(expectedPlanId!==undefined){assert.match(expectedPlanId,/^[a-f0-9]{64}$/);assert.equal(state.planId,expectedPlanId,'Plan differs from trusted external receipt');}
    for (const [name, expected] of Object.entries({repository, tag, commit, mode, sourceRun: sourceRun == null ? undefined : String(sourceRun), assetMode})) {
        if (expected !== undefined) assert.equal(plan[name], expected, `Sealed ${name} differs`);
    }
    for (const name of ['repository', 'tag', 'commit', 'sourceRun']) assert.equal(state[name], plan[name], `Checkpoint ${name} differs`);
    for (const source of ['github', 'sourceforge']) {
        assert.equal(typeof state.sources?.[source]?.objects, 'object');
        for (const [key, receipt] of Object.entries(state.sources[source].objects)) {
            const object = plan.objects.find(item => item.key === key);
            assert.ok(object && receipt.sha256 === object.sha256 && receipt.size === object.size && receipt.verifiedAt,
                'Checkpoint receipt differs from sealed object');
        }
    }
    const objects = [];
    for (const object of plan.objects) {
        const directory = object.location === 'asset' ? root : stateDir;
        const file = path.resolve(directory, object.relativePath);
        assert.ok(inside(directory, file), 'Sealed path escapes its root');
        // Reject symlink ancestors as well as linked files.
        let current = file;
        while (current !== directory) { assert.ok(!fs.lstatSync(current).isSymbolicLink(), 'Linked sealed path'); current = path.dirname(current); }
        const bytes = await fileDigest(file);
        assert.equal(bytes.size, object.size, 'Sealed publication bytes changed');
        assert.equal(bytes.sha256, object.sha256, 'Sealed publication bytes changed');
        objects.push({...object, file});
    }
    const release=JSON.parse(fs.readFileSync(objects.at(-2).file));
    assert.equal(release.tag_name,plan.tag,'Catalogue tag differs');
    assert.equal(release.body,plan.body,'Catalogue notes differ');
    assert.equal(release.published_at,plan.publishedAt,'Catalogue date differs');
    assert.equal(release.draft,false);assert.equal(release.prerelease,plan.channel==='beta');
    const advertised=JSON.parse(fs.readFileSync(objects.at(-1).file));
    assert.deepEqual(advertised,plan.channel==='beta'?[release]:release,'Channel differs from sealed catalogue');
    const physical=objects.filter(item=>item.phase==='asset'&&!item.reference);
    assert.ok(Array.isArray(release.assets)&&release.assets.length===physical.length,'Catalogue asset closure differs');
    const names=new Set();
    for(const asset of release.assets){
        assert.ok(!names.has(asset.name),'Duplicate catalogue asset');names.add(asset.name);
        const object=physical.find(item=>path.basename(item.key)===asset.name);assert.ok(object,'Unknown catalogue asset');
        assert.equal(asset.size,object.size);assert.equal(asset.digest,`sha256:${object.sha256}`);assert.equal(asset.state,'uploaded');
        assert.equal(asset.browser_download_url,`https://github.com/${plan.repository}/releases/download/${plan.tag}/${asset.name}`);
    }
    return {root, stateDir, plan: {...plan, objects}, sealedPlan: plan, state,release};
}

export async function executePublication(publication, {stage = 'seal', providers, publisherCommit = '', log = console.log} = {}) {
    assert.ok(stages.has(stage), 'Invalid publication stage');
    const {state, plan, stateDir} = publication;
    const save = () => { state.updatedAt = new Date().toISOString(); atomic(path.join(stateDir, 'publication-state.json'), state); };
    if (publisherCommit && !state.publishers.includes(publisherCommit)) state.publishers.push(publisherCommit);
    save();
    if (stage === 'seal') return state;
    for (const source of ['sourceforge', 'github']) {
        for (const method of ['begin', 'inspect', 'upload', 'verify', 'assertReady', 'checkPromotion', 'promote', 'verifyPromotion']) {
            assert.equal(typeof providers?.[source]?.[method], 'function', `Missing ${source}.${method}`);
        }
    }
    const progress = (source, phase, object) => {
        state.active = {source, phase, key: object?.key || null, startedAt: new Date().toISOString()};
        state.activeSources ||= {};state.activeSources[source]=state.active;save();
        log(`${source} ${phase}${object ? ` ${object.key} (${object.size} bytes)` : ''}`);
    };
    try {
        if (stage === 'prepare' || stage === 'all') {
            state.status = 'preparing'; delete state.failure; save();
            // A failure must wait for the other independent source to finish and
            // checkpoint; neither source may promote a channel in this phase.
            const results = await Promise.allSettled(['sourceforge', 'github'].map(async source => {
                const provider = providers[source], checkpoint = state.sources[source];checkpoint.ready=false;save();
                try {
                progress(source, 'begin'); await provider.begin(publication);
                const objects = plan.objects.filter(item => item.phase !== 'channel' && (source !== 'github' || item.phase === 'asset'));
                for (const object of objects) {
                    progress(source, 'inspect', object);
                    const receipt = checkpoint.objects[object.key];
                    const existing = await provider.inspect(object, receipt, publication);
                    assert.ok(['missing', 'matching'].includes(existing), 'Invalid remote inspection result');
                    if (existing === 'missing') {
                        assert.ok(!object.reference, 'Referenced immutable asset is missing; never create it under an old tag');
                        progress(source, 'upload', object); await provider.upload(object, publication);
                        progress(source, 'verify', object); await provider.verify(object, publication);
                    }
                    checkpoint.objects[object.key] = {sha256: object.sha256, size: object.size, verifiedAt: new Date().toISOString()}; save();
                    log(`${source} verified ${object.key} sha256=${object.sha256}`);
                }
                progress(source, 'ready-check'); await provider.assertReady(publication);
                checkpoint.ready = true;delete state.activeSources[source];save();
                } catch(error){error.publicationPhase=state.activeSources[source];throw error;}
            }));
            const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
            if (errors.length) throw new AggregateError(errors, 'Publication preparation failed; resume the sealed plan');
            state.status = 'prepared'; delete state.active;delete state.activeSources;save();
        }
        if (stage === 'promote' || stage === 'all') {
            assert.ok(state.sources.github.ready && state.sources.sourceforge.ready, 'Both sources must be prepared before promotion');
            for (const source of ['github', 'sourceforge']) {
                progress(source, 'ready-check'); await providers[source].assertReady(publication);
                progress(source, 'promotion-check'); await providers[source].checkPromotion(publication);
            }
            state.status = 'promoting'; save();
            // Cross-site promotion cannot be atomic. Checkpoint GitHub first;
            // a later SourceForge failure resumes only its channel switch.
            for (const source of ['github', 'sourceforge']) {
                if (!state.sources[source].promoted) {
                    progress(source, 'promote'); await providers[source].promote(publication);
                    progress(source, 'verify-promotion'); await providers[source].verifyPromotion(publication);
                    state.sources[source].promoted = true; save();
                } else await providers[source].verifyPromotion(publication);
            }
            state.status = 'published'; delete state.active;delete state.activeSources; delete state.failure; save();
        }
        return state;
    } catch (error) {
        const failures = (error instanceof AggregateError ? error.errors : [error]).map(item=>({phase:item.publicationPhase||state.active,message:String(item.message).slice(0,1000)}));
        // Persist phase and bounded diagnostics, never environment/configuration.
        state.failure = {failures, at: new Date().toISOString()};
        state.status = 'failed'; save(); throw error;
    }
}
