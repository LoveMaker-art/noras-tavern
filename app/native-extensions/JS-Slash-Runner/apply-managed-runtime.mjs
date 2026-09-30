import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Audited bindings for upstream 519599bc (4.11.2). Keep framework-owned
// integration here; never rewrite URLs or source inside user-authored scripts.
const prefix = `import { publishTavernHelper as publishNoraHelperFacade } from 'nora-module/scripts/nora-compat/interaction-bridge.js';
import { worldHelperIdentity as noraHelperIdentity } from '../../../../../scripts/nora-worlds/world-helper-identity.js';
import { createHelperControlAdapter, synchronizeHelperRuntimeReadiness, persistCharacterExtension } from '../nora-control-adapter.js';
let noraHelperIdentityRevision;
function noraCharacterPermission(avatar) {
    if (!noraHelperIdentityRevision) {
        noraHelperIdentityRevision = M(0);
        const changed = () => { noraHelperIdentityRevision.value++; };
        noraHelperIdentity.subscribe(changed);
        k.on(A.CHAT_CHANGED, changed);
    }
    noraHelperIdentityRevision.value;
    return noraHelperIdentity.resolve(avatar, S.nora_world?.id);
}
function noraPromptCharacterScripts(settings, scope) {
    const owner = noraCharacterPermission(scope.source);
    const confirm = globalThis.__NORA_CONFIRM_CHARACTER_CAPABILITIES__;
    if (!owner || !scope.script_trees.length || scope.enabled || typeof confirm !== 'function'
        || settings.script.popuped.characters.includes(owner.key)) return;
    settings.script.popuped.characters.push(owner.key);
    Promise.resolve().then(() => confirm({ characterAvatar: owner.avatar, worldId: owner.worldId, source: 'tavern-helper' }))
        .catch(error => {
            _.pull(settings.script.popuped.characters, owner.key);
            console.error('[Tavern Helper] Nora capability prompt failed', error);
        });
}
function publishTavernHelper(candidate) {
    const facade = publishNoraHelperFacade({ ...candidate, noraControls: createHelperControlAdapter({
        globalStore: () => uF(), scopeStore: type => kI(type),
        scopeOwner: type => type === 'character' ? oF().id : type === 'preset' ? hF().id : null,
        validateSettings: value => rk.parse(value), clone: value => Sk(value),
        flushScope: async type => {
            if (type === 'global') { mt.tavern_helper = Sk(uF().settings); return; }
            if (type === 'character') { const store = oF(); await aF(store.id, store.avatar, Sk(store.settings)); return; }
            const store = hF(); mF.cancel();
            fF(store.id, store.name, Sk(store.settings));
            await pF(store.id, store.name, Sk(store.settings));
        },
    }) });
    synchronizeHelperRuntimeReadiness(uF());
    return facade;
}
`;

function replaceOnce(source, before, after) {
    if (source.split(after).length === 2) return source;
    if (source.split(before).length !== 2) throw new Error(`Unknown Helper runtime binding: ${before}`);
    return source.replace(before, after);
}

