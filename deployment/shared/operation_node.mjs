// Private Node maintenance executor; the actual daemon keeps its runtime owner.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const here=path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(import.meta.url);
const source=[path.join(here,'operation-delegate.js'),path.join(here,'desktop/operation-delegate.js'),path.resolve(here,'../../launcher/desktop/operation-delegate.js')].find(value=>fs.existsSync(value));
if(!source)throw Object.assign(new Error('Node maintenance delegation is unavailable'),{code:'OPERATION_CAPABILITY_REQUIRED'});
const delegate=await require(source).connect();
const args=process.argv.slice(2);
if(args[0]?.startsWith('--nora-operation-job=')){
  if(args.shift().split('=')[1]!==process.env.NORA_OPERATION_JOB_ID)throw new Error('Node maintenance identity differs');
}
const target=args.shift();
if(!path.isAbsolute(target||'')||!['.mjs','.js','.cjs'].includes(path.extname(target)))throw new Error('Explicit maintenance script required');
delegate.assertActive();
process.argv=[process.execPath,target,...args];
try{await import(pathToFileURL(target).href);}finally{delegate.close();}
