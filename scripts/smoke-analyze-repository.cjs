const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.resolve(process.argv[2] || '.');
const requestedFocus = process.argv.slice(3).map(file => path.resolve(root, file));
const supported = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
    '.css', '.scss', '.sass', '.less', '.styl', '.py', '.c', '.cpp', '.cc',
    '.cxx', '.h', '.hpp', '.hxx', '.cs', '.go', '.rs', '.java', '.kt',
    '.kts', '.php', '.rb', '.swift', '.y', '.ym4', '.x', '.l',
]);
const ignored = new Set([
    '.git', 'node_modules', 'out', 'dist', 'build', 'target', 'bin', 'obj',
    '__pycache__', '.venv', 'venv', 'vendor', '.gradle', '.vs', '.idea',
]);

function walk(directory, results = []) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && ignored.has(entry.name)) { continue; }
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) { walk(full, results); }
        else if (entry.isFile() && supported.has(path.extname(entry.name).toLowerCase())) { results.push(full); }
    }
    return results;
}

const files = walk(root);
const output = [];
const vscodeMock = {
    RelativePattern: class RelativePattern {
        constructor(base, pattern) { this.base = base; this.pattern = pattern; }
    },
    workspace: {
        workspaceFolders: [{ uri: { fsPath: root } }],
        getConfiguration: () => ({ get: (_name, fallback) => fallback }),
        findFiles: async (_pattern, _exclude, maxFiles) => files.slice(0, maxFiles).map(fsPath => ({ fsPath })),
    },
    window: {
        createOutputChannel: () => ({
            appendLine: line => output.push(line),
            clear() {}, show() {}, dispose() {},
        }),
    },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') { return vscodeMock; }
    return originalLoad.call(this, request, parent, isMain);
};

async function main() {
    const { DependencyAnalyzer } = require('../out/analyzer/DependencyAnalyzer.js');
    const analyzer = new DependencyAnalyzer();
    await analyzer.analyze();
    const stats = analyzer.getStats();
    const indexed = analyzer.getAllInternalFilePaths();
    const isolated = indexed.filter(file => {
        const related = analyzer.getRelatedFiles(file);
        return related.dependencies.length === 0 && related.dependents.length === 0;
    });
    const isolatedByLanguage = {};
    for (const file of isolated) {
        const node = analyzer.serialize(file, 1, 1).nodes[0];
        const language = node?.language ?? 'unknown';
        isolatedByLanguage[language] = (isolatedByLanguage[language] ?? 0) + 1;
    }
    const focusFiles = requestedFocus.length > 0
        ? requestedFocus
        : stats.hubFiles.slice(0, 5).map(item => analyzer.resolveFilePath(item.path)).filter(Boolean);
    const focused = focusFiles.map(file => {
        const graph = analyzer.serialize(file, 25, 1);
        return {
            file: analyzer.toRelative(file),
            nodes: graph.nodes.length,
            edges: graph.edges.length,
            dependencies: analyzer.getRelatedFiles(file).dependencies.length,
            dependents: analyzer.getRelatedFiles(file).dependents.length,
        };
    });
    console.log(JSON.stringify({
        root,
        discoveredFiles: files.length,
        stats,
        isolatedFiles: isolated.length,
        isolatedPercent: indexed.length === 0 ? 0 : Number((isolated.length * 100 / indexed.length).toFixed(1)),
        isolatedByLanguage,
        isolatedSample: isolated.slice(0, 30).map(file => analyzer.toRelative(file)),
        focused,
        log: output,
    }, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
