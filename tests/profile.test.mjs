// Tests for the profile loader, configuration resolver, and module helpers.
// Pure data-transform tests — no fixtures or filesystem mock needed.
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { test, assert, assertEqual } from './_harness.mjs';

const HERE = import.meta.dirname;
const HIVE = join(HERE, '..');
const require = createRequire(import.meta.url);
const profiles = require(join(HIVE, 'out', 'profiles', 'index.js'));

test('detectProfile returns the X3 profile when adx_include.h exists', () => {
    const fixtureRoot = join(HERE, 'fixtures', 'cpp');
    const profile = profiles.detectProfile(fixtureRoot);
    assert(profile !== null, 'expected profile to be detected');
    assertEqual(profile.id, 'sage-x3-runtime');
});

test('detectProfile returns null in unrelated directory', () => {
    const profile = profiles.detectProfile(HIVE);  // hive-mind repo root, not an X3 workspace
    assertEqual(profile, null);
});

test('resolveConfiguration walks extends chain and merges defines', () => {
    const fixtureRoot = join(HERE, 'fixtures', 'cpp');
    const profile = profiles.detectProfile(fixtureRoot);
    const linux = profiles.resolveConfiguration(profile, 'linux-release');
    assert(typeof linux.defines === 'object', 'defines should be an object');
    assert(Array.isArray(linux.includeRoots), 'includeRoots should be an array');
    assert(linux.includeRoots.length > 0, 'expected non-empty includeRoots');
});

test('pickAutoConfiguration returns a known configuration name', () => {
    const fixtureRoot = join(HERE, 'fixtures', 'cpp');
    const profile = profiles.detectProfile(fixtureRoot);
    const cfgName = profiles.pickAutoConfiguration(profile);
    assert(profile.configurations[cfgName] !== undefined,
        `pickAutoConfiguration returned unknown config "${cfgName}"`);
});

test('resolveModuleTriplet expands {module} placeholder', () => {
    const fixtureRoot = join(HERE, 'fixtures', 'cpp');
    const profile = profiles.detectProfile(fixtureRoot);
    const t = profiles.resolveModuleTriplet(profile, 'apl');
    assertEqual(t.external, 'include/aplext.h');
    assertEqual(t.internal, 'include/aplin.h');
    assertEqual(t.implGlob, 'src/apl*.cpp');
});

test('isUmbrellaHeader matches profile entry', () => {
    const fixtureRoot = join(HERE, 'fixtures', 'cpp');
    const profile = profiles.detectProfile(fixtureRoot);
    assertEqual(profiles.isUmbrellaHeader(profile, 'include/adx_include.h'), true);
    assertEqual(profiles.isUmbrellaHeader(profile, 'src/aplmain.cpp'), false);
});

test('variantOf identifies the sadora variant for an Oracle source file', () => {
    const fixtureRoot = join(HERE, 'fixtures', 'cpp');
    const profile = profiles.detectProfile(fixtureRoot);
    assertEqual(profiles.variantOf(profile, 'src/db/ora/oracli.cpp'), 'sadora');
    assertEqual(profiles.variantOf(profile, 'src/aplmain.cpp'), null);
});

export {};
