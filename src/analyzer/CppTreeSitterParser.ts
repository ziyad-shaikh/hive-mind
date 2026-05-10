/**
 * Tree-sitter-backed C++ parser. Replaces the regex-based C++ include extraction
 * for .h/.hpp/.cpp/.cc/.cxx files. Handles:
 *   - multi-line, comment-embedded, and macro-pasted #include directives
 *   - the %{ ... %} prologue of bison/lex grammar files (extractGrammarPrologueIncludes)
 *
 * Tree-sitter init is async (loads WASM) but parsing afterwards is sync. The
 * analyzer calls `initCppParser()` once during its async `analyze()` setup, then
 * uses the sync `parseCppSync` / `extractIncludesSync` helpers throughout the
 * rest of the indexing run.
 */
import * as path from 'path';
import * as fs from 'fs';

type Parser = any;
type Tree = any;
type Language = any;

let parser: Parser | null = null;
let cppLanguage: Language | null = null;
let initPromise: Promise<void> | null = null;
let initFailedReason: string | null = null;

/**
 * One-time async setup. Safe to call repeatedly — only the first call does work.
 * On failure, sets `initFailedReason`; subsequent sync calls return empty results.
 */
export async function initCppParser(extensionRoot: string): Promise<void> {
    if (parser && cppLanguage) {
        return;
    }
    if (initFailedReason) {
        return;
    }
    if (initPromise) {
        return initPromise;
    }
    initPromise = (async () => {
        try {
            const TS: any = await import('web-tree-sitter');
            const Parser_ = TS.Parser ?? TS.default?.Parser;
            const Language_ = TS.Language ?? TS.default?.Language;
            if (!Parser_ || !Language_) {
                throw new Error('Parser/Language not exported');
            }

            const runtimeWasm = locateWasm(extensionRoot, 'web-tree-sitter/web-tree-sitter.wasm');
            const cppWasm = locateWasm(extensionRoot, 'tree-sitter-cpp/tree-sitter-cpp.wasm');

            await Parser_.init({ locateFile() { return runtimeWasm; } });
            parser = new Parser_();
            const langBytes = fs.readFileSync(cppWasm);
            cppLanguage = await Language_.load(langBytes);
            parser.setLanguage(cppLanguage);
        } catch (e) {
            initFailedReason = (e as Error).message ?? String(e);
            parser = null;
            cppLanguage = null;
        }
    })();
    return initPromise;
}

export function isCppParserReady(): boolean {
    return parser !== null && cppLanguage !== null;
}

export function getInitFailureReason(): string | null {
    return initFailedReason;
}

function locateWasm(extensionRoot: string, relPath: string): string {
    const candidates = [
        path.join(extensionRoot, 'node_modules', ...relPath.split('/')),
        path.join(extensionRoot, ...relPath.split('/')),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) {
            return c;
        }
    }
    throw new Error(`Cannot locate ${relPath} (tried ${candidates.join(', ')})`);
}

// ---------------------------------------------------------------------------

export interface CppParseResult {
    includes: string[];
    symbols: CppSymbol[];
}

export interface CppSymbol {
    name: string;
    kind: 'function' | 'class' | 'struct' | 'namespace' | 'enum' | 'typedef' | 'variable' | 'method' | 'macro';
    line: number;
    column: number;
}

/** Detailed parse result for the scope resolver. */
export interface CppDetailedResult {
    includes: string[];
    decls: CppDecl[];
    /** Functions with their bodies — used for call-hierarchy outgoing queries. */
    functions: CppFunctionInfo[];
}

export interface CppDecl {
    /** Simple name as declared. */
    name: string;
    /** Fully-qualified name with namespace + class scope (e.g. `foo::Bar::doFoo`). */
    qualifiedName: string;
    kind: 'function' | 'method' | 'class' | 'struct' | 'namespace' | 'enum' | 'typedef' | 'macro' | 'variable';
    line: number;
    column: number;
    /** For class/struct: list of base classes parsed from `: public X, public Y`. */
    baseClasses?: string[];
    /** For methods: present if `virtual` keyword observed. */
    isVirtual?: boolean;
    /** For methods: present if `override` specifier observed. */
    isOverride?: boolean;
    /** Number of parameters declared (rough — for overload disambiguation). */
    paramCount?: number;
}

export interface CppFunctionInfo {
    /** Fully-qualified name. */
    qualifiedName: string;
    /** Start line (1-based) of the function definition. */
    startLine: number;
    /** End line. */
    endLine: number;
    /** Names of every function/method called within the body, in source order. */
    callees: string[];
}

