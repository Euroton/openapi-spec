import {
    Node,
    ObjectLiteralExpression,
    type ArrowFunction,
    type Block,
    type Expression,
    type ParameterDeclaration,
    type VariableDeclaration,
} from 'ts-morph';

import { getMethodLiteral, parseUrlExpression } from './parseUrl.js';
import type { ExtractedOperation, HttpMethod, ParamDescriptor } from './types.js';

/**
 * Try to extract a single Operation from an exported arrow function that returns
 * a request descriptor like `{ method, url, params?, data?, input? }`.
 * Returns null if the function doesn't match the canonical shape.
 */
export function extractOperation(
    decl: VariableDeclaration,
    tag: string,
    sourceFile: string,
): { op: ExtractedOperation | null; reason?: string } {
    const operationId = decl.getName();
    const init = decl.getInitializer();
    if (!init || !Node.isArrowFunction(init)) {
        return { op: null, reason: 'not an arrow function' };
    }

    const fn = init as ArrowFunction;
    const body = fn.getBody();

    // Arrow with concise body returning a parenthesized object literal.
    let returned: ObjectLiteralExpression | null = null;
    if (Node.isParenthesizedExpression(body)) {
        const inner = body.getExpression();
        if (Node.isObjectLiteralExpression(inner)) returned = inner;
    } else if (Node.isObjectLiteralExpression(body)) {
        returned = body;
    } else if (Node.isBlock(body)) {
        // Walk all return statements belonging to this function (i.e. skipping
        // returns nested inside other functions/arrows). Take the first one
        // resolvable to a clean object literal — direct, parenthesized, or via
        // identifier-to-const resolution. This handles `setRefreshCookies`:
        //   const config = { method: 'post', url: 'auth/refresh' };
        //   if (!data) return config;        // <- this one resolves
        //   return { ...config, data: {} };  // spread; harder, skip
        for (const ret of collectDirectReturns(body)) {
            const e = ret.getExpression();
            if (!e) continue;
            if (Node.isObjectLiteralExpression(e)) { returned = e; break; }
            if (Node.isParenthesizedExpression(e)) {
                const inner = e.getExpression();
                if (Node.isObjectLiteralExpression(inner)) { returned = inner; break; }
            }
            if (Node.isIdentifier(e)) {
                const resolved = resolveIdentifierToObjectLiteral(body, e.getText());
                if (resolved) { returned = resolved; break; }
            }
        }
    }

    if (!returned) {
        // Fallback for the Pass-style inline-call shape:
        //   export const foo = async (...) => api({ url, method, ... })
        //   export const bar = async (...) => { const r = await api({ url, method }); return r.X }
        // Walk the function body for the first `api({...})` CallExpression whose
        // first arg is an object literal with `url`+`method`.
        returned = findApiCallDescriptor(fn);
    }

    if (!returned) {
        return { op: null, reason: 'no object literal return' };
    }

    const methodProp = returned.getProperty('method');
    const urlProp = returned.getProperty('url');
    if (!methodProp || !urlProp) {
        return { op: null, reason: 'missing method or url' };
    }

    const method = readPropertyExpr(methodProp, getMethodLiteral) as HttpMethod | null;
    if (!method) {
        return { op: null, reason: 'method is not a literal http verb' };
    }

    const urlExpr = readPropertyExprNode(urlProp);
    if (!urlExpr) return { op: null, reason: 'url has no expression' };
    const urlParsed = parseUrlExpression(urlExpr);
    if (!urlParsed) {
        return { op: null, reason: 'url is not statically resolvable' };
    }

    const notes: string[] = [];

    // Optional `input: 'form'`.
    let bodyKind: 'json' | 'form' | 'none' = 'none';
    const inputProp = returned.getProperty('input');
    if (inputProp) {
        const v = readPropertyExpr(inputProp, (e) =>
            Node.isStringLiteral(e) ? e.getLiteralText() : null,
        );
        if (v === 'form') bodyKind = 'form';
    }

    const dataProp = returned.getProperty('data');
    if (dataProp && bodyKind === 'none') bodyKind = 'json';

    // Collect parameter type text from the function's parameters so we can
    // surface them in the spec even before we plumb full JSON-schema resolution.
    const paramTypeMap = collectParamTypeMap(fn.getParameters());

    const queryProp = returned.getProperty('params');
    const queryParams: ParamDescriptor[] = queryProp
        ? readObjectShorthandKeys(queryProp).map((k) => ({
              name: k,
              typeText: paramTypeMap.get(k) ?? 'unknown',
              required: false,
          }))
        : [];

    const bodyProperties: ParamDescriptor[] = dataProp
        ? (() => {
              const direct = readObjectShorthandKeys(dataProp);
              if (direct.length > 0) {
                  return direct.map((k) => ({
                      name: k,
                      typeText: paramTypeMap.get(k) ?? 'unknown',
                      required: !paramTypeMap.get(k)?.includes('undefined'),
                  }));
              }
              // `data` may be a passthrough identifier (e.g., `data` itself or `messageID, data`)
              const dataIdent = readPropertyExprNode(dataProp);
              if (dataIdent && Node.isIdentifier(dataIdent)) {
                  const t = paramTypeMap.get(dataIdent.getText()) ?? 'unknown';
                  notes.push(`body is passthrough of parameter \`${dataIdent.getText()}: ${t}\``);
                  return [
                      {
                          name: dataIdent.getText(),
                          typeText: t,
                          required: true,
                      },
                  ];
              }
              return [];
          })()
        : [];

    const pathParams: ParamDescriptor[] = urlParsed.pathParamNames.map((name) => ({
        name,
        typeText: paramTypeMap.get(name) ?? 'string',
        required: true,
    }));

    if (paramTypeMap.size === 0) {
        notes.push('no static type info recovered for parameters');
    }

    return {
        op: {
            operationId,
            tag,
            sourceFile,
            sourceLine: decl.getStartLineNumber(),
            method,
            url: urlParsed.url,
            pathParams,
            queryParams,
            bodyProperties,
            bodyKind,
            notes,
        },
    };
}

