// Verify the grammar prologue extractor recovers the 132 include edges
// the regex-only parser was missing.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = import.meta.dirname;
const HIVE = join(HERE, '..', '..');
const RUNTIME = process.env.RUNTIME ?? join(HIVE, '..', 'runtime');
const require = createRequire(import.meta.url);

const tsParser = require(join(HIVE, 'out', 'analyzer', 'CppTreeSitterParser.js'));
await tsParser.initCppParser(HIVE);
console.log('parser ready:', tsParser.isCppParserReady());

const grammarDir = join(RUNTIME, 'src', 'grammar');
const files = (await readdir(grammarDir))
    .filter(f => /\.(y|ym4|x|l)$/i.test(f));

let totalIncludes = 0;
const seenHeaders = new Map();
for (const f of files) {
    const src = await readFile(join(grammarDir, f), 'utf8');
    const incs = tsParser.extractGrammarPrologueIncludesSync(src);
    totalIncludes += incs.length;
    for (const i of incs) seenHeaders.set(i, (seenHeaders.get(i) ?? 0) + 1);
    console.log(`  ${f.padEnd(28)} ${incs.length.toString().padStart(3)} includes`);
}

console.log(`\nTotal: ${files.length} grammar files, ${totalIncludes} include edges recovered`);
console.log(`Top 10 referenced headers:`);
for (const [h, n] of [...seenHeaders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${n.toString().padStart(3)}  ${h}`);
}