/**
 * Sync C++ parse. Returns an empty result if the parser failed to initialise.
 * Caller must have awaited `initCppParser` before depending on the output.
 */
export function parseCppSync(source: string): CppParseResult {
    if (!parser) {
        return { includes: [], symbols: [] };
    }
    let tree: Tree | null;
    try {
        tree = parser.parse(source);
    } catch {
        return { includes: [], symbols: [] };
    }
    if (!tree) {
        return { includes: [], symbols: [] };
    }
    const root = tree.rootNode;

    const includes: string[] = [];
    const symbols: CppSymbol[] = [];

    walk(root, (node: any) => {
        if (node.type === 'preproc_include') {
            const pathNode = node.childForFieldName('path');
            if (pathNode) {
                const raw: string = pathNode.text;
                if (raw.length >= 2) {
                    const inner = raw.slice(1, -1);
                    if (inner) {
                        // Preserve the legacy angle-include sentinel: bare name
                        // for quote includes, '<' prefix for angle includes.
                        // Downstream resolveImport relies on this distinction.
                        const isAngle = raw.startsWith('<');
                        includes.push(isAngle ? '<' + inner : inner);
                    }
                }
            }
        } else if (node.type === 'preproc_def' || node.type === 'preproc_function_def') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                symbols.push({
                    name: nameNode.text,
                    kind: 'macro',
                    line: nameNode.startPosition.row + 1,
                    column: nameNode.startPosition.column,
                });
            }
        } else if (node.type === 'function_definition') {
            const decl = node.childForFieldName('declarator');
            const name = decl ? extractDeclaratorName(decl) : null;
            if (name) {
                const isMethod = name.includes('::');
                symbols.push({
                    name,
                    kind: isMethod ? 'method' : 'function',
                    line: node.startPosition.row + 1,
                    column: node.startPosition.column,
                });
            }
            // Don't descend into bodies — saves time.
            return false;
        } else if (node.type === 'class_specifier' || node.type === 'struct_specifier' || node.type === 'union_specifier') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                symbols.push({
                    name: nameNode.text,
                    kind: node.type === 'class_specifier' ? 'class' : 'struct',
                    line: nameNode.startPosition.row + 1,
                    column: nameNode.startPosition.column,
                });
            }
        } else if (node.type === 'namespace_definition') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                symbols.push({
                    name: nameNode.text,
                    kind: 'namespace',
                    line: nameNode.startPosition.row + 1,
                    column: nameNode.startPosition.column,
                });
            }
        } else if (node.type === 'enum_specifier') {
            const nameNode = node.childForFieldName('name');
            if (nameNode) {
                symbols.push({
                    name: nameNode.text,
                    kind: 'enum',
                    line: nameNode.startPosition.row + 1,
                    column: nameNode.startPosition.column,
                });
            }
        }
        return true;
    });

    // Tree-sitter trees are heavy; release ASAP.
    try { tree.delete?.(); } catch { /* ignore */ }

    return { includes, symbols };
}

/**
 * Convenience wrapper that returns just the include list — the format
 * DependencyAnalyzer's existing pipeline expects.
 */
export function extractIncludesSync(source: string): string[] {
    return parseCppSync(source).includes;
}

/**
 * Detailed parse for the scope resolver. Returns includes, full declaration
 * list with scope/qualified names, and per-function call lists.
 *
 * This is heavier than `parseCppSync` — only invoke when the scope resolver
 * actually needs the data.
 */
