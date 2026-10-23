import * as fs from 'fs';
import * as path from 'path';

const MOD_PREFIX = 'rust-mod:';
const USE_PREFIX = 'rust-use:';
const INCLUDE_PREFIX = 'rust-include:';

interface RustCrate {
    id: string;
    manifestDir: string;
    sourceDir: string;
    names: Set<string>;
    modules: Map<string, string>;
    rootFile: string | null;
}

interface RustFileInfo {
    crate: RustCrate;
    modulePath: string[];
}

/** Extract file-level Rust relationships without treating symbols as files. */
export function extractRustReferences(content: string): string[] {
    const code = stripRustComments(content);
    const results: string[] = [];
    const modRe = /(?:#\s*\[\s*path\s*=\s*"([^"]+)"\s*\]\s*)?(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gm;
    const useRe = /(?:^|\n)\s*(?:pub(?:\s*\([^)]*\))?\s+)?use\s+([^;]+);/g;
    const externRe = /(?:^|\n)\s*(?:pub\s+)?extern\s+crate\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?\s*;/g;
    const includeRe = /\binclude!\s*\(\s*"([^"]+)"\s*\)/g;

    let match: RegExpExecArray | null;
    while ((match = modRe.exec(code)) !== null) {
        results.push(`${MOD_PREFIX}${match[2]}:${match[1] ?? ''}`);
    }
    while ((match = useRe.exec(code)) !== null) {
        for (const usePath of expandUseTree(match[1])) {
            results.push(USE_PREFIX + usePath);
        }
    }
    while ((match = externRe.exec(code)) !== null) {
        results.push(USE_PREFIX + match[1]);
    }
    while ((match = includeRe.exec(code)) !== null) {
        results.push(INCLUDE_PREFIX + match[1]);
    }
    return [...new Set(results)];
}

/** Resolve Rust module and use paths to indexed source files. */
export class RustDependencyResolver {
    private readonly fileInfo = new Map<string, RustFileInfo>();
    private readonly crateNames = new Map<string, RustCrate>();
    private readonly crates: RustCrate[] = [];

    constructor(rustFiles: string[], workspaceRoots: string[]) {
        const files = rustFiles.map(file => path.resolve(file));
        const crateByManifest = new Map<string, RustCrate>();

        for (const file of files) {
            const manifest = findNearestManifest(file, workspaceRoots);
            const manifestDir = manifest ? path.dirname(manifest) : findWorkspaceRoot(file, workspaceRoots);
            const id = norm(manifest ?? manifestDir);
            let rustCrate = crateByManifest.get(id);
            if (!rustCrate) {
                const cargo = manifest ? readCargoIdentity(manifest) : { packageName: path.basename(manifestDir), libName: null };
                const names = new Set<string>();
                for (const name of [cargo.packageName, cargo.libName]) {
                    if (name) {
                        names.add(name);
                        names.add(name.replace(/-/g, '_'));
                    }
                }
                rustCrate = {
                    id,
                    manifestDir,
                    sourceDir: path.join(manifestDir, 'src'),
                    names,
                    modules: new Map(),
                    rootFile: null,
                };
                crateByManifest.set(id, rustCrate);
                this.crates.push(rustCrate);
            }
        }

        for (const rustCrate of this.crates) {
            for (const name of rustCrate.names) {
                this.crateNames.set(name, rustCrate);
            }
        }

        for (const file of files) {
            const manifest = findNearestManifest(file, workspaceRoots);
            const crateDir = manifest ? path.dirname(manifest) : findWorkspaceRoot(file, workspaceRoots);
            const rustCrate = crateByManifest.get(norm(manifest ?? crateDir));
            if (!rustCrate) { continue; }
            const modulePath = modulePathForFile(file, rustCrate.sourceDir);
            if (!modulePath) { continue; }
            const key = moduleKey(modulePath);
            const current = rustCrate.modules.get(key);
            if (!current || isPreferredModuleFile(file, current)) {
                rustCrate.modules.set(key, file);
            }
            if (modulePath.length === 0 && (!rustCrate.rootFile || path.basename(file) === 'lib.rs')) {
                rustCrate.rootFile = file;
            }
            this.fileInfo.set(norm(file), { crate: rustCrate, modulePath });
        }
    }

    get crateCount(): number {
        return this.crates.length;
    }

    resolve(reference: string, fromFile: string): string | null {
        const info = this.fileInfo.get(norm(fromFile));
        if (!info) { return null; }

        if (reference.startsWith(MOD_PREFIX)) {
            const value = reference.slice(MOD_PREFIX.length);
            const separator = value.indexOf(':');
            const name = separator >= 0 ? value.slice(0, separator) : value;
            const pathAttribute = separator >= 0 ? value.slice(separator + 1) : '';
            if (pathAttribute) {
                const candidate = path.resolve(path.dirname(fromFile), pathAttribute);
                return this.fileInfo.has(norm(candidate)) ? candidate : null;
            }
            return info.crate.modules.get(moduleKey([...info.modulePath, name])) ?? null;
        }

        if (reference.startsWith(INCLUDE_PREFIX)) {
            const candidate = path.resolve(path.dirname(fromFile), reference.slice(INCLUDE_PREFIX.length));
            return this.fileInfo.has(norm(candidate)) ? candidate : null;
        }

        if (!reference.startsWith(USE_PREFIX)) { return null; }
        const parts = reference.slice(USE_PREFIX.length).split('::').filter(Boolean);
        if (parts.length === 0) { return null; }

        let rustCrate = info.crate;
        let modulePath: string[];
        if (parts[0] === 'crate') {
            parts.shift();
            modulePath = [];
        } else if (parts[0] === 'self') {
            parts.shift();
            modulePath = [...info.modulePath];
        } else if (parts[0] === 'super') {
            modulePath = [...info.modulePath];
            while (parts[0] === 'super') {
                parts.shift();
                modulePath.pop();
            }
        } else {
            const external = this.crateNames.get(parts[0]);
            if (external && external !== info.crate) {
                rustCrate = external;
                parts.shift();
            }
            modulePath = [];
        }

        const candidatePath = [...modulePath, ...parts];
        for (let length = candidatePath.length; length >= modulePath.length; length--) {
            const candidate = rustCrate.modules.get(moduleKey(candidatePath.slice(0, length)));
            if (candidate) { return candidate; }
        }
        return rustCrate.rootFile;
    }
}

