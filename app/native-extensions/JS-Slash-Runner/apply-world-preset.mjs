import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function transformWorldPreset(source) {
    const changes = [
        ['let n=M(dF(e.value));I([e,t]', 'let n=M(noraWorldPreset.active?dF(e.value):ak.parse({}));I([e,t]'],
        ['function kG(e){let t=', 'function kG(e){if(noraWorldPreset.active&&(e==="in_use"||e===noraWorldPreset.source))return Sk(wG(noraWorldPreset.snapshot().preset,{in_use:false}));let t='],
        ['async function MG(e,t=bG,{render:n=`debounced`}={}){let r=', 'async function MG(e,t=bG,{render:n=`debounced`}={}){if(noraWorldPreset.active&&(e==="in_use"||e===noraWorldPreset.source)){await noraWorldPreset.save(TG(t));return false}let r='],
        ['(e.name===`in_use`?Ct:Ek(e.name))?.extensions?.regex_scripts', '(e.name===`in_use`?(noraWorldPreset.active?noraWorldPreset.snapshot().preset:Ct):Ek(e.name))?.extensions?.regex_scripts'],
        ['Tk=ft(`openai`)', 'Tk=noraWorldPresetManager(ft(`openai`))'],
        ['function fF(e,t,n){e===', 'function fF(e,t,n){if(noraWorldPreset.active||String(t).startsWith("nora-world:"))return;e==='],
        ['return{id:Gi(e),name:Gi(t),settings:n}});function gF', 'noraWorldPreset.subscribe(()=>{mF.cancel();r(()=>{e.value=String(Tk.getSelectedPreset());t.value=Tk.getSelectedPresetName();n.value=dF(e.value)})});return{id:Gi(e),name:Gi(t),settings:n}});function gF'],
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
    const oldSync = 'noraWorldPreset.subscribe(()=>{mF.cancel();r(()=>{e.value=String(Tk.getSelectedPreset());t.value=Tk.getSelectedPresetName();n.value=dF(e.value)})});';
    const newSync = 'noraWorldPreset.subscribe(()=>{mF.cancel();r(()=>{e.value=noraWorldPreset.active?String(Tk.getSelectedPreset()):undefined;t.value=noraWorldPreset.active?Tk.getSelectedPresetName():undefined;n.value=noraWorldPreset.active?dF(e.value):ak.parse({})})});';
    if (source.includes(oldSync)) source = source.replace(oldSync, newSync);
    else if (!source.includes(newSync)) throw new Error('Unknown Helper world subscription');
    return source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const file = new URL('./dist/index.js', import.meta.url);
    await fs.writeFile(file, transformWorldPreset(await fs.readFile(file, 'utf8')));
}