function readPropertyExpr<T>(
    prop: ReturnType<ObjectLiteralExpression['getProperty']> & {},
    fn: (e: Expression) => T | null,
): T | null {
    const e = readPropertyExprNode(prop);
    if (!e) return null;
    return fn(e);
}

function readPropertyExprNode(
    prop: NonNullable<ReturnType<ObjectLiteralExpression['getProperty']>>,
): Expression | null {
    let expr: Expression | null = null;
    if (Node.isPropertyAssignment(prop)) expr = prop.getInitializer() ?? null;
    else if (Node.isShorthandPropertyAssignment(prop)) expr = prop.getNameNode() as unknown as Expression;
    if (!expr) return null;
    // Unwrap `{ ... } satisfies T` and `{ ... } as T` so callers see the inner literal.
    while (Node.isSatisfiesExpression(expr) || Node.isAsExpression(expr)) {
        expr = expr.getExpression() ?? null;
        if (!expr) return null;
    }
    return expr;
}

/**
 * Walk an arrow-function body for the first `api({ url, method, ... })` call.
 * Returns the first-argument object literal when it has both `url` and `method`
 * properties; otherwise returns null. Skips descendants nested inside other
 * functions so we don't grab `api` calls from helper closures.
 */
function findApiCallDescriptor(fn: ArrowFunction): ObjectLiteralExpression | null {
    const body = fn.getBody();
    let found: ObjectLiteralExpression | null = null;
    function walk(n: import('ts-morph').Node) {
        if (found) return;
        if (
            n !== body &&
            (Node.isArrowFunction(n) ||
                Node.isFunctionDeclaration(n) ||
                Node.isFunctionExpression(n) ||
                Node.isMethodDeclaration(n))
        ) {
            return;
        }
        if (Node.isCallExpression(n)) {
            const callee = n.getExpression();
            if (Node.isIdentifier(callee) && callee.getText() === 'api') {
                const args = n.getArguments();
                if (args.length > 0) {
                    let arg: Expression | null = args[0] as Expression;
                    while (
                        arg &&
                        (Node.isSatisfiesExpression(arg) || Node.isAsExpression(arg) || Node.isParenthesizedExpression(arg))
                    ) {
                        arg = (arg as any).getExpression() ?? null;
                    }
                    if (arg && Node.isObjectLiteralExpression(arg)) {
                        if (arg.getProperty('url') && arg.getProperty('method')) {
                            found = arg;
                            return;
                        }
                    }
                }
            }
        }
        n.forEachChild(walk);
    }
    walk(body);
    return found;
}