function expandUseTree(value: string): string[] {
    const expression = value.trim().replace(/^::/, '');
    const open = findTopLevelChar(expression, '{');
    if (open < 0) {
        const clean = expression.replace(/\s+as\s+[A-Za-z_][A-Za-z0-9_]*\s*$/, '').replace(/::\*$/, '').trim();
        return clean && clean !== 'self' ? [clean] : [];
    }
    const close = findMatchingBrace(expression, open);
    if (close < 0) { return []; }
    const base = expression.slice(0, open).replace(/::\s*$/, '').trim();
    const items = splitTopLevel(expression.slice(open + 1, close));
    const expanded: string[] = [];
    for (const item of items) {
        const trimmed = item.trim();
        if (!trimmed) { continue; }
        if (trimmed === 'self') {
            if (base) { expanded.push(base); }
            continue;
        }
        const combined = base ? `${base}::${trimmed}` : trimmed;
        expanded.push(...expandUseTree(combined));
    }
    return expanded;
}

function findTopLevelChar(value: string, wanted: string): number {
    let depth = 0;
    for (let index = 0; index < value.length; index++) {
        if (value[index] === wanted && depth === 0) { return index; }
        if (value[index] === '{') { depth++; }
        if (value[index] === '}') { depth--; }
    }
    return -1;
}

function findMatchingBrace(value: string, open: number): number {
    let depth = 0;
    for (let index = open; index < value.length; index++) {
        if (value[index] === '{') { depth++; }
        if (value[index] === '}' && --depth === 0) { return index; }
    }
    return -1;
}

function splitTopLevel(value: string): string[] {
    const results: string[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < value.length; index++) {
        if (value[index] === '{') { depth++; }
        if (value[index] === '}') { depth--; }
        if (value[index] === ',' && depth === 0) {
            results.push(value.slice(start, index));
            start = index + 1;
        }
    }
    results.push(value.slice(start));
    return results;
}

function stripRustComments(content: string): string {
    return content
        .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function modulePathForFile(file: string, sourceDir: string): string[] | null {
    const relative = path.relative(sourceDir, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { return null; }
    const parts = relative.split(path.sep);
    const name = parts.pop();
    if (!name) { return null; }
    if (name === 'lib.rs' || name === 'main.rs') { return []; }
    if (name === 'mod.rs') { return parts; }
    const stem = name.replace(/\.rs$/i, '');
    if (parts[0] === 'bin' && parts.length === 1) { return []; }
    return [...parts, stem];
}

function isPreferredModuleFile(candidate: string, current: string): boolean {
    const candidateName = path.basename(candidate);
    const currentName = path.basename(current);
    return candidateName === 'lib.rs' || (candidateName === 'main.rs' && currentName !== 'lib.rs');
}

function readCargoIdentity(manifest: string): { packageName: string; libName: string | null } {
    try {
        const content = fs.readFileSync(manifest, 'utf-8');
        const packageBlock = readTomlSection(content, 'package');
        const libBlock = readTomlSection(content, 'lib');
        const packageName = packageBlock.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? path.basename(path.dirname(manifest));
        const libName = libBlock.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? null;
        return { packageName, libName };
    } catch {
        return { packageName: path.basename(path.dirname(manifest)), libName: null };
    }
}

function readTomlSection(content: string, section: string): string {
    const header = new RegExp(`^\\s*\\[${section}\\]\\s*$`, 'm');
    const match = header.exec(content);
    if (!match) { return ''; }
    const remainder = content.slice(match.index + match[0].length);
    const nextSection = remainder.search(/^\s*\[/m);
    return nextSection >= 0 ? remainder.slice(0, nextSection) : remainder;
}

function findNearestManifest(file: string, workspaceRoots: string[]): string | null {
    let directory = path.dirname(file);
    const limits = workspaceRoots.map(root => path.resolve(root));
    while (true) {
        const candidate = path.join(directory, 'Cargo.toml');
        if (fs.existsSync(candidate)) { return candidate; }
        const parent = path.dirname(directory);
        if (parent === directory || limits.some(root => norm(root) === norm(directory))) { return null; }
        directory = parent;
    }
}

function findWorkspaceRoot(file: string, workspaceRoots: string[]): string {
    const resolved = path.resolve(file);
    return workspaceRoots
        .map(root => path.resolve(root))
        .filter(root => norm(resolved).startsWith(norm(root) + path.sep) || norm(resolved) === norm(root))
        .sort((left, right) => right.length - left.length)[0] ?? path.dirname(file);
}

function moduleKey(parts: string[]): string {
    return parts.join('::');
}

function norm(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
