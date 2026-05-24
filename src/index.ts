import ts = require("typescript/lib/tsserverlibrary");
import * as path from "path";

function init(modules: { typescript: typeof import("typescript/lib/tsserverlibrary") }): import("typescript/lib/tsserverlibrary").server.PluginModule {
    const ts = modules.typescript;

    interface ExtMethod {
        name: string;
        params: ts.NodeArray<ts.ParameterDeclaration>;
        firstParamType: ts.Type;
        returnType: ts.Type;
        sourceFileName: string;
    }

    function create(info: ts.server.PluginCreateInfo): ts.LanguageService {
        const log = (msg: string) => info.project.projectService.logger.info(`[ts-extensions-test] ${msg}`);
        log("Plugin loaded!");

        // ---- Patch getScriptSnapshot to append module augmentation to .ext.ts files ----
        // This is the cleanest way to teach TypeScript the return types of extension methods.
        // Since .ext.ts files are already modules (they have imports), a `declare module`
        // block appended to them becomes a proper module augmentation — TypeScript sees the
        // enriched interface everywhere the ext file is transitively included.
        const host = info.languageServiceHost;
        const originalGetScriptSnapshot = host.getScriptSnapshot.bind(host);
        host.getScriptSnapshot = (fileName: string) => {
            const original = originalGetScriptSnapshot(fileName);
            if (!normalizePath(fileName).endsWith('.ext.ts')) return original;
            if (!original) return original;
            try {
                const augCode = generateAugmentationForExtFile(fileName, original);
                if (!augCode) return original;
                const originalText = original.getText(0, original.getLength());
                return ts.ScriptSnapshot.fromString(originalText + '\n' + augCode);
            } catch (e) {
                log(`getScriptSnapshot patch error for ${fileName}: ${e}`);
                return original;
            }
        };

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

                const nameStart = accessExpr.name.getStart(sourceFile);
                const replacementSpan: ts.TextSpan = {
                    start: nameStart,
                    length: position - nameStart,
                };

                const allExtMethods = collectExtensionMethods(program, typeChecker);

                // Resolve the actual type of the expression left of the dot,
                // tracing through ext-method calls and variables assigned from them.
                const resolvedType = resolveExtReturnType(accessExpr.expression, typeChecker, allExtMethods, program);

                if (resolvedType) {
                    // Regular members of the resolved type
                    const propertyEntries: ts.CompletionEntry[] =
                        typeChecker.getPropertiesOfType(resolvedType).map(symbol => ({
                            name: symbol.name,
                            kind: symbolToScriptElementKind(symbol),
                            sortText: symbol.name,
                            replacementSpan,
                        }));

                    // Extension methods on the resolved type
                    const extEntries = allExtMethods
                        .filter(m => typesMatch(resolvedType, m.firstParamType, typeChecker))
                        .map(m => makeCompletionEntry(m, typeChecker, replacementSpan));

                    const entries = [...propertyEntries, ...extEntries];
                    if (entries.length > 0) {
                        return {
                            isGlobalCompletion: false,
                            isMemberCompletion: true,
                            isNewIdentifierLocation: false,
                            entries,
                        };
                    }
                }

                // ---- Case: user.<cursor> — suggest extension methods ----
                const objType = typeChecker.getTypeAtLocation(accessExpr.expression);
                const extEntries = allExtMethods
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
                    if (!isAlreadyImported(sourceFile, source)) {
                        const relativePath = computeRelativePath(fileName, source);
                        const insertPosition = findImportInsertPosition(sourceFile);
                        codeActions.push({
                            description: `Import extension methods from '${relativePath}'`,
                            changes: [{
                                fileName,
                                textChanges: [{
                                    span: { start: insertPosition, length: 0 },
                                    newText: `\nimport '${relativePath}';`,
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

        // ---- Shared diagnostic filter: suppress unused-import warnings for ext methods ----
        function filterExtDiagnostics(
            diagnostics: ts.Diagnostic[],
            sourceFile: ts.SourceFile,
            typeChecker: ts.TypeChecker,
            extMethods: ExtMethod[],
            program: ts.Program
        ): ts.Diagnostic[] {
            return diagnostics.filter(diag => {
                // 2339 = Property 'X' does not exist on type 'Y'
                // 2349 = This expression is not callable
                if ((diag.code === 2339 || diag.code === 2349) && diag.start !== undefined) {
                    const node = findNodeAtPosition(sourceFile, diag.start);
                    if (node) {
                        let propAccess: ts.PropertyAccessExpression | undefined;
                        if (ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent)) {
                            propAccess = node.parent;
                        } else if (ts.isPropertyAccessExpression(node)) {
                            propAccess = node;
                        }
                        if (propAccess) {
                            const objType = getEffectiveReceiverType(propAccess.expression, typeChecker, extMethods, program);
                            const propName = propAccess.name.text;
                            if (extMethods.some(m => m.name === propName && typesMatch(objType, m.firstParamType, typeChecker))) {
                                return false;
                            }
                        }
                    }
                }

                // 6133 = 'X' is declared but its value is never read
                // 6196 = 'X' is declared but never used
                // Suppress when the identifier is a named import from a *.ext file.
                // Use AST-based detection (more reliable than position comparison).
                if ((diag.code === 6133 || diag.code === 6196) && diag.start !== undefined) {
                    const node = findNodeAtPosition(sourceFile, diag.start);
                    if (node && ts.isIdentifier(node)) {
                        // Walk up: ImportSpecifier -> NamedImports -> ImportClause -> ImportDeclaration
                        const importSpec = node.parent;
                        if (importSpec && ts.isImportSpecifier(importSpec)) {
                            const namedImports = importSpec.parent;
                            const importClause = namedImports?.parent;
                            const importDecl = importClause?.parent;
                            if (
                                importDecl &&
                                ts.isImportDeclaration(importDecl) &&
                                ts.isStringLiteral(importDecl.moduleSpecifier) &&
                                /\.ext(\.ts)?$/.test(importDecl.moduleSpecifier.text)
                            ) {
                                return false;
                            }
                        }
                    }
                }

                return true;
            });
        }

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

                const allExtMethods = collectExtensionMethods(program, typeChecker);
                // Suppress 2339/2349 for ALL ext methods (imported or not) —
                // unimported ones get a better custom error below.
                const filtered = filterExtDiagnostics(diagnostics, sourceFile, typeChecker, allExtMethods, program);
                if (allExtMethods.length === 0) return filtered;

                const importedExtFileNames = getImportedExtFileNames(sourceFile, program);

                const extra: ts.Diagnostic[] = [
                    // Error for ext method calls whose source file is not imported
                    ...checkUnimportedExtMethodCalls(sourceFile, typeChecker, allExtMethods, importedExtFileNames, program),
                    // Error for duplicate ext method names for the same type across .ext.ts files
                    ...checkDuplicateExtMethods(sourceFile, allExtMethods, typeChecker),
                    // Error for non-existing properties accessed on ext-method return types
                    // (TypeScript sees these as `any` and wouldn't catch them otherwise)
                    ...checkInvalidAccessOnExtReturnTypes(sourceFile, typeChecker, allExtMethods, program),
                ];

                return [...filtered, ...extra];
            } catch (e) {
                info.project.projectService.logger.info(`[ts-extensions-test] Error in getSemanticDiagnostics: ${e}`);
                return diagnostics;
            }
        };

        // ---- getSuggestionDiagnostics — suppress "unused import" suggestions for ext methods ----
        proxy.getSuggestionDiagnostics = (fileName) => {
            const diagnostics = info.languageService.getSuggestionDiagnostics(fileName);
            try {
                const program = info.languageService.getProgram();
                if (!program) return diagnostics;
                const sourceFile = program.getSourceFile(fileName);
                if (!sourceFile) return diagnostics;
                const typeChecker = program.getTypeChecker();
                // Note: we do NOT bail out when extMethods is empty —
                // the 6133/6196 filter only needs the source file AST, not ext methods.
                const extMethods = collectExtensionMethods(program, typeChecker);

                return filterExtDiagnostics(diagnostics as ts.Diagnostic[], sourceFile, typeChecker, extMethods, program) as ts.DiagnosticWithLocation[];
            } catch (e) {
                info.project.projectService.logger.info(`[ts-extensions-test] Error in getSuggestionDiagnostics: ${e}`);
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
                const extMethods = collectExtensionMethods(program, typeChecker);
                const objType = getEffectiveReceiverType(propAccess.expression, typeChecker, extMethods, program);
                const propName = propAccess.name.text;

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

        // ---- getEncodedSemanticClassifications — give ext method names the "function" color ----
        proxy.getEncodedSemanticClassifications = (fileName, span, format) => {
            const result = info.languageService.getEncodedSemanticClassifications(fileName, span, format);
            try {
                const program = info.languageService.getProgram();
                if (!program) return result;
                const sourceFile = program.getSourceFile(fileName);
                if (!sourceFile) return result;
                const typeChecker = program.getTypeChecker();
                const extMethods = collectExtensionMethods(program, typeChecker);
                if (extMethods.length === 0) return result;

                // Collect positions of extension method name identifiers within the requested span
                const extSpans: Array<{ start: number; length: number }> = [];
                function visit(node: ts.Node) {
                    if (node.pos > span.start + span.length || node.end < span.start) return;
                    if (
                        ts.isIdentifier(node) &&
                        ts.isPropertyAccessExpression(node.parent) &&
                        node.parent.name === node
                    ) {
                        const objType = getEffectiveReceiverType(node.parent.expression, typeChecker, extMethods, program!);
                        const match = extMethods.find(
                            m => m.name === node.text && typesMatch(objType, m.firstParamType, typeChecker)
                        );
                        if (match) {
                            extSpans.push({ start: node.getStart(sourceFile), length: node.getWidth(sourceFile) });
                        }
                    }
                    ts.forEachChild(node, visit);
                }
                visit(sourceFile);

                if (extSpans.length === 0) return result;

                // Remove original classifications that overlap our positions
                const extStartSet = new Set(extSpans.map(s => s.start));
                const filteredSpans: number[] = [];
                for (let i = 0; i < result.spans.length; i += 3) {
                    if (!extStartSet.has(result.spans[i])) {
                        filteredSpans.push(result.spans[i], result.spans[i + 1], result.spans[i + 2]);
                    }
                }

                // Encode "function" token type: (TokenType.function + 1) << 8 = (11 + 1) << 8 = 3072
                const FUNCTION_CLASSIFICATION = (11 + 1) << 8;
                const extraSpans: number[] = [];
                for (const { start, length } of extSpans) {
                    extraSpans.push(start, length, FUNCTION_CLASSIFICATION);
                }

                return { spans: [...filteredSpans, ...extraSpans], endOfLineState: result.endOfLineState };
            } catch (e) {
                info.project.projectService.logger.info(`[ts-extensions-test] Error in getEncodedSemanticClassifications: ${e}`);
                return result;
            }
        };

        // ---- findReferences — make ext method imports appear "used" to WebStorm ----
        proxy.findReferences = (fileName, position) => {
            const prior = info.languageService.findReferences(fileName, position);
            try {
                const program = info.languageService.getProgram();
                if (!program) return prior;
                const sourceFile = program.getSourceFile(fileName);
                if (!sourceFile) return prior;
                const typeChecker = program.getTypeChecker();

                const node = findNodeAtPosition(sourceFile, position);
                if (!node || !ts.isIdentifier(node)) return prior;

                // Handle both: import specifier AND function declaration in .ext.ts
                const extMethodName =
                    resolveExtMethodImport(node, typeChecker) ??
                    resolveExtMethodDeclaration(node);
                if (!extMethodName) return prior;

                const extMethods = collectExtensionMethods(program, typeChecker);
                const match = extMethods.find(m => m.name === extMethodName);
                if (!match) return prior;

                // Collect all call sites: user.toUserDto(...)
                const callRefs: ts.ReferencedSymbolEntry[] = [];
                for (const sf of program.getSourceFiles()) {
                    findExtCallSites(sf, typeChecker, match, callRefs, extMethods, program);
                }

                if (callRefs.length === 0) return prior;

                // Merge with prior result (which contains the import itself as a definition)
                if (prior && prior.length > 0) {
                    return [{ ...prior[0], references: [...prior[0].references, ...callRefs] }];
                }

                return prior;
            } catch (e) {
                info.project.projectService.logger.info(`[ts-extensions-test] Error in findReferences: ${e}`);
                return prior;
            }
        };

        // ---- getReferencesAtPosition — same treatment ----
        proxy.getReferencesAtPosition = (fileName, position) => {
            const prior = info.languageService.getReferencesAtPosition(fileName, position);
            try {
                const program = info.languageService.getProgram();
                if (!program) return prior;
                const sourceFile = program.getSourceFile(fileName);
                if (!sourceFile) return prior;
                const typeChecker = program.getTypeChecker();

                const node = findNodeAtPosition(sourceFile, position);
                if (!node || !ts.isIdentifier(node)) return prior;

                // Handle both: import specifier AND function declaration in .ext.ts
                const extMethodName =
                    resolveExtMethodImport(node, typeChecker) ??
                    resolveExtMethodDeclaration(node);
                if (!extMethodName) return prior;

                const extMethods = collectExtensionMethods(program, typeChecker);
                const match = extMethods.find(m => m.name === extMethodName);
                if (!match) return prior;

                const callRefs: ts.ReferenceEntry[] = [];
                for (const sf of program.getSourceFiles()) {
                    visitForCallRefs(sf, typeChecker, match, callRefs, extMethods, program);
                }

                return [...(prior ?? []), ...callRefs];
            } catch (e) {
                info.project.projectService.logger.info(`[ts-extensions-test] Error in getReferencesAtPosition: ${e}`);
                return prior;
            }
        };

        // ---- getDefinitionAndBoundSpan — Ctrl+Click navigation for user.toUserDto ----
        proxy.getDefinitionAndBoundSpan = (fileName, position) => {

            try {
                const program = info.languageService.getProgram();
                if (program) {
                    const sourceFile = program.getSourceFile(fileName);
                    if (sourceFile) {
                        const typeChecker = program.getTypeChecker();
                        const node = findNodeAtPosition(sourceFile, position);

                        log(`[def] node=${node ? ts.SyntaxKind[node.kind] : 'null'} text=${(node as any)?.text ?? ''}`);

                        if (node && ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
                            const propAccess = node.parent;
                            const extMethods = collectExtensionMethods(program, typeChecker);
                            const objType = getEffectiveReceiverType(propAccess.expression, typeChecker, extMethods, program);
                            const propName = node.text;

                            log(`[def] propName=${propName} receiverType=${typeChecker.typeToString(objType)} extMethods=${extMethods.map(m=>m.name).join(',')}`);

                            const match = extMethods.find(
                                m => m.name === propName && typesMatch(objType, m.firstParamType, typeChecker)
                            );

                            log(`[def] match=${match ? match.name + ' in ' + match.sourceFileName : 'null'}`);

                            if (match) {
                                const extSourceFile = program.getSourceFile(match.sourceFileName);
                                log(`[def] extSourceFile=${extSourceFile ? 'found' : 'NOT FOUND for ' + match.sourceFileName}`);
                                if (extSourceFile) {
                                    // Find the declaration node in the ext file to get exact span
                                    let defStart = 0;
                                    let defLength = 0;
                                    for (const stmt of extSourceFile.statements) {
                                        if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === match.name) {
                                            defStart = stmt.name.getStart(extSourceFile);
                                            defLength = stmt.name.getWidth(extSourceFile);
                                            break;
                                        }
                                        if (ts.isVariableStatement(stmt)) {
                                            for (const decl of stmt.declarationList.declarations) {
                                                if (ts.isIdentifier(decl.name) && decl.name.text === match.name) {
                                                    defStart = decl.name.getStart(extSourceFile);
                                                    defLength = decl.name.getWidth(extSourceFile);
                                                    break;
                                                }
                                            }
                                        }
                                    }

                                    log(`[def] returning definition: ${match.sourceFileName}:${defStart}`);
                                    return {
                                        textSpan: {
                                            start: node.getStart(sourceFile),
                                            length: node.getWidth(sourceFile),
                                        },
                                        definitions: [{
                                            fileName: match.sourceFileName,
                                            textSpan: { start: defStart, length: defLength },
                                            kind: ts.ScriptElementKind.functionElement,
                                            name: match.name,
                                            containerName: "",
                                            containerKind: ts.ScriptElementKind.unknown,
                                        }],
                                    };
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                info.project.projectService.logger.info(`[ts-extensions-test] Error in getDefinitionAndBoundSpan: ${e}`);
            }

            try {
                return info.languageService.getDefinitionAndBoundSpan(fileName, position);
            } catch (e) {
                info.project.projectService.logger.info(`[ts-extensions-test] Error in getDefinitionAndBoundSpan fallback: ${e}`);
                return undefined;
            }
        };

        // ---- getDefinitionAtPosition — same as above, some IDEs use this instead of getDefinitionAndBoundSpan ----
        proxy.getDefinitionAtPosition = (fileName, position) => {
            try {
                const program = info.languageService.getProgram();
                if (program) {
                    const sourceFile = program.getSourceFile(fileName);
                    if (sourceFile) {
                        const typeChecker = program.getTypeChecker();
                        const node = findNodeAtPosition(sourceFile, position);

                        if (node && ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
                            const propAccess = node.parent;
                            const extMethods = collectExtensionMethods(program, typeChecker);
                            const objType = getEffectiveReceiverType(propAccess.expression, typeChecker, extMethods, program);
                            const propName = node.text;

                            const match = extMethods.find(
                                m => m.name === propName && typesMatch(objType, m.firstParamType, typeChecker)
                            );

                            if (match) {
                                const extSourceFile = program.getSourceFile(match.sourceFileName);
                                if (extSourceFile) {
                                    let defStart = 0;
                                    let defLength = 0;
                                    for (const stmt of extSourceFile.statements) {
                                        if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === match.name) {
                                            defStart = stmt.name.getStart(extSourceFile);
                                            defLength = stmt.name.getWidth(extSourceFile);
                                            break;
                                        }
                                        if (ts.isVariableStatement(stmt)) {
                                            for (const decl of stmt.declarationList.declarations) {
                                                if (ts.isIdentifier(decl.name) && decl.name.text === match.name) {
                                                    defStart = decl.name.getStart(extSourceFile);
                                                    defLength = decl.name.getWidth(extSourceFile);
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                    log(`[defAtPos] returning definition: ${match.name} → ${match.sourceFileName}:${defStart}`);
                                    return [{
                                        fileName: match.sourceFileName,
                                        textSpan: { start: defStart, length: defLength },
                                        kind: ts.ScriptElementKind.functionElement,
                                        name: match.name,
                                        containerName: "",
                                        containerKind: ts.ScriptElementKind.unknown,
                                    }];
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                info.project.projectService.logger.info(`[ts-extensions-test] Error in getDefinitionAtPosition: ${e}`);
            }

            return info.languageService.getDefinitionAtPosition(fileName, position);
        };

        // ---- getQuickInfoAtPosition — hover tooltip for user.toUserDto / variables assigned from it ----
        proxy.getQuickInfoAtPosition = (fileName, position) => {
            try {
                const program = info.languageService.getProgram();
                if (program) {
                    const sourceFile = program.getSourceFile(fileName);
                    if (sourceFile) {
                        const typeChecker = program.getTypeChecker();
                        const extMethods = collectExtensionMethods(program, typeChecker);
                        const node = findNodeAtPosition(sourceFile, position);
                        if (node && ts.isIdentifier(node)) {

                            // Case 1: hovering on the ext method name in a property access (user.toUserDto)
                            if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
                                const propAccess = node.parent;
                                const objType = getEffectiveReceiverType(propAccess.expression, typeChecker, extMethods, program);
                                const propName = node.text;

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

                            // Case 2: hovering on a variable that was assigned from an ext method call
                            // e.g. `const hopa = user.toUserDto()` — show correct type instead of `any`
                            const symbol = typeChecker.getSymbolAtLocation(node);
                            const decl = symbol?.declarations?.[0];
                            if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
                                const resolved = resolveExtReturnType(decl.initializer, typeChecker, extMethods, program);
                                if (resolved) {
                                    const typeStr = typeChecker.typeToString(resolved);
                                    return {
                                        kind: ts.ScriptElementKind.constElement,
                                        kindModifiers: "",
                                        textSpan: { start: node.getStart(sourceFile), length: node.getWidth(sourceFile) },
                                        displayParts: [
                                            { text: "const", kind: "keyword" },
                                            { text: " ", kind: "space" },
                                            { text: node.text, kind: "localName" },
                                            { text: ": ", kind: "punctuation" },
                                            { text: typeStr, kind: "keyword" },
                                        ],
                                        documentation: [],
                                    };
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                info.project.projectService.logger.info(`[ts-extensions-test] Error in getQuickInfoAtPosition: ${e}`);
            }

            return info.languageService.getQuickInfoAtPosition(fileName, position);
        };

        // ---- getCodeFixesAtPosition — quick-fix for "ext method not imported" ----
        proxy.getCodeFixesAtPosition = (fileName, start, end, errorCodes, formatOptions, preferences) => {
            const prior = info.languageService.getCodeFixesAtPosition(fileName, start, end, errorCodes, formatOptions, preferences);
            try {
                if (!errorCodes.includes(2339)) return prior;

                const program = info.languageService.getProgram();
                if (!program) return prior;
                const sourceFile = program.getSourceFile(fileName);
                if (!sourceFile) return prior;
                const typeChecker = program.getTypeChecker();

                // Find the identifier at the error position
                const node = findNodeAtPosition(sourceFile, start);
                if (!node || !ts.isIdentifier(node)) return prior;
                if (!ts.isPropertyAccessExpression(node.parent) || node.parent.name !== node) return prior;

                const objType = typeChecker.getTypeAtLocation(node.parent.expression);
                const propName = node.text;

                const allExtMethods = collectExtensionMethods(program, typeChecker);
                const importedExtFileNames = getImportedExtFileNames(sourceFile, program);

                const match = allExtMethods.find(
                    m =>
                        m.name === propName &&
                        typesMatch(objType, m.firstParamType, typeChecker) &&
                        !importedExtFileNames.has(normalizePath(m.sourceFileName))
                );
                if (!match) return prior;

                const relativePath = computeRelativePath(fileName, match.sourceFileName);
                const insertPosition = findImportInsertPosition(sourceFile);

                const fix: ts.CodeFixAction = {
                    fixName: "addExtImport",
                    description: `Add import '${relativePath}'`,
                    changes: [{
                        fileName,
                        textChanges: [{
                            span: { start: insertPosition, length: 0 },
                            newText: `\nimport '${relativePath}';`,
                        }],
                    }],
                    fixId: "addExtImport",
                    fixAllDescription: `Add all missing extension method imports`,
                };

                return [...prior, fix];
            } catch (e) {
                info.project.projectService.logger.info(`[ts-extensions-test] Error in getCodeFixesAtPosition: ${e}`);
                return prior;
            }
        };

        return proxy;
    }

    // ---- Augmentation injection into .ext.ts snapshots ----

    /**
     * Generates `declare module` augmentation code to append to a .ext.ts file's snapshot.
     * IMPORTANT: TypeScript only supports module augmentation for `interface` declarations,
     * NOT for `type` aliases. We skip augmentation silently when the receiver is a type alias
     * to avoid "Duplicate identifier" errors.
     */
    function generateAugmentationForExtFile(
        fileName: string,
        snapshot: ts.IScriptSnapshot
    ): string {
        const content = snapshot.getText(0, snapshot.getLength());
        const sf = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
        const extDir = path.dirname(normalizePath(fileName));

        // Build map: localTypeName → import specifier (as written in the file)
        const typeToSpec = new Map<string, string>();
        for (const stmt of sf.statements) {
            if (!ts.isImportDeclaration(stmt)) continue;
            if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
            const spec = stmt.moduleSpecifier.text;
            const bindings = stmt.importClause?.namedBindings;
            if (bindings && ts.isNamedImports(bindings)) {
                for (const el of bindings.elements) {
                    typeToSpec.set((el.propertyName ?? el.name).text, spec);
                }
            }
        }

        // Cache: resolved module path → Set of interface names in that module
        const interfaceCache = new Map<string, Set<string>>();

        /** Returns true only if `typeName` is declared as `interface` (not `type`) in `spec`. */
        function isInterface(spec: string, typeName: string): boolean {
            const absSpec = normalizePath(path.resolve(extDir, spec));
            const cached = interfaceCache.get(absSpec);
            if (cached) return cached.has(typeName);

            // Try to read the source module from disk
            const candidates = [absSpec + '.ts', absSpec + '.d.ts', absSpec, absSpec + '/index.ts'];
            let modContent: string | undefined;
            for (const c of candidates) {
                modContent = ts.sys.readFile(c);
                if (modContent !== undefined) break;
            }
            const ifaces = new Set<string>();
            if (modContent !== undefined) {
                const modSf = ts.createSourceFile(absSpec, modContent, ts.ScriptTarget.Latest, true);
                for (const stmt of modSf.statements) {
                    if (ts.isInterfaceDeclaration(stmt)) {
                        ifaces.add(stmt.name.text);
                    }
                }
            }
            interfaceCache.set(absSpec, ifaces);
            return ifaces.has(typeName);
        }

        // specifier → { typeName, method lines }
        const bySpec = new Map<string, { typeName: string; lines: string[] }>();

        for (const stmt of sf.statements) {
            let name: string | undefined;
            let params: ts.NodeArray<ts.ParameterDeclaration> | undefined;
            let returnTypeNode: ts.TypeNode | undefined;

            if (ts.isFunctionDeclaration(stmt) && stmt.name) {
                name = stmt.name.text;
                params = stmt.parameters;
                returnTypeNode = stmt.type;
            } else if (ts.isVariableStatement(stmt)) {
                for (const decl of stmt.declarationList.declarations) {
                    if (
                        ts.isIdentifier(decl.name) &&
                        decl.initializer &&
                        (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
                    ) {
                        name = decl.name.text;
                        params = decl.initializer.parameters;
                        returnTypeNode = decl.initializer.type;
                        break;
                    }
                }
            }

            if (!name || !params || params.length === 0) continue;
            const firstParam = params[0];
            if (!firstParam.type) continue;

            const typeName = firstParam.type.getText(sf).trim();
            if (!typeToSpec.has(typeName)) continue;

            const spec = typeToSpec.get(typeName)!;

            // Skip if the receiver is a type alias — augmenting a type alias causes
            // "Duplicate identifier" errors. Only interfaces can be augmented.
            if (!isInterface(spec, typeName)) continue;

            const restParams = Array.from(params).slice(1).map(p => p.getText(sf)).join(', ');
            const returnType = returnTypeNode ? returnTypeNode.getText(sf).trim() : 'void';

            const methodLine = `        ${name}(${restParams}): ${returnType};`;

            if (!bySpec.has(spec)) bySpec.set(spec, { typeName, lines: [] });
            bySpec.get(spec)!.lines.push(methodLine);
        }

        if (bySpec.size === 0) return '';

        const out: string[] = [];
        for (const [spec, { typeName, lines }] of bySpec) {
            out.push(`declare module "${spec}" {`);
            out.push(`    interface ${typeName} {`);
            for (const l of lines) out.push(l);
            out.push('    }');
            out.push('}');
        }
        return out.join('\n');
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

    /**
     * Returns the "effective" type of `expr` for ext-method matching — first tries to
     * resolve it via ext-method AST tracing, then falls back to TypeScript's own inference.
     * This is needed because TypeScript may infer `any` for chained ext calls on type aliases.
     */
    function getEffectiveReceiverType(
        expr: ts.Expression,
        typeChecker: ts.TypeChecker,
        extMethods: ExtMethod[],
        program: ts.Program
    ): ts.Type {
        return resolveExtReturnType(expr, typeChecker, extMethods, program)
            ?? typeChecker.getTypeAtLocation(expr);
    }

    /**
     * Recursively resolves the *actual* ext-method return type for an expression,
     * tracing through variables assigned from ext-method calls.
     *
     * Examples:
     *   user.toUserDto()          → UserDto (direct call)
     *   hopa.                     → UserDto (where hopa = user.toUserDto())
     *   hopa.toAdmin().           → Admin   (chained ext calls)
     *
     * Returns null if the expression has nothing to do with ext methods.
     */
    function resolveExtReturnType(
        expr: ts.Expression,
        typeChecker: ts.TypeChecker,
        extMethods: ExtMethod[],
        program: ts.Program,
        depth = 0
    ): ts.Type | null {
        if (depth > 5) return null; // prevent infinite recursion

        // Case 1: obj.extMethod(...) — direct ext method call
        if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
            const propAccess = expr.expression;
            // The receiver of the call itself might be an ext method call — resolve recursively
            const receiverType =
                resolveExtReturnType(propAccess.expression, typeChecker, extMethods, program, depth + 1)
                ?? typeChecker.getTypeAtLocation(propAccess.expression);

            const methodName = propAccess.name.text;
            const match = extMethods.find(
                m => m.name === methodName && typesMatch(receiverType, m.firstParamType, typeChecker)
            );
            if (match) return match.returnType;
        }

        // Case 2: identifier — look at its declaration initializer
        if (ts.isIdentifier(expr)) {
            const symbol = typeChecker.getSymbolAtLocation(expr);
            const decl = symbol?.declarations?.[0];
            if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
                return resolveExtReturnType(decl.initializer, typeChecker, extMethods, program, depth + 1);
            }
        }

        return null;
    }

    // ---- Resolve which *.ext.ts files are side-effect-imported in a source file ----

    function getImportedExtFileNames(sourceFile: ts.SourceFile, _program: ts.Program): Set<string> {
        const result = new Set<string>();
        const fromDir = path.dirname(sourceFile.fileName);
        for (const stmt of sourceFile.statements) {
            if (!ts.isImportDeclaration(stmt)) continue;
            if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
            const specifier = stmt.moduleSpecifier.text;
            if (!/\.ext(\.ts)?$/.test(specifier)) continue;
            // Resolve specifier to an absolute path matching the program's file names
            let resolved = path.resolve(fromDir, specifier);
            if (!resolved.endsWith(".ts")) resolved += ".ts";
            result.add(normalizePath(resolved));
        }
        return result;
    }

    // ---- Emit an error for ext method calls whose source file is not imported ----

    function checkUnimportedExtMethodCalls(
        sourceFile: ts.SourceFile,
        typeChecker: ts.TypeChecker,
        allExtMethods: ExtMethod[],
        importedExtFileNames: Set<string>,
        program: ts.Program
    ): ts.Diagnostic[] {
        const diagnostics: ts.Diagnostic[] = [];

        function visit(node: ts.Node) {
            if (ts.isPropertyAccessExpression(node)) {
                const objType = getEffectiveReceiverType(node.expression, typeChecker, allExtMethods, program);
                const propName = node.name.text;
                const match = allExtMethods.find(
                    m => m.name === propName && typesMatch(objType, m.firstParamType, typeChecker)
                );
                if (match && !importedExtFileNames.has(normalizePath(match.sourceFileName))) {
                    const relPath = computeRelativePath(sourceFile.fileName, match.sourceFileName);
                    diagnostics.push(makeDiag(
                        sourceFile,
                        node.name.getStart(sourceFile),
                        node.name.getWidth(sourceFile),
                        ts.DiagnosticCategory.Error,
                        2339,
                        `Extension method '${propName}' is not imported. Add: import '${relPath}';`
                    ));
                }
            }
            ts.forEachChild(node, visit);
        }

        visit(sourceFile);
        return diagnostics;
    }

    // ---- Error when two .ext.ts files define an extension method with the same name for the same type ----

    function checkDuplicateExtMethods(
        sourceFile: ts.SourceFile,
        allExtMethods: ExtMethod[],
        typeChecker: ts.TypeChecker
    ): ts.Diagnostic[] {
        // Only relevant when diagnosing a .ext.ts file itself
        if (!sourceFile.fileName.endsWith(".ext.ts")) return [];

        const myFileName = normalizePath(sourceFile.fileName);
        const myMethods = allExtMethods.filter(m => normalizePath(m.sourceFileName) === myFileName);
        const otherMethods = allExtMethods.filter(m => normalizePath(m.sourceFileName) !== myFileName);

        const diagnostics: ts.Diagnostic[] = [];

        for (const mine of myMethods) {
            const conflict = otherMethods.find(
                other =>
                    other.name === mine.name &&
                    typesMatch(mine.firstParamType, other.firstParamType, typeChecker)
            );
            if (!conflict) continue;

            // Find the identifier node in this file's AST
            for (const stmt of sourceFile.statements) {
                let nameNode: ts.Identifier | undefined;
                if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === mine.name) {
                    nameNode = stmt.name;
                } else if (ts.isVariableStatement(stmt)) {
                    for (const decl of stmt.declarationList.declarations) {
                        if (ts.isIdentifier(decl.name) && decl.name.text === mine.name) {
                            nameNode = decl.name;
                        }
                    }
                }
                if (nameNode) {
                    const conflictPath = computeRelativePath(sourceFile.fileName, conflict.sourceFileName);
                    diagnostics.push(makeDiag(
                        sourceFile,
                        nameNode.getStart(sourceFile),
                        nameNode.getWidth(sourceFile),
                        ts.DiagnosticCategory.Error,
                        2300,
                        `Duplicate extension method '${mine.name}' for type '${typeChecker.typeToString(mine.firstParamType)}'. Already defined in '${conflictPath}'.`
                    ));
                }
            }
        }

        return diagnostics;
    }

    /**
     * Emits TS2339 errors for property/method accesses on expressions whose type
     * TypeScript infers as `any` but our ext-method tracer can resolve to a concrete type.
     *
     * This covers cases like:
     *   const chainedUser = user.toAdmin().toUser();  // TS sees `any`, we see `User`
     *   chainedUser.nonExistingMethod();              // ← should be an error
     */
    function checkInvalidAccessOnExtReturnTypes(
        sourceFile: ts.SourceFile,
        typeChecker: ts.TypeChecker,
        allExtMethods: ExtMethod[],
        program: ts.Program
    ): ts.Diagnostic[] {
        const diagnostics: ts.Diagnostic[] = [];

        function visit(node: ts.Node) {
            if (ts.isPropertyAccessExpression(node)) {
                const tsType = typeChecker.getTypeAtLocation(node.expression);
                // Only intervene when TS has given up and inferred `any`
                if (tsType.flags & ts.TypeFlags.Any) {
                    const resolvedType = resolveExtReturnType(
                        node.expression, typeChecker, allExtMethods, program
                    );
                    if (resolvedType && !(resolvedType.flags & ts.TypeFlags.Any)) {
                        const propName = node.name.text;
                        const propExists = typeChecker.getPropertiesOfType(resolvedType)
                            .some(p => p.name === propName);
                        const isExtMethod = allExtMethods.some(
                            m => m.name === propName &&
                                typesMatch(resolvedType, m.firstParamType, typeChecker)
                        );
                        if (!propExists && !isExtMethod) {
                            const typeStr = typeChecker.typeToString(resolvedType);
                            diagnostics.push(makeDiag(
                                sourceFile,
                                node.name.getStart(sourceFile),
                                node.name.getWidth(sourceFile),
                                ts.DiagnosticCategory.Error,
                                2339,
                                `Property '${propName}' does not exist on type '${typeStr}'.`
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

    /** Returns true when `node` (an identifier) lives inside an import declaration
     *  whose module specifier ends with ".ext" or ".ext.ts". */
    function isImportedFromExtFile(node: ts.Node): boolean {
        let current: ts.Node | undefined = node.parent;
        while (current) {
            if (ts.isImportDeclaration(current)) {
                return (
                    ts.isStringLiteral(current.moduleSpecifier) &&
                    /\.ext(\.ts)?$/.test(current.moduleSpecifier.text)
                );
            }
            current = current.parent;
        }
        return false;
    }

    /** If `node` is an identifier in an import specifier whose resolved symbol lives in a .ext.ts file,
     *  returns the imported name. Otherwise returns null. */
    function resolveExtMethodImport(node: ts.Node, typeChecker: ts.TypeChecker): string | null {
        if (!ts.isIdentifier(node)) return null;
        const parent = node.parent;
        if (!ts.isImportSpecifier(parent)) return null;
        if (isImportedFromExtFile(node)) return node.text;
        // Fallback: resolve alias symbol
        const symbol = typeChecker.getSymbolAtLocation(node);
        if (symbol) {
            const resolved = (symbol.flags & ts.SymbolFlags.Alias)
                ? typeChecker.getAliasedSymbol(symbol)
                : symbol;
            if (resolved?.declarations?.some(d => d.getSourceFile().fileName.endsWith(".ext.ts"))) {
                return node.text;
            }
        }
        return null;
    }

    /** If `node` is the name identifier of a function/variable declaration in a .ext.ts file,
     *  returns the method name. Otherwise returns null. */
    function resolveExtMethodDeclaration(node: ts.Node): string | null {
        if (!ts.isIdentifier(node)) return null;
        if (!node.getSourceFile().fileName.endsWith(".ext.ts")) return null;
        const parent = node.parent;
        if (ts.isFunctionDeclaration(parent) && parent.name === node) return node.text;
        if (ts.isVariableDeclaration(parent) && parent.name === node) return node.text;
        return null;
    }

    /** Gather ReferencedSymbolEntry items for all ext method call sites in `sf` */
    function findExtCallSites(
        sf: ts.SourceFile,
        typeChecker: ts.TypeChecker,
        match: ExtMethod,
        out: ts.ReferencedSymbolEntry[],
        extMethods: ExtMethod[],
        program: ts.Program
    ): void {
        function visit(node: ts.Node) {
            if (
                ts.isPropertyAccessExpression(node) &&
                node.name.text === match.name
            ) {
                const objType = getEffectiveReceiverType(node.expression, typeChecker, extMethods, program);
                if (typesMatch(objType, match.firstParamType, typeChecker)) {
                    out.push({
                        fileName: sf.fileName,
                        textSpan: { start: node.name.getStart(sf), length: node.name.getWidth(sf) },
                        isWriteAccess: false,
                        isDefinition: false,
                    } as ts.ReferencedSymbolEntry);
                }
            }
            ts.forEachChild(node, visit);
        }
        visit(sf);
    }

    /** Gather ReferenceEntry items for all ext method call sites in `sf` */
    function visitForCallRefs(
        sf: ts.SourceFile,
        typeChecker: ts.TypeChecker,
        match: ExtMethod,
        out: ts.ReferenceEntry[],
        extMethods: ExtMethod[],
        program: ts.Program
    ): void {
        function visit(node: ts.Node) {
            if (
                ts.isPropertyAccessExpression(node) &&
                node.name.text === match.name
            ) {
                const objType = getEffectiveReceiverType(node.expression, typeChecker, extMethods, program);
                if (typesMatch(objType, match.firstParamType, typeChecker)) {
                    out.push({
                        fileName: sf.fileName,
                        textSpan: { start: node.name.getStart(sf), length: node.name.getWidth(sf) },
                        isWriteAccess: false,
                    });
                }
            }
            ts.forEachChild(node, visit);
        }
        visit(sf);
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

    function normalizePath(p: string): string {
        return p.replace(/\\/g, "/");
    }

    /** Maps a TypeChecker symbol to the closest ScriptElementKind for completion entries. */
    function symbolToScriptElementKind(symbol: ts.Symbol): ts.ScriptElementKind {
        const decl = symbol.declarations?.[0];
        if (!decl) return ts.ScriptElementKind.memberVariableElement;
        if (ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl)) {
            return ts.ScriptElementKind.memberFunctionElement;
        }
        if (ts.isGetAccessorDeclaration(decl) || ts.isSetAccessorDeclaration(decl)) {
            return ts.ScriptElementKind.memberGetAccessorElement;
        }
        return ts.ScriptElementKind.memberVariableElement;
    }

    function typesMatch(a: ts.Type, b: ts.Type, typeChecker: ts.TypeChecker): boolean {
        if (a.symbol && b.symbol && a.symbol === b.symbol) return true;
        return typeChecker.typeToString(a) === typeChecker.typeToString(b);
    }

    /** Returns true when the given .ext.ts file is already side-effect-imported in sourceFile. */
    function isAlreadyImported(sourceFile: ts.SourceFile, extSourceFileName: string): boolean {
        const fromDir = path.dirname(sourceFile.fileName);
        for (const stmt of sourceFile.statements) {
            if (!ts.isImportDeclaration(stmt)) continue;
            if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
            const specifier = stmt.moduleSpecifier.text;
            if (!/\.ext(\.ts)?$/.test(specifier)) continue;
            let resolved = path.resolve(fromDir, specifier);
            if (!resolved.endsWith(".ts")) resolved += ".ts";
            if (normalizePath(resolved) === normalizePath(extSourceFileName)) return true;
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

