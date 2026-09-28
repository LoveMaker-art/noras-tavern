import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function transformDeferredFaker(source) {
    const replacements = [
        ['import*as __WEBPACK_EXTERNAL_MODULE__libs_faker_mjs_f3becd00__ from"../libs/faker.mjs";',
            'import{loadFaker as noraLoadFaker}from"../deferred-faker.js";'],
        ['2395:e=>{e.exports=__WEBPACK_EXTERNAL_MODULE__libs_faker_mjs_f3becd00__},', ''],
        ['const Gm={faker:void 0};$((async()=>{window.setTimeout((()=>{Promise.resolve().then(__webpack_require__.bind(__webpack_require__,2395)).then((e=>{Gm.faker=e,console.log("[Prompt Template] Faker loaded"),console.log(Object.keys(e))})).catch((e=>{console.log("cannot load faker"),console.error(e)}))}),100)}));',
            'const Gm={faker:void 0};'],
        ['async function Hf(e){var t;', 'async function Hf(e){Gm.faker=await noraLoadFaker();var t;'],
    ];
    const applied = source.includes('Gm.faker=await noraLoadFaker();');
    if (applied) {
        if (!source.includes('from"../deferred-faker.js"') || source.includes('2395:e=>')) throw new Error('Incomplete deferred faker transformation');
        return source;
    }
    for (const [before, after] of replacements) {
        if (source.split(before).length !== 2) throw new Error('Managed template changed: review deferred faker anchors');
        source = source.replace(before, after);
    }
    return source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const file = new URL('./dist/index.js', import.meta.url);
    await fs.writeFile(file, transformDeferredFaker(await fs.readFile(file, 'utf8')));
}
