// Run all collectors and produce a single consolidated x3-runtime-snapshot.json.
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const DATA = join(HERE, 'data');
const STEPS = [
    '01-collect-vcxproj.mjs',
    '02-collect-makefile.mjs',
    '03-find-umbrella-headers.mjs',
    '04-validate-module-triplets.mjs',
    '05-collect-grammar-includes.mjs',
    '06-collect-build-variants.mjs',
];

function run(script) {
    return new Promise((resolve, reject) => {
        const c = spawn(process.execPath, [join(HERE, script)], { stdio: 'inherit', env: process.env });
        c.on('exit', code => code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`)));
    });
}

async function readJson(name) {
    return JSON.parse(await readFile(join(DATA, name), 'utf8'));
}

async function main() {
    await mkdir(DATA, { recursive: true });
    for (const s of STEPS) {
        console.log(`\n=== ${s} ===`);
        await run(s);
    }
    const snapshot = {
        generatedAt: new Date().toISOString(),
        vcxproj: await readJson('01-vcxproj.json'),
        makefile: await readJson('02-makefile.json'),
        umbrellaHeaders: await readJson('03-umbrella-headers.json'),
        moduleTriplets: await readJson('04-module-triplets.json'),
        grammarIncludes: await readJson('05-grammar-includes.json'),
        buildVariants: await readJson('06-build-variants.json'),
    };
    await writeFile(join(DATA, 'x3-runtime-snapshot.json'), JSON.stringify(snapshot, null, 2));
    console.log(`\n=== Consolidated snapshot → data/x3-runtime-snapshot.json ===`);
    console.log(`Projects:           ${snapshot.vcxproj.projectCount}`);
    console.log(`Source files:       ${snapshot.umbrellaHeaders.sourceFileCount}`);
    console.log(`Umbrella candidates: ${snapshot.umbrellaHeaders.umbrellaCandidates.length}`);
    console.log(`Modules:            ${snapshot.moduleTriplets.completeTriplets.length}`);
    console.log(`Grammar files:      ${snapshot.grammarIncludes.fileCount}`);
}

main().catch(e => { console.error(e); process.exit(1); });
