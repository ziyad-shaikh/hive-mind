import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileNode {
    id: string;
    label: string;
    relativePath: string;
    language: string;
    dependencies: Set<string>;
    dependents: Set<string>;
}

export interface GraphEdge {
    source: string;
    target: string;
}

export interface SerializedGraph {
    nodes: SerializedNode[];
    edges: GraphEdge[];
}

export interface SerializedNode {
    id: string;
    label: string;
    relativePath: string;
    language: string;
    connectionCount: number;
}

export interface CycleInfo {
    files: string[];
}

// ---------------------------------------------------------------------------
// Language-specific import parsers
// ---------------------------------------------------------------------------

interface LanguageParser {
    extensions: string[];
    extract(content: string): string[];
}

const PARSERS: LanguageParser[] = [
    {
        // TypeScript / JavaScript / Vue / Svelte
        extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'],
        extract(content: string) {
            let code = content;
            if (content.includes('<script')) {
                const scriptBlocks: string[] = [];
                const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
                let m: RegExpExecArray | null;
                while ((m = scriptRe.exec(content)) !== null) {
                    scriptBlocks.push(m[1]);
                }
                if (scriptBlocks.length > 0) {
                    code = scriptBlocks.join('\n');
                }
            }

            const results: string[] = [];
            const staticRe = /\bfrom\s+['"]([^'"]+)['"]/g;
            const dynRe = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
            const reRe = /\bexport\s+.*?\bfrom\s+['"]([^'"]+)['"]/g;
            const cssImportRe = /\bimport\s+['"]([^'"]+\.(?:css|scss|sass|less|styl))['"]/g;
            const cssReqRe = /\brequire\s*\(\s*['"]([^'"]+\.(?:css|scss|sass|less|styl))['"]\s*\)/g;

            for (const re of [staticRe, dynRe, reRe, cssImportRe, cssReqRe]) {
                let m: RegExpExecArray | null;
                while ((m = re.exec(code)) !== null) {
                    results.push(m[1]);
                }
            }
            return results;
        },
    },
    {
        // CSS / SCSS / LESS
        extensions: ['.css', '.scss', '.sass', '.less', '.styl'],
        extract(content: string) {
            const results: string[] = [];
            const importRe = /(?:@import|@use|@forward)\s+(?:url\()?\s*['"]([^'"]+)['"]\s*\)?/g;
            let m: RegExpExecArray | null;
            while ((m = importRe.exec(content)) !== null) {
                results.push(m[1]);
            }
            return results;
        },
    },
    {
        // Python
        extensions: ['.py'],
        extract(content: string) {
            const results: string[] = [];
            const fromRe = /^from\s+(\.{0,3}[\w.]*)\s+import/gm;
            const impRe = /^import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;
            let m: RegExpExecArray | null;
            while ((m = fromRe.exec(content)) !== null) {
                results.push(m[1]);
            }
            while ((m = impRe.exec(content)) !== null) {
                const parts = m[1].split(/\s*,\s*/);
                for (const p of parts) {
                    const trimmed = p.trim();
                    if (trimmed) { results.push(trimmed); }
                }
            }
            return results;
        },
    },
    {
        // C / C++
        extensions: ['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx'],
        extract(content: string) {
            const results: string[] = [];
            const quoteRe = /^#include\s+"([^"]+)"/gm;
            const angleRe = /^#include\s+<([^>]+)>/gm;
            let m: RegExpExecArray | null;
            while ((m = quoteRe.exec(content)) !== null) { results.push(m[1]); }
            while ((m = angleRe.exec(content)) !== null) { results.push('<' + m[1]); }
            return results;
        },
    },
    {
        // C#
        extensions: ['.cs'],
        extract(content: string) {
            const results: string[] = [];
            const re = /^using\s+([\w.]+)\s*;/gm;
            let m: RegExpExecArray | null;
            while ((m = re.exec(content)) !== null) {
                results.push(m[1]);
            }
            return results;
        },
    },
    {
        // Go
        extensions: ['.go'],
        extract(content: string) {
            const results: string[] = [];
            const singleRe = /^import\s+"([^"]+)"/gm;
            const blockRe = /^import\s*\(([\s\S]*?)\)/gm;
            const innerRe = /["']([^"']+)["']/g;
            let m: RegExpExecArray | null;
            while ((m = singleRe.exec(content)) !== null) {
                results.push(m[1]);
            }
            while ((m = blockRe.exec(content)) !== null) {
                let inner: RegExpExecArray | null;
                while ((inner = innerRe.exec(m[1])) !== null) {
                    results.push(inner[1]);
                }
            }
            return results;
        },
    },
    {
        // Rust
        extensions: ['.rs'],
        extract(content: string) {
            const results: string[] = [];
            const modRe = /^mod\s+(\w+)\s*;/gm;
            const useRe = /^use\s+((?:crate|super|self)(?:::\w+)+)/gm;
            let m: RegExpExecArray | null;
            while ((m = modRe.exec(content)) !== null) { results.push('mod:' + m[1]); }
            while ((m = useRe.exec(content)) !== null) { results.push('use:' + m[1]); }
            return results;
        },
    },
    {
        // Java / Kotlin
        extensions: ['.java', '.kt', '.kts'],
        extract(content: string) {
            const results: string[] = [];
            const re = /^import\s+([\w.]+)\s*;?/gm;
            let m: RegExpExecArray | null;
            while ((m = re.exec(content)) !== null) {
                results.push(m[1]);
            }
            return results;
        },
    },
    {
        // PHP
        extensions: ['.php'],
        extract(content: string) {
            const results: string[] = [];
            const re = /\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]\s*\)?/g;
            const useRe = /^use\s+([\w\\]+)\s*;/gm;
            let m: RegExpExecArray | null;
            while ((m = re.exec(content)) !== null) { results.push(m[1]); }
            while ((m = useRe.exec(content)) !== null) { results.push(m[1]); }
            return results;
        },
    },
    {
        // Ruby
        extensions: ['.rb'],
        extract(content: string) {
            const results: string[] = [];
            const re = /\b(?:require|require_relative|load)\s+['"]([^'"]+)['"]/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(content)) !== null) { results.push(m[1]); }
            return results;
        },
    },
    {
        // Swift
        extensions: ['.swift'],
        extract(content: string) {
            const results: string[] = [];
            const re = /^import\s+(\w+)/gm;
            let m: RegExpExecArray | null;
            while ((m = re.exec(content)) !== null) { results.push(m[1]); }
            return results;
        },
    },
];

