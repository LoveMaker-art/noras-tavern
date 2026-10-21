import assert from 'node:assert/strict';
import test from 'node:test';
import { NoraControlPlane } from '../dist/nora-control-plane.js';

const result = () => ({schema:'nora-story-read/1',status:'ready',scope:{worldId:'world',worldName:'雾港',sessionId:'harbor',sessionName:'码头线'},source:{revision:'r1'},ledger:{timeline:['找到了地图。']},recent_history:[],read_only:true,model_called:false});
function fixture(reply=result()) {
    const calls=[];
    return {calls,plane:new NoraControlPlane({}, {get:async()=>{throw Error('Do not scan the legacy all-session route');},post:async(route,body)=>{calls.push({route,body});return reply;}})};
}
test('one story read forwards names/section/budget and does not preload other worlds or recent chat', async()=>{
    const f=fixture(),request={worldName:'雾港',sessionName:'码头线',view:'objects',query:'钥匙',maxChars:3000};
    assert.deepEqual(await f.plane.storyProgress(request),result());
    assert.deepEqual(f.calls,[{route:'/api/nora-story-profile/read',body:request}]);
});
test('existing exact IDs and source-bound continuation use the same read-only endpoint',async()=>{
    for(const request of [{worldId:'world',sessionId:'harbor',includeRecent:true,recentLimit:4,maxChars:6000},{cursor:'source-bound-cursor'}]){
        const f=fixture(); await f.plane.storyProgress(request); assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body,request);
    }
});
test('ambiguous names are returned as choices without silently reading the first branch',async()=>{
    const choices={schema:'nora-story-read/1',status:'choose-session',choices:[{worldId:'world',sessionId:'one',sessionName:'码头线'},{worldId:'world',sessionId:'two',sessionName:'图书馆线'}],ledger:{},recent_history:[],read_only:true,model_called:false};
    const f=fixture(choices);assert.deepEqual(await f.plane.storyProgress({worldName:'雾港'}),choices);assert.equal(f.calls.length,1);
});
test('the bridge refuses foreign scope, over-budget and model-generated responses',async()=>{
    for(const patch of [r=>r.scope.sessionId='foreign',r=>r.ledger.timeline=['x'.repeat(6001)],r=>r.model_called=true]){
        const value=result();patch(value);const f=fixture(value);
        await assert.rejects(f.plane.storyProgress({worldId:'world',sessionId:'harbor'}),error=>['NORA_STORY_SCOPE_UNCONFIRMED','NORA_STORY_RESULT_INVALID'].includes(error.code));
    }
});

test('cursor-only continuation can preserve recent-chat opt-in, explicit opt-out remains enforced', async()=>{
    const reply=result();reply.recent_history=[{role:'assistant',mes:'新的线索。'}];
    const f=fixture(reply);await f.plane.storyProgress({cursor:'scoped-opted-in-cursor'});
    await assert.rejects(f.plane.storyProgress({cursor:'scoped-opted-in-cursor',includeRecent:false}),e=>e.code==='NORA_STORY_RESULT_INVALID');
    await assert.rejects(f.plane.storyProgress({worldId:'world',sessionId:'harbor'}),e=>e.code==='NORA_STORY_RESULT_INVALID');
});