export function parseCppDetailedSync(source: string): CppDetailedResult {
    if (!parser) {
        return { includes: [], decls: [], functions: [] };
    }
    let tree: Tree | null;
    try {
        tree = parser.parse(source);
    } catch {
        return { includes: [], decls: [], functions: [] };
    }
    if (!tree) {
        return { includes: [], decls: [], functions: [] };
    }

    const includes: string[] = [];
    const decls: CppDecl[] = [];
    const functions: CppFunctionInfo[] = [];

    type ScopeFrame = { kind: 'namespace' | 'class' | 'struct'; name: string };
    const scope: ScopeFrame[] = [];

    const qualify = (name: string): string => {
        if (scope.length === 0) {
            return name;
        }
        return scope.map(f => f.name).filter(Boolean).join('::') + '::' + name;
    };

    function visit(node: any): void {
        const t = node.type;

        if (t === 'preproc_include') {
            const pn = node.childForFieldName('path');
            if (pn) {
                const raw: string = pn.text;
                if (raw.length >= 2) {
                    const inner = raw.slice(1, -1);
                    if (inner) {
                        const isAngle = raw.startsWith('<');
                        includes.push(isAngle ? '<' + inner : inner);
                    }
                }
            }
            return;
        }

        if (t === 'preproc_def' || t === 'preproc_function_def') {
            const n = node.childForFieldName('name');
            if (n) {
                decls.push({
                    name: n.text,
                    qualifiedName: n.text,
                    kind: 'macro',
                    line: n.startPosition.row + 1,
                    column: n.startPosition.column,
                });
            }
            return;
        }

        if (t === 'namespace_definition') {
            const n = node.childForFieldName('name');
            const name = n ? n.text : '';
            if (n) {
                decls.push({
                    name,
                    qualifiedName: qualify(name),
                    kind: 'namespace',
                    line: n.startPosition.row + 1,
                    column: n.startPosition.column,
                });
            }
            scope.push({ kind: 'namespace', name });
            for (let i = 0; i < node.childCount; i++) { visit(node.child(i)); }
            scope.pop();
            return;
        }

        if (t === 'class_specifier' || t === 'struct_specifier') {
            const n = node.childForFieldName('name');
            const name = n ? n.text : '';
            const bases = extractBaseClasses(node);
            if (n) {
                decls.push({
                    name,
                    qualifiedName: qualify(name),
                    kind: t === 'class_specifier' ? 'class' : 'struct',
                    line: n.startPosition.row + 1,
                    column: n.startPosition.column,
                    baseClasses: bases.length > 0 ? bases : undefined,
                });
            }
            // Descend into the body so methods get their qualified names.
            scope.push({ kind: t === 'class_specifier' ? 'class' : 'struct', name });
            const body = node.childForFieldName('body');
            if (body) {
                for (let i = 0; i < body.childCount; i++) { visit(body.child(i)); }
            }
            scope.pop();
            return;
        }

        if (t === 'enum_specifier') {
            const n = node.childForFieldName('name');
            if (n) {
                decls.push({
                    name: n.text,
                    qualifiedName: qualify(n.text),
                    kind: 'enum',
                    line: n.startPosition.row + 1,
                    column: n.startPosition.column,
                });
            }
            return;
        }

        if (t === 'function_definition' || t === 'declaration') {
            const decl = node.childForFieldName('declarator');
            if (!decl) {
                for (let i = 0; i < node.childCount; i++) { visit(node.child(i)); }
                return;
            }
            const name = extractDeclaratorName(decl);
            const isFunctionLike = decl.type === 'function_declarator' ||
                                   findDescendant(decl, 'function_declarator') !== null;
            if (name && isFunctionLike) {
                const inClass = scope.length > 0 && (scope[scope.length - 1].kind === 'class' || scope[scope.length - 1].kind === 'struct');
                const isMember = inClass || name.includes('::');
                const flags = extractFunctionFlags(node);
                const paramCount = countFunctionParams(decl);
                const qn = name.includes('::') ? name : qualify(name);
                decls.push({
                    name: name.replace(/.*::/, ''),
                    qualifiedName: qn,
                    kind: isMember ? 'method' : 'function',
                    line: node.startPosition.row + 1,
                    column: node.startPosition.column,
                    isVirtual: flags.virtual || undefined,
                    isOverride: flags.override || undefined,
                    paramCount,
                });
                if (t === 'function_definition') {
                    const body = node.childForFieldName('body');
                    if (body) {
                        functions.push({
                            qualifiedName: qn,
                            startLine: node.startPosition.row + 1,
                            endLine: node.endPosition.row + 1,
                            callees: extractCallees(body),
                        });
                    }
                }
            }
            // Function bodies have their own scope; we don't descend further
            // (callees are already extracted, and we don't want local variables
            // in our top-level decl list).
            return;
        }

        // For everything else, just recurse so nested namespaces/classes are caught.
        for (let i = 0; i < node.childCount; i++) {
            visit(node.child(i));
        }
    }

    visit(tree.rootNode);
    try { tree.delete?.(); } catch { /* ignore */ }

    return { includes, decls, functions };
}

function findDescendant(node: any, type: string, depth = 0): any | null {
    if (depth > 8) { return null; }
    if (node.type === type) { return node; }
    for (let i = 0; i < node.childCount; i++) {
        const r = findDescendant(node.child(i), type, depth + 1);
        if (r) { return r; }
    }
    return null;
}

