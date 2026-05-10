// Test runner — imports each *.test.mjs file in turn, runs registered tests,
// reports a summary, and exits non-zero on any failure.
//
// Designed to run after `npm run compile` so the tests can require() compiled
// JS from `out/`.
import { runRegistered, resetRegistered } from './_harness.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const HIVE = join(HERE, '..');

if (!existsSync(join(HIVE, 'out', 'analyzer', 'CppScopeResolver.js'))) {
    console.error('error: out/ is missing — run "npm run compile" before "npm test".');
    process.exit(2);
}

const suites = [
    { name: 'profile',         path: './profile.test.mjs' },
    { name: 'module-graph',    path: './module-graph.test.mjs' },
    { name: 'scope-resolver',  path: './scope-resolver.test.mjs' },
];

let totalPassed = 0, totalFailed = 0;
const allFailures = [];

for (const suite of suites) {
    console.log(`\n━━━ ${suite.name} ━━━`);
    resetRegistered();
    await import(suite.path);
    const { passed, failed, failures } = await runRegistered();
    totalPassed += passed;
    totalFailed += failed;
    for (const f of failures) allFailures.push({ suite: suite.name, ...f });
}

console.log(`\n${'─'.repeat(40)}`);
console.log(`Total: ${totalPassed} passed, ${totalFailed} failed`);

if (totalFailed > 0) {
    console.log('\nFailures:');
    for (const f of allFailures) {
        console.log(`  [${f.suite}] ${f.name}`);
        console.log(`    ${(f.error?.message ?? f.error).split('\n').join('\n    ')}`);
    }
    process.exit(1);
}
