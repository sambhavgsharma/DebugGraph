import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
]);

const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".vercel",
]);

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
};

export type ParsedFile = {
  readonly id: string;
  readonly filePath: string;
  readonly language: string;
  readonly contentHash: string;
};

export type ParsedSymbol = {
  readonly id: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: "function" | "method" | "class" | "variable";
  readonly filePath: string;
  readonly lineNumber: number;
  readonly endLineNumber: number;
  readonly language: string;
  readonly signature: string;
  readonly contentHash: string;
};

export type ParsedImport = {
  readonly sourceFilePath: string;
  readonly targetFilePath: string;
  readonly importedName: string;
  readonly localName: string;
  readonly typeOnly: boolean;
};

export type ParsedCall = {
  readonly sourceSymbolId: string;
  readonly targetSymbolId: string;
  readonly callSiteLine: number;
};

export type ParsedProject = {
  readonly rootDir: string;
  readonly files: readonly ParsedFile[];
  readonly symbols: readonly ParsedSymbol[];
  readonly imports: readonly ParsedImport[];
  readonly calls: readonly ParsedCall[];
};

type SourceFileInfo = {
  readonly sourceFile: ts.SourceFile;
  readonly file: ParsedFile;
};

function stableId(kind: string, identity: string): string {
  return createHash("sha256")
    .update(`${kind}:${identity}`)
    .digest("hex");
}

function normalizePath(filePath: string): string {
  return filePath.split(sep).join("/");
}

function scanFiles(rootDir: string): readonly string[] {
  const files: string[] = [];

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        files.push(resolve(entryPath));
      }
    }
  }

  visit(rootDir);
  return files.sort();
}

function compilerOptions(rootDir: string): ts.CompilerOptions {
  const configPath = join(rootDir, "tsconfig.json");
  if (!statSync(configPath, { throwIfNoEntry: false })) {
    return {
      allowJs: true,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.Latest,
    };
  }

  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }

  const options = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    rootDir,
    undefined,
    configPath,
  ).options;
  options.allowJs = true;
  return options;
}

function symbolName(node: ts.Declaration): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
    return node.name?.text ?? "default";
  }
  if (ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node)) {
    return node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
  }
  return undefined;
}

function symbolKind(node: ts.Declaration): ParsedSymbol["kind"] | undefined {
  if (ts.isFunctionDeclaration(node)) {
    return "function";
  }
  if (ts.isMethodDeclaration(node)) {
    return "method";
  }
  if (ts.isClassDeclaration(node)) {
    return "class";
  }
  if (ts.isVariableDeclaration(node)) {
    return "variable";
  }
  return undefined;
}

function isFunctionInitializer(
  initializer: ts.Expression | undefined,
): initializer is ts.ArrowFunction | ts.FunctionExpression {
  return initializer !== undefined
    && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer));
}

function declarationForSymbol(node: ts.Node): ts.Declaration | undefined {
  if (
    ts.isFunctionDeclaration(node)
    || ts.isClassDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isVariableDeclaration(node)
  ) {
    return node;
  }

  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return node.parent && ts.isVariableDeclaration(node.parent)
      ? node.parent
      : undefined;
  }

  return undefined;
}

function qualifiedName(node: ts.Declaration, relativePath: string): string {
  const parts: string[] = [];
  let current: ts.Node | undefined = node;

  while (current !== undefined && !ts.isSourceFile(current)) {
    if (
      ts.isFunctionDeclaration(current)
      || ts.isClassDeclaration(current)
      || ts.isMethodDeclaration(current)
      || ts.isVariableDeclaration(current)
    ) {
      const name = current.name;
      if (name && ts.isIdentifier(name)) {
        parts.unshift(name.text);
      }
    }
    current = current.parent;
  }

  return `${relativePath}:${parts.join(".") || "anonymous"}`;
}

function lineNumber(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function signatureText(node: ts.Declaration, sourceFile: ts.SourceFile): string {
  let end = node.end;
  if (
    (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node))
    && node.body
  ) {
    end = node.body.getStart(sourceFile);
  } else if (ts.isClassDeclaration(node) && node.members.length > 0) {
    end = node.members[0].getStart(sourceFile);
  } else if (
    ts.isVariableDeclaration(node)
    && isFunctionInitializer(node.initializer)
  ) {
    end = node.initializer.body.getStart(sourceFile);
  }

  return sourceFile.text.slice(node.getStart(sourceFile), end).trim().slice(0, 2000);
}

function importNames(
  declaration: ts.ImportDeclaration,
): readonly { importedName: string; localName: string; typeOnly: boolean }[] {
  const clause = declaration.importClause;
  if (!clause) {
    return [];
  }

  const names: { importedName: string; localName: string; typeOnly: boolean }[] = [];
  if (clause.name) {
    names.push({
      importedName: "default",
      localName: clause.name.text,
      typeOnly: clause.isTypeOnly,
    });
  }

  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) {
    names.push({
      importedName: "*",
      localName: bindings.name.text,
      typeOnly: clause.isTypeOnly,
    });
  } else if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      names.push({
        importedName: element.propertyName?.text ?? element.name.text,
        localName: element.name.text,
        typeOnly: clause.isTypeOnly || element.isTypeOnly,
      });
    }
  }

  return names;
}

