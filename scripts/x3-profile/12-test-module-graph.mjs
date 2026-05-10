// Smoke-test ModuleGraphPanel.buildData against the runtime repo.
// We can't construct the WebviewPanel outside the extension host, so we
// load the panel module with a mocked `vscode` and call buildData() directly.
import { join, dirname, basename, extname, relative } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import Module from 'node:module';

const HERE = import.meta.dirname;
const HIVE = join(HERE, '..', '..');
const RUNTIME = process.env.RUNTIME ?? join(HIVE, '..', 'runtime');
const require = createRequire(import.meta.url);

// ── Mock the `vscode` module so the import works under plain Node. ────
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
    if (req === 'vscode') {
        return require.resolve(join(HIVE, 'scripts', 'x3-profile', '_vscode-mock.cjs'));
    }
    return originalResolve.call(this, req, parent, ...rest);
};

// Build the mock once
import { writeFileSync, mkdirSync } from 'node:fs';
const mockPath = join(HIVE, 'scripts', 'x3-profile', '_vscode-mock.cjs');
mkdirSync(dirname(mockPath), { recursive: true });
writeFileSync(mockPath, `
module.exports = {
    Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }) },
    window: {
        createWebviewPanel: () => ({
            webview: { html: '', onDidReceiveMessage: () => ({ dispose() {} }) },
            onDidDispose: () => ({ dispose() {} }),
            reveal: () => {},
        }),
        showTextDocument: () => Promise.resolve(),
    },
    ViewColumn: { Beside: 'beside' },
    workspace: {},
};
`);

// ── Walk the runtime to enumerate all C/C++ files (mirrors analyzer.getAllFilePaths). ──
function walk(dir, out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.') || ['node_modules','build','extlib','iz-pack','out'].includes(e.name)) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.isFile() && /\.(c|cc|cpp|cxx|h|hpp|hxx|inl)$/i.test(e.name)) out.push(p);
    }
    return out;
}
const allFiles = walk(RUNTIME);
console.log(`enumerated ${allFiles.length} C/C++ files in ${RUNTIME}`);

// ── Mock DependencyAnalyzer surface that ModuleGraphPanel consumes. ───
// We give it a *toy* edge graph (each impl includes its own ext header) so
// edges aren't all empty — enough to exercise edge aggregation.
const profile = require(join(HIVE, 'src', 'profiles', 'sage-x3-runtime.json'));

// Resolve {module} → file paths that actually exist in the runtime
const filesByName = new Map();
for (const f of allFiles) filesByName.set(basename(f).toLowerCase(), f);

const fakeEdges = new Map(); // file → Set<dep>
function addEdge(src, dst) {
    if (!src || !dst || src === dst) return;
    if (!fakeEdges.has(src)) fakeEdges.set(src, new Set());
    fakeEdges.get(src).add(dst);
}
// For each module, pretend impls include the matching ext header
for (const m of profile.modulePattern.knownModules) {
    const ext = filesByName.get(`${m}ext.h`);
    const inh = filesByName.get(`${m}in.h`);
    for (const f of allFiles) {
        const stem = basename(f, extname(f)).toLowerCase();
        if (stem.startsWith(m) && /\.(cpp|cc|cxx|c|inl)$/i.test(f)) {
            addEdge(f, ext); addEdge(f, inh);
        }
    }
}
// Add a few cross-module edges manually so module→module aggregation is non-trivial
const aplExt = filesByName.get('aplext.h');
const calExt = filesByName.get('calext.h');
const divExt = filesByName.get('divext.h');
for (const f of allFiles) {
    const stem = basename(f, extname(f)).toLowerCase();
    if (stem.startsWith('apl') && /\.(cpp|cc|cxx)$/i.test(f)) {
        addEdge(f, calExt); addEdge(f, divExt);
    }
}

const mockAnalyzer = {
    getAllFilePaths: () => allFiles,
    getProfile: () => profile,
    getRelatedFiles: (file) => ({
        dependencies: [...(fakeEdges.get(file) ?? [])],
        dependents: [],
    }),
    toRelative: (abs) => relative(RUNTIME, abs).replace(/\\/g, '/'),
};

// ── Load and invoke ModuleGraphPanel.buildData() ──────────────────────
const { ModuleGraphPanel } = require(join(HIVE, 'out', 'views', 'ModuleGraphPanel.js'));

// buildData is private — reach in via the prototype (smoke test only).
const panelProto = ModuleGraphPanel.prototype;
const panel = Object.create(panelProto);
panel.analyzer = mockAnalyzer;

const data = panel.buildData();
if (!data) {
    console.error('FAIL: buildData returned null');
    process.exit(1);
}

console.log(`\nprofile: ${data.profileName}`);
console.log(`modules with files: ${data.nodes.length}`);
console.log(`inter-module edges: ${data.edges.length}\n`);

console.log('top modules by file count:');
for (const n of [...data.nodes].sort((a, b) => b.files.length - a.files.length).slice(0, 10)) {
    const variantTag = n.variants.length ? `  [${n.variants.join(',')}]` : '';
    console.log(`  ${n.name.padEnd(8)} ${String(n.files.length).padStart(4)} files (${n.headerCount}h / ${n.implCount}i)${variantTag}`);
}

console.log('\ntop edges by weight:');
for (const e of [...data.edges].sort((a, b) => b.weight - a.weight).slice(0, 10)) {
    console.log(`  ${e.from.padEnd(8)} → ${e.to.padEnd(8)}  ${e.weight}`);
}

if (data.nodes.length === 0) { console.error('FAIL: 0 modules with files — module classifier may be broken.'); process.exit(1); }
console.log('\nSmoke test passed.');