/**
 * Given an `ObjectLiteralExpression` like `{ A, B, C: foo, D: bar }`, return
 * the canonical OpenAPI key names. For `C: foo`, the key is `C`.
 */
function readObjectShorthandKeys(
    prop: NonNullable<ReturnType<ObjectLiteralExpression['getProperty']>>,
): string[] {
    const expr = readPropertyExprNode(prop);
    if (!expr || !Node.isObjectLiteralExpression(expr)) return [];
    const keys: string[] = [];
    for (const p of expr.getProperties()) {
        if (Node.isShorthandPropertyAssignment(p)) keys.push(p.getName());
        else if (Node.isPropertyAssignment(p)) keys.push(p.getName());
    }
    return keys;
}

/**
 * Collect a map of parameter-name → type-text from the function's parameter list.
 * Handles destructuring patterns: `({ A, B }: SomeType)` records each destructured
 * name and recovers its type from `SomeType` via the TS type-checker.
 */
function collectDirectReturns(scope: Block) {
    const out: import('ts-morph').ReturnStatement[] = [];
    function walk(n: import('ts-morph').Node) {
        if (
            Node.isArrowFunction(n) ||
            Node.isFunctionDeclaration(n) ||
            Node.isFunctionExpression(n) ||
            Node.isMethodDeclaration(n)
        ) {
            return; // don't descend into nested functions
        }
        if (Node.isReturnStatement(n)) {
            out.push(n);
            return;
        }
        n.forEachChild(walk);
    }
    scope.forEachChild(walk);
    return out;
}

function resolveIdentifierToObjectLiteral(scope: Block, name: string): ObjectLiteralExpression | null {
    for (const stmt of scope.getStatements()) {
        if (!Node.isVariableStatement(stmt)) continue;
        for (const decl of stmt.getDeclarationList().getDeclarations()) {
            if (decl.getName() !== name) continue;
            const init = decl.getInitializer();
            if (init && Node.isObjectLiteralExpression(init)) return init;
            if (init && Node.isParenthesizedExpression(init)) {
                const inner = init.getExpression();
                if (Node.isObjectLiteralExpression(inner)) return inner;
            }
        }
    }
    return null;
}

function collectParamTypeMap(params: ParameterDeclaration[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const p of params) {
        const nameNode = p.getNameNode();
        if (Node.isIdentifier(nameNode)) {
            out.set(nameNode.getText(), p.getType().getText());
            continue;
        }
        if (Node.isObjectBindingPattern(nameNode)) {
            const paramType = p.getType();
            for (const element of nameNode.getElements()) {
                const ident = element.getNameNode();
                if (!Node.isIdentifier(ident)) continue;
                const key = element.getPropertyNameNode()?.getText() ?? ident.getText();
                const prop = paramType.getProperty(key);
                if (prop) {
                    const t = prop.getTypeAtLocation(element).getText();
                    out.set(ident.getText(), t);
                } else {
                    out.set(ident.getText(), 'unknown');
                }
            }
            continue;
        }
    }
    return out;
}
