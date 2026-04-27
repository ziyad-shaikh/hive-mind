// =============================================================================
// CppPreprocessor — strips dead `#if`/`#ifdef` branches from C/C++ source.
// =============================================================================
//
// The dependency graph treats every `#include` line as a real edge. That's
// wrong for any non-trivial C/C++ codebase: a file that contains
//
//   #ifdef _WIN32
//     #include "win/sock.h"
//   #else
//     #include "posix/sock.h"
//   #endif
//
// has exactly ONE real dependency for any given build, not two. Without this
// module:
//   • The graph reports inflated dependency counts (impact analysis lies).
//   • Cycles pop up that don't exist in any real build.
//   • Many "duplicate basename" picks in the header index resolve to the
//     wrong file (e.g., a Linux-only header in a Windows-only TU).
//
// What this module does:
//   1. Walks the file linewise.
//   2. Maintains a stack of branch states for `#if`/`#ifdef`/`#else`/`#endif`.
//   3. Evaluates branch conditions using:
//        • `defines` — the macro set known to be defined for this TU
//          (typically -D flags from compile_commands.json).
//        • A small expression evaluator covering `defined()`, logical ops,
//          comparisons, and integer literals.
//   4. Returns only `#include` lines that lie in an active branch.
//
// What this module does NOT do:
//   • Macro expansion. `#if FOO` where FOO is `(BAR + 1)` and BAR is itself a
//     macro... we resolve FOO to its define value, but we don't recursively
//     expand macros that appear inside *other* `#if` expressions. This is good
//     enough for ~95% of real-world `#if` patterns. For exact answers, use
//     `hivemind_macroExpand`.
//   • `#define`/`#undef` *within* the file. We assume the input `defines` set
//     is the entire universe. (A previous `#define FOO 1` in the same file
//     does NOT enable a later `#ifdef FOO`.) Doing this properly requires a
//     full preprocessor; that's `hivemind_macroExpand`'s job.
//   • Computed includes (`#include MACRO(...)`). Skipped silently.
//
// Conservative default: when an expression can't be evaluated (unknown
// identifier in arithmetic context, function-like macro, etc.), we treat the
// branch as ACTIVE. We'd rather over-report edges than miss real ones.
// =============================================================================

export interface ActiveIncludeResult {
    /** Include directives in active branches. Quote includes are bare ('foo.h'); angle includes are prefixed ('<foo.h'). */
    includes: string[];
    /** Number of #include directives that were dropped because they sat in dead branches. For diagnostics. */
    droppedCount: number;
    /** Number of branch decisions where the expression couldn't be resolved (we kept the branch active). */
    ambiguousCount: number;
}

/**
 * Extract the include directives from `content` that lie in branches active
 * for the given `defines` set.
 *
 * Output shape matches the legacy C/C++ parser:
 *   `#include "foo.h"`  →  `'foo.h'`
 *   `#include <bar.h>`  →  `'<bar.h'`
 *   (Yes — the leading `<` with no closing `>` is the legacy sentinel for
 *   "angle-bracket include". We preserve it for compatibility.)
 */