export function transformManagedRuntime(source) {
    source = source.replaceAll('from"../../../../../', 'from"nora-module/');
    source = replaceOnce(source, 'globalThis.TavernHelper=uq()', 'globalThis.TavernHelper=publishTavernHelper(uq())');
    source = replaceOnce(source, '$(`#extension_floating_prompt`).val();', '$(`#extension_floating_prompt`).val()??``;');
    source = replaceOnce(source,
        'p=Ct.new_chat_prompt,m=await vt.createAsync(`system`,Re(p),`newMainChat`);n.reserveBudget(m),f.add(m);',
        'p=typeof Ct.new_chat_prompt==`string`?Re(Ct.new_chat_prompt).trim():``,m=p?await vt.createAsync(`system`,p,`newMainChat`):null;m&&(n.reserveBudget(m),f.add(m));');
    source = replaceOnce(source, '}n.freeBudget(m),c?', '}m&&n.freeBudget(m),c?');
    const cdn = 'https://testingcf.jsdelivr.net/';
    const local = '/scripts/extensions/third-party/JS-Slash-Runner/vendor/iframe/';
    for (const [url, file] of [
        ['npm/@fortawesome/fontawesome-free/css/all.min.css', 'fontawesome/css/all.min.css'],
        ['npm/jquery/dist/jquery.min.js', 'jquery-3.5.1.min.js'],
        ['npm/jquery-ui/dist/jquery-ui.min.js', 'jquery-ui/jquery-ui-1.13.2.min.js'],
        ['npm/jquery-ui/themes/base/theme.min.css', 'jquery-ui/jquery-ui-1.13.2.min.css'],
        ['npm/jquery-ui-touch-punch', 'jquery-ui-touch-punch-1.0.9.min.js'],
        ['npm/vue/dist/vue.runtime.global.prod.min.js', 'vue.runtime.global.prod.min.js'],
        ['npm/vue-router/dist/vue-router.global.prod.min.js', 'vue-router.global.prod.min.js'],
        ['gh/N0VI028/JS-Slash-Runner/src/iframe/node_modules/log.js', 'log.js'],
    ]) {
        const expected = file === 'vue.runtime.global.prod.min.js' ? 3 : ['vue-router.global.prod.min.js', 'log.js'].includes(file) ? 2 : 1;
        if (source.split(local + file).length - 1 === expected) continue;
        if (source.split(cdn + url).length - 1 !== expected) throw new Error(`Unknown Helper bootstrap URL: ${url}`);
        source = source.replaceAll(cdn + url, local + file);
    }
    // Permission belongs to the World; source and persistence still use the
    // actual ST avatar. Invalidate on World/binding changes, including a switch
    // where the old and new World temporarily share an avatar.
    source = replaceOnce(source,
        'get:()=>i.avatar!==void 0&&e.settings.script.enabled.characters.includes(i.avatar),set:t=>{i.avatar!==void 0&&(t?e.settings.script.enabled.characters.push(i.avatar):_.pull(e.settings.script.enabled.characters,i.avatar))}',
        'get:()=>{const owner=noraCharacterPermission(i.avatar);return !!owner&&e.settings.script.enabled.characters.includes(owner.key)},set:t=>{const owner=noraCharacterPermission(i.avatar);if(owner){if(t){if(!e.settings.script.enabled.characters.includes(owner.key))e.settings.script.enabled.characters.push(owner.key)}else _.pull(e.settings.script.enabled.characters,owner.key)}}');
    const promptStart = 'k.once(`chatLoaded`,()=>{I(t,e=>';
    const promptEnd = '}),k.on(A.CHARACTER_RENAMED';
    const promptReplacement = 'k.once(`chatLoaded`,()=>{I(()=>noraCharacterPermission(i.source)?.key,()=>noraPromptCharacterScripts(n.settings,i),{immediate:!0,flush:`post`})';
    if (!source.includes(promptReplacement)) {
        const start = source.indexOf(promptStart), end = source.indexOf(promptEnd, start);
        if (start < 0 || end < 0 || source.indexOf(promptStart, start + 1) >= 0) throw new Error('Unknown Helper character prompt binding');
        source = source.slice(0, start) + promptReplacement + source.slice(end);
    }
    // Upstream guesses old character names by appending .png. Nora must not
    // convert either legacy records or World permission keys into filenames.
    const migrationStart = 't.value.script.enabled.characters.length>0&&!t.value.script.enabled.characters[0].endsWith(`.png`)';
    const start = source.indexOf(migrationStart);
    if (start >= 0) {
        const end = source.indexOf('I(t,e=>{_.set(mt,$O,Sk(e)),Ae()}', start);
        if (end < 0) throw new Error('Unknown Helper permission migration');
        source = source.slice(0, start) + source.slice(end);
    } else if (!source.includes(prefix)) throw new Error('Unknown Helper legacy migration binding');
    source = source.replace(/\n\/\/# sourceMappingURL=index\.js\.map\s*$/, '\n');
    if (!source.includes(prefix)) source = prefix + source;
    return source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const file = new URL('./dist/index.js', import.meta.url);
    await fs.writeFile(file, transformManagedRuntime(await fs.readFile(file, 'utf8')));
}
