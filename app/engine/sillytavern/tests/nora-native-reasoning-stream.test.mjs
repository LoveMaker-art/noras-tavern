import './helpers/nora-locale-fixture.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import express from 'express';
import compression from 'compression';
import { Response as NodeFetchResponse } from 'node-fetch';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ledgerPromptPlan, ledgerPromptValid, acknowledgeLedger } from '../public/scripts/nora-story-ledger/client.js';
import {parse as yaml} from 'yaml';
import {parse} from 'acorn';
const root=process.env.NORA_TEST_APP||fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const {createStMessageViewAdapter}=await import(root+'/native-extensions/nora-ui/st-message-view-adapter.js');
const nativeViewPath=root+'/engine/sillytavern/public/scripts/nora-compat/reasoning-view.js';
const nativeView=fs.existsSync(nativeViewPath)?await import(nativeViewPath):{};
function declarations(file,names){const source=fs.readFileSync(root+'/engine/sillytavern/public/'+file,'utf8');return parse(source,{ecmaVersion:'latest',sourceType:'module'}).body.map(n=>n.declaration||n).filter(n=>names.includes(n.id?.name)||n.declarations?.some(d=>names.includes(d.id?.name))).map(n=>source.slice(n.start,n.end)).join('\n');}
const code=declarations('scripts/reasoning.js',['ReasoningType','ReasoningState','ReasoningHandler'])+'\n'+declarations('scripts/openai.js',['getStreamingReply'])+'\n'+declarations('script.js',['StreamingProcessor']);
class Element {
 constructor(tag='div',doc){this.tagName=tag.toUpperCase();this.ownerDocument=doc;this.dataset={};this.attrs={};this.children=[];this.open=false;this.hidden=false;this.classes=new Set();this.classList={contains:n=>this.classes.has(n),add:n=>this.classes.add(n),remove:n=>this.classes.delete(n),toggle:(n,on)=>on?this.classes.add(n):this.classes.delete(n)};}
 set className(v){this.classes=new Set(v.split(/\s+/).filter(Boolean));}get className(){return[...this.classes].join(' ');}
 append(n){n.remove();this.children.push(n);n.parentElement=this;n.ownerDocument=this.ownerDocument;}remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(x=>x!==this);this.parentElement=null;}
 replaceWith(n){const p=this.parentElement;if(!p)return;n.remove();const i=p.children.indexOf(this);p.children[i]=n;n.parentElement=p;n.ownerDocument=p.ownerDocument;this.parentElement=null;}
 setAttribute(k,v){this.attrs[k]=String(v);if(k==='class')this.className=v;}getAttribute(k){return this.attrs[k]??null;}removeAttribute(k){delete this.attrs[k];if(k==='open')this.open=false;}
 get innerHTML(){return this.textContent;}set innerHTML(v){this.textContent=v;}
 get textContent(){return(this.text||'')+this.children.map(n=>n.textContent).join('');}set textContent(v){this.text=String(v);for(const n of this.children)n.parentElement=null;this.children=[];}
 matches(s){if(s.includes(','))return s.split(',').some(x=>this.matches(x.trim()));const cls=[...s.matchAll(/\.([\w-]+)/g)].map(m=>m[1]);if(cls.some(c=>!this.classes.has(c)))return false;const attr=s.match(/\[([\w-]+)="([^"]*)"\]/);if(attr&&this.getAttribute(attr[1])!==attr[2])return false;const tag=s.match(/^[a-z]+/i)?.[0];return !tag||tag.toUpperCase()===this.tagName;}
 querySelector(s){for(const n of this.children){if(n.matches(s))return n;const r=n.querySelector(s);if(r)return r;}return null;}
 cloneNode(deep){const n=new Element(this.tagName,this.ownerDocument);n.className=this.className;n.attrs={...this.attrs};n.dataset={...this.dataset};n.text=this.text;n.open=this.open;n.hidden=this.hidden;if(deep)for(const c of this.children)n.append(c.cloneNode(true));return n;}
 contains(n){return n===this||this.children.some(c=>c.contains(n));}focus(){this.ownerDocument.activeElement=this;}
}
function setup(){
 let nodes=[];const chat=[];const doc={activeElement:null,createElement:tag=>new Element(tag,doc)};
 const el=(tag,cls)=>{const e=doc.createElement(tag);e.className=cls;return e;};
 const host=el('div',''),chatHost=el('div','');host.append(chatHost);doc.body=el('body','nora-product');doc.body.append(host);
 const template=el('details','mes_reasoning_details'),summary=el('summary','mes_reasoning_summary');summary.append(el('span','mes_reasoning_header_title'));summary.append(el('div','mes_reasoning_actions'));template.append(summary);template.append(el('div','mes_reasoning'));
 doc.querySelector=s=>s==='#message_template .mes_reasoning_details'?template:s==='#nora-chat .nora-pending-message > .mes_reasoning_details'?host.querySelector('.nora-pending-message')?.children.find(n=>n.classList.contains('mes_reasoning_details'))||null:s.includes('#chat')?nodes.find(n=>String(n.getAttribute('mesid'))===s.match(/mesid="(\d+)"/)?.[1])||null:null;
 const makeMessage=(text='',extra={})=>{const n=el('div','mes');n.attrs={mesid:String(chat.length),is_user:'false',is_system:'false'};const block=el('div','mes_block');block.append(template.cloneNode(true));for(const name of ['mes_text','mes_edit_add_reasoning','mes_timer','tokenCounterDisplay'])block.append(el('div',name));n.append(block);n.querySelector('.mes_text').textContent=text;nodes.push(n);chatHost.append(n);chat.push({name:'fixture',is_user:false,mes:text,extra});return n;};
 const view=createStMessageViewAdapter({select:(s,p)=>p?.querySelector(s)||({'#nora-chat':host,'#chat':chatHost})[s]||null,selectAll:s=>s==='#chat .mes'?nodes:[],icons:{},documentRef:doc,MutationObserverImpl:class{}});
 const sources=['CLAUDE','MAKERSUITE','VERTEXAI','COHERE','DEEPSEEK','XAI','OPENROUTER','CUSTOM','POLLINATIONS','AIMLAPI','MOONSHOT','COMETAPI','ELECTRONHUB','NANOGPT','ZAI','SILICONFLOW','CHUTES','WORKERS_AI','MISTRALAI'];
 const context={...nativeView,console,Date,HTMLElement:Element,AbortController,chat,document:doc,
  power_user:{reasoning:{auto_expand:false,prefix:'<think>',suffix:'</think>'},stream_fade_in:false,message_token_count_enabled:false},oai_settings:{chat_completion_source:'custom',show_thoughts:true},chat_completion_sources:Object.fromEntries(sources.map(k=>[k,k.toLowerCase()])),
  isHiddenReasoningModel:()=>false,isReasoningAutoParseEnabled:()=>true,getRegexedString:s=>s,regex_placement:{REASONING:6},
  trimSpaces:s=>String(s||'').trim(),setDatasetProperty:(e,k,v)=>e.dataset[k]=v,translate:s=>s,t:s=>s[0],moment:{duration:d=>({asSeconds:()=>d/1000})},
  messageFormatting:s=>s,cleanUpMessage:({getMessage})=>getMessage,countOccurrences:(s,t)=>s.split(t).length-1,isOdd:n=>n%2===1,
  formatGenerationTimer:()=>({timerValue:'',timerTitle:''}),scrollLock:true,structuredClone,eventSource:{emit:async()=>{}},event_types:{STREAM_REASONING_DONE:'reasoning_done'},
  saveReply:async({getMessage})=>makeMessage(getMessage),deactivateSendButtons:()=>{},hideSwipeButtons:()=>{},scrollChatToBottom:()=>{},unblockGeneration:()=>{}};
 vm.createContext(context);vm.runInContext(code+'\nglobalThis.Processor=StreamingProcessor;globalThis.Handler=ReasoningHandler;',context);
 const state={reasoning:'',images:[],toolSignatures:{}};let bodyText='';let processor;
 return {host,chat,doc,view,makeMessage,context,get node(){return nodes.at(-1);},get processor(){return processor;},
  begin(text='测试消息'){return view.beginPending(text,'a');},waiting(){return host.querySelector('.nora-pending-message')?.querySelector('.mes_reasoning_details');},
  async start(){processor=new context.Processor('normal',false,new Date(0),'',{});processor.messageId=await processor.onStartStreaming('...');view.decorate(chat);},
  async frame(delta){bodyText+=context.getStreamingReply({choices:[{delta}]},state);processor.reasoningHandler.updateReasoning(processor.messageId,state.reasoning);await processor.onProgressStreaming(processor.messageId,bodyText,false);view.decorate(chat);},
  async finish(){await processor.reasoningHandler.finish(processor.messageId);view.clearPending();},
 };
}
test('one native template instance from waiting through reasoning stream and body, never substitute prose',async()=>{
 const f=setup();f.begin();const waiting=f.waiting();assert.ok(waiting,'Waiting must use the native reasoning template, not nora-generation-status');
 assert.equal(waiting.open,false);assert.equal(waiting.querySelector('.mes_reasoning').textContent,'');assert.equal(waiting.querySelector('.mes_reasoning_header_title').textContent,'正在思考…');assert.equal(f.chat.length,0);
 waiting.open=true;await f.start();assert.ok(f.node.querySelector('.mes_reasoning_details')===waiting,'Same element must survive engine adoption');assert.equal(waiting.open,true);assert.equal(waiting.dataset.state,'pending');
 await f.frame({reasoning_content:'第一段。'});assert.equal(waiting.querySelector('.mes_reasoning').textContent,'第一段。');assert.equal(f.node.dataset.reasoningState,'thinking');assert.equal(f.node.dataset.noraReasoningReady,'true');assert.equal(waiting.hidden,false);assert.equal(waiting.open,true);assert.equal(f.node.querySelector('.mes_text').textContent,'');
 await f.frame({reasoning_content:'第二段。'});assert.equal(waiting.querySelector('.mes_reasoning').textContent,'第一段。第二段。');
 await f.frame({content:'正式正文'});assert.equal(f.node.querySelector('.mes_text').textContent,'正式正文');assert.equal(waiting.dataset.state,'done');assert.match(waiting.querySelector('.mes_reasoning_header_title').textContent,/已思考/);
 await f.finish();assert.ok(f.node.querySelector('.mes_reasoning_details')===waiting);assert.equal(waiting.open,true);assert.equal(f.host.children.length,1);assert.equal(f.chat[0].extra.reasoning,'第一段。第二段。');
});
test('first reasoning delta is visible immediately in the actual processor, with no automatic expansion',async()=>{
 const f=setup();f.begin();await f.start();const detail=f.node.querySelector('.mes_reasoning_details');await f.frame({reasoning_content:'实时原文'});
 assert.equal(detail.open,false);assert.equal(f.node.dataset.reasoningState,'thinking');assert.equal(detail.querySelector('.mes_reasoning_header_title').textContent,'正在思考…');assert.equal(detail.querySelector('.mes_reasoning').textContent,'实时原文');
 detail.open=true;await f.frame({reasoning_content:'继续'});assert.equal(detail.open,true);detail.open=false;await f.frame({reasoning_content:'结束'});assert.equal(detail.open,false);
});
test('native header click permits opening pending reasoning before the first delta',()=>{
 const f=setup();f.begin();const details=f.waiting(),handlers=new Map();
 const wrapped={attr:name=>name==='data-state'?details.dataset.state:null,find:()=>({is:()=>true}),0:details};
 f.context.$=target=>target===f.doc?{on:(_event,selector,handler)=>handlers.set(selector,handler)}:{closest:selector=>selector==='.mes_reasoning_details'?wrapped:{find:()=>({length:0})}};
 vm.runInContext(declarations('scripts/reasoning.js',['setReasoningEventHandlers'])+'\nsetReasoningEventHandlers();',f.context);
 let prevented=false;handlers.get('.mes_reasoning_header').call({}, {preventDefault:()=>{prevented=true;}});
 assert.equal(prevented,false,'Pending reasoning must accept the user click, not only programmatic open=true');
 details.dataset.state='none';handlers.get('.mes_reasoning_header').call({}, {preventDefault:()=>{prevented=true;}});assert.equal(prevented,true);
});
test('new-stream reasoning clock excludes earlier client preparation',async()=>{
 const f=setup();f.begin();await f.start();
 assert.ok(f.processor.reasoningHandler.initialTime.getTime()>=f.processor.createdAt.getTime());
});
test('body-only model removes empty waiting state without claiming completed thinking',async()=>{
 const f=setup();f.begin();await f.start();await f.frame({content:'普通回复'});const d=f.node.querySelector('.mes_reasoning_details');assert.equal(d.hidden,true);assert.equal(f.node.querySelector('.mes_text').textContent,'普通回复');await f.finish();assert.ok(!f.chat[0].extra.reasoning);assert.ok(!f.chat[0].extra.reasoning_duration);
});
test('cancellation before model data removes waiting UI, does not create persisted reasoning',async()=>{
 const early=setup();early.begin();early.view.clearPending();assert.equal(early.chat.length,0);assert.equal(early.host.children.length,1);
 const f=setup();f.begin();await f.start();const d=f.node.querySelector('.mes_reasoning_details');f.view.clearPending();assert.equal(d.hidden,true);assert.ok(!f.chat[0].extra.reasoning);assert.ok(!f.chat[0].extra.reasoning_duration);
});
test('history initialization never consumes the active waiting control and stays collapsed',()=>{
 const f=setup();const history=f.makeMessage('历史正文',{reasoning:'历史思考',reasoning_duration:1000});f.begin();const wait=f.waiting();assert.ok(wait);
 const h=new f.context.Handler();h.initHandleMessage(history);f.view.decorate(f.chat);assert.ok(f.waiting()===wait);assert.ok(history.querySelector('.mes_reasoning_details')!==wait);assert.equal(history.querySelector('.mes_reasoning_details').open,false);
});
test('world change removes preflight feedback and old completion cannot clear a new send',()=>{
 const f=setup();const old=f.begin();f.view.syncPending('b');assert.equal(f.host.children.length,1);const current=f.begin();f.view.clearPending(old);assert.ok(f.waiting());f.view.clearPending(current);assert.equal(f.host.children.length,1);
});
test('obsolete custom thinking markup, handoff toggles and styles have been removed',()=>{
 for(const file of ['pending-message-view.js','st-message-view-adapter.js','style.css']){const source=fs.readFileSync(root+'/native-extensions/nora-ui/'+file,'utf8');assert.doesNotMatch(source,/nora-generation-(?:status|summary|label|hint)|onReasoningHandoff|reasoningHandedOff|思考内容尚未返回/);}
});
test('pending native details explicitly override ST empty-reasoning CSS, while cancelled details stay hidden',()=>{
 const css=fs.readFileSync(root+'/native-extensions/nora-ui/style.css','utf8');assert.match(css,/#nora-chat \.mes_reasoning_details\[data-state="pending"\] \{ display: block !important; \}/);assert.match(css,/#nora-chat \.mes_reasoning_details\[hidden\] \{ display: none !important; \}/);
 const template=fs.readFileSync(root+'/engine/sillytavern/public/index.html','utf8');assert.match(template,/<details class="mes_reasoning_details">/);assert.match(template,/<div class="mes_reasoning"><\/div>/);
});
test('stream errors finalize actual received reasoning, not an endless thinking indicator',async()=>{
 const f=setup();f.begin();await f.start();await f.frame({reasoning_content:'已收到的原文'});f.processor.onErrorStreaming();await Promise.resolve();f.view.clearPending();
 const d=f.node.querySelector('.mes_reasoning_details');assert.equal(d.dataset.state,'done');assert.equal(d.querySelector('.mes_reasoning').textContent,'已收到的原文');assert.match(d.querySelector('.mes_reasoning_header_title').textContent,/已(?:思考|完成思考)/);
});
test('thinking completion renders before asynchronous plugin callbacks finish',async()=>{
 const f=setup();f.begin();await f.start();await f.frame({reasoning_content:'原文'});let release;f.context.eventSource.emit=()=>new Promise(r=>release=r);
 const completion=f.processor.reasoningHandler.finish(f.processor.messageId);assert.equal(f.node.querySelector('.mes_reasoning_details').dataset.state,'done');release();await completion;
});
test('local HTTP proxy, native SSE parser and native generator render reasoning before upstream completion',async()=>{
 const f=setup(),upstream=new Readable({read(){}}),app=express();app.use(compression());let secondChunk;
 const utilSource=fs.readFileSync(root+'/engine/sillytavern/src/util.js','utf8');const parsed=parse(utilSource,{ecmaVersion:'latest',sourceType:'module'});
 const forward=parsed.body.map(n=>n.declaration||n).find(n=>n.id?.name==='forwardFetchResponse');
 const proxyContext=vm.createContext({Readable,console:{info(){},warn(){}}});vm.runInContext(utilSource.slice(forward.start,forward.end),proxyContext);
 const frame=delta=>'data: '+JSON.stringify({choices:[{delta}]})+'\n\n';
 app.post('/api/backends/chat-completions/generate',(_req,res)=>{
  void proxyContext.forwardFetchResponse(new NodeFetchResponse(upstream,{headers:{'content-type':'text/event-stream'}}),res);
  upstream.push(frame({reasoning_content:'第一段原文。'}));
  secondChunk=setTimeout(()=>upstream.push(frame({reasoning_content:'第二段原文。'})),80);
 });
 const server=http.createServer(app);const ready=once(server,'listening');server.listen(0,'127.0.0.1');await ready;
 const endpoint='http://127.0.0.1:'+server.address().port;let seenHeaders,observed;
 const updated=new Promise(resolve=>observed=resolve);
 Object.assign(f.context,{ReadableStream,TransformStream,TextDecoderStream,MessageEvent,ledgerPromptPlan,ledgerPromptValid,acknowledgeLedger,
  fetch:async(url,options)=>{const r=await fetch(new URL(url,endpoint),options);seenHeaders={contentType:r.headers.get('content-type'),cacheControl:r.headers.get('cache-control'),contentEncoding:r.headers.get('content-encoding')};return r;},
  getChatCompletionModel:()=> 'fixture-model',createGenerationParameters:async()=>({generate_data:{stream:true},stream:true,canMultiSwipe:false}),getRequestHeaders:()=>({'Content-Type':'application/json'}),
  tryParseStreamingError:()=>{},ToolManager:{parseToolCalls(){}},parseChatCompletionLogprobs:()=>null,
  delay:ms=>new Promise(r=>setTimeout(r,ms)),getStoppingStrings:()=>[],main_api:'openai',scrollLock:false,
  scrollChatToBottom:()=>{if(f.node?.querySelector('.mes_reasoning')?.textContent==='第一段原文。第二段原文。')observed();},
 });
 f.context.power_user.streaming_fps=30;
 vm.runInContext(declarations('scripts/sse-stream.js',['EventSourceStream','getEventSourceStream'])+'\n'+declarations('scripts/utils.js',['Stopwatch'])+'\n'+declarations('scripts/openai.js',['sendOpenAIRequest']),f.context);
 let timeout;
 try{
  f.begin();const details=f.waiting();details.open=true;await f.start();
  f.processor.generator=await f.context.sendOpenAIRequest('normal',[]);
  const generation=f.processor.generate();
  await Promise.race([updated,new Promise((_,reject)=>timeout=setTimeout(()=>reject(Error('Reasoning was not displayed before upstream completion')),2000))]);
  clearTimeout(timeout);assert.equal(upstream.readableEnded,false);assert.equal(details.open,true);assert.equal(details.hidden,false);assert.equal(f.node.querySelector('.mes_text').textContent,'');
  assert.equal(details.querySelector('.mes_reasoning').textContent,'第一段原文。第二段原文。');
  upstream.push(frame({content:'正式正文'}));upstream.push('data: [DONE]\n\n');upstream.push(null);
  const result=await generation;await f.processor.onProgressStreaming(f.processor.messageId,result,true);await f.finish();assert.equal(f.node.querySelector('.mes_text').textContent,'正式正文');
  console.log(JSON.stringify({localTransport:{nativeParser:true,nativeGenerator:true,reasoningBeforeUpstreamEnd:true,responseHeaders:seenHeaders,browserOrLivewareVerified:false}}));
 }finally{clearTimeout(timeout);clearTimeout(secondChunk);upstream.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('real model stream updates the same native reasoning element before body arrives',{skip:process.env.NORA_REAL_STREAM!=='1'},async()=>{
 const oai=JSON.parse(fs.readFileSync(process.env.NORA_TEST_SETTINGS || new URL('../../../../local-state/native/default-user/settings.json', import.meta.url))).oai_settings;assert.equal(yaml(oai.custom_include_body).thinking.type,'enabled');
 const headers={'Content-Type':'application/json'},csrf=await fetch((process.env.NORA_TEST_SERVER_URL || 'http://127.0.0.1:8799') + '/csrf-token');assert.ok(csrf.ok);const c=await csrf.json();if(c.token)headers['X-CSRF-Token']=c.token;const cookies=csrf.headers.getSetCookie?.()||[];if(cookies.length)headers.Cookie=cookies.map(v=>v.split(';')[0]).join('; ');
 const f=setup();f.begin();const d=f.waiting();d.open=true;await f.start();const started=performance.now();
 const response=await fetch((process.env.NORA_TEST_SERVER_URL || 'http://127.0.0.1:8799') + '/api/backends/chat-completions/generate',{method:'POST',headers,signal:AbortSignal.timeout(45000),body:JSON.stringify({chat_completion_source:oai.chat_completion_source,custom_url:oai.custom_url,model:oai.custom_model,custom_include_body:oai.custom_include_body,custom_exclude_body:oai.custom_exclude_body,custom_include_headers:oai.custom_include_headers,messages:[{role:'user',content:'计算 137×249，只输出最后的计算结果。'}],stream:true,max_tokens:512,temperature:0.2,top_p:1,show_thoughts:true})});assert.equal(response.status,200);
 const decoder=new TextDecoder();let buffer='',expected='',body='',reasoningFrames=0,firstReasoningMs=null,firstBodyMs=null,done=false;
 for await(const chunk of response.body){buffer+=decoder.decode(chunk,{stream:true});const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(data==='[DONE]'){done=true;continue;}if(!data)continue;const event=JSON.parse(data);assert.ok(!event.error);const delta=event.choices?.[0]?.delta||{};expected+=delta.reasoning_content||delta.reasoning||'';body+=delta.content||'';await f.frame(delta);
  if(delta.reasoning_content||delta.reasoning){reasoningFrames++;firstReasoningMs??=Math.round(performance.now()-started);assert.equal(d.querySelector('.mes_reasoning').textContent,expected.trim());assert.equal(d.hidden,false);assert.equal(d.open,true);assert.ok(f.node.querySelector('.mes_reasoning_details')===d);}
  if(delta.content){firstBodyMs??=Math.round(performance.now()-started);assert.equal(f.node.querySelector('.mes_text').textContent,body);}
 }}await f.finish();assert.ok(done&&reasoningFrames>1&&body.length>0);assert.equal(d.dataset.state,'done');assert.equal(f.chat[0].extra.reasoning,expected.trim());
 console.log(JSON.stringify({liveNativeStream:{reasoningFrames,reasoningChars:expected.length,bodyChars:body.length,firstReasoningMs,firstBodyMs,sameNativeElement:true,persistedToUserChat:false}}));
});
