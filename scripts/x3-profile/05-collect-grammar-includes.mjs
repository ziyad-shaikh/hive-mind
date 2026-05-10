// For each .y / .ym4 / .x / .l file, extract:
//   - the %{...%} prologue block(s)
//   - all #include directives within them
//   - all %token directives (token-name catalog)
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const RUNTIME = process.env.RUNTIME ?? join(process.cwd(), '..', '..', '..', 'runtime');
const OUT_DIR = join(import.meta.dirname, 'data');
const OUT = join(OUT_DIR, '05-grammar-includes.json');
const EXTS = new Set(['.y', '.ym4', '.x', '.l']);

async function* walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'build' || entry.name === 'extlib') continue;
        const p = join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(p);
        else if (entry.isFile()) {
            const dot = entry.name.lastIndexOf('.');
            if (dot >= 0 && EXTS.has(entry.name.slice(dot).toLowerCase())) yield p;
        }
    }
}

const PROLOGUE_RE = /%\{([\s\S]*?)%\}/g;
const INCLUDE_RE = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm;
const TOKEN_RE = /^\s*%token\s+([A-Z_][A-Z0-9_]*)/gm;

async function processFile(path) {
    const txt = await readFile(path, 'utf8');
    const prologues = [];
    let m;
    PROLOGUE_RE.lastIndex = 0;
    while ((m = PROLOGUE_RE.exec(txt)) !== null) prologues.push(m[1]);
    const prologueText = prologues.join('\n');

    const includes = [];
    INCLUDE_RE.lastIndex = 0;
    while ((m = INCLUDE_RE.exec(prologueText)) !== null) includes.push(m[1]);

    const tokens = [];
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(txt)) !== null) tokens.push(m[1]);

    return {
        path: relative(RUNTIME, path).replace(/\\/g, '/'),
        prologueCount: prologues.length,
        includes,
        tokenCount: tokens.length,
        sampleTokens: tokens.slice(0, 8),
    };
}

async function main() {
    if (!existsSync(RUNTIME)) { console.error(`runtime not found at ${RUNTIME}`); process.exit(1); }
    await mkdir(OUT_DIR, { recursive: true });

    const files = [];
    for await (const p of walk(RUNTIME)) files.push(await processFile(p));

    const totalIncludes = files.reduce((n, f) => n + f.includes.length, 0);
    const headerHits = {};
    for (const f of files) {
        for (const inc of f.includes) headerHits[inc] = (headerHits[inc] ?? 0) + 1;
    }

    const out = {
        generatedAt: new Date().toISOString(),
        runtimeRoot: RUNTIME,
        fileCount: files.length,
        totalIncludeEdges: totalIncludes,
        topHeaders: Object.entries(headerHits)
            .sort((a, b) => b[1] - a[1])
            .map(([h, n]) => ({ header: h, count: n })),
        files,
    };
    await writeFile(OUT, JSON.stringify(out, null, 2));
    console.log(`[05] grammar prologue scan → ${OUT}`);
    console.log(`     ${files.length} grammar files; ${totalIncludes} include edges that the regex parser misses today`);
}

main().catch(e => { console.error(e); process.exit(1); });
