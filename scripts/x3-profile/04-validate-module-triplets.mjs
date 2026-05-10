// For every header matching <m>ext.h, check if <m>in.h exists and which
// src/<m>*.cpp files exist. Output the validated module list.
import { readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const RUNTIME = process.env.RUNTIME ?? join(process.cwd(), '..', '..', '..', 'runtime');
const OUT_DIR = join(import.meta.dirname, 'data');
const OUT = join(OUT_DIR, '04-module-triplets.json');

async function listFiles(dir) {
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isFile()).map(e => e.name);
}

async function main() {
    await mkdir(OUT_DIR, { recursive: true });
    const includeDir = join(RUNTIME, 'include');
    const srcDir = join(RUNTIME, 'src');

    const incFiles = await listFiles(includeDir);
    const srcFiles = await listFiles(srcDir);

    // Find every *ext.h
    const moduleByExt = {};
    for (const f of incFiles) {
        const m = /^(.+)ext\.h$/i.exec(f);
        if (m) moduleByExt[m[1]] = { external: f };
    }

    // Find every *in.h and pair
    for (const f of incFiles) {
        const m = /^(.+)in\.h$/i.exec(f);
        if (m && moduleByExt[m[1]]) {
            moduleByExt[m[1]].internal = f;
        } else if (m) {
            // *in.h with no *ext.h — still a module
            moduleByExt[m[1]] = { internal: f };
        }
    }

    // For each module, find sibling .cpp files in src/
    for (const mod of Object.keys(moduleByExt)) {
        const re = new RegExp(`^${mod}(\\d+)?\\.cpp$`, 'i');
        moduleByExt[mod].impls = srcFiles.filter(f => re.test(f)).sort();
        // Also broader prefix-based match (e.g. exec*.cpp also matches execdiv.cpp, execws.cpp)
        const reBroad = new RegExp(`^${mod}\\w*\\.cpp$`, 'i');
        moduleByExt[mod].implsBroad = srcFiles.filter(f => reBroad.test(f)).sort();
    }

    // Headers that are not *ext.h / *in.h / version*.h — for awareness
    const otherHeaders = incFiles.filter(f => f.endsWith('.h') && !/ext\.h$|in\.h$/i.test(f) && !/^version/.test(f));

    const validated = Object.entries(moduleByExt)
        .map(([name, m]) => ({
            name,
            external: m.external ?? null,
            internal: m.internal ?? null,
            impls: m.impls ?? [],
            implsBroad: m.implsBroad ?? [],
            // "Complete" = has both header types AND at least one impl (broad match counts).
            // Runtime convention is <m>WORD.cpp not strict <m>.cpp, so broad is the right test.
            complete: !!m.external && !!m.internal && (m.implsBroad?.length ?? 0) > 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

    const out = {
        generatedAt: new Date().toISOString(),
        runtimeRoot: RUNTIME,
        moduleCount: validated.length,
        completeTriplets: validated.filter(m => m.complete).map(m => m.name),
        validated,
        otherHeaders,
    };

    await writeFile(OUT, JSON.stringify(out, null, 2));
    console.log(`[04] module-triplet scan → ${OUT}`);
    console.log(`     ${validated.length} candidate modules; ${out.completeTriplets.length} have ext+in+impls`);
    console.log(`     complete: ${out.completeTriplets.join(', ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
