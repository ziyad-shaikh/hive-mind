// Minimal test harness — no Jest/Mocha dependency.
//
// Each test file imports `test`, `assert`, `assertEqual`, `assertContains` from
// here. Tests register themselves via `test('name', fn)`. The runner imports
// the file (which side-effects the registration) then calls `runRegistered()`.
//
// Designed for CI where pulling in Jest would mean dragging Babel/ts-jest etc.
// for an extension that ships no test runtime of its own.

const tests = [];

export function test(name, fn) {
    tests.push({ name, fn });
}

export function assert(cond, msg) {
    if (!cond) throw new Error(msg ?? 'assertion failed');
}

export function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error((msg ?? 'not equal') + `\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
    }
}

export function assertContains(haystack, needle, msg) {
    if (Array.isArray(haystack) ? !haystack.includes(needle) : !haystack.includes(needle)) {
        throw new Error((msg ?? 'does not contain') + `\n  haystack: ${JSON.stringify(haystack).slice(0, 200)}\n  needle:   ${JSON.stringify(needle)}`);
    }
}

export async function runRegistered() {
    let passed = 0, failed = 0;
    const failures = [];
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`  ✓ ${t.name}`);
            passed++;
        } catch (e) {
            console.log(`  ✗ ${t.name}`);
            console.log(`      ${e.message ?? e}`);
            failures.push({ name: t.name, error: e });
            failed++;
        }
    }
    return { passed, failed, failures };
}

// Reset between files when the runner imports several
export function resetRegistered() {
    tests.length = 0;
}
