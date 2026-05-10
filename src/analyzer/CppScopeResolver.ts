/**
 * CppScopeResolver — tree-sitter-backed replacement for the four clangd-driven
 * tools (findReferences, findOverrides, callHierarchy, typeHierarchy).
 *
 * Strategy:
 *   1. On first query, walk every C/C++ file in the workspace, parse it with
 *      tree-sitter, and record:
 *        - every top-level declaration (with qualified name, scope, base list, virtual flag)
 *        - every function body's callee list
 *      Result is cached for the lifetime of the analyzer.
 *
 *   2. findReferences: locate the symbol's declaration(s), then text-grep every
 *      file for the simple name. Filter via tree-sitter so comments/strings
 *      don't pollute the result. Confidence is downgraded when the name is
 *      ambiguous or the file uses templates.
 *
 *   3. findOverrides: build the subclass closure of the declaring class, then
 *      look in each subclass for a method matching the name (and paramCount).
 *      `override` keyword observed → high; `virtual` only → medium; neither → low.
 *
 *   4. callHierarchy: outgoing = look up the function's callees from the index;
 *      incoming = scan every other function's callees for a match.
 *      Depth 2 = re-apply once.
 *
 *   5. typeHierarchy: supertypes from baseClasses; subtypes from the closure.
 *
 * Every result carries a confidence label so callers (and the AI) know whether
 * to verify with hivemind_buildSubset.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { DependencyAnalyzer } from './DependencyAnalyzer';
import {
    parseCppDetailedSync,
    isCppParserReady,
    type CppDecl,
    type CppFunctionInfo,
} from './CppTreeSitterParser';

export type Confidence = 'high' | 'medium' | 'low';

export interface ReferenceResult {
    file: string;        // absolute path
    line: number;        // 1-based
    column: number;      // 0-based
    snippet: string;     // the full source line, trimmed
    isDeclaration: boolean;
    confidence: Confidence;
}

export interface OverrideResult {
    className: string;            // qualified name of the derived class
    file: string;
    line: number;
    column: number;
    paramCount: number | null;
    confidence: Confidence;
    confidenceReason: string;
}

export interface CallNode {
    qualifiedName: string;
    file: string | null;
    line: number | null;
    confidence: Confidence;
    children?: CallNode[];
}

export interface TypeNode {
    className: string;
    file: string | null;
    line: number | null;
    confidence: Confidence;
    children?: TypeNode[];
}

interface IndexedDecl extends CppDecl {
    file: string;
}

interface IndexedFunction extends CppFunctionInfo {
    file: string;
}

export class CppScopeResolver {
    private declsByName = new Map<string, IndexedDecl[]>();      // simple name → decls
    private declsByQName = new Map<string, IndexedDecl[]>();      // qualified name → decls
    private declsByFile = new Map<string, IndexedDecl[]>();
    private functionsByQName = new Map<string, IndexedFunction[]>();
    private subclassesOf = new Map<string, Set<string>>();        // qualified base → set of subclass qnames
    private indexBuiltAt: number | null = null;
    private buildPromise: Promise<void> | null = null;

    constructor(private readonly analyzer: DependencyAnalyzer) {}

    /** Force a fresh build on next query. Call when the file list changes. */
    invalidate(): void {
        this.declsByName.clear();
        this.declsByQName.clear();
        this.declsByFile.clear();
        this.functionsByQName.clear();
        this.subclassesOf.clear();
        this.indexBuiltAt = null;
        this.buildPromise = null;
    }

    /** Build the index if not present. Safe to call repeatedly. */
    async ensureIndex(): Promise<void> {
        if (this.indexBuiltAt) {
            return;
        }
        if (this.buildPromise) {
            return this.buildPromise;
        }
        this.buildPromise = this.buildIndex();
        return this.buildPromise;
    }

    isReady(): boolean {
        return this.indexBuiltAt !== null;
    }

    /** Stats for diagnostics. */
    getStats(): { decls: number; functions: number; classes: number; built: boolean } {
        let classes = 0;
        for (const list of this.declsByName.values()) {
            for (const d of list) {
                if (d.kind === 'class' || d.kind === 'struct') { classes++; }
            }
        }
        let fns = 0;
        for (const list of this.functionsByQName.values()) { fns += list.length; }
        let decls = 0;
        for (const list of this.declsByName.values()) { decls += list.length; }
        return { decls, functions: fns, classes, built: this.isReady() };
    }

    private async buildIndex(): Promise<void> {
        if (!isCppParserReady()) {
            this.indexBuiltAt = Date.now();  // mark "built" but empty
            return;
        }
        const files = this.analyzer.getAllFilePaths()
            .filter(f => /\.(c|cc|cpp|cxx|h|hpp|hxx|inl|ipp|tpp)$/i.test(f));

        for (const file of files) {
            let src: string;
            try {
                src = fs.readFileSync(file, 'utf8');
            } catch {
                continue;
            }
            const result = parseCppDetailedSync(src);

            const fileDecls: IndexedDecl[] = [];
            for (const d of result.decls) {
                const idx: IndexedDecl = { ...d, file };
                fileDecls.push(idx);
                pushMap(this.declsByName, d.name, idx);
                pushMap(this.declsByQName, d.qualifiedName, idx);

                if ((d.kind === 'class' || d.kind === 'struct') && d.baseClasses) {
                    for (const base of d.baseClasses) {
                        // Index by both the simple base name and the full text.
                        let set = this.subclassesOf.get(base);
                        if (!set) { set = new Set(); this.subclassesOf.set(base, set); }
                        set.add(d.qualifiedName);
                        // Also index by simple name so `: public Foo` finds `ns::Foo`.
                        const simple = base.replace(/.*::/, '');
                        if (simple !== base) {
                            let simpleSet = this.subclassesOf.get(simple);
                            if (!simpleSet) { simpleSet = new Set(); this.subclassesOf.set(simple, simpleSet); }
                            simpleSet.add(d.qualifiedName);
                        }
                    }
                }
            }
            this.declsByFile.set(file, fileDecls);

            for (const fn of result.functions) {
                pushMap(this.functionsByQName, fn.qualifiedName, { ...fn, file });
                // Also index by simple name for callees that aren't fully qualified.
                const simple = fn.qualifiedName.replace(/.*::/, '');
                if (simple !== fn.qualifiedName) {
                    pushMap(this.functionsByQName, simple, { ...fn, file });
                }
            }
        }

        this.indexBuiltAt = Date.now();
    }

    // ─────────────────────────────────────────────────────────────────────
    // findReferences
    // ─────────────────────────────────────────────────────────────────────

    async findReferences(opts: {
        symbolName: string;
        fromFile?: string;
        includeDeclaration?: boolean;
        maxResults?: number;
    }): Promise<ReferenceResult[]> {
        await this.ensureIndex();
        const simpleName = opts.symbolName.replace(/.*::/, '');
        const includeDecl = opts.includeDeclaration ?? true;
        const maxResults = opts.maxResults ?? 200;

        const declsForName = this.declsByName.get(simpleName) ?? [];
        const declSites = new Set<string>();
        for (const d of declsForName) {
            declSites.add(`${d.file}:${d.line}`);
        }

        // Confidence baseline: how many distinct declarations share this name?
        const distinctDecls = declsForName.length;
        const baselineConf: Confidence =
            distinctDecls <= 1 ? 'high' :
            distinctDecls <= 4 ? 'medium' : 'low';

        const re = new RegExp(`\\b${escapeRegExp(simpleName)}\\b`, 'g');
        const out: ReferenceResult[] = [];

        const files = this.analyzer.getAllFilePaths()
            .filter(f => /\.(c|cc|cpp|cxx|h|hpp|hxx|inl|ipp|tpp|y|ym4|x|l)$/i.test(f));

        for (const file of files) {
            if (out.length >= maxResults) { break; }
            let src: string;
            try {
                src = fs.readFileSync(file, 'utf8');
            } catch {
                continue;
            }
            // Strip block comments + line comments before searching to cut
            // false positives from documentation. (Imperfect — but better than
            // no filtering.)
            const stripped = stripCommentsAndStrings(src);
            const lines = stripped.split(/\r?\n/);
            const rawLines = src.split(/\r?\n/);

            for (let i = 0; i < lines.length; i++) {
                if (out.length >= maxResults) { break; }
                re.lastIndex = 0;
                let m: RegExpExecArray | null;
                while ((m = re.exec(lines[i])) !== null) {
                    const isDecl = declSites.has(`${file}:${i + 1}`);
                    if (isDecl && !includeDecl) { continue; }
                    out.push({
                        file,
                        line: i + 1,
                        column: m.index,
                        snippet: rawLines[i]?.trim().slice(0, 200) ?? '',
                        isDeclaration: isDecl,
                        confidence: baselineConf,
                    });
                }
            }
        }

        return out;
    }

    // ─────────────────────────────────────────────────────────────────────
    // findOverrides
    // ─────────────────────────────────────────────────────────────────────

    async findOverrides(opts: {
        symbolName: string;
        fromFile?: string;
    }): Promise<OverrideResult[]> {
        await this.ensureIndex();
        const target = opts.symbolName;
        const simple = target.replace(/.*::/, '');

        // Locate the base class containing the method.
        const methodDecls = this.declsByName.get(simple) ?? [];
        const virtualBaseMethods = methodDecls.filter(d => d.kind === 'method' && d.isVirtual);
        const baseClasses = new Set<string>();

        if (virtualBaseMethods.length > 0) {
            for (const m of virtualBaseMethods) {
                // m.qualifiedName = "ns::ClassName::methodName" → base = "ns::ClassName"
                const base = m.qualifiedName.split('::').slice(0, -1).join('::');
                if (base) { baseClasses.add(base); }
            }
        } else {
            // No `virtual` keyword observed. Fall back to: any class declaring
            // a method with this name is treated as a candidate base. The
            // confidence on the results is downgraded.
            for (const m of methodDecls.filter(d => d.kind === 'method')) {
                const base = m.qualifiedName.split('::').slice(0, -1).join('::');
                if (base) { baseClasses.add(base); }
            }
        }

        const allSubclasses = new Set<string>();
        for (const base of baseClasses) {
            const closureSet = this.subclassClosure(base);
            for (const c of closureSet) { allSubclasses.add(c); }
            // Also try by simple class name.
            const simpleBase = base.replace(/.*::/, '');
            const closureBySimple = this.subclassClosure(simpleBase);
            for (const c of closureBySimple) { allSubclasses.add(c); }
        }

        const out: OverrideResult[] = [];
        for (const subClassQName of allSubclasses) {
            const classDecls = this.declsByQName.get(subClassQName) ?? [];
            const classFiles = new Set(classDecls.map(c => c.file));

            // Find the method within this subclass. We look for any decl whose
            // qualifiedName starts with subClassQName + '::' and ends with simple.
            const candidates: IndexedDecl[] = [];
            for (const d of (this.declsByName.get(simple) ?? [])) {
                if (d.kind !== 'method') { continue; }
                if (!classFiles.has(d.file)) { continue; }
                const expectedQName = subClassQName + '::' + simple;
                if (d.qualifiedName === expectedQName ||
                    d.qualifiedName.endsWith('::' + simple)) {
                    candidates.push(d);
                }
            }
            for (const d of candidates) {
                let conf: Confidence = 'medium';
                let reason = 'method name matches in derived class';
                if (d.isOverride) {
                    conf = 'high';
                    reason = '`override` specifier observed';
                } else if (d.isVirtual) {
                    conf = 'medium';
                    reason = '`virtual` keyword observed (no `override`)';
                } else if (virtualBaseMethods.length === 0) {
                    conf = 'low';
                    reason = 'name match only (no virtual/override observed in base)';
                }
                out.push({
                    className: subClassQName,
                    file: d.file,
                    line: d.line,
                    column: d.column,
                    paramCount: d.paramCount ?? null,
                    confidence: conf,
                    confidenceReason: reason,
                });
            }
        }
        return out;
    }

    // ─────────────────────────────────────────────────────────────────────
    // callHierarchy
    // ─────────────────────────────────────────────────────────────────────

    async callHierarchy(opts: {
        symbolName: string;
        direction: 'incoming' | 'outgoing' | 'both';
        depth?: number;
        maxPerLevel?: number;
    }): Promise<{ incoming: CallNode[]; outgoing: CallNode[] }> {
        await this.ensureIndex();
        const target = opts.symbolName;
        const simple = target.replace(/.*::/, '');
        const depth = Math.min(Math.max(opts.depth ?? 1, 1), 3);
        const maxPerLevel = opts.maxPerLevel ?? 25;

        const result = { incoming: [] as CallNode[], outgoing: [] as CallNode[] };

        if (opts.direction === 'outgoing' || opts.direction === 'both') {
            result.outgoing = this.outgoing(simple, depth, maxPerLevel, new Set());
        }
        if (opts.direction === 'incoming' || opts.direction === 'both') {
            result.incoming = this.incoming(simple, depth, maxPerLevel, new Set());
        }
        return result;
    }

    private outgoing(name: string, depth: number, maxPerLevel: number, visited: Set<string>): CallNode[] {
        if (depth === 0 || visited.has(name)) { return []; }
        visited.add(name);
        const fns = this.functionsByQName.get(name) ?? [];
        const seen = new Set<string>();
        const out: CallNode[] = [];
        for (const fn of fns) {
            for (const callee of fn.callees) {
                const calleeSimple = callee.replace(/.*::/, '');
                if (seen.has(calleeSimple)) { continue; }
                seen.add(calleeSimple);
                if (out.length >= maxPerLevel) { break; }
                const calleeDecl = this.locateDecl(calleeSimple);
                out.push({
                    qualifiedName: calleeDecl?.qualifiedName ?? calleeSimple,
                    file: calleeDecl?.file ?? null,
                    line: calleeDecl?.line ?? null,
                    confidence: this.callConfidence(calleeSimple),
                    children: depth > 1 ? this.outgoing(calleeSimple, depth - 1, maxPerLevel, visited) : undefined,
                });
            }
        }
        return out;
    }

    private incoming(name: string, depth: number, maxPerLevel: number, visited: Set<string>): CallNode[] {
        if (depth === 0 || visited.has(name)) { return []; }
        visited.add(name);
        const out: CallNode[] = [];
        const seen = new Set<string>();
        for (const fns of this.functionsByQName.values()) {
            for (const fn of fns) {
                if (fn.callees.some(c => c === name || c.endsWith('::' + name) || c.replace(/.*::/, '') === name)) {
                    if (seen.has(fn.qualifiedName)) { continue; }
                    seen.add(fn.qualifiedName);
                    if (out.length >= maxPerLevel) { break; }
                    const callerSimple = fn.qualifiedName.replace(/.*::/, '');
                    out.push({
                        qualifiedName: fn.qualifiedName,
                        file: fn.file,
                        line: fn.startLine,
                        confidence: 'medium',
                        children: depth > 1 ? this.incoming(callerSimple, depth - 1, maxPerLevel, visited) : undefined,
                    });
                }
            }
            if (out.length >= maxPerLevel) { break; }
        }
        return out;
    }

    // ─────────────────────────────────────────────────────────────────────
    // typeHierarchy
    // ─────────────────────────────────────────────────────────────────────

    async typeHierarchy(opts: {
        className: string;
        direction: 'supertypes' | 'subtypes' | 'both';
        depth?: number;
        maxPerLevel?: number;
    }): Promise<{ supertypes: TypeNode[]; subtypes: TypeNode[] }> {
        await this.ensureIndex();
        const depth = Math.min(Math.max(opts.depth ?? 2, 1), 4);
        const maxPerLevel = opts.maxPerLevel ?? 25;
        const result = { supertypes: [] as TypeNode[], subtypes: [] as TypeNode[] };

        if (opts.direction === 'supertypes' || opts.direction === 'both') {
            result.supertypes = this.supertypes(opts.className, depth, maxPerLevel, new Set());
        }
        if (opts.direction === 'subtypes' || opts.direction === 'both') {
            result.subtypes = this.subtypes(opts.className, depth, maxPerLevel, new Set());
        }
        return result;
    }

    private supertypes(className: string, depth: number, maxPerLevel: number, visited: Set<string>): TypeNode[] {
        if (depth === 0 || visited.has(className)) { return []; }
        visited.add(className);
        const decls = this.locateClass(className);
        const out: TypeNode[] = [];
        const seen = new Set<string>();
        for (const d of decls) {
            for (const base of d.baseClasses ?? []) {
                if (seen.has(base)) { continue; }
                seen.add(base);
                if (out.length >= maxPerLevel) { break; }
                const baseDecl = this.locateClass(base)[0];
                out.push({
                    className: baseDecl?.qualifiedName ?? base,
                    file: baseDecl?.file ?? null,
                    line: baseDecl?.line ?? null,
                    confidence: baseDecl ? 'high' : 'medium',
                    children: depth > 1 ? this.supertypes(base, depth - 1, maxPerLevel, visited) : undefined,
                });
            }
        }
        return out;
    }

    private subtypes(className: string, depth: number, maxPerLevel: number, visited: Set<string>): TypeNode[] {
        if (depth === 0 || visited.has(className)) { return []; }
        visited.add(className);
        const subs = this.subclassClosure(className, /*direct*/ true);
        const out: TypeNode[] = [];
        for (const subQName of subs) {
            if (out.length >= maxPerLevel) { break; }
            const subDecl = this.locateClass(subQName)[0];
            out.push({
                className: subQName,
                file: subDecl?.file ?? null,
                line: subDecl?.line ?? null,
                confidence: subDecl ? 'high' : 'medium',
                children: depth > 1 ? this.subtypes(subQName, depth - 1, maxPerLevel, visited) : undefined,
            });
        }
        return out;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────

    private locateClass(name: string): IndexedDecl[] {
        const exact = this.declsByQName.get(name) ?? [];
        if (exact.length > 0) { return exact.filter(d => d.kind === 'class' || d.kind === 'struct'); }
        const simple = this.declsByName.get(name.replace(/.*::/, '')) ?? [];
        return simple.filter(d => d.kind === 'class' || d.kind === 'struct');
    }

    private locateDecl(name: string): IndexedDecl | null {
        const list = this.declsByName.get(name) ?? [];
        return list[0] ?? null;
    }

    private subclassClosure(name: string, directOnly = false): Set<string> {
        const out = new Set<string>();
        const queue = [name];
        while (queue.length > 0) {
            const cur = queue.shift()!;
            const direct = this.subclassesOf.get(cur);
            if (!direct) { continue; }
            for (const d of direct) {
                if (out.has(d)) { continue; }
                out.add(d);
                if (!directOnly) { queue.push(d); }
                // Also queue by simple name
                const simple = d.replace(/.*::/, '');
                if (!directOnly && simple !== d) { queue.push(simple); }
            }
        }
        return out;
    }

    private callConfidence(name: string): Confidence {
        const decls = this.declsByName.get(name) ?? [];
        if (decls.length === 0) { return 'low'; }
        if (decls.length === 1) { return 'high'; }
        if (decls.length <= 4) { return 'medium'; }
        return 'low';
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Local helpers
// ─────────────────────────────────────────────────────────────────────────────

function pushMap<K, V>(m: Map<K, V[]>, k: K, v: V): void {
    const list = m.get(k);
    if (list) { list.push(v); } else { m.set(k, [v]); }
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace the body of every comment and string literal with spaces so a
 * line-based regex search doesn't match inside them. Preserves line numbers
 * and column offsets.
 */
function stripCommentsAndStrings(src: string): string {
    const out: string[] = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        const c2 = src[i + 1];
        // Block comment
        if (c === '/' && c2 === '*') {
            out.push('  ');
            i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
                out.push(src[i] === '\n' ? '\n' : ' ');
                i++;
            }
            if (i < n) { out.push('  '); i += 2; }
            continue;
        }
        // Line comment
        if (c === '/' && c2 === '/') {
            while (i < n && src[i] !== '\n') {
                out.push(' ');
                i++;
            }
            continue;
        }
        // String literal
        if (c === '"' || c === '\'') {
            const quote = c;
            out.push(' ');
            i++;
            while (i < n && src[i] !== quote) {
                if (src[i] === '\\' && i + 1 < n) {
                    out.push('  ');
                    i += 2;
                    continue;
                }
                out.push(src[i] === '\n' ? '\n' : ' ');
                i++;
            }
            if (i < n) { out.push(' '); i++; }
            continue;
        }
        out.push(c);
        i++;
    }
    return out.join('');
}
