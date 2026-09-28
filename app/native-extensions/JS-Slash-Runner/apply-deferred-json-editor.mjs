import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Exact anchors protect the pinned vendor build and existing Nora adaptations.
export function transformDeferredEditor(source) {
    const replacements = [
        ['import{Mode as un,ValidationSeverity as dn,createJSONEditor as fn}from"../lib/jsoneditor.js";',
            'import{mountJSONEditor as noraMountJSONEditor}from"../deferred-json-editor.js";'],
        ['s,c=!1,l=un.tree,u=!1,d=[]', 's,noraStopEditorWatch,c=!1,l="tree",u=!1,d=[]'],
        ['is(()=>{document.documentElement.style.setProperty(`--jse-custom-anim-duration`',
            'is(()=>noraMountJSONEditor({target:i.value,disposed:()=>u,initialize:({Mode:un,ValidationSeverity:dn,createJSONEditor:fn})=>{document.documentElement.style.setProperty(`--jse-custom-anim-duration`'],
        ['language:f().includes(`zh`)?`zh`:`en`}}),I(r,(e,t)=>',
            'language:f().includes(`zh`)?`zh`:`en`}}),noraStopEditorWatch=I(r,(e,t)=>'],
        ['h()})}),as(()=>{u=!0,d.length=0,s?.destroy()})',
            'h()})}})),as(()=>{u=!0,d.length=0,o.cancel(),noraStopEditorWatch?.(),s?.destroy()})'],
    ];
    for (const [before, after] of replacements) {
        const oldCount = source.split(before).length - 1;
        const newCount = source.split(after).length - 1;
        if (oldCount === 0 && newCount === 1) continue;
        if (oldCount !== 1 || newCount !== 0) throw new Error('Managed runner changed: review deferred editor anchors');
        source = source.replace(before, after);
    }
    return source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const file = new URL('./dist/index.js', import.meta.url);
    await fs.writeFile(file, transformDeferredEditor(await fs.readFile(file, 'utf8')));
}
