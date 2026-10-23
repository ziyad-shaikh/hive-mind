import { join, relative } from 'node:path';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test, assert, assertEqual } from './_harness.mjs';

const HERE = import.meta.dirname;
const HIVE = join(HERE, '..');
const FIXTURE = join(HERE, 'fixtures', 'rust');
const require = createRequire(import.meta.url);
const { extractRustReferences, RustDependencyResolver } = require(join(HIVE, 'out', 'analyzer', 'RustDependencyResolver.js'));

function walk(dir, files = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, files);
        else if (entry.name.endsWith('.rs')) files.push(full);
    }
    return files;
}

function rel(file) {
    return file ? relative(FIXTURE, file).replace(/\\/g, '/') : null;
}

test('extracts public modules and expands grouped use paths', () => {
    const references = extractRustReferences(`
        pub mod model;
        use crate::{model::Record, service::{self, Runner as ActiveRunner}};
    `);
    assert(references.includes('rust-mod:model:'), 'public module was not extracted');
    assert(references.includes('rust-use:crate::model::Record'), 'grouped model import was not expanded');
    assert(references.includes('rust-use:crate::service'), 'grouped self import was not expanded');
    assert(references.includes('rust-use:crate::service::Runner'), 'nested alias import was not expanded');
});

test('resolves nested modules and path attributes', () => {
    const resolver = new RustDependencyResolver(walk(FIXTURE), [FIXTURE]);
    const lib = join(FIXTURE, 'crates', 'core-lib', 'src', 'lib.rs');
    assertEqual(rel(resolver.resolve('rust-mod:model:', lib)), 'crates/core-lib/src/model.rs');
    assertEqual(rel(resolver.resolve('rust-mod:platform:platform/windows.rs', lib)), 'crates/core-lib/src/platform/windows.rs');
    const command = join(FIXTURE, 'crates', 'app', 'src', 'command.rs');
    assertEqual(rel(resolver.resolve('rust-mod:detail:', command)), 'crates/app/src/command/detail.rs');
});

test('resolves symbols to their deepest module file', () => {
    const resolver = new RustDependencyResolver(walk(FIXTURE), [FIXTURE]);
    const service = join(FIXTURE, 'crates', 'core-lib', 'src', 'service.rs');
    assertEqual(rel(resolver.resolve('rust-use:crate::model::Record', service)), 'crates/core-lib/src/model.rs');
});

test('resolves Cargo library names across workspace crates', () => {
    const resolver = new RustDependencyResolver(walk(FIXTURE), [FIXTURE]);
    const main = join(FIXTURE, 'crates', 'app', 'src', 'main.rs');
    assertEqual(rel(resolver.resolve('rust-use:core_engine::service', main)), 'crates/core-lib/src/service.rs');
    assertEqual(resolver.crateCount, 2);
});