export function parseProject(rootDir: string): ParsedProject {
  const absoluteRoot = resolve(rootDir);
  const absolutePaths = scanFiles(absoluteRoot);
  const relativePaths = new Map(
    absolutePaths.map((filePath) => [
      filePath,
      normalizePath(relative(absoluteRoot, filePath)),
    ]),
  );
  const options = compilerOptions(absoluteRoot);
  const program = ts.createProgram(absolutePaths, options);
  const checker = program.getTypeChecker();
  const sourceInfos = new Map<string, SourceFileInfo>();
  const sourcePaths = new Set(absolutePaths);

  for (const absolutePath of absolutePaths) {
    const sourceFile = program.getSourceFile(absolutePath);
    if (!sourceFile) {
      throw new Error(`TypeScript did not load scanned file: ${absolutePath}`);
    }

    const content = readFileSync(absolutePath);
    const contentHash = createHash("sha256").update(content).digest("hex");
    const filePath = relativePaths.get(absolutePath);
    if (!filePath) {
      throw new Error(`Missing relative path for scanned file: ${absolutePath}`);
    }

    sourceInfos.set(absolutePath, {
      sourceFile,
      file: {
        id: stableId("file", filePath),
        filePath,
        language: LANGUAGE_BY_EXTENSION[extname(absolutePath)],
        contentHash,
      },
    });
  }

  const symbols: ParsedSymbol[] = [];
  const declarationIds = new Map<ts.Declaration, string>();

  for (const info of sourceInfos.values()) {
    function visit(node: ts.Node): void {
      const declaration = declarationForSymbol(node);
      const kind = declaration && symbolKind(declaration);
      const name = declaration && symbolName(declaration);

      if (declaration && kind && name) {
        const filePath = info.file.filePath;
        const qualified = qualifiedName(declaration, filePath);
        const declarationHash = createHash("sha256")
          .update(info.sourceFile.text.slice(
            declaration.getStart(info.sourceFile),
            declaration.end,
          ))
          .digest("hex");
        const declarationContext: string[] = [];
        let contextNode: ts.Node | undefined = declaration.parent;
        while (contextNode !== undefined && !ts.isSourceFile(contextNode)) {
          declarationContext.push(contextNode.getText(info.sourceFile));
          contextNode = contextNode.parent;
        }
        const contextHash = createHash("sha256")
          .update(declarationContext.join("\n"))
          .digest("hex");
        const id = stableId(
          "symbol",
          `${qualified}:${kind}:${declarationHash}:${contextHash}`,
        );
        declarationIds.set(declaration, id);
        symbols.push({
          id,
          name,
          qualifiedName: qualified,
          kind,
          filePath,
          lineNumber: lineNumber(info.sourceFile, declaration.getStart(info.sourceFile)),
          endLineNumber: lineNumber(info.sourceFile, declaration.end),
          language: info.file.language,
          signature: signatureText(declaration, info.sourceFile),
          contentHash: info.file.contentHash,
        });
      }

      if (ts.isVariableDeclaration(node) && isFunctionInitializer(node.initializer)) {
        declarationIds.set(node.initializer, declarationIds.get(node) ?? "");
      }

      ts.forEachChild(node, visit);
    }

    visit(info.sourceFile);
  }

  const imports: ParsedImport[] = [];
  const calls: ParsedCall[] = [];

  for (const info of sourceInfos.values()) {
    function visit(node: ts.Node, currentSymbolId: string | undefined): void {
      const declaration = declarationForSymbol(node);
      const nextSymbolId = declaration
        ? declarationIds.get(declaration) ?? currentSymbolId
        : currentSymbolId;

      if (ts.isImportDeclaration(node)) {
        const moduleText = ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : undefined;
        if (moduleText) {
          const resolved = ts.resolveModuleName(
            moduleText,
            info.sourceFile.fileName,
            options,
            ts.sys,
          ).resolvedModule?.resolvedFileName;
          if (resolved && sourcePaths.has(resolve(resolved))) {
            const targetFilePath = sourceInfos.get(resolve(resolved))?.file.filePath;
            if (targetFilePath) {
              for (const imported of importNames(node)) {
                imports.push({
                  sourceFilePath: info.file.filePath,
                  targetFilePath,
                  importedName: imported.importedName,
                  localName: imported.localName,
                  typeOnly: imported.typeOnly,
                });
              }
            }
          }
        }
      }

      if (ts.isCallExpression(node) && nextSymbolId) {
        const declaration = checker.getResolvedSignature(node)?.declaration;
        const targetDeclaration = declaration && declarationForSymbol(declaration);
        const targetId = targetDeclaration && declarationIds.get(targetDeclaration);
        if (targetId && sourceInfos.has(resolve(targetDeclaration.getSourceFile().fileName))) {
          calls.push({
            sourceSymbolId: nextSymbolId,
            targetSymbolId: targetId,
            callSiteLine: lineNumber(info.sourceFile, node.getStart(info.sourceFile)),
          });
        }
      }

      ts.forEachChild(node, (child) => visit(child, nextSymbolId));
    }

    visit(info.sourceFile, undefined);
  }

  return {
    rootDir: absoluteRoot,
    files: [...sourceInfos.values()].map((info) => info.file),
    symbols,
    imports,
    calls: deduplicateCalls(calls),
  };
}

function deduplicateCalls(calls: readonly ParsedCall[]): readonly ParsedCall[] {
  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = `${call.sourceSymbolId}:${call.targetSymbolId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
