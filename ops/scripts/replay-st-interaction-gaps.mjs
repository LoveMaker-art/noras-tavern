import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.argv[2]||path.resolve(import.meta.dirname,'../..');
const require=createRequire(path.join(root,'app/engine/sillytavern/package.json'));
const ts=require('typescript');
const {createStoryActionDispatcher}=await import(pathToFileURL(path.join(root,'app/native-extensions/nora-ui/story-action-dispatcher.js')));
const {createTavernHelperActionAdapter}=await import(pathToFileURL(path.join(root,'app/engine/sillytavern/public/scripts/nora-adapters/tavern-helper-action-adapter.js')));
function extract(file,names){
    const text=fs.readFileSync(path.join(root,file),'utf8'),sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),found=[];
    function visit(n){if(ts.isFunctionDeclaration(n)&&names.includes(n.name?.text))found.push(n.getText(sf).replace(/^export\s+/,''));ts.forEachChild(n,visit)}visit(sf);
    if(found.length!==names.length)throw Error('Function extraction failed');
    return found.join('\n');
}
const core='app/engine/sillytavern/public/script.js';
let failed=0;
function check(name,expected,actual,pass){console.log(JSON.stringify({name,expected,actual,pass}));if(!pass)failed++;}
// Actual /send target + actual history hydration + actual save wrapper.
// Only I/O, formatting and browser event/render dependencies are replaced.
{
    const disk=Array.from({length:60},(_,i)=>({mes:`old-${i}`}));
    let persisted;
    const ctx=vm.createContext({chat:disk.slice(-20),chat_metadata:{},noraChatWindowState:{start:40,total:60,avatar:'card',chatId:'world-a'},isChatSaving:false,DEFAULT_SAVE_EDIT_TIMEOUT:1,
        name1:'user',user_avatar:'avatar',power_user:{message_token_count_enabled:false,personas:{}},regex_placement:{USER_INPUT:1},
        getRegexedString:x=>x,getMessageTimeStamp:()=>'',substituteParams:x=>x,populateFileAttachment:async()=>{},
        eventSource:{emit:async()=>{}},event_types:{MESSAGE_SENT:'sent',USER_MESSAGE_RENDERED:'rendered'},addOneMessage:()=>{},
        isNoraProductMode:()=>true,matchesNoraChatWindow:()=>true,currentNoraChatBinding:()=>({avatar:'card',chatId:'world-a'}),
        requestNoraChatWindow:async()=>[{chat_metadata:{}},...structuredClone(disk)],ensureMessageMediaIsArray:()=>{},printMessages:async()=>{},
        waitUntilCondition:async()=>{},cancelDebouncedChatSave:()=>{},saveTokenCache:()=>{},saveItemizedPrompts:()=>{},getCurrentChatId:()=>'',console,
        saveChat:async()=>{persisted=structuredClone(ctx.chat);},
    });
    vm.runInContext(extract(core,['sendMessageAsUser','ensureNoraFullChatLoaded','saveChatConditional']),ctx);
    const returned=await ctx.sendMessageAsUser('new-message','');
    const actual={returned:returned.mes,inMemory:ctx.chat.some(x=>x.mes==='new-message'),onDisk:persisted.some(x=>x.mes==='new-message'),count:ctx.chat.length};
    check('native-send-after-windowed-load',{inMemory:true,onDisk:true,count:61},actual,actual.inMemory&&actual.onDisk&&actual.count===61);
}
{
    let resolve;const pending=new Promise(r=>{resolve=r;});
    const d=createStoryActionDispatcher({messages:{sendText:()=>pending,stop:()=>{},isGenerating:()=>true}});
    const work=d.execute({type:'story.send',text:'x'});await Promise.resolve();await d.cancel('story');resolve(undefined);
    const actual=(await work).status;check('cancel-then-native-resolves','cancelled',actual,actual==='cancelled');
}
{
    let world='a';const calls=[];
    const d=createStoryActionDispatcher({hasWorld:()=>Boolean(world),messages:{sendText:async()=>{throw Object.assign(Error('failed'),{noraMessagePersisted:true});},regenerate:()=>calls.push(world)}});
    await d.execute({type:'story.send',text:'x'});world='b';await d.execute({type:'story.retry'});
    check('retry-after-world-change','must not regenerate world b',calls,!calls.includes('b'));
}
{
    let calls=0, tasks=0;
    const native={generate:async()=>++calls,generateRaw:async()=>0,stopGenerationById:()=>true};
    const globalRef={TavernHelper:native};
    const earlyIframeGenerate=globalRef.TavernHelper.generate;
    const d=createStoryActionDispatcher({messages:{}});
    const a=createTavernHelperActionAdapter({globalRef,storyActions:{status:d.status,cancel:d.cancel,execute:c=>{tasks++;return d.execute(c);}}});a.start();
    await earlyIframeGenerate();
    check('helper-reference-copied-before-facade','task tracked or caller explicitly invalidated',{calls,tasks},tasks===1);
}
// Real parser wrapper and real Helper trigger function, deterministic parser failure.
{
    class ParseError extends Error{}
    const {SlashCommandClosureResult}=await import(pathToFileURL(path.join(root,'app/engine/sillytavern/public/scripts/slash-commands/SlashCommandClosureResult.js')));
    const ctx=vm.createContext({parser:{parse:()=>{throw new ParseError('unknown command');}},SlashCommandAbortController:class{},SlashCommandParserError:ParseError,SlashCommandClosureResult,toastr:{error:()=>{},warning:()=>{}},callGenericPopup:()=>{},t:()=>'',console});
    vm.runInContext(extract('app/engine/sillytavern/public/scripts/slash-commands.js',['executeSlashCommandsWithOptions']),ctx);
    ctx.Zt=ctx.executeSlashCommandsWithOptions;
    vm.runInContext(extract('app/native-extensions/JS-Slash-Runner/dist/index.js',['kq']),ctx);
    let outcome='resolved';try{await ctx.kq('/unknown');}catch{outcome='rejected';}
    check('helper-slash-parser-error','rejected',outcome,outcome==='rejected');
}
console.log(JSON.stringify({checks:5,failed,mode:'no browser, no model, no remote data mutation'}));
process.exitCode=failed?1:0;
