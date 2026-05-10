// Walk every .vcxproj under runtime/, extract:
//   - PreprocessorDefinitions per (Configuration, Platform)
//   - AdditionalIncludeDirectories per (Configuration, Platform)
//   - ClCompile source files
//   - AdditionalDependencies (link libs) — useful for build-variant detection
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

const RUNTIME = process.env.RUNTIME ?? join(process.cwd(), '..', '..', '..', 'runtime');
const OUT_DIR = join(import.meta.dirname, 'data');
const OUT = join(OUT_DIR, '01-vcxproj.json');

async function* walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'build' || entry.name === '.vs') continue;
            yield* walk(p);
        } else if (entry.isFile() && entry.name.endsWith('.vcxproj')) {
            yield p;
        }
    }
}

// Extract <X>...</X> — simple, sufficient for vcxproj since they're flat.
function tagsAll(xml, tag) {
    const re = new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)</${tag}>`, 'g');
    const out = [];
    let m;
    while ((m = re.exec(xml)) !== null) out.push({ attrs: m[1], body: m[2] });
    return out;
}

function attr(attrs, name) {
    const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
    return m ? m[1] : null;
}

function parseConditionConfig(cond) {
    // 'Condition'-style: $(Configuration)|$(Platform)'=='Debug|x64'
    const m = /'\$\(Configuration\)\|\$\(Platform\)'=='([^']+)'/.exec(cond ?? '');
    return m ? m[1] : null;
}

function splitDefines(s) {
    if (!s) return [];
    return s.split(';')
        .map(d => d.trim())
        .filter(d => d && d !== '%(PreprocessorDefinitions)');
}

function splitIncludes(s) {
    if (!s) return [];
    return s.split(';')
        .map(d => d.trim())
        .filter(d => d && d !== '%(AdditionalIncludeDirectories)');
}

async function processProject(file) {
    const xml = await readFile(file, 'utf8');
    const result = {
        path: relative(RUNTIME, file).replace(/\\/g, '/'),
        rootNamespace: tagsAll(xml, 'RootNamespace')[0]?.body ?? null,
        configurations: {},
        sources: tagsAll(xml, 'ClCompile')
            .map(t => attr(t.attrs, 'Include'))
            .filter(Boolean)
            .map(p => p.replace(/\\/g, '/'))
            .filter(p => p.endsWith('.cpp') || p.endsWith('.c') || p.endsWith('.cc') || p.endsWith('.cxx')),
        headers: tagsAll(xml, 'ClInclude')
            .map(t => attr(t.attrs, 'Include'))
            .filter(Boolean)
            .map(p => p.replace(/\\/g, '/')),
    };

    // Per-config <ItemDefinitionGroup>
    const groupRe = /<ItemDefinitionGroup\s+([^>]*)>([\s\S]*?)<\/ItemDefinitionGroup>/g;
    let g;
    while ((g = groupRe.exec(xml)) !== null) {
        const cond = attr(g[1], 'Condition');
        const cfg = parseConditionConfig(cond);
        if (!cfg) continue;
        const body = g[2];
        const defs = tagsAll(body, 'PreprocessorDefinitions')[0]?.body;
        const incs = tagsAll(body, 'AdditionalIncludeDirectories')[0]?.body;
        const deps = tagsAll(body, 'AdditionalDependencies')[0]?.body;
        result.configurations[cfg] = {
            defines: splitDefines(defs),
            includeDirs: splitIncludes(incs),
            linkDeps: splitDefines(deps),
        };
    }
    return result;
}

async function main() {
    if (!existsSync(RUNTIME)) {
        console.error(`runtime not found at ${RUNTIME} — set RUNTIME env var`);
        process.exit(1);
    }
    await mkdir(OUT_DIR, { recursive: true });

    const projects = [];
    for await (const p of walk(RUNTIME)) {
        try {
            projects.push(await processProject(p));
        } catch (e) {
            console.warn(`failed: ${p} — ${e.message}`);
        }
    }

    // Aggregate: union of defines per config, frequency of each define
    const aggregateByCfg = {};
    for (const p of projects) {
        for (const [cfg, cfgData] of Object.entries(p.configurations)) {
            const a = aggregateByCfg[cfg] ??= { defineFreq: {}, includeFreq: {}, projectCount: 0 };
            a.projectCount++;
            for (const d of cfgData.defines) a.defineFreq[d] = (a.defineFreq[d] ?? 0) + 1;
            for (const i of cfgData.includeDirs) a.includeFreq[i] = (a.includeFreq[i] ?? 0) + 1;
        }
    }

    // Compute "common defines" = those defined in ≥80% of projects per config
    const commonByCfg = {};
    for (const [cfg, a] of Object.entries(aggregateByCfg)) {
        const threshold = Math.ceil(a.projectCount * 0.8);
        commonByCfg[cfg] = {
            projectCount: a.projectCount,
            commonDefines: Object.entries(a.defineFreq)
                .filter(([_, n]) => n >= threshold)
                .map(([d]) => d)
                .sort(),
            allDefinesByFreq: Object.entries(a.defineFreq)
                .sort((a, b) => b[1] - a[1])
                .map(([d, n]) => ({ define: d, count: n })),
            includeDirsByFreq: Object.entries(a.includeFreq)
                .sort((a, b) => b[1] - a[1])
                .map(([i, n]) => ({ dir: i, count: n })),
        };
    }

    const out = {
        generatedAt: new Date().toISOString(),
        runtimeRoot: RUNTIME,
        projectCount: projects.length,
        aggregate: commonByCfg,
        projects,
    };
    await writeFile(OUT, JSON.stringify(out, null, 2));
    console.log(`[01] ${projects.length} vcxproj parsed → ${OUT}`);
    for (const cfg of Object.keys(commonByCfg)) {
        console.log(`     ${cfg}: ${commonByCfg[cfg].commonDefines.length} common defines across ${commonByCfg[cfg].projectCount} projects`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
