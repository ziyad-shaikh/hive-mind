import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type {
    ProjectProfile,
    ProfileMatch,
    BuildConfiguration,
} from './types';

import sageX3Runtime from './sage-x3-runtime.json';

const BUILTIN_PROFILES: ProjectProfile[] = [
    sageX3Runtime as unknown as ProjectProfile,
];

/** Returns the first profile whose `match` rule fires against `workspaceRoot`. */
export function detectProfile(workspaceRoot: string): ProjectProfile | null {
    for (const profile of BUILTIN_PROFILES) {
        if (matches(profile.match, workspaceRoot)) {
            return profile;
        }
    }
    return null;
}

function matches(m: ProfileMatch, root: string): boolean {
    if ('fileExists' in m) {
        return fs.existsSync(path.join(root, m.fileExists));
    }
    if ('anyOf' in m) {
        return m.anyOf.some(sub => matches(sub, root));
    }
    if ('allOf' in m) {
        return m.allOf.every(sub => matches(sub, root));
    }
    return false;
}

/**
 * Resolve a configuration name to its fully merged define + include set,
 * walking the `extends` chain.
 */
export function resolveConfiguration(
    profile: ProjectProfile,
    name: string
): { defines: Record<string, string>; includeRoots: string[] } {
    const visited = new Set<string>();
    const order: string[] = [];

    function visit(n: string): void {
        if (visited.has(n)) {
            return;
        }
        visited.add(n);
        const cfg = profile.configurations[n];
        if (!cfg) {
            return;
        }
        if (cfg.extends) {
            visit(cfg.extends);
        }
        order.push(n);
    }
    visit(name);

    const defines: Record<string, string> = {};
    let includeRoots: string[] = [];

    for (const cfgName of order) {
        const cfg = profile.configurations[cfgName];
        if (cfg.implicitDefines) {
            for (const [k, v] of Object.entries(cfg.implicitDefines)) {
                defines[k] = v;
            }
        }
        for (const [k, v] of Object.entries(cfg.defines)) {
            if (v === null) {
                delete defines[k];
            } else {
                defines[k] = v;
            }
        }
        if (cfg.includeRoots && cfg.includeRoots.length > 0) {
            // Last-wins: a configuration declaring includeRoots replaces inherited ones.
            includeRoots = [...cfg.includeRoots];
        }
    }

    return { defines, includeRoots };
}

/**
 * Pick the configuration to use when `defaultConfiguration` is "auto",
 * based on the host OS.
 */
export function pickAutoConfiguration(profile: ProjectProfile): string {
    if (profile.defaultConfiguration !== 'auto') {
        return profile.defaultConfiguration;
    }
    const platform = process.platform;
    const candidates: string[] = [];
    if (platform === 'win32') {
        candidates.push('windows-x64-release', 'windows-release', 'windows-x64-debug');
    } else if (platform === 'darwin') {
        candidates.push('darwin-release', 'darwin-debug');
    } else {
        candidates.push('linux-release', 'linux-debug');
    }
    for (const c of candidates) {
        if (profile.configurations[c]) {
            return c;
        }
    }
    return Object.keys(profile.configurations)[0];
}

/**
 * Convenience helper: resolve a module name to its triplet of header/internal/impl
 * file paths, expanding the {module} placeholder.
 */
export function resolveModuleTriplet(
    profile: ProjectProfile,
    module: string
): { external: string; internal: string; implGlob: string } {
    const m = profile.modulePattern;
    return {
        external: m.external.replace('{module}', module),
        internal: m.internal.replace('{module}', module),
        implGlob: m.implGlob.replace('{module}', module),
    };
}

/** Identify the build variant a TU belongs to (or null if it's in the common set). */
export function variantOf(
    profile: ProjectProfile,
    relPath: string
): string | null {
    const normalized = relPath.replace(/\\/g, '/');
    for (const variant of profile.buildVariants) {
        if (variant.extraSources.some(s => s.replace(/\\/g, '/') === normalized)) {
            return variant.name;
        }
    }
    return null;
}

/** Is `relPath` an umbrella header for this profile? */
export function isUmbrellaHeader(profile: ProjectProfile, relPath: string): boolean {
    const normalized = relPath.replace(/\\/g, '/');
    return profile.umbrellaHeaders.some(h => h.replace(/\\/g, '/') === normalized);
}

export type { ProjectProfile, BuildConfiguration } from './types';
