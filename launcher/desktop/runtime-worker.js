const { installBundledHermes } = require('./runtime');
const { errorDetails } = require('./diagnostics');
const [payloadRoot, noraHome, hermesHome] = process.argv.slice(2);
try {
  installBundledHermes({ payloadRoot, noraHome, hermesHome,
    onEvent: message => process.stdout.write(`${JSON.stringify(message)}\n`) });
} catch (error) {
  process.stdout.write(`${JSON.stringify({ event: 'diagnostic', error: errorDetails(error) })}\n`);
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
