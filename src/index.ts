import ts from "typescript/lib/tsserverlibrary";
import * as path from "path";

function init(modules: { typescript: typeof ts }) {
    const ts = modules.typescript;

    interface ExtMethod {
        name: string;
        params: ts.NodeArray<ts.ParameterDeclaration>;
        firstParamType: ts.Type;
        returnType: ts.Type;
        sourceFileName: string;
    }

    function create(info: ts.server.PluginCreateInfo): ts.LanguageService {
        info.project.projectService.logger.info("[ts-extensions-test] Plugin loaded!");

        const proxy = Object.create(null) as ts.LanguageService;
        for (const k of Object.keys(info.languageService) as Array<keyof ts.LanguageService>) {
            const original = info.languageService[k];
            if (typeof original === "function") {
                (proxy as any)[k] = (...args: any[]) => (original as any)(...args);
            }
        }

        // ---- getCompletionsAtPosition ----
        proxy.getCompletionsAtPosition = (fileName, position, options) => {
            const prior = info.languageService.getCompletionsAtPosition(fileName, position, options);
            try {
                const program = info.languageService.getProgram();
                if (!program) return prior;
                const sourceFile = program.getSourceFile(fileName);
                if (!sourceFile) return prior;
                const typeChecker = program.getTypeChecker();

                const accessExpr = findPropertyAccessAt(sourceFile, position);
                if (!accessExpr) return prior;

                const objType = typeChecker.getTypeAtLocation(accessExpr.expression);

                // Cover only the partial name AFTER the dot — "user." stays in the file
                const nameStart = accessExpr.name.getStart(sourceFile);
                const replacementSpan: ts.TextSpan = {
                    start: nameStart,
                    length: position - nameStart,
                };

                const extEntries = collectExtensionMethods(program, typeChecker)
                    .filter(m => typesMatch(objType, m.firstParamType, typeChecker))
                    .map(m => makeCompletionEntry(m, typeChecker, replacementSpan));

                if (extEntries.length === 0) return prior;

                const entries = prior ? [...prior.entries, ...extEntries] : extEntries;
                return prior
                    ? { ...prior, entries }
                    : { isGlobalCompletion: false, isMemberCompletion: true, isNewIdentifierLocation: false, entries };
            } catch (e) {
                info.project.projectService.logger.info(`[ts-extensions-test] Error in getCompletionsAtPosition: ${e}`);
                return prior;
            }
        };

        // ---- getCompletionEntryDetails (auto-import) ----
        proxy.getCompletionEntryDetails = (fileName, position, entryName, formatOptions, source, preferences, data) => {
            if (source && source.endsWith(".ext.ts")) {
                try {
                    const program = info.languageService.getProgram();
                    if (!program) return undefined;
                    const sourceFile = program.getSourceFile(fileName);
                    if (!sourceFile) return undefined;

                    const codeActions: ts.CodeAction[] = [];
                    if (!isAlreadyImported(sourceFile, entryName)) {
                        const relativePath = computeRelativePath(fileName, source);
                        const insertPosition = findImportInsertPosition(sourceFile);
                        codeActions.push({
                            description: `Import '${entryName}' from '${relativePath}'`,
                            changes: [{
                                fileName,
                                textChanges: [{
                                    span: { start: insertPosition, length: 0 },
                                    newText: `import { ${entryName} } from '${relativePath}';\n`,
                                }],
                            }],
                        });
                    }

                    return {
                        name: entryName,
                        kind: ts.ScriptElementKind.functionElement,
                        kindModifiers: "",
                        displayParts: [{ text: entryName, kind: "text" }],
                        documentation: [],
                        codeActions: codeActions.length > 0 ? codeActions : undefined,
                    };
                } catch (e) {
                    info.project.projectService.logger.info(`[ts-extensions-test] Error in getCompletionEntryDetails: ${e}`);
                    return undefined;
                }
            }
            return info.languageService.getCompletionEntryDetails(
                fileName, position, entryName, formatOptions, source, preferences, data
            );
        };

        // ---- getSemanticDiagnostics — suppress TS2339/TS2349 for extension method accesses,
        //      then add our own type-checking diagnostics for those calls ----
        proxy.getSemanticDiagnostics = (fileName) => {
            const diagnostics = info.languageService.getSemanticDiagnostics(fileName);
            try {
                const program = info.languageService.getProgram();
                if (!program) return diagnostics;
                const sourceFile = program.getSourceFile(fileName);
                if (!sourceFile) return diagnostics;
                const typeChecker = program.getTypeChecker();
                const extMethods = collectExtensionMethods(program, typeChecker);
                if (extMethods.length === 0) return diagnostics;

                const filtered = diagnostics.filter(diag => {
                    // 2339 = Property 'X' does not exist on type 'Y'
                    // 2349 = This expression is not callable
                    if (
                        (diag.code === 2339 || diag.code === 2349) &&
                        diag.start !== undefined
                    ) {
                        const node = findNodeAtPosition(sourceFile, diag.start);
                        if (node) {
                            let propAccess: ts.PropertyAccessExpression | undefined;
                            if (ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent)) {
                                propAccess = node.parent;
                            } else if (ts.isPropertyAccessExpression(node)) {
                                propAccess = node;
                            }
                            if (propAccess) {
                                const objType = typeChecker.getTypeAtLocation(propAccess.expression);
                                const propName = propAccess.name.text;
                                const isExt = extMethods.some(
                                    m => m.name === propName && typesMatch(objType, m.firstParamType, typeChecker)
                                );
                                if (isExt) return false; // suppress
                            }
                        }
                    }
                    return true;
                });

                const extra = checkExtensionMethodCalls(sourceFile, typeChecker, extMethods);
                return [...filtered, ...extra];
            } catch (e) {
                info.project.projectService.logger.info(`[ts-extensions-test] Error in getSemanticDiagnostics: ${e}`);
                return diagnostics;
            }
        };

        // ---- getSignatureHelpItems — parameter hints inside user.toUserDto(|) ----
        proxy.getSignatureHelpItems = (fileName, position, options) => {
            const prior = info.languageService.getSignatureHelpItems(fileName, position, options);
            // Only intervene when the underlying LS has nothing to offer
            if (prior) return prior;

            try {
                const program = info.languageService.getProgram();
                if (!program) return prior;
                const sourceFile = program.getSourceFile(fileName);
                if (!sourceFile) return prior;
                const typeChecker = program.getTypeChecker();

                const callExpr = findCallExpressionAt(sourceFile, position);
                if (!callExpr || !ts.isPropertyAccessExpression(callExpr.expression)) return prior;

                const propAccess = callExpr.expression;
                const objType = typeChecker.getTypeAtLocation(propAccess.expression);
                const propName = propAccess.name.text;

                const extMethods = collectExtensionMethods(program, typeChecker);
                const match = extMethods.find(
                    m => m.name === propName && typesMatch(objType, m.firstParamType, typeChecker)
                );
                if (!match) return prior;

                // Params shown to the user = everything except the implicit first param (the object)
                const restParams = Array.from(match.params).slice(1);
                const returnTypeStr = typeChecker.typeToString(match.returnType);

                const sigParams: ts.SignatureHelpParameter[] = restParams.map(p => {
                    const pName = ts.isIdentifier(p.name) ? p.name.text : "_";
                    const pType = typeChecker.typeToString(typeChecker.getTypeAtLocation(p));
                    return {
                        name: pName,
                        documentation: [],
                        displayParts: [
                            { text: pName, kind: "parameterName" },
                            { text: ": ", kind: "punctuation" },
                            { text: pType, kind: "keyword" },
                        ],
                        isOptional: !!p.questionToken || p.initializer !== undefined,
                    };
                });

                // Which argument slot is the cursor in?
                let argumentIndex = 0;
                const args = callExpr.arguments;
                for (let i = 0; i < args.length; i++) {
                    if (position <= args[i].end) { argumentIndex = i; break; }
                    argumentIndex = i + 1;
                }

                const signature: ts.SignatureHelpItem = {
                    isVariadic: false,
                    prefixDisplayParts: [
                        { text: match.name, kind: "functionName" },
                        { text: "(", kind: "punctuation" },
                    ],
                    suffixDisplayParts: [
                        { text: ")", kind: "punctuation" },
                        { text: ": ", kind: "punctuation" },
                        { text: returnTypeStr, kind: "keyword" },
                    ],
                    separatorDisplayParts: [
                        { text: ",", kind: "punctuation" },
                        { text: " ", kind: "space" },
                    ],
                    parameters: sigParams,
                    documentation: [],
                    tags: [],
                };

                return {
                    items: [signature],
                    applicableSpan: { start: args.pos, length: args.end - args.pos },
                    selectedItemIndex: 0,
                    argumentIndex,
                    argumentCount: args.length,
                };
            } catch (e) {
                info.project.projectService.logger.info(`[ts-extensions-test] Error in getSignatureHelpItems: ${e}`);
                return prior;
            }
        };

        // ---- getQuickInfoAtPosition — hover tooltip for user.toUserDto ----
        proxy.getQuickInfoAtPosition = (fileName, position) => {
            try {
                const program = info.languageService.getProgram();
                if (program) {
                    const sourceFile = program.getSourceFile(fileName);
                    if (sourceFile) {
                        const typeChecker = program.getTypeChecker();

                        const node = findNodeAtPosition(sourceFile, position);
                        if (node && ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
                            const propAccess = node.parent;
                            const objType = typeChecker.getTypeAtLocation(propAccess.expression);
                            const propName = node.text;

                            const extMethods = collectExtensionMethods(program, typeChecker);
                            const match = extMethods.find(
                                m => m.name === propName && typesMatch(objType, m.firstParamType, typeChecker)
                            );

                            if (match) {
                                const restParams = Array.from(match.params).slice(1);
                                const returnTypeStr = typeChecker.typeToString(match.returnType);

                                const paramParts: ts.SymbolDisplayPart[] = [];
                                restParams.forEach((p, i) => {
                                    if (i > 0) paramParts.push({ text: ", ", kind: "punctuation" });
                                    const pName = ts.isIdentifier(p.name) ? p.name.text : "_";
                                    const pType = typeChecker.typeToString(typeChecker.getTypeAtLocation(p));
                                    paramParts.push({ text: pName, kind: "parameterName" });
                                    paramParts.push({ text: ": ", kind: "punctuation" });
                                    paramParts.push({ text: pType, kind: "keyword" });
                                });

                                return {
                                    kind: ts.ScriptElementKind.functionElement,
                                    kindModifiers: "",
                                    textSpan: { start: node.getStart(sourceFile), length: node.getWidth(sourceFile) },
                                    displayParts: [
                                        { text: "(", kind: "punctuation" },
                                        { text: "extension method", kind: "text" },
                                        { text: ")", kind: "punctuation" },
                                        { text: " ", kind: "space" },
                                        { text: propName, kind: "functionName" },
                                        { text: "(", kind: "punctuation" },
                                        ...paramParts,
                                        { text: ")", kind: "punctuation" },
                                        { text: ": ", kind: "punctuation" },
                                        { text: returnTypeStr, kind: "keyword" },
                                    ],
                                    documentation: [],
                                };
                            }
                        }
                    }
                }
            } catch (e) {
                info.project.projectService.logger.info(`[ts-extensions-test] Error in getQuickInfoAtPosition: ${e}`);
            }

            return info.languageService.getQuickInfoAtPosition(fileName, position);
        };

        return proxy;
    }

    // ---- Collect all extension methods from *.ext.ts files in the program ----

    function collectExtensionMethods(program: ts.Program, typeChecker: ts.TypeChecker): ExtMethod[] {
        const result: ExtMethod[] = [];
        for (const sf of program.getSourceFiles()) {
            if (!sf.fileName.endsWith(".ext.ts")) continue;
            for (const stmt of sf.statements) {
                const m = extractExtMethod(stmt, sf, typeChecker);
                if (m) result.push(m);
            }
        }
        return result;
    }

    // ---- Type-check calls of the form user.toUserDto(...) ----

    function checkExtensionMethodCalls(
        sourceFile: ts.SourceFile,
        typeChecker: ts.TypeChecker,
        extMethods: ExtMethod[]
    ): ts.Diagnostic[] {
        const diagnostics: ts.Diagnostic[] = [];

        function visit(node: ts.Node) {
            if (
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression)
            ) {
                const propAccess = node.expression;
                const objType = typeChecker.getTypeAtLocation(propAccess.expression);
                const propName = propAccess.name.text;

                const match = extMethods.find(
                    m => m.name === propName && typesMatch(objType, m.firstParamType, typeChecker)
                );

                if (match) {
                    // Parameters visible to the caller = everything except the first implicit param
                    const expectedParams = Array.from(match.params).slice(1);
                    const args = Array.from(node.arguments);

                    const hasRest = expectedParams.some(p => !!p.dotDotDotToken);
                    const requiredCount = expectedParams.filter(
                        p => !p.questionToken && !p.initializer && !p.dotDotDotToken
                    ).length;
                    const maxCount = hasRest ? Infinity : expectedParams.length;

                    // Too few arguments
                    if (args.length < requiredCount) {
                        diagnostics.push(makeDiag(
                            sourceFile,
                            node.getStart(sourceFile),
                            node.getWidth(sourceFile),
                            ts.DiagnosticCategory.Error,
                            2554,
                            `Expected ${requiredCount} argument${requiredCount === 1 ? "" : "s"}, but got ${args.length}.`
                        ));
                    }

                    // Too many arguments
                    if (args.length > maxCount) {
                        for (const extraArg of args.slice(maxCount)) {
                            diagnostics.push(makeDiag(
                                sourceFile,
                                extraArg.getStart(sourceFile),
                                extraArg.getWidth(sourceFile),
                                ts.DiagnosticCategory.Error,
                                2554,
                                `Expected ${expectedParams.length} argument${expectedParams.length === 1 ? "" : "s"}, but got ${args.length}.`
                            ));
                        }
                    }

                    // Type-check each argument against the corresponding parameter type
                    const checkCount = Math.min(args.length, hasRest ? args.length : expectedParams.length);
                    for (let i = 0; i < checkCount; i++) {
                        const arg = args[i];
                        // For rest params, reuse the last (rest) parameter type repeatedly
                        const paramIdx = hasRest ? Math.min(i, expectedParams.length - 1) : i;
                        const param = expectedParams[paramIdx];
                        if (!param) continue;

                        let paramType = typeChecker.getTypeAtLocation(param);

                        // Unwrap the array element type for rest parameters
                        if (param.dotDotDotToken) {
                            const indexType = typeChecker.getIndexTypeOfType(paramType, ts.IndexKind.Number);
                            if (indexType) paramType = indexType;
                        }

                        const argType = typeChecker.getTypeAtLocation(arg);

                        // isTypeAssignableTo is an internal TS API, but stable in practice
                        const isAssignable = (typeChecker as any).isTypeAssignableTo(argType, paramType);
                        if (!isAssignable) {
                            diagnostics.push(makeDiag(
                                sourceFile,
                                arg.getStart(sourceFile),
                                arg.getWidth(sourceFile),
                                ts.DiagnosticCategory.Error,
                                2345,
                                `Argument of type '${typeChecker.typeToString(argType)}' is not assignable to parameter of type '${typeChecker.typeToString(paramType)}'.`
                            ));
                        }
                    }
                }
            }

            ts.forEachChild(node, visit);
        }

        visit(sourceFile);
        return diagnostics;
    }

    function makeDiag(
        file: ts.SourceFile,
        start: number,
        length: number,
        category: ts.DiagnosticCategory,
        code: number,
        messageText: string
    ): ts.Diagnostic {
        return { file, start, length, category, code, messageText, source: "ts-extensions-test" };
    }

    function extractExtMethod(
        stmt: ts.Statement,
        sourceFile: ts.SourceFile,
        typeChecker: ts.TypeChecker
    ): ExtMethod | null {
        let name: string | undefined;
        let params: ts.NodeArray<ts.ParameterDeclaration> | undefined;
        let sigNode: ts.Node | undefined;

        if (ts.isFunctionDeclaration(stmt) && stmt.name) {
            name = stmt.name.text;
            params = stmt.parameters;
            sigNode = stmt.name;
        } else if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (
                    ts.isIdentifier(decl.name) &&
                    decl.initializer &&
                    (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
                ) {
                    name = decl.name.text;
                    params = decl.initializer.parameters;
                    sigNode = decl.name;
                    break;
                }
            }
        }

        if (!name || !params || params.length === 0 || !sigNode) return null;

        const sig = typeChecker.getSignaturesOfType(
            typeChecker.getTypeAtLocation(sigNode),
            ts.SignatureKind.Call
        )[0];
        if (!sig) return null;

        return {
            name,
            params,
            firstParamType: typeChecker.getTypeAtLocation(params[0]),
            returnType: typeChecker.getReturnTypeOfSignature(sig),
            sourceFileName: sourceFile.fileName,
        };
    }

    function makeCompletionEntry(
        m: ExtMethod,
        typeChecker: ts.TypeChecker,
        replacementSpan: ts.TextSpan
    ): ts.CompletionEntry {
        const paramLabel = Array.from(m.params)
            .map(p => {
                const pName = ts.isIdentifier(p.name) ? p.name.text : "_";
                const pType = typeChecker.typeToString(typeChecker.getTypeAtLocation(p));
                return `${pName}: ${pType}`;
            })
            .join(", ");

        return {
            name: m.name,
            kind: ts.ScriptElementKind.functionElement,
            sortText: "0",
            // $0 = final cursor position (inside parens) — snippet syntax
            insertText: `${m.name}($0)`,
            isSnippet: true,
            replacementSpan,
            labelDetails: {
                detail: `(${paramLabel})`,
                description: `: ${typeChecker.typeToString(m.returnType)}`,
            },
            hasAction: true,
            source: m.sourceFileName,
        };
    }

    // ---- AST traversal helpers ----

    function findPropertyAccessAt(
        sourceFile: ts.SourceFile,
        position: number
    ): ts.PropertyAccessExpression | null {
        function visit(node: ts.Node): ts.PropertyAccessExpression | null {
            if (position < node.pos || position > node.end) return null;
            const fromChild = ts.forEachChild(node, visit);
            if (fromChild) return fromChild;
            if (ts.isPropertyAccessExpression(node)) return node;
            if (node.parent && ts.isPropertyAccessExpression(node.parent)) return node.parent;
            return null;
        }
        return visit(sourceFile);
    }

    /** Finds the innermost CallExpression whose argument list contains `position` */
    function findCallExpressionAt(
        sourceFile: ts.SourceFile,
        position: number
    ): ts.CallExpression | null {
        function visit(node: ts.Node): ts.CallExpression | null {
            if (position < node.pos || position > node.end) return null;
            const fromChild = ts.forEachChild(node, visit);
            if (fromChild) return fromChild;
            // position must be after the opening paren (inside the argument list)
            if (ts.isCallExpression(node) && position >= node.expression.end) return node;
            return null;
        }
        return visit(sourceFile);
    }

    /** Finds the deepest AST node that contains `position` */
    function findNodeAtPosition(sourceFile: ts.SourceFile, position: number): ts.Node | null {
        function visit(node: ts.Node): ts.Node | null {
            if (position < node.getStart(sourceFile) || position >= node.end) return null;
            return ts.forEachChild(node, visit) ?? node;
        }
        return visit(sourceFile);
    }

    // ---- Other helpers ----

    function typesMatch(a: ts.Type, b: ts.Type, typeChecker: ts.TypeChecker): boolean {
        if (a.symbol && b.symbol && a.symbol === b.symbol) return true;
        return typeChecker.typeToString(a) === typeChecker.typeToString(b);
    }

    function isAlreadyImported(sourceFile: ts.SourceFile, name: string): boolean {
        for (const stmt of sourceFile.statements) {
            if (!ts.isImportDeclaration(stmt)) continue;
            const clause = stmt.importClause;
            if (!clause) continue;
            if (clause.name?.text === name) return true;
            if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                for (const el of clause.namedBindings.elements) {
                    if (el.name.text === name) return true;
                }
            }
        }
        return false;
    }

    function findImportInsertPosition(sourceFile: ts.SourceFile): number {
        let pos = 0;
        for (const stmt of sourceFile.statements) {
            if (ts.isImportDeclaration(stmt)) pos = stmt.getEnd();
        }
        return pos === 0 ? 0 : pos + 1;
    }

    function computeRelativePath(fromFile: string, toFile: string): string {
        const fromDir = path.dirname(fromFile);
        let rel = path.relative(fromDir, toFile).replace(/\\/g, "/");
        rel = rel.replace(/\.ts$/, "");
        if (!rel.startsWith(".")) rel = "./" + rel;
        return rel;
    }

    return { create };
}

export = init;