const EXT_TO_PARSER = new Map<string, LanguageParser>();
for (const p of PARSERS) {
    for (const ext of p.extensions) {
        EXT_TO_PARSER.set(ext, p);
    }
}

// ---------------------------------------------------------------------------
// tsconfig.json / jsconfig.json path alias loader
// ---------------------------------------------------------------------------

interface PathAliases {
    baseUrl: string;
    paths: Map<string, string[]>;
}

function loadTsConfigPaths(workspaceRoot: string): PathAliases | null {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const configPath = path.join(workspaceRoot, name);
        if (!fs.existsSync(configPath)) { continue; }
        try {
            const raw = fs.readFileSync(configPath, 'utf-8');
            const stripped = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
            const config = JSON.parse(stripped);
            const opts = config.compilerOptions ?? {};
            const baseUrl = opts.baseUrl
                ? path.resolve(workspaceRoot, opts.baseUrl)
                : workspaceRoot;
            const pathsMap = new Map<string, string[]>();
            if (opts.paths) {
                for (const [alias, targets] of Object.entries<string[]>(opts.paths)) {
                    pathsMap.set(alias, targets);
                }
            }
            return { baseUrl, paths: pathsMap };
        } catch {
            continue;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Import resolution helpers
// ---------------------------------------------------------------------------

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const STYLE_EXTS = ['.css', '.scss', '.sass', '.less', '.styl'];
const ALL_JS_RESOLVE_EXTS = [...JS_EXTS, ...STYLE_EXTS, '.json', '.vue', '.svelte'];

function tryResolveWithExtensions(base: string, exts: string[]): string | null {
    if (fs.existsSync(base) && fs.statSync(base).isFile()) { return base; }
    for (const ext of exts) {
        const candidate = base + ext;
        if (fs.existsSync(candidate)) { return candidate; }
    }
    for (const ext of JS_EXTS) {
        const candidate = path.join(base, 'index' + ext);
        if (fs.existsSync(candidate)) { return candidate; }
    }
    return null;
}

function tryResolveJsImport(
    importStr: string,
    fromDir: string,
    workspaceRoot: string,
    tsConfigPaths: PathAliases | null
): string | null {
    if (importStr.startsWith('.') || importStr.startsWith('/')) {
        const base = importStr.startsWith('/')
            ? path.join(workspaceRoot, importStr)
            : path.resolve(fromDir, importStr);
        return tryResolveWithExtensions(base, ALL_JS_RESOLVE_EXTS);
    }

    // tsconfig/jsconfig path aliases  (e.g. @/* -> src/*)
    if (tsConfigPaths) {
        for (const [alias, targets] of tsConfigPaths.paths) {
            const pattern = alias.replace('*', '(.*)');
            const re = new RegExp(`^${pattern}$`);
            const match = importStr.match(re);
            if (match) {
                for (const target of targets) {
                    const resolved = target.replace('*', match[1] ?? '');
                    const abs = path.resolve(tsConfigPaths.baseUrl, resolved);
                    const result = tryResolveWithExtensions(abs, ALL_JS_RESOLVE_EXTS);
                    if (result) { return result; }
                }
            }
        }
        // baseUrl resolution  (e.g. import 'components/Button')
        const baseUrlResolved = path.resolve(tsConfigPaths.baseUrl, importStr);
        const result = tryResolveWithExtensions(baseUrlResolved, ALL_JS_RESOLVE_EXTS);
        if (result) { return result; }
    }

    return null;
}

function tryResolveStyleImport(importStr: string, fromDir: string): string | null {
    const base = path.resolve(fromDir, importStr);
    const result = tryResolveWithExtensions(base, STYLE_EXTS);
    if (result) { return result; }

    // SCSS underscore partial convention: @import 'vars' -> _vars.scss
    const dir = path.dirname(base);
    const basename = path.basename(base);
    for (const ext of STYLE_EXTS) {
        const partial = path.join(dir, '_' + basename + ext);
        if (fs.existsSync(partial)) { return partial; }
    }
    // Already has extension
    const partialExact = path.join(dir, '_' + basename);
    if (fs.existsSync(partialExact) && fs.statSync(partialExact).isFile()) { return partialExact; }
    return null;
}

function tryResolvePythonImport(importStr: string, fromDir: string, workspaceRoot: string): string | null {
    if (importStr.startsWith('.')) {
        const dots = importStr.match(/^\.+/)?.[0].length ?? 0;
        let base = fromDir;
        for (let i = 1; i < dots; i++) { base = path.dirname(base); }
        const rest = importStr.slice(dots).replace(/\./g, path.sep);
        if (rest) {
            const candidate = path.join(base, rest + '.py');
            if (fs.existsSync(candidate)) { return candidate; }
            const pkg = path.join(base, rest, '__init__.py');
            if (fs.existsSync(pkg)) { return pkg; }
        }
        return null;
    }
    const rel = importStr.replace(/\./g, path.sep);
    for (const prefix of ['', 'src', 'lib', 'app']) {
        const candidate = path.join(workspaceRoot, prefix, rel + '.py');
        if (fs.existsSync(candidate)) { return candidate; }
        const pkg = path.join(workspaceRoot, prefix, rel, '__init__.py');
        if (fs.existsSync(pkg)) { return pkg; }
    }
    return null;
}

function tryResolveCImport(
    importStr: string,
    fromDir: string,
    headerIndex: Map<string, string[]>,
    includePaths: string[]
): string | null {
    const isAngle = importStr.startsWith('<');
    const cleaned = isAngle ? importStr.slice(1) : importStr;
    const basename = path.basename(cleaned).toLowerCase();
    const normalizedCleaned = cleaned.toLowerCase().replace(/\//g, path.sep);

    // 1. Relative resolution for quoted includes
    if (!isAngle) {
        const candidate = path.resolve(fromDir, cleaned);
        if (fs.existsSync(candidate)) { return candidate; }
    }

    // 2. Search include paths (from compile_commands.json or discovered dirs)
    for (const incDir of includePaths) {
        const candidate = path.resolve(incDir, cleaned);
        if (fs.existsSync(candidate)) { return candidate; }
    }

    // 3. Match by relative path in index
    const byRelPath = headerIndex.get(normalizedCleaned);
    if (byRelPath && byRelPath.length === 1) { return byRelPath[0]; }
    if (byRelPath && byRelPath.length > 1) {
        // Multiple matches — pick closest to fromDir
        return pickClosest(fromDir, byRelPath);
    }

    // 4. Match by basename (with disambiguation)
    const byBasename = headerIndex.get(basename);
    if (byBasename && byBasename.length === 1) { return byBasename[0]; }
    if (byBasename && byBasename.length > 1) {
        // If the include has path segments (e.g. "net/socket.h"), filter by suffix match
        if (cleaned.includes('/')) {
            const suffix = cleaned.replace(/\//g, path.sep).toLowerCase();
            const suffixMatches = byBasename.filter(f => f.toLowerCase().endsWith(suffix));
            if (suffixMatches.length === 1) { return suffixMatches[0]; }
            if (suffixMatches.length > 1) { return pickClosest(fromDir, suffixMatches); }
        }
        return pickClosest(fromDir, byBasename);
    }
    return null;
}

/** Pick the file with the shortest path distance to fromDir (common prefix heuristic). */
function pickClosest(fromDir: string, candidates: string[]): string {
    let best = candidates[0];
    let bestScore = 0;
    const fromParts = fromDir.toLowerCase().split(path.sep);
    for (const c of candidates) {
        const cParts = path.dirname(c).toLowerCase().split(path.sep);
        let common = 0;
        for (let i = 0; i < Math.min(fromParts.length, cParts.length); i++) {
            if (fromParts[i] === cParts[i]) { common++; } else { break; }
        }
        if (common > bestScore) { bestScore = common; best = c; }
    }
    return best;
}

function tryResolveRustImport(importStr: string, fromFile: string, workspaceRoot: string): string | null {
    const fromDir = path.dirname(fromFile);

    if (importStr.startsWith('mod:')) {
        const modName = importStr.slice(4);
        const sibling = path.join(fromDir, modName + '.rs');
        if (fs.existsSync(sibling)) { return sibling; }
        const nested = path.join(fromDir, modName, 'mod.rs');
        if (fs.existsSync(nested)) { return nested; }
        return null;
    }
    if (importStr.startsWith('use:')) {
        const usePath = importStr.slice(4);
        const parts = usePath.split('::');
        if (parts[0] === 'crate') {
            const relParts = parts.slice(1);
            const srcDir = path.join(workspaceRoot, 'src');
            for (const slice of [relParts, relParts.slice(0, -1)]) {
                if (slice.length === 0) { continue; }
                const candidate = path.join(srcDir, ...slice) + '.rs';
                if (fs.existsSync(candidate)) { return candidate; }
                const modCandidate = path.join(srcDir, ...slice, 'mod.rs');
                if (fs.existsSync(modCandidate)) { return modCandidate; }
            }
        }
        if (parts[0] === 'super') {
            const parentDir = path.dirname(fromDir);
            const relParts = parts.slice(1);
            if (relParts.length > 0) {
                const candidate = path.join(parentDir, ...relParts) + '.rs';
                if (fs.existsSync(candidate)) { return candidate; }
            }
        }
    }
    return null;
}

function tryResolveJavaImport(importStr: string, workspaceRoot: string): string | null {
    const relPath = importStr.replace(/\./g, path.sep);
    for (const srcRoot of ['src/main/java', 'src/main/kotlin', 'src', 'app/src/main/java', 'app/src/main/kotlin']) {
        for (const ext of ['.java', '.kt']) {
            const candidate = path.join(workspaceRoot, srcRoot, relPath + ext);
            if (fs.existsSync(candidate)) { return candidate; }
        }
    }
    return null;
}

function tryResolveRubyImport(importStr: string, fromDir: string, workspaceRoot: string): string | null {
    const relCandidate = path.resolve(fromDir, importStr + '.rb');
    if (fs.existsSync(relCandidate)) { return relCandidate; }
    const relExact = path.resolve(fromDir, importStr);
    if (fs.existsSync(relExact) && fs.statSync(relExact).isFile()) { return relExact; }
    for (const prefix of ['', 'lib', 'app']) {
        const candidate = path.join(workspaceRoot, prefix, importStr + '.rb');
        if (fs.existsSync(candidate)) { return candidate; }
    }
    return null;
}

function tryResolvePhpImport(importStr: string, fromDir: string, workspaceRoot: string): string | null {
    const direct = path.resolve(fromDir, importStr);
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) { return direct; }
    const fromRoot = path.join(workspaceRoot, importStr);
    if (fs.existsSync(fromRoot) && fs.statSync(fromRoot).isFile()) { return fromRoot; }
    const nsPath = importStr.replace(/\\/g, path.sep);
    for (const prefix of ['src', 'app', 'lib', '']) {
        const candidate = path.join(workspaceRoot, prefix, nsPath + '.php');
        if (fs.existsSync(candidate)) { return candidate; }
    }
    return null;
}

function resolveImport(
    importStr: string,
    fromFile: string,
    workspaceRoot: string,
    headerIndex: Map<string, string[]>,
    includePaths: string[],
    tsConfigPaths: PathAliases | null
): string | null {
    const ext = path.extname(fromFile).toLowerCase();
    const fromDir = path.dirname(fromFile);

    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'].includes(ext)) {
        return tryResolveJsImport(importStr, fromDir, workspaceRoot, tsConfigPaths);
    }
    if (STYLE_EXTS.includes(ext)) {
        return tryResolveStyleImport(importStr, fromDir);
    }
    if (ext === '.py') {
        return tryResolvePythonImport(importStr, fromDir, workspaceRoot);
    }
    if (['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx'].includes(ext)) {
        return tryResolveCImport(importStr, fromDir, headerIndex, includePaths);
    }
    if (ext === '.rs') {
        return tryResolveRustImport(importStr, fromFile, workspaceRoot);
    }
    if (['.java', '.kt', '.kts'].includes(ext)) {
        return tryResolveJavaImport(importStr, workspaceRoot);
    }
    if (ext === '.rb') {
        return tryResolveRubyImport(importStr, fromDir, workspaceRoot);
    }
    if (ext === '.php') {
        return tryResolvePhpImport(importStr, fromDir, workspaceRoot);
    }
    return null;
}

// ---------------------------------------------------------------------------
// Ignored paths
// ---------------------------------------------------------------------------

const DEFAULT_IGNORED_DIRS = new Set([
    'node_modules', '.git', 'out', 'dist', 'build', '.next', '.nuxt',
    '__pycache__', '.venv', 'venv', 'env', '.tox', 'target', 'bin', 'obj',
    '.idea', '.vs', 'coverage', '.nyc_output', '.cache', 'vendor',
    '.gradle', '.mvn', 'Pods',
]);

function isIgnored(filePath: string, extraIgnored: Set<string>): boolean {
    const parts = filePath.split(/[\\/]/);
    return parts.some(p => DEFAULT_IGNORED_DIRS.has(p) || extraIgnored.has(p));
}

// ---------------------------------------------------------------------------
// C/C++ include path discovery
// ---------------------------------------------------------------------------

/** Common include directory names in large C/C++ projects */
const COMMON_INCLUDE_DIRS = ['include', 'inc', 'src', 'source', 'lib', 'third_party', '3rdparty', 'external'];

/**
 * Discovers include paths from:
 * 1. compile_commands.json — extracts -I and -isystem flags
 * 2. Common directory conventions (include/, src/, etc.)
 */
function discoverIncludePaths(workspaceRoots: string[]): string[] {
    const paths = new Set<string>();

    for (const root of workspaceRoots) {
        // 1. Parse compile_commands.json
        for (const buildDir of ['', 'build', 'out', 'cmake-build-debug', 'cmake-build-release']) {
            const ccPath = path.join(root, buildDir, 'compile_commands.json');
            if (fs.existsSync(ccPath)) {
                try {
                    const raw = fs.readFileSync(ccPath, 'utf-8');
                    const commands: Array<{ command?: string; arguments?: string[]; directory?: string }> = JSON.parse(raw);
                    for (const entry of commands) {
                        const dir = entry.directory || root;
                        const args = entry.arguments || splitCommand(entry.command || '');
                        for (let i = 0; i < args.length; i++) {
                            let incPath: string | null = null;
                            if (args[i] === '-I' || args[i] === '-isystem') {
                                incPath = args[i + 1];
                                i++;
                            } else if (args[i].startsWith('-I')) {
                                incPath = args[i].slice(2);
                            } else if (args[i].startsWith('-isystem')) {
                                incPath = args[i].slice(8);
                            }
                            if (incPath) {
                                const abs = path.isAbsolute(incPath) ? incPath : path.resolve(dir, incPath);
                                if (fs.existsSync(abs)) { paths.add(abs); }
                            }
                        }
                    }
                } catch {
                    // Malformed compile_commands.json — skip
                }
                break; // Use first found compile_commands.json
            }
        }

        // 2. Common include directories
        for (const dirName of COMMON_INCLUDE_DIRS) {
            const candidate = path.join(root, dirName);
            if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
                paths.add(candidate);
            }
        }

        // 3. The workspace root itself (for #include "foo.h" at root)
        paths.add(root);
    }

    return [...paths];
}

/** Split a shell command string into arguments (basic splitting, handles quotes). */
function splitCommand(cmd: string): string[] {
    const args: string[] = [];
    let current = '';
    let inQuote: string | null = null;
    for (const ch of cmd) {
        if (inQuote) {
            if (ch === inQuote) { inQuote = null; }
            else { current += ch; }
        } else if (ch === '"' || ch === "'") {
            inQuote = ch;
        } else if (ch === ' ' || ch === '\t') {
            if (current) { args.push(current); current = ''; }
        } else {
            current += ch;
        }
    }
    if (current) { args.push(current); }
    return args;
}

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

export class DependencyAnalyzer {
    private graph = new Map<string, FileNode>();
    private workspaceRoots: string[] = [];
    private headerIndex = new Map<string, string[]>();
    private includePaths: string[] = [];
    private tsConfigPaths: PathAliases | null = null;
    private extraIgnored = new Set<string>();
    private _debounceTimers = new Map<string, NodeJS.Timeout>();

    readonly outputChannel: vscode.OutputChannel;

    constructor() {
        this.workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
        this.outputChannel = vscode.window.createOutputChannel('Hive Mind');
    }

    private get primaryRoot(): string | undefined {
        return this.workspaceRoots[0];
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    async analyze(): Promise<void> {
        if (this.workspaceRoots.length === 0) { return; }

        const cfg = vscode.workspace.getConfiguration('hiveMind');
        const maxFiles = cfg.get<number>('maxFiles', 5000);
        const ignoredDirs = cfg.get<string[]>('ignoredDirectories', []);
        this.extraIgnored = new Set(ignoredDirs);
        this.graph.clear();
        this.headerIndex.clear();
        this.includePaths = [];

        // Load tsconfig/jsconfig path aliases
        for (const root of this.workspaceRoots) {
            const loaded = loadTsConfigPaths(root);
            if (loaded) {
                this.tsConfigPaths = loaded;
                this.outputChannel.appendLine(
                    `[Hive Mind] Loaded tsconfig paths from ${root} (baseUrl=${loaded.baseUrl}, ${loaded.paths.size} alias(es))`
                );
                break;
            }
        }

        // Build glob from all parser extensions
        const allExts = new Set<string>();
        for (const p of PARSERS) {
            for (const ext of p.extensions) { allExts.add(ext.slice(1)); }
        }
        const extGlob = [...allExts].join(',');

        const allUris: vscode.Uri[] = [];
        for (const root of this.workspaceRoots) {
            const pattern = new vscode.RelativePattern(root, `**/*.{${extGlob}}`);
            const exclude = '{node_modules,out,dist,build,.git,__pycache__,.venv,venv,target,bin,obj,vendor,.gradle}/**';
            const uris = await vscode.workspace.findFiles(pattern, exclude, maxFiles);
            allUris.push(...uris);
        }

        const validUris = allUris.filter(u => !isIgnored(u.fsPath, this.extraIgnored));
        this.outputChannel.appendLine(
            `[Hive Mind] Found ${validUris.length} source files across ${this.workspaceRoots.length} workspace root(s)`
        );

        // Build header index for C/C++ — stores all matches per key
        for (const uri of validUris) {
            const ext = path.extname(uri.fsPath).toLowerCase();
            if (['.h', '.hpp', '.hxx'].includes(ext)) {
                const basename = path.basename(uri.fsPath).toLowerCase();
                const existing = this.headerIndex.get(basename);
                if (existing) {
                    existing.push(uri.fsPath);
                } else {
                    this.headerIndex.set(basename, [uri.fsPath]);
                }
                for (const root of this.workspaceRoots) {
                    if (uri.fsPath.startsWith(root)) {
                        const rel = path.relative(root, uri.fsPath).replace(/\\/g, '/').toLowerCase();
                        const relExisting = this.headerIndex.get(rel);
                        if (relExisting) {
                            relExisting.push(uri.fsPath);
                        } else {
                            this.headerIndex.set(rel, [uri.fsPath]);
                        }
                    }
                }
            }
        }

        // Discover C/C++ include paths from compile_commands.json and common directories
        this.includePaths = discoverIncludePaths(this.workspaceRoots);
        if (this.includePaths.length > 0) {
            this.outputChannel.appendLine(
                `[Hive Mind] Discovered ${this.includePaths.length} C/C++ include path(s)`
            );
        }

        // Parse all files
        for (const uri of validUris) {
            this.parseFile(uri.fsPath);
        }

        this.buildDependents();

        const cycles = this.detectCycles();
        this.outputChannel.appendLine(
            `[Hive Mind] Analysis complete. ${this.graph.size} files, ${this.getEdgeCount()} edges, ${cycles.length} circular dep(s).`
        );
    }

    /** Debounced incremental update — avoids thrashing on rapid saves */
    debouncedUpdateFile(filePath: string): void {
        const existing = this._debounceTimers.get(filePath);
        if (existing) { clearTimeout(existing); }
        this._debounceTimers.set(filePath, setTimeout(() => {
            this._debounceTimers.delete(filePath);
            this.updateFile(filePath);
        }, 500));
    }

    updateFile(filePath: string): void {
        if (this.workspaceRoots.length === 0 || isIgnored(filePath, this.extraIgnored)) { return; }
        const existing = this.graph.get(filePath);
        if (existing) {
            for (const dep of existing.dependencies) {
                this.graph.get(dep)?.dependents.delete(filePath);
            }
        }
        this.parseFile(filePath);
        const updated = this.graph.get(filePath);
        if (updated) {
            for (const dep of updated.dependencies) {
                this.graph.get(dep)?.dependents.add(filePath);
            }
        }
    }

    removeFile(filePath: string): void {
        const node = this.graph.get(filePath);
        if (!node) { return; }
        for (const dep of node.dependencies) {
            this.graph.get(dep)?.dependents.delete(filePath);
        }
        for (const dep of node.dependents) {
            this.graph.get(dep)?.dependencies.delete(filePath);
        }
        this.graph.delete(filePath);
    }

    getDependencies(filePath: string, depth = 2): string[] {
        const resolved = this.resolveFilePath(filePath);
        if (!resolved) { return []; }
        const visited = new Set<string>();
        this.walk(resolved, depth, visited, 'dependencies');
        visited.delete(resolved);
        return [...visited];
    }

    getImpact(filePath: string, depth = 2): string[] {
        const resolved = this.resolveFilePath(filePath);
        if (!resolved) { return []; }
        const visited = new Set<string>();
        this.walk(resolved, depth, visited, 'dependents');
        visited.delete(resolved);
        return [...visited];
    }

    getRelatedFiles(filePath: string): { dependencies: string[]; dependents: string[] } {
        const resolved = this.resolveFilePath(filePath);
        if (!resolved) { return { dependencies: [], dependents: [] }; }
        const node = this.graph.get(resolved);
        if (!node) { return { dependencies: [], dependents: [] }; }
        return {
            dependencies: [...node.dependencies],
            dependents: [...node.dependents],
        };
    }

    getNodeCount(): number { return this.graph.size; }

    /** Get all absolute file paths in the graph */
    getAllFilePaths(): string[] {
        return [...this.graph.keys()];
    }

    getEdgeCount(): number {
        let count = 0;
        for (const n of this.graph.values()) { count += n.dependencies.size; }
        return count;
    }

    getIndexedFiles(): string[] {
        return [...this.graph.keys()].map(k => this.toRelative(k)).sort();
    }

    /** Detect all circular dependency chains (returns unique cycles) */
    detectCycles(): CycleInfo[] {
        const cycles: CycleInfo[] = [];
        const visited = new Set<string>();
        const stack = new Set<string>();
        const stackList: string[] = [];

        const dfs = (nodeId: string) => {
            if (stack.has(nodeId)) {
                const idx = stackList.indexOf(nodeId);
                if (idx >= 0) {
                    const cycle = stackList.slice(idx).map(f => this.toRelative(f));
                    cycles.push({ files: cycle });
                }
                return;
            }
            if (visited.has(nodeId)) { return; }
            visited.add(nodeId);
            stack.add(nodeId);
            stackList.push(nodeId);
            const node = this.graph.get(nodeId);
            if (node) {
                for (const dep of node.dependencies) {
                    if (this.graph.has(dep)) { dfs(dep); }
                }
            }
            stack.delete(nodeId);
            stackList.pop();
        };

        for (const nodeId of this.graph.keys()) {
            if (!visited.has(nodeId)) { dfs(nodeId); }
        }
        return cycles;
    }

    getStats(): {
        totalFiles: number;
        totalEdges: number;
        languages: Record<string, number>;
        hubFiles: { path: string; connections: number }[];
        circularDeps: number;
        orphanFiles: number;
    } {
        const languages: Record<string, number> = {};
        const hubs: { path: string; connections: number }[] = [];
        let orphans = 0;

        for (const node of this.graph.values()) {
            languages[node.language] = (languages[node.language] ?? 0) + 1;
            const conns = node.dependencies.size + node.dependents.size;
            hubs.push({ path: node.relativePath, connections: conns });
            if (conns === 0) { orphans++; }
        }
        hubs.sort((a, b) => b.connections - a.connections);

        return {
            totalFiles: this.graph.size,
            totalEdges: this.getEdgeCount(),
            languages,
            hubFiles: hubs.slice(0, 15),
            circularDeps: this.detectCycles().length,
            orphanFiles: orphans,
        };
    }

    // -----------------------------------------------------------------------
    // Test file mapping
    // -----------------------------------------------------------------------

    /**
     * Given a source file, find its associated test files.
     * Given a test file, includes the source file it tests.
     */
    getTestFiles(filePath: string): string[] {
        const resolved = this.resolveFilePath(filePath);
        if (!resolved) { return []; }

        const results: string[] = [];
        const rel = this.toRelative(resolved);
        const dir = path.dirname(resolved);
        const ext = path.extname(resolved);
        const base = path.basename(resolved, ext);

        // Check if this IS a test file → return source
        if (this.isTestFile(base)) {
            const sourceFile = this.findSourceForTest(resolved, dir, base, ext);
            if (sourceFile) { results.push(sourceFile); }
            return results;
        }

        // This is a source file → find test files
        const testPatterns = [
            // Same directory: foo.test.ts, foo.spec.ts
            path.join(dir, `${base}.test${ext}`),
            path.join(dir, `${base}.spec${ext}`),
            path.join(dir, `${base}_test${ext}`),
            // __tests__ directory
            path.join(dir, '__tests__', `${base}.test${ext}`),
            path.join(dir, '__tests__', `${base}.spec${ext}`),
            path.join(dir, '__tests__', `${base}${ext}`),
            // test/ directory sibling
            path.join(path.dirname(dir), 'test', path.basename(dir), `${base}.test${ext}`),
            path.join(path.dirname(dir), 'tests', path.basename(dir), `${base}.test${ext}`),
        ];

        // Go: foo_test.go
        if (ext === '.go') {
            testPatterns.push(path.join(dir, `${base}_test.go`));
        }
        // Java/Kotlin: FooTest.java
        if (['.java', '.kt', '.kts'].includes(ext)) {
            testPatterns.push(path.join(dir, `${base}Test${ext}`));
            // src/test mirror
            const relToSrc = resolved.replace(/[/\\]src[/\\]main[/\\]/, `${path.sep}src${path.sep}test${path.sep}`);
            if (relToSrc !== resolved) {
                testPatterns.push(relToSrc.replace(ext, `Test${ext}`));
            }
        }
        // Python: test_foo.py
        if (ext === '.py') {
            testPatterns.push(path.join(dir, `test_${base}.py`));
            testPatterns.push(path.join(dir, 'tests', `test_${base}.py`));
        }

        for (const candidate of testPatterns) {
            const normalized = path.normalize(candidate);
            if (this.graph.has(normalized)) {
                results.push(normalized);
            }
        }

        // Also check dependents that look like test files
        const node = this.graph.get(resolved);
        if (node) {
            for (const dep of node.dependents) {
                const depBase = path.basename(dep, path.extname(dep));
                if (this.isTestFile(depBase) && !results.includes(dep)) {
                    results.push(dep);
                }
            }
        }

        return [...new Set(results)];
    }

    /**
     * Given a test file, return the source file it tests.
     */
    getSourceForTest(filePath: string): string | undefined {
        const resolved = this.resolveFilePath(filePath);
        if (!resolved) { return undefined; }
        const ext = path.extname(resolved);
        const base = path.basename(resolved, ext);
        const dir = path.dirname(resolved);

        if (!this.isTestFile(base)) { return undefined; }
        return this.findSourceForTest(resolved, dir, base, ext);
    }

    private isTestFile(baseName: string): boolean {
        return /[._-](test|spec)$/i.test(baseName) ||
               /^test[._-]/i.test(baseName) ||
               /Test$/i.test(baseName) && baseName !== 'Test';
    }

    private findSourceForTest(testPath: string, dir: string, base: string, ext: string): string | undefined {
        // Strip test suffixes: foo.test → foo, foo.spec → foo, foo_test → foo
        let sourceBase = base
            .replace(/[._-](test|spec)$/i, '')
            .replace(/Test$/i, '');
        if (/^test[._-]/i.test(base)) {
            sourceBase = base.replace(/^test[._-]/i, '');
        }

        const candidates = [
            path.join(dir, `${sourceBase}${ext}`),
            // If in __tests__, look in parent
            path.join(path.dirname(dir), `${sourceBase}${ext}`),
            // src/test → src/main mirror
            testPath.replace(/[/\\]src[/\\]test[/\\]/, `${path.sep}src${path.sep}main${path.sep}`)
                .replace(`${base}${ext}`, `${sourceBase}${ext}`),
        ];

        for (const candidate of candidates) {
            const normalized = path.normalize(candidate);
            if (this.graph.has(normalized)) { return normalized; }
        }

        // Check dependencies — a test file likely imports its source
        const node = this.graph.get(testPath);
        if (node) {
            for (const dep of node.dependencies) {
                const depBase = path.basename(dep, path.extname(dep));
                if (depBase.toLowerCase() === sourceBase.toLowerCase()) {
                    return dep;
                }
            }
        }

        return undefined;
    }

    serialize(focusFile?: string, maxNodes = 150, depth = 1): SerializedGraph {
        // If a focus file is given, build an ego-graph around it.
        // If no focus file, return top-connected files (limited view).
        if (focusFile) {
            const resolved = this.resolveFilePath(focusFile);
            const rootNode = resolved ? this.graph.get(resolved) : undefined;

            if (!rootNode) {
                // File not in graph — return just that file with no connections
                const label = focusFile.split(/[\\/]/).pop() ?? focusFile;
                return {
                    nodes: [{ id: focusFile, label, relativePath: this.toRelative(focusFile), language: 'unknown', connectionCount: 0 }],
                    edges: [],
                };
            }

            // BFS-expand from the root node, hop by hop
            const distMap = new Map<string, number>();  // id → hop distance
            distMap.set(rootNode.id, 0);
            let frontier = [rootNode.id];

            for (let hop = 1; hop <= depth && frontier.length > 0; hop++) {
                const nextFrontier: string[] = [];
                for (const id of frontier) {
                    const n = this.graph.get(id);
                    if (!n) continue;
                    for (const neighbor of [...n.dependencies, ...n.dependents]) {
                        if (!distMap.has(neighbor)) {
                            distMap.set(neighbor, hop);
                            nextFrontier.push(neighbor);
                        }
                    }
                }
                // Cap each hop: keep the most-connected neighbors first
                if (nextFrontier.length > maxNodes) {
                    nextFrontier.sort((a, b) => {
                        const na = this.graph.get(a), nb = this.graph.get(b);
                        const sa = na ? na.dependencies.size + na.dependents.size : 0;
                        const sb = nb ? nb.dependencies.size + nb.dependents.size : 0;
                        return sb - sa;
                    });
                    nextFrontier.length = maxNodes;
                }
                frontier = nextFrontier;
            }

            // Collect nodes, capped to maxNodes (root always included)
            let ids = [...distMap.keys()];
            if (ids.length > maxNodes) {
                // Keep root + sort rest by distance then connection count
                ids = ids.filter(id => id !== rootNode.id)
                    .sort((a, b) => {
                        const da = distMap.get(a)!, db = distMap.get(b)!;
                        if (da !== db) return da - db;  // closer first
                        const na = this.graph.get(a), nb = this.graph.get(b);
                        const sa = na ? na.dependencies.size + na.dependents.size : 0;
                        const sb = nb ? nb.dependencies.size + nb.dependents.size : 0;
                        return sb - sa;
                    })
                    .slice(0, maxNodes - 1);
                ids.unshift(rootNode.id);
            }

            const nodeIds = new Set(ids);
            const nodes = ids.map(id => this.graph.get(id)!).filter(Boolean);

            // Only include edges where BOTH endpoints are in the ego-graph
            const edges: GraphEdge[] = [];
            for (const n of nodes) {
                for (const dep of n.dependencies) {
                    if (nodeIds.has(dep)) {
                        edges.push({ source: n.id, target: dep });
                    }
                }
            }

            return {
                nodes: nodes.map(n => ({
                    id: n.id,
                    label: n.label,
                    relativePath: n.relativePath,
                    language: n.language,
                    connectionCount: n.dependencies.size + n.dependents.size,
                })),
                edges,
            };
        }

        // No focus file — return top-connected files as a fallback
        let nodes = [...this.graph.values()];
        nodes.sort((a, b) => (b.dependencies.size + b.dependents.size) - (a.dependencies.size + a.dependents.size));
        nodes = nodes.slice(0, maxNodes);

        const nodeIds = new Set(nodes.map(n => n.id));
        const edges: GraphEdge[] = [];
        for (const n of nodes) {
            for (const dep of n.dependencies) {
                if (nodeIds.has(dep)) {
                    edges.push({ source: n.id, target: dep });
                }
            }
        }

        return {
            nodes: nodes.map(n => ({
                id: n.id,
                label: n.label,
                relativePath: n.relativePath,
                language: n.language,
                connectionCount: n.dependencies.size + n.dependents.size,
            })),
            edges,
        };
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    toRelative(absPath: string): string {
        for (const root of this.workspaceRoots) {
            if (absPath.startsWith(root)) {
                return path.relative(root, absPath).replace(/\\/g, '/');
            }
        }
        return absPath;
    }

    private parseFile(filePath: string): void {
        const ext = path.extname(filePath).toLowerCase();
        const parser = EXT_TO_PARSER.get(ext);
        if (!parser) { return; }

        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        } catch {
            return;
        }

        const rawImports = parser.extract(content);
        const deps = new Set<string>();

        for (const raw of rawImports) {
            const resolved = resolveImport(
                raw, filePath, this.primaryRoot ?? '', this.headerIndex, this.includePaths, this.tsConfigPaths
            );
            if (resolved && resolved !== filePath) {
                deps.add(resolved);
            }
        }

        const existing = this.graph.get(filePath);
        this.graph.set(filePath, {
            id: filePath,
            label: path.basename(filePath),
            relativePath: this.toRelative(filePath),
            language: languageFromExt(ext),
            dependencies: deps,
            dependents: existing?.dependents ?? new Set(),
        });
    }

    private buildDependents(): void {
        for (const node of this.graph.values()) { node.dependents = new Set(); }
        for (const [, node] of this.graph) {
            for (const dep of node.dependencies) {
                this.graph.get(dep)?.dependents.add(node.id);
            }
        }
    }

    private walk(
        filePath: string,
        depth: number,
        visited: Set<string>,
        direction: 'dependencies' | 'dependents'
    ): void {
        if (visited.has(filePath)) { return; }
        visited.add(filePath);
        if (depth === 0) { return; }
        const node = this.graph.get(filePath);
        if (!node) { return; }
        const nextDepth = depth === -1 ? -1 : depth - 1;
        for (const dep of node[direction]) {
            this.walk(dep, nextDepth, visited, direction);
        }
    }

    resolveFilePath(filePath: string): string | undefined {
        if (path.isAbsolute(filePath) && this.graph.has(filePath)) {
            return filePath;
        }
        for (const root of this.workspaceRoots) {
            const abs = path.join(root, filePath);
            if (this.graph.has(abs)) { return abs; }
            const normalized = abs.replace(/\//g, path.sep);
            if (this.graph.has(normalized)) { return normalized; }
        }
        // Fuzzy matching with scoring
        const lower = filePath.replace(/\\/g, '/').toLowerCase();
        let bestMatch: string | undefined;
        let bestScore = 0;

        for (const node of this.graph.values()) {
            if (node.relativePath.toLowerCase() === lower) { return node.id; }

            if (node.relativePath.toLowerCase().endsWith('/' + lower) ||
                node.relativePath.toLowerCase().endsWith('\\' + lower)) {
                if (bestScore < 3) { bestMatch = node.id; bestScore = 3; }
            }
            if (node.label.toLowerCase() === lower) {
                if (bestScore < 2) { bestMatch = node.id; bestScore = 2; }
            }
            if (bestScore < 1 && node.relativePath.toLowerCase().includes(lower)) {
                bestMatch = node.id;
                bestScore = 1;
            }
        }
        return bestMatch;
    }
}

function languageFromExt(ext: string): string {
    const map: Record<string, string> = {
        '.ts': 'typescript', '.tsx': 'typescript',
        '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
        '.vue': 'vue', '.svelte': 'svelte',
        '.css': 'css', '.scss': 'scss', '.sass': 'sass', '.less': 'less', '.styl': 'stylus',
        '.py': 'python',
        '.cs': 'csharp',
        '.go': 'go',
        '.rs': 'rust',
        '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
        '.c': 'c',
        '.h': 'c', '.hpp': 'cpp', '.hxx': 'cpp',
        '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
        '.php': 'php',
        '.rb': 'ruby',
        '.swift': 'swift',
    };
    return map[ext] ?? 'unknown';
}
