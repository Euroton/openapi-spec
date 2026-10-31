import { Node, SyntaxKind, type Expression, type Identifier } from 'ts-morph';

export interface ParsedUrl {
    url: string;
    pathParamNames: string[];
}

/**
 * Normalize an API URL literal into an OpenAPI-style path with `{name}` segments.
 * Returns `null` for expressions we can't statically resolve.
 *
 * Handles:
 *   - "mail/v4/messages"
 *   - `mail/v4/messages/${id}`
 *   - `mail/v4/messages/${a}/mark/${b}`
 *   - `${BASE_URL}/${tokenId}` where BASE_URL is a const string literal
 *     (Pass uses this pattern: PAT_BASE_URL, PASS_PAT_BASE_URL, ...)
 */
export function parseUrlExpression(expr: Expression): ParsedUrl | null {
    if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
        return { url: '/' + stripLeadingSlash(expr.getLiteralText()), pathParamNames: [] };
    }

    if (Node.isIdentifier(expr)) {
        const lit = resolveConstStringLiteral(expr);
        if (lit !== null) return { url: '/' + stripLeadingSlash(lit), pathParamNames: [] };
        return null;
    }

    if (Node.isTemplateExpression(expr)) {
        const head = expr.getHead().getLiteralText();
        let out = head;
        const pathParamNames: string[] = [];
        for (const span of expr.getTemplateSpans()) {
            const sub = span.getExpression();
            if (!Node.isIdentifier(sub)) {
                return null;
            }
            const lit = resolveConstStringLiteral(sub);
            if (lit !== null) {
                out += lit + span.getLiteral().getLiteralText();
                continue;
            }
            const name = sub.getText();
            pathParamNames.push(name);
            out += `{${name}}` + span.getLiteral().getLiteralText();
        }
        return { url: '/' + stripLeadingSlash(out), pathParamNames };
    }

    return null;
}

/**
 * Resolve an identifier to its string-literal value if it was declared as
 * `const X = 'literal'` somewhere reachable in the project. Returns the
 * literal value or null. Used so Pass's `PAT_BASE_URL`-style URL prefixes
 * inline into the path instead of becoming `{PAT_BASE_URL}` path params.
 */
function resolveConstStringLiteral(id: Identifier): string | null {
    const decls = id.getSymbol()?.getDeclarations() ?? [];
    for (const decl of decls) {
        if (!Node.isVariableDeclaration(decl)) continue;
        const init = decl.getInitializer();
        if (!init) continue;
        if (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init)) {
            return init.getLiteralText();
        }
    }
    return null;
}

function stripLeadingSlash(s: string): string {
    return s.startsWith('/') ? s.slice(1) : s;
}

export function getMethodLiteral(expr: Expression): string | null {
    if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
        const m = expr.getLiteralText().toLowerCase();
        if (['get', 'post', 'put', 'delete', 'patch'].includes(m)) return m;
    }
    return null;
}

export { SyntaxKind };
