// End-to-end check: exercise the compiled CppTreeSitterParser the same way
// the extension does — via require() of out/analyzer/CppTreeSitterParser.js.
// Confirms the compiled JS works in a CommonJS Node context.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = import.meta.dirname;
const HIVE = join(HERE, '..', '..');
const require = createRequire(import.meta.url);

const compiled = join(HIVE, 'out', 'analyzer', 'CppTreeSitterParser.js');
if (!existsSync(compiled)) {
    console.error(`compiled parser not found at ${compiled} — run 'npx tsc -p .' first`);
    process.exit(1);
}

const tsParser = require(compiled);
console.log('exports:', Object.keys(tsParser).join(', '));

// initCppParser expects the extension root (where node_modules/web-tree-sitter lives).
await tsParser.initCppParser(HIVE);
if (!tsParser.isCppParserReady()) {
    console.error('parser failed to init:', tsParser.getInitFailureReason());
    process.exit(1);
}
console.log('parser ready');

const RUNTIME = process.env.RUNTIME ?? join(HIVE, '..', 'runtime');
const SAMPLES = [
    'src/exec.cpp',
    'src/div.cpp',
    'include/adx_include.h',
    'include/divext.h',
];

const t0 = performance.now();
let totalIncludes = 0, totalSymbols = 0, totalBytes = 0;
for (const rel of SAMPLES) {
    const src = await readFile(join(RUNTIME, rel), 'utf8');
    totalBytes += src.length;
    const r = tsParser.parseCppSync(src);
    totalIncludes += r.includes.length;
    totalSymbols += r.symbols.length;
    const angles = r.includes.filter(i => i.startsWith('<')).length;
    const quotes = r.includes.length - angles;
    console.log(`  ${rel.padEnd(30)} ${r.includes.length.toString().padStart(4)} incs (${angles}<>, ${quotes}"") ${r.symbols.length.toString().padStart(4)} syms`);
}
const ms = performance.now() - t0;
console.log(`\n${SAMPLES.length} files, ${(totalBytes/1024).toFixed(1)} KB total, ${totalIncludes} includes, ${totalSymbols} symbols in ${ms.toFixed(0)} ms (${(totalBytes/1024/ms*1000).toFixed(0)} KB/s)`);
