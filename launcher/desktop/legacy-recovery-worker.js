// A guarded, short-lived file executor. It never claims service readiness.
const {connect}=require('./operation-delegate');
const {errorDetails}=require('./diagnostics');
const update=require('./system-update');
async function main(){
 let delegate;
 try{
  delegate=await connect();delegate.assertActive();
  const args=process.argv.slice(2),home=args.shift();
  if(args.length!==1||args[0]!==`--nora-operation-job=${delegate.context.jobId}`)
   throw Object.assign(new Error('旧版本恢复执行身份不匹配。'),{code:'OPERATION_CAPABILITY_REQUIRED'});
  let body='';for await(const chunk of process.stdin){body+=chunk;if(Buffer.byteLength(body)>65536)throw new Error('恢复参数超过限制。');}
  const request=JSON.parse(body);
  const result=await update.recover(home,{delegate,journalDigest:request.journalDigest,offlineProof:request.offlineProof,
   onEvent:event=>process.stdout.write(JSON.stringify(event)+'\n')});
  process.stdout.write(JSON.stringify({event:'result',...result})+'\n');
 }catch(error){
  process.stdout.write(JSON.stringify({event:'diagnostic',component:'updater',error:errorDetails(error)})+'\n');
  process.stdout.write(JSON.stringify({event:'error',code:error.code||'LEGACY_RECOVERY_UNSUPPORTED',message:error.message})+'\n');
  process.exitCode=1;
 }finally{delegate?.close();}
}
module.exports={main};
if(require.main===module)main();
