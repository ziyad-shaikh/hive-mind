// Recover build variants from the makefile + .vcxproj data:
//   - Which TUs are linked into sadora vs sadpgs vs sadoss
//   - Which Windows projects map to which Linux variant
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const RUNTIME = process.env.RUNTIME ?? join(process.cwd(), '..', '..', '..', 'runtime');
const OUT_DIR = join(import.meta.dirname, 'data');
const OUT = join(OUT_DIR, '06-build-variants.json');

async function main() {
    if (!existsSync(RUNTIME)) { console.error(`runtime not found at ${RUNTIME}`); process.exit(1); }
    await mkdir(OUT_DIR, { recursive: true });

    const mk = await readFile(join(RUNTIME, 'makefile'), 'utf8');

    function listVar(name) {
        const re = new RegExp(`^${name}\\s*=\\s*([\\s\\S]*?)(?=\\r?\\n\\r?\\n|\\r?\\n\\w+\\s*=)`, 'm');
        const m = re.exec(mk);
        if (!m) return [];
        return m[1]
            .replace(/\\\r?\n/g, ' ')
            .split(/\s+/)
            .map(s => s.replace(/\\$/, '').trim())
            .filter(s => s && s !== '\\' && !s.startsWith('$('));
    }

    const variants = {
        common: listVar('CPPFILES'),
        ora: listVar('ORA_CPPFILES'),
        pgs: listVar('PGS_CPPFILES'),
        sql: listVar('SQL_CPPFILES'),
        grammar: listVar('GRA_CPPFILES'),
    };

    // Distinct binaries from EXES
    const exesMatch = /EXES\s*=\s*([\s\S]*?)(?=\n\w)/.exec(mk);
    const binaries = exesMatch
        ? exesMatch[1].replace(/\\\n/g, ' ').split(/\s+/)
            .map(s => s.trim())
            .filter(s => s.includes('/bin/'))
            .map(s => s.split('/bin/').pop())
        : [];

    // Variant binaries are produced from explicit recipes farther down — extract them
    const variantBinariesMatch = mk.match(/(\$\(BUILD_DIR\)\/bin\/sad\w+):\s*\$\(LIB\).*?(\$\(\w+_CPPOBJS\))/g) ?? [];

    const out = {
        generatedAt: new Date().toISOString(),
        runtimeRoot: RUNTIME,
        commonTUs: variants.common,
        variants: [
            { name: 'sadora',  extraSources: variants.ora,  description: 'Oracle backend' },
            { name: 'sadpgs',  extraSources: variants.pgs,  description: 'PostgreSQL backend' },
            { name: 'sadoss',  extraSources: variants.sql,  description: 'ODBC / MSSQL backend' },
            { name: 'sadldap', extraSources: variants.ora,  description: 'LDAP admin (uses Oracle backend)' },
        ],
        grammarTUs: variants.grammar,
        binaries,
        variantRecipeFragments: variantBinariesMatch,
        counts: {
            commonTUs: variants.common.length,
            oraTUs: variants.ora.length,
            pgsTUs: variants.pgs.length,
            sqlTUs: variants.sql.length,
            grammarTUs: variants.grammar.length,
        },
    };

    await writeFile(OUT, JSON.stringify(out, null, 2));
    console.log(`[06] build-variants → ${OUT}`);
    console.log(`     common=${out.counts.commonTUs}  ora=${out.counts.oraTUs}  pgs=${out.counts.pgsTUs}  sql=${out.counts.sqlTUs}  grammar=${out.counts.grammarTUs}`);
}

main().catch(e => { console.error(e); process.exit(1); });
