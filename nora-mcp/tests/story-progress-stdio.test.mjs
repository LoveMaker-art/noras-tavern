import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('actual MCP text preserves the whole-result budget through CSRF HTTP and stdio',async()=>{
    const result={schema:'nora-story-read/1',read_only:true,model_called:false,status:'ready',scope:{worldId:'world',sessionId:'branch'},source:{revision:'revision'},ledger:{timeline:Array.from({length:12},(_,i)=>`${i}:完整测试进展。`)},recent_history:[],omitted:{},nextCursor:null};
    result.ledger.timeline[0]+='完'.repeat(2950-JSON.stringify(result).length);
    assert.equal(JSON.stringify(result).length,2950);
    assert.ok(JSON.stringify(result,null,2).length>3000,'pretty-printing would break the accepted budget');
    const state=await fs.mkdtemp(path.join(os.tmpdir(),'nora-mcp-story-'));const userDataRoot=path.join(state,'native/default-user');await fs.mkdir(userDataRoot,{recursive:true});
    const calls=[];
    const server=http.createServer(async(req,res)=>{
        res.setHeader('Content-Type','application/json');calls.push(req.url);
        if(req.url==='/api/nora-worlds-v2/status'){res.end(JSON.stringify({userDataRoot}));return;}
        if(req.url==='/csrf-token') {res.setHeader('Set-Cookie','session=fixture; HttpOnly');res.end(JSON.stringify({token:'fixture-token'}));return;}
        assert.equal(req.url,'/api/nora-story-profile/read');assert.equal(req.headers['x-csrf-token'],'fixture-token');assert.match(req.headers.cookie,/session=fixture/);
        const chunks=[];for await(const chunk of req)chunks.push(chunk);assert.deepEqual(JSON.parse(Buffer.concat(chunks)),{worldId:'world',sessionId:'branch',maxChars:3000});res.end(JSON.stringify(result));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const client=new Client({name:'bounded-story-read',version:'1'});
    try {
        await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/server.js',import.meta.url))],env:{...process.env,NORA_MCP_STATE_ROOT:state,NORA_MCP_MODE:'read-only',NORA_MCP_BASE_URL:`http://127.0.0.1:${server.address().port}`},stderr:'pipe'}));
        const reply=await client.callTool({name:'nora.story.progress',arguments:{worldId:'world',sessionId:'branch',maxChars:3000}});
        assert.notEqual(reply.isError,true);assert.equal(reply.content[0].text,JSON.stringify(result));assert.ok(reply.content[0].text.length<=3000);assert.deepEqual(calls,['/api/nora-worlds-v2/status','/csrf-token','/api/nora-story-profile/read']);
        const invalid=await client.callTool({name:'nora.story.progress',arguments:{worldId:'world',query:'a'.repeat(129)}});
        assert.equal(invalid.isError,true);assert.equal(calls.length,3,'invalid query is rejected before HTTP');
    } finally {await client.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(state,{recursive:true,force:true});}
});
