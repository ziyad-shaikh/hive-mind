// Parse the runtime/makefile to extract:
//   - CFLAGS_OPTIONS per build target (debug/release/coverage)
//   - CFLAGS / CPPFLAGS as a whole
//   - INCLUDE_PATHS (-I directives)
//   - Per-target -D flags
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const RUNTIME = process.env.RUNTIME ?? join(process.cwd(), '..', '..', '..', 'runtime');
const OUT_DIR = join(import.meta.dirname, 'data');
const OUT = join(OUT_DIR, '02-makefile.json');

function extractAssignments(makefile) {
    // Match `VAR=...` or `VAR := ...` or per-target `target: VAR = ...`
    const out = {};
    const lines = makefile.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
        let line = lines[i];
        // line continuation: keep concatenating while previous line ends with '\'
        while (line.endsWith('\\') && i + 1 < lines.length) {
            line = line.slice(0, -1) + ' ' + lines[++i];
        }
        // Per-target assignments: `release: CFLAGS_OPTIONS = ...`
        const tgt = /^(\w+):\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (tgt) {
            out[`${tgt[1]}.${tgt[2]}`] = tgt[3].trim();
            i++;
            continue;
        }
        // Plain assignment
        const plain = /^([A-Z_][A-Z0-9_]*)\s*[:?]?=\s*(.*)$/.exec(line);
        if (plain) {
            out[plain[1]] = plain[2].trim();
        }
        i++;
    }
    return out;
}

function tokens(s) {
    if (!s) return [];
    return s.split(/\s+/).filter(Boolean);
}

function extractFlags(value) {
    const defines = [];
    const includes = [];
    const other = [];
    for (const tok of tokens(value)) {
        if (tok.startsWith('-D')) defines.push(tok.slice(2));
        else if (tok.startsWith('-I')) includes.push(tok.slice(2));
        else other.push(tok);
    }
    return { defines, includes, other };
}

async function main() {
    const path = join(RUNTIME, 'makefile');
    const mk = await readFile(path, 'utf8');
    await mkdir(OUT_DIR, { recursive: true });

    const vars = extractAssignments(mk);

    // Resolve $(VAR) recursively up to a safe limit
    function resolve(s, depth = 0) {
        if (depth > 8) return s;
        return s.replace(/\$\((\w+)\)/g, (_, name) => {
            if (vars[name] !== undefined) return resolve(vars[name], depth + 1);
            return `\${${name}}`;
        });
    }

    const targets = ['debug', 'release', 'coverage'];
    const perTarget = {};
    for (const t of targets) {
        const opt = vars[`${t}.CFLAGS_OPTIONS`] ?? '';
        const cflags = resolve(vars.CFLAGS ?? '');
        const cppflags = resolve(vars.CPPFLAGS ?? '');
        const includes = resolve(vars.INCLUDE_PATHS ?? '');
        // Inject per-target options into a synthetic CFLAGS view
        const fullCFlags = cflags.replace(/\$\{CFLAGS_OPTIONS\}/g, opt);
        const fullCppFlags = cppflags.replace(/\$\{CFLAGS_OPTIONS\}/g, opt).replace(/\$\{CFLAGS\}/g, fullCFlags);
        perTarget[t] = {
            cflags: extractFlags(fullCFlags),
            cppflags: extractFlags(fullCppFlags),
            includes: extractFlags(includes),
        };
    }

    // Source lists
    const srcVars = ['CPPFILES', 'GRA_CPPFILES', 'ORA_CPPFILES', 'PGS_CPPFILES', 'SQL_CPPFILES', 'EXES', 'EXE_CPPFILES', 'LFILES', 'YFILES'];
    const sources = {};
    for (const v of srcVars) {
        const raw = vars[v] ?? '';
        sources[v] = tokens(raw).filter(t => !t.startsWith('$('));
    }

    // Link libs
    const linkVars = ['LINK_LIBS', 'ORA_LINK_LIBS', 'PGS_LINK_LIBS', 'SQL_LINK_LIBS'];
    const linkLibs = {};
    for (const v of linkVars) linkLibs[v] = tokens(resolve(vars[v] ?? ''));

    const out = {
        generatedAt: new Date().toISOString(),
        runtimeRoot: RUNTIME,
        path: relative(RUNTIME, path).replace(/\\/g, '/'),
        rawVars: Object.fromEntries(
            Object.entries(vars).filter(([k]) => /CFLAG|CPPFLAG|INCLUDE|FILE|LIB|EXE/.test(k))
        ),
        perTarget,
        sources,
        linkLibs,
    };
    await writeFile(OUT, JSON.stringify(out, null, 2));
    console.log(`[02] makefile parsed → ${OUT}`);
    for (const t of targets) {
        console.log(`     ${t}: ${perTarget[t].cppflags.defines.length} defines, ${perTarget[t].includes.includes.length} include paths`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
