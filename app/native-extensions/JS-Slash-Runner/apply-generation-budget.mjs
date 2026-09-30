import fs from 'node:fs/promises';

// Reproducible vendor transformation for the pinned managed 4.11.2 build.
// Refuse unknown bundles rather than silently losing the prompt-budget binding.
const file = new URL('./dist/index.js', import.meta.url);
let source = await fs.readFile(file, 'utf8');
const replacements = [
    [
        'await PW(b,{image:r,overrides:i,max_chat_history:a,inject:o,order:s,processedImageArray:v},l)',
        'await PW(b,{image:r,overrides:i,max_chat_history:a,inject:o,order:s,custom_api:u,processedImageArray:v},l)',
    ],
    [
        'async function PW(e,t,n){let r=new _t;r.setTokenBudget(Ct.openai_max_context,Ct.openai_max_tokens)',
        'async function PW(e,t,n){let configuredContext=t.custom_api?.max_context,configuredOutput=t.custom_api?.max_tokens;let maxContext=typeof configuredContext==="number"&&Number.isFinite(configuredContext)&&configuredContext>0?configuredContext:Ct.openai_max_context;let maxOutput=typeof configuredOutput==="number"&&Number.isFinite(configuredOutput)&&configuredOutput>0?configuredOutput:Ct.openai_max_tokens;let r=new _t;r.setTokenBudget(maxContext,maxOutput)',
    ],
];
for (const [before, after] of replacements) {
    const oldCount = source.split(before).length - 1;
    const newCount = source.split(after).length - 1;
    if (oldCount === 0 && newCount === 1) continue;
    if (oldCount !== 1 || newCount !== 0) throw new Error('Managed runner changed: review generation-budget bindings before rebuilding');
    source = source.replace(before, after);
}
await fs.writeFile(file, source);
console.log('Managed runner prompt budgets aligned with custom API requests.');
