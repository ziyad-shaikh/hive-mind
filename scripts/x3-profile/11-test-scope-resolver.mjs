// Smoke-test the compiled CppScopeResolver against the runtime repo.
// Builds a minimal mock of DependencyAnalyzer (just getAllFilePaths) and runs
// findReferences / findOverrides / callHierarchy / typeHierarchy.
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const HERE = import.meta.dirname;
const HIVE = join(HERE, '..', '..');
const RUNTIME = process.env.RUNTIME ?? join(HIVE, '..', 'runtime');
const require = createRequire(import.meta.url);

async function listCppFiles(root, out = []) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' ||
            entry.name === 'build' || entry.name === 'extlib' || entry.name === 'iz-pack') continue;
        const p = join(root, entry.name);
        if (entry.isDirectory()) await listCppFiles(p, out);
        else if (entry.isFile() && /\.(c|cc|cpp|cxx|h|hpp|hxx)$/i.test(entry.name)) {
            out.push(p);
        }
    }
    return out;
}

const tsParser = require(join(HIVE, 'out', 'analyzer', 'CppTreeSitterParser.js'));
const { CppScopeResolver } = require(join(HIVE, 'out', 'analyzer', 'CppScopeResolver.js'));

await tsParser.initCppParser(HIVE);
console.log('parser ready:', tsParser.isCppParserReady());

const allFiles = await listCppFiles(RUNTIME);
console.log(`scanning ${allFiles.length} C/C++ files`);

// Minimal analyzer mock — only the surface CppScopeResolver actually uses.
const mockAnalyzer = {
    getAllFilePaths: () => allFiles,
};
const r = new CppScopeResolver(mockAnalyzer);

const t0 = performance.now();
await r.ensureIndex();
console.log(`index built in ${(performance.now() - t0).toFixed(0)} ms`);
const stats = r.getStats();
console.log(`stats: ${stats.decls} decls, ${stats.classes} classes, ${stats.functions} functions`);

// ─── findReferences ────────────────────────────────────────────────────
console.log('\n=== findReferences("execerprg") ===');
{
    const refs = await r.findReferences({ symbolName: 'execerprg', maxResults: 10 });
    for (const ref of refs.slice(0, 8)) {
        const rel = ref.file.replace(RUNTIME, '').replace(/^[\\\/]/, '');
        const decl = ref.isDeclaration ? '[decl]' : '      ';
        console.log(`  ${decl} ${ref.confidence.padEnd(6)} ${rel}:${ref.line}  ${ref.snippet.slice(0, 80)}`);
    }
    console.log(`  total: ${refs.length}`);
}

console.log('\n=== findReferences("AdxException") ===');
{
    const refs = await r.findReferences({ symbolName: 'AdxException', maxResults: 5 });
    for (const ref of refs.slice(0, 5)) {
        const rel = ref.file.replace(RUNTIME, '').replace(/^[\\\/]/, '');
        console.log(`  ${ref.confidence.padEnd(6)} ${rel}:${ref.line}  ${ref.snippet.slice(0, 80)}`);
    }
    console.log(`  total: ${refs.length}`);
}

// ─── findOverrides ─────────────────────────────────────────────────────
console.log('\n=== findOverrides — pick a class that has subclasses ===');
{
    // Locate any class with subclasses in the runtime
    const internal = r;
    const subsMap = internal['subclassesOf'];
    const candidates = [...subsMap.entries()].filter(([k, v]) => v.size > 0).slice(0, 5);
    console.log('  classes with subclasses:');
    for (const [parent, children] of candidates) {
        console.log(`    ${parent} → ${[...children].slice(0, 3).join(', ')}${children.size > 3 ? ' …' : ''}`);
    }
}

// ─── typeHierarchy ─────────────────────────────────────────────────────
console.log('\n=== typeHierarchy ===');
{
    const subsMap = r['subclassesOf'];
    const aClassWithSubs = [...subsMap.entries()].find(([k, v]) => v.size >= 1)?.[0];
    if (aClassWithSubs) {
        const t = await r.typeHierarchy({ className: aClassWithSubs, direction: 'subtypes', depth: 2 });
        console.log(`  ${aClassWithSubs} has ${t.subtypes.length} direct subtypes:`);
        for (const sub of t.subtypes.slice(0, 5)) {
            console.log(`    ${sub.className} (conf=${sub.confidence}) ${sub.file ? '← '+sub.file.replace(RUNTIME, '').replace(/^[\\\/]/, '') : ''}`);
        }
    } else {
        console.log('  (no inheritance found in runtime — runtime is mostly C-style)');
    }
}

// ─── callHierarchy ─────────────────────────────────────────────────────
console.log('\n=== callHierarchy ===');
{
    // Find a function with non-empty callees
    const fns = r['functionsByQName'];
    let target = null;
    for (const [name, list] of fns) {
        for (const fn of list) {
            if (fn.callees.length > 5 && !name.includes('::')) { target = fn; break; }
        }
        if (target) break;
    }
    if (target) {
        console.log(`  outgoing calls from ${target.qualifiedName}:`);
        const ch = await r.callHierarchy({ symbolName: target.qualifiedName, direction: 'outgoing', depth: 1, maxPerLevel: 8 });
        for (const c of ch.outgoing.slice(0, 8)) {
            console.log(`    → ${c.qualifiedName.padEnd(30)} (conf=${c.confidence}) ${c.file ? c.file.replace(RUNTIME, '').replace(/^[\\\/]/, '') : '(unresolved)'}`);
        }
    }
}

console.log('\nAll resolver checks executed.');
