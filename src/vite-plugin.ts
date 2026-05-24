import type { Plugin } from "vite";
import ts from "typescript";
import * as path from "path";
import * as fs from "fs";
import MagicString from "magic-string";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExtExport {
    /** Original exported function name, e.g. "toUserDto" */
    name: string;
    /** First parameter type text, e.g. "User" */
    typeName: string;
    /** Import alias: typeName + Capitalize(name), e.g. "UserToUserDto" */
    alias: string;
    /** Return type text, e.g. "UserDto", or "" if unavailable */
    returnTypeName: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Vite plugin that enables "extension methods" syntax for TypeScript.
 *
 * Two transformations are applied:
 *
 * 1. Side-effect imports of `.ext` files are expanded to aliased named imports:
 *      import './user.ext'
 *    becomes (when User is the extended type):
 *      import { toUserDto as UserToUserDto } from './user.ext'
 *
 *    This avoids name collisions when two `.ext` files export a method with the
 *    same name but for different types.
 *
 * 2. Extension-method call expressions are rewritten to aliased function calls:
 *      user.toUserDto()              →  UserToUserDto(user)
 *      user.toUserDto(123, "x")      →  UserToUserDto(user, 123, "x")
 *
 *    The correct alias is selected by resolving the receiver's type via the
 *    TypeScript type checker (with fallback chain-tracking for chained ext calls).
 */
export function tsExtensionsPlugin(): Plugin {
    // Cache: tsconfig absolute path → ts.Program (rebuilt on each build start)
    const programCache = new Map<string, ts.Program>();

    function getProgram(filePath: string): ts.Program | null {
        const configPath = ts.findConfigFile(
            path.dirname(filePath),
            ts.sys.fileExists,
            "tsconfig.json",
        );
        if (!configPath) return null;

        const cached = programCache.get(configPath);
        if (cached) return cached;

        const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
        if (error) return null;

        const parsed = ts.parseJsonConfigFileContent(
            config,
            ts.sys,
            path.dirname(configPath),
        );

        const program = ts.createProgram(parsed.fileNames, parsed.options);
        programCache.set(configPath, program);
        return program;
    }

    return {
        name: "vite-plugin-ts-extensions",
        enforce: "pre",

        buildStart() {
            programCache.clear();
        },

        watchChange(changedId) {
            if (/\.(ts|tsx)$/.test(changedId)) {
                programCache.clear();
            }
        },

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
            // Pass 1 – collect ext imports, resolve exports, rewrite to aliases
            // ------------------------------------------------------------------

            /**
             * methodName → candidates from each .ext file that exports it.
             * When two .ext files export the same name for different types both
             * entries will be here; the correct one is selected in Pass 2 by
             * checking the receiver's type.
             */
            const methodCandidates = new Map<
                string,
                { alias: string; typeName: string; returnTypeName: string }[]
            >();

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

                for (const exp of exports) {
                    if (!methodCandidates.has(exp.name)) {
                        methodCandidates.set(exp.name, []);
                    }
                    methodCandidates.get(exp.name)!.push({
                        alias: exp.alias,
                        typeName: exp.typeName,
                        returnTypeName: exp.returnTypeName,
                    });
                }

                // Rewrite:  import './user.ext'
                //     →     import { toUserDto as UserToUserDto, toUser as UserDtoToUser } from './user.ext'
                const bareSpecifier = specifier.replace(/\.ts$/, "");
                const specs = exports.map(e => `${e.name} as ${e.alias}`).join(", ");

                s.overwrite(
                    stmt.getStart(sourceFile),
                    stmt.getEnd(),
                    `import { ${specs} } from '${bareSpecifier}'`,
                );
            }

            // Nothing to do if no ext methods are in scope
            if (methodCandidates.size === 0) return null;

            // ------------------------------------------------------------------
            // Pass 2 – type-aware rewrite of extension-method call expressions
            // ------------------------------------------------------------------
            //
            // Type resolution order for the receiver of `receiver.method(args)`:
            //
            //   (a) If receiver is itself an ext call we already processed →
            //       use the return type we recorded (handles chained calls).
            //   (b) If receiver is an identifier that was assigned from an ext
            //       call → use the return type we recorded for that call.
            //   (c) Ask the TypeScript type checker via ts.createProgram.
            //   (d) If exactly one candidate → use it regardless (safe fallback).
            //   (e) Cannot disambiguate → leave call as-is.
            //
            // The AST is traversed post-order (children before parents) so that
            // chained calls are handled correctly.
            // ------------------------------------------------------------------

            // Lazily obtain a TypeScript program for type resolution
            const program = getProgram(id);
            const typeChecker = program?.getTypeChecker() ?? null;

            // The program's source file may be keyed by a normalized path
            const programSF: ts.SourceFile | null = program
                ? (program.getSourceFile(id) ??
                   program.getSourceFile(normalizePath(id)) ??
                   null)
                : null;

            /** varName → resolved type name (for variables assigned from ext calls) */
            const varTypeMap = new Map<string, string>();

            /** Maps a CallExpression node → its fully-transformed text. */
            const callTransforms = new Map<ts.CallExpression, string>();

            /** Maps a CallExpression node → return type name of the matched export. */
            const callReturnTypes = new Map<ts.CallExpression, string>();

            /** Find a node in `psf` whose [start, end) positions match. */
            function findNodeByPos(
                psf: ts.SourceFile,
                start: number,
                end: number,
            ): ts.Node | undefined {
                function seek(node: ts.Node): ts.Node | undefined {
                    const ns = node.getStart(psf);
                    const ne = node.getEnd();
                    if (ns === start && ne === end) return node;
                    if (ns > end || ne < start) return undefined;
                    return ts.forEachChild(node, seek);
                }
                return seek(psf);
            }

            /** Resolve the type name for `expr` using all available sources. */
            function resolveTypeName(expr: ts.Expression): string | null {
                // (a) Chained ext call whose return type we already tracked
                if (ts.isCallExpression(expr) && callReturnTypes.has(expr)) {
                    return callReturnTypes.get(expr)!;
                }

                // (b) Identifier known from our variable-assignment tracker
                if (ts.isIdentifier(expr) && varTypeMap.has(expr.text)) {
                    return varTypeMap.get(expr.text)!;
                }

                // (c) TypeScript type checker
                if (typeChecker && programSF) {
                    const pNode = findNodeByPos(
                        programSF,
                        expr.getStart(sourceFile),
                        expr.getEnd(),
                    );
                    if (pNode) {
                        const tsType = typeChecker.getTypeAtLocation(pNode);
                        if (
                            !(tsType.flags & ts.TypeFlags.Any) &&
                            !(tsType.flags & ts.TypeFlags.Unknown)
                        ) {
                            return typeChecker.typeToString(tsType);
                        }
                    }
                }

                return null;
            }

            function visitPost(node: ts.Node): void {
                // Visit children first (post-order)
                ts.forEachChild(node, visitPost);

                // Track variable assignments for chain-of-ext-calls resolution:
                //   const result = user.toUserDto()  →  "result" maps to "UserDto"
                if (
                    ts.isVariableDeclaration(node) &&
                    ts.isIdentifier(node.name) &&
                    node.initializer
                ) {
                    const varName = node.name.text;
                    const init = node.initializer;
                    if (ts.isCallExpression(init) && callReturnTypes.has(init)) {
                        varTypeMap.set(varName, callReturnTypes.get(init)!);
                    } else if (ts.isIdentifier(init) && varTypeMap.has(init.text)) {
                        varTypeMap.set(varName, varTypeMap.get(init.text)!);
                    }
                    return;
                }

                if (
                    !ts.isCallExpression(node) ||
                    !ts.isPropertyAccessExpression(node.expression) ||
                    !ts.isIdentifier(node.expression.name)
                ) {
                    return;
                }

                const methodName = node.expression.name.text;
                const candidates = methodCandidates.get(methodName);
                if (!candidates || candidates.length === 0) return;

                const receiver = node.expression.expression;
                const receiverTypeName = resolveTypeName(receiver);

                // Pick the candidate whose typeName matches the resolved receiver type
                let match: (typeof candidates)[0] | undefined;
                if (receiverTypeName) {
                    match = candidates.find(c => c.typeName === receiverTypeName);
                }
                // Fallback: if there is only one candidate, use it unconditionally
                if (!match) {
                    if (candidates.length === 1) {
                        match = candidates[0];
                    } else {
                        return; // cannot disambiguate — leave the call as-is
                    }
                }

                // Receiver text: prefer the already-transformed text if the receiver
                // is itself an ext-method call we just handled.
                const receiverText =
                    ts.isCallExpression(receiver) && callTransforms.has(receiver)
                        ? callTransforms.get(receiver)!
                        : code.slice(receiver.getStart(sourceFile), receiver.getEnd());

                // Argument texts: same logic for arguments that are ext calls.
                const argTexts = Array.from(node.arguments).map(arg =>
                    ts.isCallExpression(arg) && callTransforms.has(arg)
                        ? callTransforms.get(arg)!
                        : code.slice(arg.getStart(sourceFile), arg.getEnd()),
                );

                const transformed = `${match.alias}(${[receiverText, ...argTexts].join(", ")})`;
                callTransforms.set(node, transformed);
                if (match.returnTypeName) {
                    callReturnTypes.set(node, match.returnTypeName);
                }
            }

            visitPost(sourceFile);

            // ------------------------------------------------------------------
            // Apply replacements – only for "outermost" ext-call nodes.
            // ------------------------------------------------------------------

            for (const [node, transformed] of callTransforms) {
                const nodeStart = node.getStart(sourceFile);
                const nodeEnd = node.getEnd();

                const isContained = Array.from(callTransforms.keys()).some(other => {
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

function normalizePath(p: string): string {
    return p.replace(/\\/g, "/");
}

/**
 * Generates the alias name for an ext export.
 *   makeAlias("User", "toUserDto") → "UserToUserDto"
 *   makeAlias("UserDto", "toUser") → "UserDtoToUser"
 */
function makeAlias(typeName: string, methodName: string): string {
    return typeName + methodName[0].toUpperCase() + methodName.slice(1);
}

/**
 * Reads a `.ext.ts` file and returns metadata for all exported top-level
 * functions (both `function` declarations and `const fn = () => …` forms),
 * including the first-parameter type name and return type name.
 */
function readExtFileExports(filePath: string): ExtExport[] {
    if (!fs.existsSync(filePath)) return [];

    let content: string;
    try {
        content = fs.readFileSync(filePath, "utf-8");
    } catch {
        return [];
    }

    const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.ESNext, true);
    const exports: ExtExport[] = [];

    for (const stmt of sf.statements) {
        const hasExport = (stmt as ts.HasModifiers).modifiers?.some(
            m => m.kind === ts.SyntaxKind.ExportKeyword,
        );
        if (!hasExport) continue;

        if (ts.isFunctionDeclaration(stmt) && stmt.name) {
            if (stmt.parameters.length === 0) continue;
            const firstParam = stmt.parameters[0];
            const typeName = firstParam.type?.getText(sf).trim() ?? "";
            if (!typeName) continue;
            const returnTypeName = stmt.type?.getText(sf).trim() ?? "";
            exports.push({
                name: stmt.name.text,
                typeName,
                alias: makeAlias(typeName, stmt.name.text),
                returnTypeName,
            });
        } else if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (
                    ts.isIdentifier(decl.name) &&
                    decl.initializer &&
                    (ts.isArrowFunction(decl.initializer) ||
                        ts.isFunctionExpression(decl.initializer))
                ) {
                    const fn = decl.initializer;
                    if (fn.parameters.length === 0) continue;
                    const firstParam = fn.parameters[0];
                    const typeName = firstParam.type?.getText(sf).trim() ?? "";
                    if (!typeName) continue;
                    const returnTypeName = fn.type?.getText(sf).trim() ?? "";
                    exports.push({
                        name: decl.name.text,
                        typeName,
                        alias: makeAlias(typeName, decl.name.text),
                        returnTypeName,
                    });
                }
            }
        }
    }

    return exports;
}
