// Standalone lifecycle adapter; conditions, attempts and task closure remain
// owned by the same existing operation policy/controller.
const path=require('node:path');
const {create:operationPolicy}=require('./operation-policy');
const value=input=>typeof input==='function'?input():input;
const fail=message=>Object.assign(new Error(message),{code:'VERIFICATION_FAILED'});
function create(options={}){
  const {home,bridge}=options;
  if(typeof bridge!=='function')throw new TypeError('The standalone backend is required');
  const untouched=()=>({effectState:'untouched',recoveryOutcome:'not-required',canRecover:false});
  const systemEffects=async record=>{
    if(record.handoffRef)throw fail('独立酒馆更新不能接管启动器替换记录。');
    const result=await bridge('operation-effects',{operationId:record.operationId,kind:'update'},null);
    const facts=result?.effects;
    if(!facts||!['untouched','changed','restored','unknown'].includes(facts.effectState)
      ||!['not-required','restored-and-verified','files-restored-start-failed','recovery-required'].includes(facts.recoveryOutcome))
      throw fail('独立更新后端没有返回可核验的文件状态。');
    if(facts.canResume===true&&(facts.operationId!==record.operationId||facts.status!=='committed'))
      throw fail('已提交独立更新不属于当前任务。');
    return facts;
  };
  const shared=operationPolicy({...options,systemEffects,inspectRuntime:untouched,inspectLegacy:()=>null,
    runRuntime:async()=>{throw fail('独立酒馆更新不能替换诺拉运行环境。');}});
  async function prepareEffects(context){
    context.check();
    // Old closure references remain strict. Creating a new partial-install
    // closure is intentionally outside standalone Tavern update authority.
    return require('./operation-history').inspect(path.resolve(value(home))).references;
  }
  async function recover(context){
    context.check();await context.stage('recovering');
    const facts=await systemEffects(context.snapshot);
    if(facts.effectState==='untouched')return {effectState:'untouched',verification:'confirmed',value:{untouched:true}};
    if(facts.effectState==='restored'&&facts.recoveryOutcome==='restored-and-verified'){
      const current=await bridge('status',{},context);
      if(current?.standalone!==true||current.systemReady!==true)throw fail('恢复后的原酒馆尚未通过实际检查。');
      return {effectState:'restored',verification:'confirmed',value:{...current,updateRecovered:true,recoveryVerification:'confirmed'}};
    }
    if(facts.effectState==='unknown'||facts.canRecover!==true)throw fail('独立更新恢复来源无法核验，现有文件与备份已保留。');
    const result=await bridge('recover-update',{operationId:context.operationId},context);
    context.check();const after=await systemEffects(context.snapshot);
    if(result?.updateRecovered!==true||result.recoveryVerification!=='confirmed'
      ||after.effectState!=='restored'||after.recoveryOutcome!=='restored-and-verified')
      throw fail('独立更新文件或原服务尚未通过恢复验收。');
    return {effectState:'restored',verification:'confirmed',value:result};
  }
  return {...shared,prepareEffects,recover};
}
module.exports={create};
