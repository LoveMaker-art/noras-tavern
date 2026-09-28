import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function transformWorldPreset(source) {
    const changes = [
        ['let n=M(NF(e.value));I([e,t]', 'let n=M(noraWorldPreset.active?NF(e.value):Ok.parse({}));I([e,t]'],
        ['function iK(e){let t=', 'function iK(e){if(noraWorldPreset.active&&(e==="in_use"||e===noraWorldPreset.source))return Wk($G(noraWorldPreset.snapshot().preset,{in_use:false}));let t='],
        ['async function sK(e,t=YG,{render:n=`debounced`}={}){let r=', 'async function sK(e,t=YG,{render:n=`debounced`}={}){if(noraWorldPreset.active&&(e==="in_use"||e===noraWorldPreset.source)){await noraWorldPreset.save(eK(t));return false}let r='],
        ['(e.name===`in_use`?wt:Jk(e.name))?.extensions?.regex_scripts', '(e.name===`in_use`?(noraWorldPreset.active?noraWorldPreset.snapshot().preset:wt):Jk(e.name))?.extensions?.regex_scripts'],
        ['qk=pt(`openai`)', 'qk=noraWorldPresetManager(pt(`openai`))'],
        ['function PF(e,t,n){e===', 'function PF(e,t,n){if(noraWorldPreset.active||String(t).startsWith("nora-world:"))return;e==='],
        ['return{id:Gi(e),name:Gi(t),settings:n}});function RF', 'noraWorldPreset.subscribe(()=>{IF.cancel();r(()=>{e.value=String(qk.getSelectedPreset());t.value=qk.getSelectedPresetName();n.value=NF(e.value)})});return{id:Gi(e),name:Gi(t),settings:n}});function RF'],
        ['get:()=>i.name!==void 0&&e.settings.script.enabled.presets.includes(i.name)', 'get:()=>(i.settings,noraWorldPreset.active?noraWorldPreset.enabled("scripts"):i.name!==void 0&&e.settings.script.enabled.presets.includes(i.name))'],
        ['set:t=>{i.name!==void 0&&(t?e.settings.script.enabled.presets.push', 'set:t=>{if(noraWorldPreset.active){void noraWorldPreset.permission("scripts",t).catch(console.error);return}i.name!==void 0&&(t?e.settings.script.enabled.presets.push'],
    ];
    for (const [before, after] of changes) {
        if (after.startsWith('noraWorldPreset.subscribe') && source.includes('noraWorldPreset.subscribe(')) continue;
        if (source.includes(after)) continue;
        if (source.split(before).length !== 2) throw new Error(`Unknown Helper binding: ${before}`);
        source = source.replace(before, after);
    }
    const prefix = "import { worldPresetExtensions as noraWorldPreset, worldPresetManager as noraWorldPresetManager } from 'nora-module/scripts/nora-worlds/world-preset-extensions.js';\n";
    if (!source.includes(prefix)) source = prefix + source;
    const oldSync = 'noraWorldPreset.subscribe(()=>{IF.cancel();r(()=>{e.value=String(qk.getSelectedPreset());t.value=qk.getSelectedPresetName();n.value=NF(e.value)})});';
    const newSync = 'noraWorldPreset.subscribe(()=>{IF.cancel();r(()=>{e.value=noraWorldPreset.active?String(qk.getSelectedPreset()):undefined;t.value=noraWorldPreset.active?qk.getSelectedPresetName():undefined;n.value=noraWorldPreset.active?NF(e.value):Ok.parse({})})});';
    if (source.includes(oldSync)) source = source.replace(oldSync, newSync);
    else if (!source.includes(newSync)) throw new Error('Unknown Helper world subscription');
    return source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const file = new URL('./dist/index.js', import.meta.url);
    await fs.writeFile(file, transformWorldPreset(await fs.readFile(file, 'utf8')));
}
