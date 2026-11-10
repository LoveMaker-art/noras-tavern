// Isolated unit adapter for the guard's commit contract. Native ownership and
// process death are exercised separately with operation-lock.js.
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {createEvidenceStore}=require('../installer/desktop/evidence-store');
function createTestOperationLock(){
  let held=false;
  return {probe:async()=>({busy:held}),acquire:async({directory,operationId,ownerEpoch})=>{
    if(held)throw Object.assign(new Error('busy'),{code:'OPERATION_BUSY'});held=true;let active=true;
    const assertActive=()=>{if(!active)throw Object.assign(new Error('guard lost'),{code:'LOCK_GUARD_LOST'});};
    return {assertActive,release:async()=>{active=false;held=false;},commitOperation:async({record,expected,evidence,archive})=>{
      assertActive();
      const root=path.join(directory,'operations'),file=path.join(root,record.operationId,'operation.json');
      const current=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
      if((!archive&&(record.operationId!==operationId||record.ownerEpoch!==ownerEpoch))
        ||(expected===null?Boolean(current):!current||current.ownerEpoch!==expected.ownerEpoch||current.sequence!==expected.sequence))
        throw Object.assign(new Error('operation changed'),{code:'OPERATION_STALE_EVENT'});
      fs.mkdirSync(path.dirname(file),{recursive:true});const store=createEvidenceStore({directory});
      const saved=evidence?store.commitSnapshot(evidence):null;
      fs.writeFileSync(file,JSON.stringify(record)+'\n');const generation=randomUUID();
      fs.writeFileSync(path.join(root,'.history-generation.json'),JSON.stringify({schema:1,id:generation,writing:false}));
      if(archive)store.archive(record.operationId);
      return {record,evidence:saved,generation};
    }};
  }};
}
module.exports={createTestOperationLock};
