const {presentError}=require('./error-presentation');
const {describeError}=require('./launcher-errors');
const SCHEMA='nora-launcher-result/1';
const NETWORK=new Set(['dns_failed','connection_refused','network','tls_failed','timeout','http_unauthorized','http_forbidden','rate_limited','http_error']);
const BUSINESS_ACTIONS={MODEL_SETUP_REQUIRED:['configure-model','recheck','logs'],CLAWCHAT_PAIR_REQUIRED:['pair-clawchat','recheck','logs'],
  MODEL_SYNC_PENDING:['resume-model','recheck','logs'],MODEL_CONFIG_PARTIAL:['recheck','logs'],
  INSTALLER_STATE_WRITE_FAILED:['recheck','logs'],UPDATE_RECOVERY_REQUIRED:['recover','recheck','logs'],
  TAVERN_OWNERSHIP:['recheck','logs'],GATEWAY_IDENTITY:['recheck','logs'],TAVERN_PORT_OCCUPIED:['recheck','logs'],
  TAVERN_START_TIMEOUT:['recheck','logs'],
  RELEASE_COMPATIBILITY:['replace-launcher','recheck','logs'],RETRY_CONDITIONS_UNCHANGED:['recheck','logs']};
BUSINESS_ACTIONS.RELEASE_EXECUTOR_INCOMPATIBLE=['logs'];
BUSINESS_ACTIONS.RESOURCE_INCOMPLETE=['replace-launcher','logs'];
function failureActions(error,{operation}={}){
  const code=typeof error==='string'?error:error?.userCode||error?.code;
  const business=BUSINESS_ACTIONS[code];
  if(!operation)return business?.slice();
  if(code==='RETRY_CONDITIONS_UNCHANGED'&&operation.attempt===0&&operation.verifiedConditions)return operation.allowedActions;
  const safe=!operation.busy&&!operation.archived&&!operation.handoffRef
    &&['untouched','restored'].includes(operation.effectState)
    &&!['recovery-required','files-restored-start-failed'].includes(operation.recoveryOutcome)
    &&!['succeeded','blocked'].includes(operation.state);
  return safe&&business?business.slice():operation.allowedActions;
}
function successResult(value){return {schema:SCHEMA,ok:true,value};}
function verifyWorkflowResult({action,service='all',targetVersion,result,status=result,before}={}){
  if(!status||typeof status!=='object')return false;
  const checks=service==='tavern'?['running']:service==='nora'?['gatewayRunning']:['running','gatewayRunning'];
  if(['start','restart'].includes(action))return checks.every(key=>status[key]===true);
  if(['stop','shutdown'].includes(action))return checks.every(key=>status[key]===false);
  if(action==='pair')return status.clawchatPaired===true&&status.clawchatProfileReady===true;
  if(action==='recover')return result?.recoveryVerification==='confirmed'
    &&(result.updateRecovered===true||result.firstInstallRecovered===true);
  if(!['install','update','repair'].includes(action)||!targetVersion)return false;
  if(status.systemReady!==true||String(status.version).replace(/^v/,'')!==String(targetVersion).replace(/^v/,''))return false;
  if(action==='install')return true;
  return result?.updateVerified===true&&(!before||['running','gatewayRunning'].every(key=>
    typeof before[key]==='boolean'&&status[key]===before[key]));
}
function failureResult(error,{action,operation}={}){
  const technical=operation?.currentFailure?.technical||operation?.primaryFailure?.technical||describeError(error,{action});
  const userCode=operation?.failureCode||error?.userCode||error?.code;
  const actions=failureActions(userCode,{operation})||
    (NETWORK.has(technical.error_code)?['recheck','logs']:['logs','recheck']);
  return {schema:SCHEMA,ok:false,error:{failureCode:technical.error_code,userCode:/^[A-Z0-9_]{1,100}$/.test(userCode||'')?userCode:'',
    logOperationId:/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(error?.logOperationId||'')?error.logOperationId:undefined,
    technical,guidance:operation?.currentFailure?.guidance||operation?.primaryFailure?.guidance||presentError(error,{action}),allowedActions:actions,
    operation:operation?{...operation,allowedActions:actions}:null}};
}
module.exports={successResult,failureResult,failureActions,verifyWorkflowResult};