export function extractActiveCppIncludes(content: string, defines: ReadonlySet<string>): ActiveIncludeResult {
    const includes: string[] = [];
    let droppedCount = 0;
    let ambiguousCount = 0;

    // Branch stack. Each frame = state of one #if/#ifdef block.
    //   active       : are we currently emitting includes from this branch?
    //   anyTaken     : has any branch (#if/#elif) of this chain been taken?
    //                  (controls what #elif can do)
    //   parentActive : was the enclosing block active? (a nested block in a
    //                  dead parent stays dead regardless of its own condition)
    interface Frame { active: boolean; anyTaken: boolean; parentActive: boolean; }
    const stack: Frame[] = [];

    const isActive = () => stack.length === 0 || stack.every(f => f.active);

    // Strip block comments to make line-level scanning safe. We don't need to
    // be hyper-correct here (string literals, line continuations, etc.) — we
    // just need not to confuse `#include` lines.
    const stripped = stripBlockComments(content);
    const lines = stripped.split(/\r?\n/);

    // Combine line continuations: `#if FOO \\\n    && BAR` → one logical line.
    const logicalLines = combineContinuations(lines);

    for (const line of logicalLines) {
        const trimmed = line.replace(/^\s+/, '');
        if (!trimmed.startsWith('#')) {
            // Not a preprocessor directive — irrelevant to branch tracking.
            continue;
        }

        // Strip line comment from the end of the directive.
        const noComment = trimmed.replace(/\/\/.*$/, '').trimEnd();
        // Tokens: drop the leading '#' and split.
        const directiveMatch = /^#\s*(\w+)\s*(.*)$/.exec(noComment);
        if (!directiveMatch) { continue; }
        const directive = directiveMatch[1];
        const rest = directiveMatch[2];

        switch (directive) {
            case 'if': {
                const parentActive = isActive();
                const evalResult = evaluateExpression(rest, defines);
                const taken = parentActive && evalResult.value === true;
                if (evalResult.ambiguous) { ambiguousCount++; }
                stack.push({ active: taken || (parentActive && evalResult.ambiguous), anyTaken: taken, parentActive });
                break;
            }
            case 'ifdef': {
                const parentActive = isActive();
                const name = rest.trim().split(/\s/)[0];
                const taken = parentActive && defines.has(name);
                stack.push({ active: taken, anyTaken: taken, parentActive });
                break;
            }
            case 'ifndef': {
                const parentActive = isActive();
                const name = rest.trim().split(/\s/)[0];
                const taken = parentActive && !defines.has(name);
                stack.push({ active: taken, anyTaken: taken, parentActive });
                break;
            }
            case 'elif': {
                const top = stack[stack.length - 1];
                if (!top) { break; } // malformed
                if (top.anyTaken || !top.parentActive) {
                    top.active = false;
                } else {
                    const evalResult = evaluateExpression(rest, defines);
                    if (evalResult.ambiguous) { ambiguousCount++; }
                    if (evalResult.value === true) {
                        top.active = true; top.anyTaken = true;
                    } else if (evalResult.ambiguous) {
                        top.active = true;          // conservative
                    } else {
                        top.active = false;
                    }
                }
                break;
            }
            case 'else': {
                const top = stack[stack.length - 1];
                if (!top) { break; }
                top.active = top.parentActive && !top.anyTaken;
                if (top.active) { top.anyTaken = true; }
                break;
            }
            case 'endif': {
                stack.pop();
                break;
            }
            case 'include': {
                if (!isActive()) {
                    droppedCount++;
                    break;
                }
                const inc = parseIncludeArgument(rest);
                if (inc) { includes.push(inc); }
                break;
            }
            // We deliberately ignore #define/#undef within the file. See header notes.
        }
    }

    return { includes, droppedCount, ambiguousCount };
}

// -----------------------------------------------------------------------------
// Helpers — tokenisation
// -----------------------------------------------------------------------------

