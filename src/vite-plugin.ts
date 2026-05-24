import type { Plugin } from "vite";
import ts from "typescript";
import * as path from "path";
import * as fs from "fs";
import MagicString from "magic-string";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Vite plugin that enables "extension methods" syntax for TypeScript.
 *
 * Two transformations are applied:
 *
 * 1. Side-effect imports of `.ext` files are expanded to named imports:
 *      import './user.ext'
 *    becomes:
 *      import { toAdmin } from './user.ext'
 *
 * 2. Extension-method call expressions are rewritten to plain function calls:
 *      user.toAdmin()              →  toAdmin(user)
 *      user.toUserDto(123, "x")   →  toUserDto(user, 123, "x")
 */
export function tsExtensionsPlugin(): Plugin {
    return {
        name: "vite-plugin-ts-extensions",
        enforce: "pre",

        transform(code: string, id: string) {
            // Only process TS / JS files
            if (!/\.(ts|tsx|js|jsx|mts|cts)$/.test(id)) return null;

            // Never transform the ext files themselves
            if (/\.ext\.(ts|js|mts|cts|tsx|jsx)$/.test(id)) return null;

            const s = new MagicString(code);

            // Parse the original source once so every position reference is
            // stable and maps back to the unmodified `code` string.
            const sourceFile = ts.createSourceFile(
                id,
                code,
                ts.ScriptTarget.ESNext,
                /* setParentNodes */ true,
            );

            // ------------------------------------------------------------------
            // Pass 1 – collect ext imports and resolve their exported functions
            // ------------------------------------------------------------------

            /** All extension-method names visible in this file. */
            const extMethods = new Set<string>();

            for (const stmt of sourceFile.statements) {
                if (!ts.isImportDeclaration(stmt)) continue;
                if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;

                const specifier = stmt.moduleSpecifier.text;
                if (!/\.ext(\.ts)?$/.test(specifier)) continue;

                // Only handle bare side-effect imports (no import clause).
                // Named imports like `import { toAdmin } from './user.ext'` are
                // already correct – skip them.
                if (stmt.importClause) continue;

                const dir = path.dirname(id);
                let resolved = path.resolve(dir, specifier);
                if (!resolved.endsWith(".ts")) resolved += ".ts";

                const exports = readExtFileExports(resolved);
                if (exports.length === 0) continue;

                exports.forEach((e) => extMethods.add(e));

                // Rewrite:  import './user.ext'
                //     →     import { toAdmin } from './user.ext'
                const bareSpecifier = specifier.replace(/\.ts$/, "");
                const newImport = `import { ${exports.join(", ")} } from '${bareSpecifier}'`;

                s.overwrite(
                    stmt.getStart(sourceFile),
                    stmt.getEnd(),
                    newImport,
                );
            }

            // Nothing to do if no ext methods are in scope
            if (extMethods.size === 0) return null;

            // ------------------------------------------------------------------
            // Pass 2 – rewrite extension-method call expressions
            // ------------------------------------------------------------------
            //
            // Strategy (handles chained calls correctly):
            //
            //   a) Visit the AST in *post-order* (children before parent).
            //   b) For every CallExpression that looks like  expr.extMethod(args)
            //      compute its transformed text, merging any inner-call
            //      transformations collected in the same pass.
            //   c) Apply only the *outermost* replacements to MagicString so
            //      that we never overwrite overlapping ranges.
            // ------------------------------------------------------------------

            /** Maps a CallExpression node → its fully-transformed text. */
            const callTransforms = new Map<ts.CallExpression, string>();

            function visitPost(node: ts.Node): void {
                // Visit children first (post-order)
                ts.forEachChild(node, visitPost);

                if (
                    !ts.isCallExpression(node) ||
                    !ts.isPropertyAccessExpression(node.expression) ||
                    !ts.isIdentifier(node.expression.name) ||
                    !extMethods.has(node.expression.name.text)
                ) {
                    return;
                }

                const propAccess = node.expression;
                const methodName = propAccess.name.text;
                const receiver = propAccess.expression;

                // Receiver text: use the already-computed transform if the
                // receiver is itself an ext-method call that we just handled.
                const receiverText = ts.isCallExpression(receiver) && callTransforms.has(receiver)
                    ? callTransforms.get(receiver)!
                    : code.slice(receiver.getStart(sourceFile), receiver.getEnd());

                // Argument texts: same logic for arguments that are ext calls.
                const argTexts = Array.from(node.arguments).map((arg) => {
                    return ts.isCallExpression(arg) && callTransforms.has(arg)
                        ? callTransforms.get(arg)!
                        : code.slice(arg.getStart(sourceFile), arg.getEnd());
                });

                const allArgs = [receiverText, ...argTexts].join(", ");
                callTransforms.set(node, `${methodName}(${allArgs})`);
            }

            visitPost(sourceFile);

            // ------------------------------------------------------------------
            // Apply replacements – only for "outermost" ext-call nodes, i.e.
            // those whose span is not entirely enclosed by another replacement.
            // ------------------------------------------------------------------

            for (const [node, transformed] of callTransforms) {
                const nodeStart = node.getStart(sourceFile);
                const nodeEnd = node.getEnd();

                const isContained = Array.from(callTransforms.keys()).some((other) => {
                    if (other === node) return false;
                    const os = other.getStart(sourceFile);
                    const oe = other.getEnd();
                    return os <= nodeStart && nodeEnd <= oe;
                });

                if (!isContained) {
                    s.overwrite(nodeStart, nodeEnd, transformed);
                }
            }

            return {
                code: s.toString(),
                map: s.generateMap({ hires: true }),
            };
        },
    };
}

export default tsExtensionsPlugin;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reads a `.ext.ts` file and returns the names of all exported top-level
 * functions (both `function` declarations and `const fn = () => …` forms).
 */
function readExtFileExports(filePath: string): string[] {
    if (!fs.existsSync(filePath)) return [];

    let content: string;
    try {
        content = fs.readFileSync(filePath, "utf-8");
    } catch {
        return [];
    }

    const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.ESNext, true);
    const exports: string[] = [];

    for (const stmt of sf.statements) {
        const hasExport = (stmt as ts.HasModifiers).modifiers?.some(
            (m) => m.kind === ts.SyntaxKind.ExportKeyword,
        );
        if (!hasExport) continue;

        if (ts.isFunctionDeclaration(stmt) && stmt.name) {
            exports.push(stmt.name.text);
        } else if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (
                    ts.isIdentifier(decl.name) &&
                    decl.initializer &&
                    (ts.isArrowFunction(decl.initializer) ||
                        ts.isFunctionExpression(decl.initializer))
                ) {
                    exports.push(decl.name.text);
                }
            }
        }
    }

    return exports;
}




