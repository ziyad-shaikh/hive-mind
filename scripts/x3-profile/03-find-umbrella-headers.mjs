// For every C/C++ source/header in runtime, list its #includes (direct only).
// Then count how many files include each header. The top of that list (>25%)
// are umbrella-header candidates.
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

const RUNTIME = process.env.RUNTIME ?? join(process.cwd(), '..', '..', '..', 'runtime');
const OUT_DIR = join(import.meta.dirname, 'data');
const OUT = join(OUT_DIR, '03-umbrella-headers.json');

const CPP_EXT = new Set(['.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.hxx', '.inl', '.ipp']);

async function* walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'build' || entry.name === 'extlib' || entry.name === 'iz-pack') continue;
        const p = join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(p);
        else if (entry.isFile()) {
            const dot = entry.name.lastIndexOf('.');
            if (dot >= 0 && CPP_EXT.has(entry.name.slice(dot).toLowerCase())) yield p;
        }
    }
}

const INCLUDE_RE = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm;

function extractIncludes(text) {
    const out = [];
    let m;
    while ((m = INCLUDE_RE.exec(text)) !== null) out.push(m[1]);
    return out;
}

async function main() {
    if (!existsSync(RUNTIME)) { console.error(`runtime not found at ${RUNTIME}`); process.exit(1); }
    await mkdir(OUT_DIR, { recursive: true });

    const fileToIncludes = {};
    let fileCount = 0;
    for await (const p of walk(RUNTIME)) {
        try {
            const txt = await readFile(p, 'utf8');
            const incs = extractIncludes(txt);
            const rel = relative(RUNTIME, p).replace(/\\/g, '/');
            fileToIncludes[rel] = incs;
            fileCount++;
        } catch {
            // binary or permission; skip
        }
    }

    // Count by basename and by exact include token
    const byBasename = {};
    const byExact = {};
    for (const incs of Object.values(fileToIncludes)) {
        const seen = new Set();
        for (const inc of incs) {
            const b = basename(inc).toLowerCase();
            if (!seen.has(b)) {
                byBasename[b] = (byBasename[b] ?? 0) + 1;
                seen.add(b);
            }
            byExact[inc] = (byExact[inc] ?? 0) + 1;
        }
    }

    const sorted = Object.entries(byBasename)
        .map(([h, n]) => ({ header: h, includedBy: n, percent: +(100 * n / fileCount).toFixed(1) }))
        .sort((a, b) => b.includedBy - a.includedBy);

    const umbrellaCandidates = sorted.filter(e => e.percent >= 25);

    const out = {
        generatedAt: new Date().toISOString(),
        runtimeRoot: RUNTIME,
        sourceFileCount: fileCount,
        umbrellaCandidates,
        topByBasename: sorted.slice(0, 30),
        topByExactPath: Object.entries(byExact).sort((a, b) => b[1] - a[1]).slice(0, 50)
            .map(([h, n]) => ({ include: h, count: n })),
    };
    await writeFile(OUT, JSON.stringify(out, null, 2));
    console.log(`[03] umbrella scan → ${OUT}`);
    console.log(`     ${fileCount} TUs scanned, ${umbrellaCandidates.length} umbrella candidates (>=25% inclusion)`);
    for (const c of umbrellaCandidates.slice(0, 10)) {
        console.log(`       ${c.header}  ${c.includedBy}/${fileCount} (${c.percent}%)`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
