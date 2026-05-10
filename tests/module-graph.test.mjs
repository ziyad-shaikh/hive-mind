// Tests for ModuleGraphPanel.buildData against the synthetic X3-shaped fixture.
// Mocks vscode and the DependencyAnalyzer surface that buildData consumes.
import { join, dirname, basename, extname, relative } from 'node:path';
import { readdirSync, statSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { test, assert, assertEqual } from './_harness.mjs';

const HERE = import.meta.dirname;
const HIVE = join(HERE, '..');
const FIXTURE = join(HERE, 'fixtures', 'cpp');
const require = createRequire(import.meta.url);

// ── Mock the `vscode` module so the panel module can be require()d. ────
const vscodeMockPath = join(HERE, '_vscode-mock.cjs');
mkdirSync(dirname(vscodeMockPath), { recursive: true });
writeFileSync(vscodeMockPath, `
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
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
    if (req === 'vscode') return vscodeMockPath;
    return originalResolve.call(this, req, parent, ...rest);
};

// ── Walk fixture for all C/C++ files ───────────────────────────────────
function walk(dir, out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.isFile() && /\.(c|cc|cpp|cxx|h|hpp|hxx|inl)$/i.test(e.name)) out.push(p);
    }
    return out;
}

function buildMockAnalyzer() {
    const allFiles = walk(FIXTURE);
    // Real-ish edges: parse #include directives so the test has structure.
    const edges = new Map();
    const fileByBase = new Map();
    for (const f of allFiles) fileByBase.set(basename(f).toLowerCase(), f);

    for (const src of allFiles) {
        const text = readFileSync(src, 'utf-8');
        const re = /#include\s+["<]([^">]+)[">]/g;
        let m;
        while ((m = re.exec(text)) !== null) {
            const target = fileByBase.get(basename(m[1]).toLowerCase());
            if (target && target !== src) {
                if (!edges.has(src)) edges.set(src, new Set());
                edges.get(src).add(target);
            }
        }
    }

    const profiles = require(join(HIVE, 'out', 'profiles', 'index.js'));
    const profile = profiles.detectProfile(FIXTURE);

    return {
        getAllFilePaths: () => allFiles,
        getProfile: () => profile,
        getRelatedFiles: (file) => ({
            dependencies: [...(edges.get(file) ?? [])],
            dependents: [],
        }),
        toRelative: (abs) => relative(FIXTURE, abs).replace(/\\/g, '/'),
    };
}

test('ModuleGraphPanel.buildData detects three modules from fixtures', () => {
    const { ModuleGraphPanel } = require(join(HIVE, 'out', 'views', 'ModuleGraphPanel.js'));
    const panel = Object.create(ModuleGraphPanel.prototype);
    panel.analyzer = buildMockAnalyzer();
    const data = panel.buildData();
    assert(data !== null, 'buildData returned null');
    const names = data.nodes.map(n => n.name).sort();
    assertEqual(names.join(','), 'apl,cal,div',
        'expected exactly the three module names that match the fixture');
});

test('module nodes have header + impl counts that match fixtures', () => {
    const { ModuleGraphPanel } = require(join(HIVE, 'out', 'views', 'ModuleGraphPanel.js'));
    const panel = Object.create(ModuleGraphPanel.prototype);
    panel.analyzer = buildMockAnalyzer();
    const data = panel.buildData();
    const apl = data.nodes.find(n => n.name === 'apl');
    assert(apl, 'apl module not found');
    assertEqual(apl.headerCount, 2, 'apl should have 2 headers (aplext.h + aplin.h)');
    // apl module includes aplmain.cpp + aplhelper.cpp + apl_test.cpp.
    // X3 convention treats `<m>_test.cpp` as part of module <m> via the
    // `<m>WORD` rule in identifyModule — that's intentional.
    assertEqual(apl.implCount, 3, 'apl should have 3 impls (main + helper + test)');
    const cal = data.nodes.find(n => n.name === 'cal');
    assertEqual(cal.headerCount, 2);
    assertEqual(cal.implCount, 1);
});

test('inter-module edges include div→apl and div→cal (from divhelper.cpp)', () => {
    const { ModuleGraphPanel } = require(join(HIVE, 'out', 'views', 'ModuleGraphPanel.js'));
    const panel = Object.create(ModuleGraphPanel.prototype);
    panel.analyzer = buildMockAnalyzer();
    const data = panel.buildData();
    const edgeStrs = data.edges.map(e => `${e.from}->${e.to}`).sort();
    assert(edgeStrs.includes('div->apl'), `expected div->apl in edges, got ${edgeStrs.join(', ')}`);
    assert(edgeStrs.includes('div->cal'), `expected div->cal in edges, got ${edgeStrs.join(', ')}`);
});

test('returns null for a workspace with no profile', () => {
    const { ModuleGraphPanel } = require(join(HIVE, 'out', 'views', 'ModuleGraphPanel.js'));
    const panel = Object.create(ModuleGraphPanel.prototype);
    panel.analyzer = {
        getAllFilePaths: () => [],
        getProfile: () => null,
        getRelatedFiles: () => ({ dependencies: [], dependents: [] }),
        toRelative: (s) => s,
    };
    assertEqual(panel.buildData(), null);
});

export {};
