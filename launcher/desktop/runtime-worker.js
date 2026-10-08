const { installBundledHermes } = require('./runtime');
const { errorDetails } = require('./diagnostics');
const {connect} = require('./operation-delegate');
const [payloadRoot, noraHome, hermesHome,...options] = process.argv.slice(2);
async function main(){
let delegate;
try {
  delegate=await connect();delegate.assertActive();
  const onEvent=message => {
      delegate.assertActive();
      // Fixed program stages survive native termination without disclosing a path.
      if (message.event === 'task') process.stderr.write(`Runtime phase: ${message.stage_id}; ${message.task}\n`);
      process.stdout.write(`${JSON.stringify(message)}\n`);
    };
  const {operationId,ownerEpoch}=delegate.context;
  if(options.includes('--recover-runtime'))await require('./runtime-transaction').recover({noraHome,hermesHome,operationId,ownerEpoch,delegate,
    allowCommitted:options.includes('--allow-committed'),onEvent});
  else await installBundledHermes({payloadRoot,noraHome,hermesHome,operationId,ownerEpoch,delegate,onEvent});
} catch (error) {
  if (error.context?.operation === 'copy-skill') {
    const {sourceType,destinationType,failingPathType,sourcePathLength,destinationPathLength,failingPathLength}=error.context;
    process.stderr.write(`Runtime skill copy failed: ${JSON.stringify({sourceType,destinationType,failingPathType,sourcePathLength,destinationPathLength,failingPathLength})}\n`);
  }
  process.stdout.write(`${JSON.stringify({ event: 'diagnostic', component: 'runtime', error: errorDetails(error) })}\n`);
  process.stdout.write(`${JSON.stringify({ event: 'error', code: error.code || error.cause?.code, userCode: error.userCode, message: error.message })}\n`);
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}finally{delegate?.close();}
}
main();