/** Replace `/* ... *\/` regions with spaces of equivalent length so line numbers stay aligned. */
function stripBlockComments(src: string): string {
    let out = '';
    let i = 0;
    let inString: string | null = null;
    while (i < src.length) {
        const ch = src[i];
        const next = src[i + 1];
        if (inString) {
            out += ch;
            if (ch === '\\' && i + 1 < src.length) {
                out += src[i + 1]; i += 2; continue;
            }
            if (ch === inString) { inString = null; }
            i++;
            continue;
        }
        if (ch === '"' || ch === "'") { inString = ch; out += ch; i++; continue; }
        if (ch === '/' && next === '*') {
            // Replace until */
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
                out += src[i] === '\n' ? '\n' : ' ';
                i++;
            }
            i += 2;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

/** Merge backslash line continuations so a `\\\n` joins two physical lines. */
function combineContinuations(lines: string[]): string[] {
    const out: string[] = [];
    let buffer: string | null = null;
    for (const line of lines) {
        const merged: string = buffer === null ? line : buffer + ' ' + line.replace(/^\s+/, '');
        if (merged.endsWith('\\')) {
            buffer = merged.slice(0, -1);
        } else {
            out.push(merged);
            buffer = null;
        }
    }
    if (buffer !== null) { out.push(buffer); }
    return out;
}

/** Parse `"foo.h"` or `<foo.h>` from the rest of an `#include` line. */
function parseIncludeArgument(rest: string): string | null {
    const r = rest.trim();
    if (r.startsWith('"')) {
        const end = r.indexOf('"', 1);
        if (end < 0) { return null; }
        return r.slice(1, end);
    }
    if (r.startsWith('<')) {
        const end = r.indexOf('>', 1);
        if (end < 0) { return null; }
        return '<' + r.slice(1, end);
    }
    // Computed include like `#include MACRO(...)` — can't resolve statically.
    return null;
}

// -----------------------------------------------------------------------------
// Expression evaluator for `#if` / `#elif`
// -----------------------------------------------------------------------------

interface EvalResult {
    /** Concrete result (true/false) when we could evaluate, else undefined. */
    value: boolean | undefined;
    /** True if any sub-expression contained a token we couldn't resolve. */
    ambiguous: boolean;
}

interface Token {
    kind: 'num' | 'ident' | 'op';
    text: string;
    /** For numeric tokens. */
    value?: number;
}

function tokenize(expr: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    while (i < expr.length) {
        const ch = expr[i];
        if (ch === ' ' || ch === '\t') { i++; continue; }

        // Multi-char operators first
        const two = expr.slice(i, i + 2);
        if (['&&', '||', '==', '!=', '<=', '>=', '<<', '>>'].includes(two)) {
            tokens.push({ kind: 'op', text: two });
            i += 2; continue;
        }
        if ('()!<>+-*/%&|^~,'.includes(ch)) {
            tokens.push({ kind: 'op', text: ch });
            i++; continue;
        }

        // Numeric literal: 0x..., 0b..., decimal. Accept trailing u/l/ul/ll/ull.
        if (ch >= '0' && ch <= '9') {
            const numMatch = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|\d+)([uUlL]*)/.exec(expr.slice(i));
            if (numMatch) {
                const raw = numMatch[1];
                let value: number;
                if (raw.startsWith('0x') || raw.startsWith('0X')) { value = parseInt(raw.slice(2), 16); }
                else if (raw.startsWith('0b') || raw.startsWith('0B')) { value = parseInt(raw.slice(2), 2); }
                else if (raw.startsWith('0') && raw.length > 1) { value = parseInt(raw, 8); }
                else { value = parseInt(raw, 10); }
                tokens.push({ kind: 'num', text: numMatch[0], value });
                i += numMatch[0].length;
                continue;
            }
        }

        // Identifier
        if (/[A-Za-z_]/.test(ch)) {
            const idMatch = /^[A-Za-z_]\w*/.exec(expr.slice(i));
            if (idMatch) {
                tokens.push({ kind: 'ident', text: idMatch[0] });
                i += idMatch[0].length;
                continue;
            }
        }

        // Anything else — bail out by emitting a sentinel that forces ambiguity.
        tokens.push({ kind: 'op', text: '?' });
        i++;
    }
    return tokens;
}

/**
 * Evaluate a `#if` expression against the given define set.
 *
 * Numeric semantics: identifiers that aren't defined evaluate to 0. Identifiers
 * that ARE defined but with no value evaluate to 1. (Matches GNU cpp behavior.)
 *
 * `defined(X)` and `defined X` are special-cased to lookup membership in
 * `defines` (returning 0 or 1) without recursing on X.
 */
function evaluateExpression(expr: string, defines: ReadonlySet<string>): EvalResult {
    const tokens = tokenize(expr);
    if (tokens.length === 0) { return { value: undefined, ambiguous: true }; }

    let pos = 0;
    let ambiguous = false;

    const peek = () => tokens[pos];
    const eat = () => tokens[pos++];

    // Recursive-descent precedence climbing.
    // Precedence (low → high): || , && , | , ^ , & , == != , < <= > >= , << >> , + - , * / % , unary
    const parseUnary = (): number => {
        const t = peek();
        if (!t) { ambiguous = true; return 0; }
        if (t.kind === 'op' && (t.text === '!' || t.text === '-' || t.text === '+' || t.text === '~')) {
            eat();
            const v = parseUnary();
            switch (t.text) {
                case '!': return v === 0 ? 1 : 0;
                case '-': return -v;
                case '+': return v;
                case '~': return ~v;
            }
        }
        if (t.kind === 'op' && t.text === '(') {
            eat();
            const v = parseOr();
            if (peek()?.text === ')') { eat(); }
            return v;
        }
        if (t.kind === 'num') { eat(); return t.value ?? 0; }
        if (t.kind === 'ident') {
            eat();
            if (t.text === 'defined') {
                // defined X  or  defined(X)
                let nameTok: Token | undefined;
                if (peek()?.text === '(') {
                    eat();
                    nameTok = eat();
                    if (peek()?.text === ')') { eat(); }
                } else {
                    nameTok = eat();
                }
                if (!nameTok || nameTok.kind !== 'ident') { ambiguous = true; return 0; }
                return defines.has(nameTok.text) ? 1 : 0;
            }
            // Function-like macro call? `FOO(x, y)` — we can't evaluate.
            if (peek()?.text === '(') {
                ambiguous = true;
                // Skip to matching paren so subsequent parse keeps progressing.
                let depth = 0;
                while (pos < tokens.length) {
                    const tt = eat();
                    if (tt.text === '(') { depth++; }
                    else if (tt.text === ')') { depth--; if (depth === 0) { break; } }
                }
                return 0;
            }
            // Plain identifier: defined → 1, undefined → 0. (Per C standard.)
            return defines.has(t.text) ? 1 : 0;
        }
        ambiguous = true;
        return 0;
    };

    const parseBin = (next: () => number, ops: readonly string[]): number => {
        let lhs = next();
        while (peek() && peek().kind === 'op' && ops.includes(peek().text)) {
            const op = eat().text;
            const rhs = next();
            switch (op) {
                case '*': lhs = lhs * rhs; break;
                case '/': lhs = rhs === 0 ? 0 : Math.trunc(lhs / rhs); break;
                case '%': lhs = rhs === 0 ? 0 : lhs % rhs; break;
                case '+': lhs = lhs + rhs; break;
                case '-': lhs = lhs - rhs; break;
                case '<<': lhs = lhs << rhs; break;
                case '>>': lhs = lhs >> rhs; break;
                case '<': lhs = lhs < rhs ? 1 : 0; break;
                case '<=': lhs = lhs <= rhs ? 1 : 0; break;
                case '>': lhs = lhs > rhs ? 1 : 0; break;
                case '>=': lhs = lhs >= rhs ? 1 : 0; break;
                case '==': lhs = lhs === rhs ? 1 : 0; break;
                case '!=': lhs = lhs !== rhs ? 1 : 0; break;
                case '&': lhs = lhs & rhs; break;
                case '^': lhs = lhs ^ rhs; break;
                case '|': lhs = lhs | rhs; break;
                case '&&': lhs = (lhs !== 0 && rhs !== 0) ? 1 : 0; break;
                case '||': lhs = (lhs !== 0 || rhs !== 0) ? 1 : 0; break;
            }
        }
        return lhs;
    };

    const parseMul   = () => parseBin(parseUnary, ['*', '/', '%']);
    const parseAdd   = () => parseBin(parseMul,   ['+', '-']);
    const parseShift = () => parseBin(parseAdd,   ['<<', '>>']);
    const parseRel   = () => parseBin(parseShift, ['<', '<=', '>', '>=']);
    const parseEq    = () => parseBin(parseRel,   ['==', '!=']);
    const parseBitAnd= () => parseBin(parseEq,    ['&']);
    const parseXor   = () => parseBin(parseBitAnd,['^']);
    const parseBitOr = () => parseBin(parseXor,   ['|']);
    const parseAnd   = () => parseBin(parseBitOr, ['&&']);
    function parseOr(): number { return parseBin(parseAnd, ['||']); }

    const result = parseOr();
    if (pos < tokens.length) {
        // Trailing tokens we didn't consume — likely something we don't support.
        ambiguous = true;
    }
    return { value: result !== 0, ambiguous };
}
