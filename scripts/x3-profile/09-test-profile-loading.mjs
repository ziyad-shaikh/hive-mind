// Verify the compiled profile loader works against the runtime repo.
// Exercises detection, configuration resolution, and variant detection.
import { join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = import.meta.dirname;
const HIVE = join(HERE, '..', '..');
const RUNTIME = process.env.RUNTIME ?? join(HIVE, '..', 'runtime');
const require = createRequire(import.meta.url);

const profiles = require(join(HIVE, 'out', 'profiles', 'index.js'));

console.log('=== detectProfile() against runtime ===');
const p = profiles.detectProfile(RUNTIME);
if (!p) {
    console.error('NO PROFILE DETECTED — investigate');
    process.exit(1);
}
console.log(`detected: ${p.id} (${p.displayName})`);
console.log(`umbrellas: ${p.umbrellaHeaders.join(', ')}`);
console.log(`known modules: ${p.modulePattern.knownModules.length} entries — ${p.modulePattern.knownModules.slice(0, 8).join(', ')}, ...`);
console.log(`build variants: ${p.buildVariants.map(v => v.name).join(', ')}`);

console.log('\n=== resolveConfiguration() ===');
const auto = profiles.pickAutoConfiguration(p);
console.log(`auto config (this host): ${auto}`);
const resolved = profiles.resolveConfiguration(p, auto);
console.log(`defines: ${Object.keys(resolved.defines).length} entries`);
console.log(`include roots: ${resolved.includeRoots.length}`);
const sample = Object.entries(resolved.defines).slice(0, 8).map(([k, v]) => `${k}=${v}`).join(', ');
console.log(`sample defines: ${sample}`);

console.log('\n=== resolveModuleTriplet() ===');
for (const mod of ['div', 'apl', 'cal', 'fil']) {
    const t = profiles.resolveModuleTriplet(p, mod);
    console.log(`  ${mod}: ${t.external} | ${t.internal} | ${t.implGlob}`);
}

console.log('\n=== variantOf() ===');
const samples = [
    'src/exec.cpp',
    'src/db/ora/oracli.cpp',
    'src/db/pgs/pgsfil.cpp',
    'src/db/sql/sqlcli.cpp',
    'include/divext.h',
];
for (const f of samples) {
    const v = profiles.variantOf(p, f);
    console.log(`  ${f.padEnd(30)} → ${v ?? '(common)'}`);
}

console.log('\n=== isUmbrellaHeader() ===');
for (const f of ['include/adx_include.h', 'include/divext.h', 'test/adx_test.h']) {
    console.log(`  ${f.padEnd(30)} → ${profiles.isUmbrellaHeader(p, f)}`);
}

console.log('\nAll profile loader checks passed.');
