const { installBundledHermes } = require('./runtime');
const { errorDetails } = require('./diagnostics');
const [payloadRoot, noraHome, hermesHome] = process.argv.slice(2);
try {
  installBundledHermes({ payloadRoot, noraHome, hermesHome,
    onEvent: message => process.stdout.write(`${JSON.stringify(message)}\n`) });
} catch (error) {
  process.stdout.write(`${JSON.stringify({ event: 'diagnostic', error: errorDetails(error) })}\n`);
  process.stdout.write(`${JSON.stringify({ event: 'error', code: error.code || error.cause?.code, userCode: error.userCode, message: error.message })}\n`);
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
