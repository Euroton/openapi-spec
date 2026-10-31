import fs from 'node:fs';
import path from 'node:path';

import { Project, type SourceFile } from 'ts-morph';

import { parseApiFile } from './parseFile.js';
import type { ExtractedSpec } from './types.js';

export interface ExtractOptions {
    upstreamRoot: string;
    apiSubdir?: string;
    includeFiles?: string[];
}

export function extract(opts: ExtractOptions): ExtractedSpec {
    const apiDir = path.resolve(opts.upstreamRoot, opts.apiSubdir ?? 'packages/shared/lib/api');

    const project = new Project({
        tsConfigFilePath: findTsConfig(opts.upstreamRoot),
        skipAddingFilesFromTsConfig: true,
    });

    const sharedFiles = (opts.includeFiles && opts.includeFiles.length > 0)
        ? opts.includeFiles.map((f) => path.resolve(apiDir, f))
        : project.addSourceFilesAtPaths(`${apiDir}/*.ts`).map((sf) => sf.getFilePath());

    const sharedSources = sharedFiles.map((p) =>
        project.getSourceFile(p) ?? project.addSourceFileAtPath(p),
    );

    const operations: ExtractedSpec['operations'] = [];
    const skipped: ExtractedSpec['skipped'] = [];

    for (const sf of sharedSources) {
        const { operations: ops, skipped: sk } = parseApiFile(sf, opts.upstreamRoot);
        operations.push(...ops);
        for (const s of sk) {
            skipped.push({ file: path.relative(opts.upstreamRoot, sf.getFilePath()), reason: `${s.name}: ${s.reason}` });
        }
    }

    // Pass is structured differently from shared/lib/api: API calls live inline as
    // `api({ url, method, ... })` inside exported async helpers under
    // `packages/pass/lib/**/(*.requests.ts | *.request.ts)`. Walk those too so the
    // generated spec covers the Pass surface that the server already implements.
    if (!opts.includeFiles) {
        for (const file of collectPassRequestFiles(opts.upstreamRoot)) {
            const sf: SourceFile = project.getSourceFile(file) ?? project.addSourceFileAtPath(file);
            const tag = derivePassTag(file);
            const { operations: ops, skipped: sk } = parseApiFile(sf, opts.upstreamRoot, { tag });
            operations.push(...ops);
            for (const s of sk) {
                skipped.push({ file: path.relative(opts.upstreamRoot, sf.getFilePath()), reason: `${s.name}: ${s.reason}` });
            }
        }
    }

    return { operations, skipped };
}

function collectPassRequestFiles(upstreamRoot: string): string[] {
    const passLib = path.join(upstreamRoot, 'packages/pass/lib');
    if (!fs.existsSync(passLib)) return [];
    const out: string[] = [];
    function walk(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules') continue;
                walk(full);
                continue;
            }
            if (!entry.isFile()) continue;
            if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.test.ts')) continue;
            if (entry.name.endsWith('.requests.ts') || entry.name.endsWith('.request.ts')) {
                out.push(full);
            }
        }
    }
    walk(passLib);
    return out.sort();
}

function derivePassTag(file: string): string {
    // packages/pass/lib/shares/share.requests.ts → "Pass Shares"
    // packages/pass/lib/monitor/monitor.request.ts → "Pass Monitor"
    const parts = file.split(path.sep);
    const libIdx = parts.lastIndexOf('lib');
    const slug = (libIdx >= 0 && libIdx + 1 < parts.length ? parts[libIdx + 1] : 'misc') ?? 'misc';
    const titled = slug.charAt(0).toUpperCase() + slug.slice(1);
    return `Pass ${titled}`;
}

function findTsConfig(upstreamRoot: string): string | undefined {
    const candidates = [
        path.join(upstreamRoot, 'tsconfig.json'),
        path.join(upstreamRoot, 'packages/shared/tsconfig.json'),
    ];
    for (const c of candidates) {
        try {
            const fs = require('node:fs');
            if (fs.existsSync(c)) return c;
        } catch {
            /* fall through */
        }
    }
    return undefined;
}
