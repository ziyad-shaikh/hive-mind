// Smoke-test the tree-sitter C++ parser against a handful of runtime files.
// Confirms: it loads, parses, extracts includes, extracts top-level symbols.
// Compares include extraction against a regex baseline so we can spot drift.
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const HERE = import.meta.dirname;
const HIVE = join(HERE, '..', '..');
const RUNTIME = process.env.RUNTIME ?? join(HIVE, '..', 'runtime');

// Mimic the extension's runtime: load web-tree-sitter from node_modules.
const TS = await import('web-tree-sitter');
const Parser = TS.Parser ?? TS.default?.Parser;
const Language = TS.Language ?? TS.default?.Language;

const runtimeWasm = join(HIVE, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm');
const cppWasm = join(HIVE, 'node_modules', 'tree-sitter-cpp', 'tree-sitter-cpp.wasm');
console.log('runtime wasm exists?', existsSync(runtimeWasm));
console.log('cpp wasm exists?    ', existsSync(cppWasm));

await Parser.init({ locateFile() { return runtimeWasm; } });
const parser = new Parser();
const cpp = await Language.load(readFileSync(cppWasm));
parser.setLanguage(cpp);
console.log(`tree-sitter ready (cpp grammar loaded, ${(readFileSync(cppWasm).byteLength / 1024 / 1024).toFixed(1)} MB)`);

function regexIncludes(src) {
    const re = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm;
    const out = [];
    let m;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
    return out;
}

function tsExtract(src) {
    const tree = parser.parse(src);
    const includes = [];
    const symbols = [];
    function walk(node, depth) {
        if (node.type === 'preproc_include') {
            const p = node.childForFieldName('path');
            if (p) { const t = p.text; if (t.length >= 2) includes.push(t.slice(1, -1)); }
            return;
        }
        if (node.type === 'class_specifier' || node.type === 'struct_specifier' ||
            node.type === 'namespace_definition' || node.type === 'enum_specifier' ||
            node.type === 'preproc_def' || node.type === 'preproc_function_def') {
            const n = node.childForFieldName('name');
            if (n) symbols.push({ kind: node.type, name: n.text, line: n.startPosition.row + 1 });
        }
        if (node.type === 'function_definition') {
            // Function with body
            const decl = node.childForFieldName('declarator');
            if (decl) {
                let cur = decl;
                for (let i = 0; i < 6 && cur; i++) {
                    if (cur.type === 'identifier' || cur.type === 'qualified_identifier' ||
                        cur.type === 'field_identifier') {
                        symbols.push({ kind: 'function', name: cur.text, line: cur.startPosition.row + 1 });
                        break;
                    }
                    cur = cur.childForFieldName?.('declarator') ?? cur.child?.(0);
                }
            }
            return; // don't descend into body
        }
        for (let i = 0; i < node.childCount; i++) walk(node.child(i), depth + 1);
    }
    walk(tree.rootNode, 0);
    return { includes, symbols };
}

const SAMPLES = [
    'src/exec.cpp',
    'src/div.cpp',
    'include/adx_include.h',
    'include/divext.h',
    'src/db/ora/oracli.cpp',
    'test/adx_test.h',
];

let passes = 0, fails = 0;
for (const rel of SAMPLES) {
    const full = join(RUNTIME, rel);
    if (!existsSync(full)) { console.log(`SKIP ${rel} (not found)`); continue; }
    const src = await readFile(full, 'utf8');
    const t0 = performance.now();
    const ts = tsExtract(src);
    const tsMs = (performance.now() - t0).toFixed(1);
    const reg = regexIncludes(src);

    const tsSet = new Set(ts.includes);
    const regSet = new Set(reg);
    const missing = [...regSet].filter(x => !tsSet.has(x));
    const extra = [...tsSet].filter(x => !regSet.has(x));

    console.log(`\n=== ${rel}  (${(src.length/1024).toFixed(1)} KB)`);
    console.log(`  tree-sitter: ${ts.includes.length} includes, ${ts.symbols.length} top-level symbols, ${tsMs}ms`);
    console.log(`  regex      : ${reg.length} includes`);
    if (missing.length) console.log(`  ⚠ tree-sitter MISSED (regex saw): ${missing.join(', ')}`);
    if (extra.length)   console.log(`  ✓ tree-sitter FOUND extras (regex missed): ${extra.join(', ')}`);
    if (ts.symbols.length > 0) {
        console.log(`  first 5 symbols:`);
        for (const s of ts.symbols.slice(0, 5)) console.log(`    [${s.kind.padEnd(20)}] ${s.name}  (line ${s.line})`);
    }
    if (missing.length === 0) passes++; else fails++;
}

console.log(`\n${passes}/${passes + fails} files: tree-sitter found at least every include the regex did.`);
