import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [mode = 'source', root = path.resolve(import.meta.dirname, '../../app'), output] = process.argv.slice(2);
const digest = value => createHash('sha256').update(value).digest('hex');
const walk = dir => fs.existsSync(dir) ? fs.readdirSync(dir, {withFileTypes:true}).flatMap(e => e.name.startsWith('._') ? [] : e.isDirectory() ? walk(path.join(dir,e.name)) : [path.join(dir,e.name)]) : [];
const rel = file => path.relative(root,file).split(path.sep).join('/');
const scopes = ['engine/sillytavern/public/script.js', 'engine/sillytavern/public/index.html', 'engine/sillytavern/public/scripts', 'engine/sillytavern/public/dist/nora', 'native-extensions/nora-ui', 'native-extensions/nora-mvu', 'native-extensions/JS-Slash-Runner'];
const files = scopes.flatMap(item => {const p=path.join(root,item);return fs.statSync(p).isDirectory()?walk(p):[p];}).filter(f=>/\.(?:js|json|html|css|gz|br)$/.test(f));
const fingerprints = files.map(file=>({file:rel(file),sha256:digest(fs.readFileSync(file))}));
let result;
if(mode==='fingerprints') {
    const deployed='/opt/data/tavern-state/native/default-user/extensions';
    const managed = fingerprints.filter(f=>f.file.startsWith('native-extensions/')).map(f=>{
        const p=path.join(deployed,f.file.slice('native-extensions/'.length));
        return {file:f.file,exists:fs.existsSync(p),matches:fs.existsSync(p)&&digest(fs.readFileSync(p))===f.sha256};
    });
    result={captured_at:new Date().toISOString(),files:fingerprints,managed};
} else if(mode==='cards') {
    const { read } = await import(pathToFileURL(path.join(root,'engine/sillytavern/src/character-card-parser.js')));
    const response=await fetch('http://127.0.0.1:8799/api/nora-worlds-v2/worlds');
    if(!response.ok)throw Error(`worlds ${response.status}`);
    const {worlds}=await response.json();
    const tokens=/\b(?:generateRaw|generateQuietPrompt|generateRawData|generate|Generate|triggerSlashWithResult|triggerSlash|executeSlashCommandsWithOptions|executeSlashCommands|stopGenerationById|stopAllGeneration|stopGeneration|sendMessageAsUser|sendText|regenerate|setChatMessages|setChatMessage|createChatMessages|deleteChatMessages|rotateChatMessages|updateWorldbookWith|replaceWorldbook|getWorldbook|replaceVariables|updateVariablesWith|getVariables|request_chat_completion|request_chat_stop|slash-command|swipe_left|swipe_right|TavernHelper|getContext|fetch|postMessage)\b|#(?:send_but|mes_stop|options_button|send_textarea)|\/trigger\b|\/send\b|\/genraw\b|\/gen\b/g;
    result={captured_at:new Date().toISOString(),method:'String token inventory, not executed-call proof; no prompt contents exported',worlds:[]};
    const externalRefs=value=>[...value.matchAll(/(?:import\s*\(?\s*|from\s+|\.load\s*\(\s*|\bsrc\s*=\s*)["'`]([^"'`]+)["'`]/g)].map(m=>m[1]).filter(x=>/^https?:/.test(x)).map(x=>{try{const u=new URL(x);return `${u.origin}${u.pathname}`;}catch{return '<unresolved>';}});
    for(const w of worlds){
        const file=path.join('/opt/data/tavern-state/native/default-user/characters',w.runtime_card.binding.avatar);
        const buffer=fs.readFileSync(file);const card=JSON.parse(read(buffer));const found=[],external=[];
        const visit=(value,field)=>{
            if(typeof value==='string'){
                const hits=[...new Set(value.match(tokens)||[])].sort();
                if(hits.length)found.push({field,characters:value.length,tokens:hits});
                const refs=externalRefs(value);if(refs.length)external.push({field,references:[...new Set(refs)]});
            }else if(Array.isArray(value))value.forEach((v,i)=>visit(v,`${field}.${i}`));
            else if(value&&typeof value==='object')Object.entries(value).forEach(([k,v])=>visit(v,`${field}.${k}`));
        };
        visit(card.data??card,'data');
        result.worlds.push({name:w.name,world_id:w.world_id,card_sha256:digest(buffer),capabilities:w.capabilities,fields:found,external});
    }
    const state='/opt/data/tavern-state/native/default-user';
    const settings=JSON.parse(fs.readFileSync(path.join(state,'settings.json'),'utf8'));
    result.installed_extensions=fs.readdirSync(path.join(state,'extensions'),{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.name.startsWith('.')).map(e=>e.name);
    result.disabled_extensions=settings.extension_settings?.disabledExtensions??settings.disabled_extensions??[];
    result.helper_script_configuration_keys=Object.keys(settings.extension_settings?.tavern_helper?.script??{});
    result.configured_global_scripts=[];
    const scanScripts=(value,field)=>{
        if(Array.isArray(value))value.forEach((v,i)=>scanScripts(v,`${field}.${i}`));
        else if(value&&typeof value==='object'){
            if(typeof value.content==='string')result.configured_global_scripts.push({field,name:String(value.name??''),enabled:value.enabled??null,tokens:[...new Set(value.content.match(tokens)||[])].sort(),external:externalRefs(value.content)});
            Object.entries(value).filter(([key])=>key!=='content').forEach(([key,v])=>scanScripts(v,`${field}.${key}`));
        }
    };
    scanScripts(settings.extension_settings?.tavern_helper?.script?.scripts,'settings.extension_settings.tavern_helper.script.scripts');
} else {
    const req=createRequire(path.join(root,'engine/sillytavern/package.json'));
    const ts=req('typescript');
    result={captured_at:new Date().toISOString(),scope:scopes,files:fingerprints,commands:[],registrations:[],context:[],helper:[],helper_bound:[],calls:[],selectors:[],post_messages:[],parse_diagnostics:[]};
    const sinkNames=new Set(['Generate','generate','generateRaw','generateRawData','generateQuietPrompt','sendGenerationRequest','sendStreamingRequest','sendText','sendTextareaMessage','sendMessageAsUser','regenerate','regenerateLastMessage','stopGeneration','stopGenerationById','stopAllGeneration','executeSlashCommands','executeSlashCommandsWithOptions','triggerSlash','triggerSlashWithResult','commitMessageEdit','deleteLastMessage','deleteMessage','swipe','swipe_left','swipe_right','deleteSwipe','setChatMessages','setChatMessage','createChatMessages','deleteChatMessages','rotateChatMessages']);
    for(const file of files.filter(f=>f.endsWith('.js')&&!f.includes('/public/dist/')&&!f.includes('/vendor/iframe/')&&!f.includes('/lib/'))){
        const text=fs.readFileSync(file,'utf8'), sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
        const loc=n=>({file:rel(file),line:sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1,column:sf.getLineAndCharacterOfPosition(n.getStart(sf)).character+1,offset:n.getStart(sf)});
        const name=n=>n&&(ts.isIdentifier(n)||ts.isStringLiteral(n))?n.text:n?.getText(sf);
        const props=n=>new Map(n.properties.map(p=>[name(p.name),p.initializer??p.name]));
        const literal=n=>n&&ts.isStringLiteralLike(n)?n.text:null;
        const brief=n=>n?.getText(sf).slice(0,170)??null;
        const owner=n=>{for(let p=n.parent;p;p=p.parent)if(ts.isFunctionLike(p))return p.name?.getText(sf)|| (ts.isVariableDeclaration(p.parent)?name(p.parent.name):'<anonymous>');return '<module>';};
        for(const d of sf.parseDiagnostics)result.parse_diagnostics.push({file:rel(file),start:d.start,message:ts.flattenDiagnosticMessageText(d.messageText,' ')});
        const visit=n=>{
            if(ts.isCallExpression(n)){
                const callee=n.expression.getText(sf), method=ts.isPropertyAccessExpression(n.expression)?n.expression.name.text:callee;
                if(method==='fromProps'&&/SlashCommand|^\w+\.fromProps$/.test(callee)&&n.arguments[0]&&ts.isObjectLiteralExpression(n.arguments[0])){
                    const p=props(n.arguments[0]);
                    if(p.has('name')&&(p.has('callback')||callee.includes('SlashCommand.'))){
                        result.commands.push({...loc(n),callee,name:literal(p.get('name')),name_expression:brief(p.get('name')),aliases:p.get('aliases')&&ts.isArrayLiteralExpression(p.get('aliases'))?p.get('aliases').elements.map(literal):[],callback:brief(p.get('callback')),callback_owner:owner(n)});
                    }
                }
                if(['addCommandObject','addCommandObjectUnsafe','addCommand','registerSlashCommand'].includes(method))result.registrations.push({...loc(n),callee,argument:brief(n.arguments[0]),owner:owner(n)});
                if(sinkNames.has(method))result.calls.push({...loc(n),callee,owner:owner(n)});
                if(method==='postMessage')result.post_messages.push({...loc(n),callee,argument:brief(n.arguments[0]),owner:owner(n)});
            }
            if(ts.isStringLiteralLike(n)&&/#(?:send_but|mes_stop|options_button|send_textarea)\b/.test(n.text))result.selectors.push({...loc(n),selectors:[...new Set(n.text.match(/#(?:send_but|mes_stop|options_button|send_textarea)\b/g))],owner:owner(n)});
            if(ts.isReturnStatement(n)&&n.expression&&ts.isObjectLiteralExpression(n.expression)){
                const fn=owner(n);
                if(rel(file)==='engine/sillytavern/public/scripts/st-context.js'&&fn==='getContext'){
                    for(const [key,value]of props(n.expression))result.context.push({...loc(value),name:key,implementation:brief(value)});
                }
                if(rel(file)==='native-extensions/JS-Slash-Runner/dist/index.js'){
                    const p=props(n.expression);
                    if(p.has('triggerSlash')&&p.has('generateRaw')){
                        for(const[key,value]of p)result.helper.push({...loc(value),name:key,implementation:brief(value),factory:fn});
                        const bound=p.get('_bind');
                        if(bound&&ts.isObjectLiteralExpression(bound))for(const[key,value]of props(bound))result.helper_bound.push({...loc(value),name:key.replace('_',''),implementation:brief(value)});
                    }
                }
            }
            ts.forEachChild(n,visit);
        };visit(sf);
    }
}
if(output)fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');else process.stdout.write(JSON.stringify(result,null,2)+'\n');