function extractBaseClasses(classNode: any): string[] {
    // tree-sitter-cpp wraps the inheritance list in a `base_class_clause` node.
    const baseClause = findDescendant(classNode, 'base_class_clause', 4);
    if (!baseClause) { return []; }
    const out: string[] = [];
    for (let i = 0; i < baseClause.childCount; i++) {
        const c = baseClause.child(i);
        // The actual type name appears as type_identifier or qualified_identifier.
        if (c.type === 'type_identifier' || c.type === 'qualified_identifier') {
            out.push(c.text);
        } else {
            // Drill in to find the type name (skipping access specifiers, commas).
            const nested = findDescendant(c, 'type_identifier', 3) ??
                           findDescendant(c, 'qualified_identifier', 3);
            if (nested) {
                out.push(nested.text);
            }
        }
    }
    return out;
}

function extractFunctionFlags(node: any): { virtual: boolean; override: boolean } {
    let isVirtual = false;
    let isOverride = false;
    // Walk only the immediate vicinity — not the body.
    for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        const text = c.text;
        if (c.type === 'virtual' || /\bvirtual\b/.test(text)) {
            isVirtual = true;
        }
        if (c.type === 'virtual_specifier') {
            if (/\boverride\b/.test(text)) { isOverride = true; }
        }
    }
    // Also check the declarator subtree for `override` (some grammars place it
    // inside the function_declarator).
    const decl = node.childForFieldName?.('declarator');
    if (decl) {
        for (let i = 0; i < decl.childCount; i++) {
            const c = decl.child(i);
            if (c.type === 'virtual_specifier' && /\boverride\b/.test(c.text)) {
                isOverride = true;
            }
        }
    }
    return { virtual: isVirtual, override: isOverride };
}

function countFunctionParams(declarator: any): number {
    const fnDecl = declarator.type === 'function_declarator'
        ? declarator
        : findDescendant(declarator, 'function_declarator', 4);
    if (!fnDecl) { return 0; }
    const params = fnDecl.childForFieldName?.('parameters');
    if (!params) { return 0; }
    let n = 0;
    for (let i = 0; i < params.childCount; i++) {
        const c = params.child(i);
        if (c.type === 'parameter_declaration' || c.type === 'optional_parameter_declaration' ||
            c.type === 'variadic_parameter_declaration') {
            n++;
        }
    }
    return n;
}

function extractCallees(body: any): string[] {
    const callees: string[] = [];
    function walk2(n: any, depth: number): void {
        if (depth > 60) { return; }
        if (n.type === 'call_expression') {
            const fn = n.childForFieldName('function');
            if (fn) {
                let nameNode = fn;
                // If the called expression is field access (`obj.foo()`), grab field name.
                if (fn.type === 'field_expression') {
                    const f = fn.childForFieldName('field');
                    if (f) { nameNode = f; }
                } else if (fn.type === 'qualified_identifier') {
                    nameNode = fn;
                }
                callees.push(nameNode.text);
            }
        }
        for (let i = 0; i < n.childCount; i++) {
            walk2(n.child(i), depth + 1);
        }
    }
    walk2(body, 0);
    return callees;
}

/**
 * Extract `#include` directives from the `%{ ... %}` prologue blocks of
 * bison/lex/x grammar files. Multiple prologue blocks are concatenated and
 * parsed as a single C++ fragment.
 */
export function extractGrammarPrologueIncludesSync(source: string): string[] {
    const re = /%\{([\s\S]*?)%\}/g;
    const fragments: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
        fragments.push(m[1]);
    }
    if (fragments.length === 0) {
        return [];
    }
    return parseCppSync(fragments.join('\n')).includes;
}

// ---------------------------------------------------------------------------

function walk(node: any, visit: (n: any) => boolean): void {
    const recurse = visit(node);
    if (recurse === false) {
        return;
    }
    for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i), visit);
    }
}

function extractDeclaratorName(node: any): string | null {
    let cur = node;
    for (let i = 0; i < 8 && cur; i++) {
        if (cur.type === 'identifier' || cur.type === 'field_identifier' ||
            cur.type === 'qualified_identifier' || cur.type === 'destructor_name' ||
            cur.type === 'operator_name') {
            return cur.text;
        }
        const inner = cur.childForFieldName?.('declarator');
        if (inner) {
            cur = inner;
            continue;
        }
        for (let j = 0; j < cur.childCount; j++) {
            const c = cur.child(j);
            if (c && (c.type === 'identifier' || c.type === 'qualified_identifier' || c.type === 'field_identifier')) {
                return c.text;
            }
        }
        break;
    }
    return null;
}
