import path from 'node:path';

import type { SourceFile } from 'ts-morph';

import { extractOperation } from './extractOp.js';
import type { ExtractedOperation } from './types.js';

export interface ParseApiFileOpts {
    /** Override the tag derivation. Use for repos where the filename alone is uninformative (e.g. `share.requests.ts`). */
    tag?: string;
}

export function parseApiFile(
    sourceFile: SourceFile,
    upstreamRoot: string,
    opts: ParseApiFileOpts = {},
): { operations: ExtractedOperation[]; skipped: Array<{ name: string; reason: string }> } {
    const filePath = sourceFile.getFilePath();
    const relativePath = path.relative(upstreamRoot, filePath);
    const tag = opts.tag ?? deriveTagFromFilename(path.basename(filePath, '.ts'));

    const operations: ExtractedOperation[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];

    for (const decl of sourceFile.getVariableDeclarations()) {
        if (!decl.isExported()) continue;
        const { op, reason } = extractOperation(decl, tag, relativePath);
        if (op) {
            operations.push(op);
        } else if (reason) {
            skipped.push({ name: decl.getName(), reason });
        }
    }

    return { operations, skipped };
}

function deriveTagFromFilename(name: string): string {
    // `messages` → `Messages`, `mailSettings` → `Mail Settings`
    const withSpaces = name.replace(/([a-z])([A-Z])/g, '$1 $2');
    return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
}
