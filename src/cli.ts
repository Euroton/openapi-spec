#!/usr/bin/env -S npx tsx
import fs from 'node:fs';
import path from 'node:path';

import { Command } from 'commander';
import yaml from 'yaml';

import { buildOpenApi } from './build/buildSpec.js';
import { extract } from './extract/index.js';

const program = new Command();
program
    .name('euroton-openapi')
    .description('Mechanically extract an OpenAPI 3.1 spec from ProtonWebClients sources.');

program
    .command('extract')
    .description('Extract API operations and write spec/euroton.openapi.yaml')
    .option(
        '-u, --upstream <dir>',
        'path to upstream ProtonWebClients checkout',
        process.env.PROTON_WEBCLIENTS ?? '../WebClients',
    )
    .option(
        '-o, --output <path>',
        'output path for the OpenAPI document',
        'spec/euroton.openapi.yaml',
    )
    .option(
        '-f, --files <list>',
        'comma-separated list of file basenames under packages/shared/lib/api (e.g. messages.ts,conversations.ts). Omit to extract everything.',
    )
    .option('--json', 'emit JSON instead of YAML')
    .action((opts) => {
        const upstream = path.resolve(opts.upstream);
        if (!fs.existsSync(upstream)) {
            console.error(`Upstream directory not found: ${upstream}`);
            process.exit(1);
        }
        const apiDirCheck = path.join(upstream, 'packages/shared/lib/api');
        if (!fs.existsSync(apiDirCheck)) {
            console.error(
                `Upstream directory does not look like ProtonWebClients (missing ${apiDirCheck}).\n` +
                `Hint: clone github.com/Euroton/WebClients next to this repo.\n` +
                `Or set PROTON_WEBCLIENTS to a checkout elsewhere.`,
            );
            process.exit(1);
        }

        const includeFiles = opts.files ? String(opts.files).split(',').map((s) => s.trim()) : undefined;

        const extracted = extract({ upstreamRoot: upstream, includeFiles });
        const doc = buildOpenApi(extracted);

        const augmentPath = path.resolve('spec/augment.yaml');
        let augmentAdded = 0;
        if (fs.existsSync(augmentPath)) {
            const augment = yaml.parse(fs.readFileSync(augmentPath, 'utf8')) ?? {};
            if (augment.paths && typeof augment.paths === 'object') {
                for (const [p, item] of Object.entries(augment.paths as Record<string, Record<string, unknown>>)) {
                    const target = (doc.paths[p] ||= {} as any);
                    for (const [method, op] of Object.entries(item)) {
                        (target as any)[method] = op;
                        augmentAdded++;
                    }
                }
            }
            if (Array.isArray(augment.tags)) {
                const have = new Set(doc.tags.map((t) => t.name));
                for (const t of augment.tags) {
                    if (t && typeof t === 'object' && !have.has((t as any).name)) {
                        doc.tags.push(t as any);
                        have.add((t as any).name);
                    }
                }
                doc.tags.sort((a, b) => a.name.localeCompare(b.name));
            }
        }

        const output = path.resolve(opts.output);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        // ts-morph prints imported types with absolute paths; keep the spec machine-independent.
        const serialized = (opts.json ? JSON.stringify(doc, null, 2) : yaml.stringify(doc))
            .replaceAll(`${upstream}/`, '');
        fs.writeFileSync(output, serialized);

        console.error(`Extracted ${extracted.operations.length} operations`);
        if (augmentAdded > 0) {
            console.error(`Merged ${augmentAdded} operations from ${path.relative(process.cwd(), augmentPath)}`);
        }
        console.error(`Skipped ${extracted.skipped.length} (see report below)`);
        if (extracted.skipped.length > 0) {
            for (const s of extracted.skipped) {
                console.error(`  - ${s.file}: ${s.reason}`);
            }
        }
        console.error(`Wrote ${output}`);
    });

program.parseAsync(process.argv).catch((e) => {
    console.error(e);
    process.exit(1);
});
