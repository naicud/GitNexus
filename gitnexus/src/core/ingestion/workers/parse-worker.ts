import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { SupportedLanguages } from '../../../config/supported-languages.js';
import { LANGUAGE_QUERIES } from '../tree-sitter-queries.js';
import { getTreeSitterBufferSize, TREE_SITTER_MAX_BUFFER } from '../constants.js';
import { preprocessCobolSource, extractCobolSymbolsWithRegex } from '../languages/cobol/cobol-preprocessor.js';
import {
  getLanguageFromFilename,
  getLanguageFromPath,
  FUNCTION_NODE_TYPES,
  extractFunctionName,
  isBuiltInOrNoise,
  DEFINITION_CAPTURE_KEYS,
  getDefinitionNodeFromCaptures,
  findEnclosingClassId,
  extractMethodSignature,
  countCallArguments,
  inferCallForm,
  extractReceiverName,
  findSiblingChild,
  extractReceiverNode,
  extractMixedChain,
  type MixedChainStep,
} from '../utils.js';
import { buildTypeEnv } from '../type-env.js';
import type { ConstructorBinding } from '../type-env.js';

// ============================================================================
// Lazy tree-sitter loading — skip native modules for COBOL-only repos
// ============================================================================

const _require = createRequire(import.meta.url);
const isCobolOnlyMode = !!process.env.GITNEXUS_COBOL_DIRS;

let treeSitterLoaded = false;
let Parser: any = null;
let parser: any = null;
let languageMap: Record<string, any> = {};

/** Load tree-sitter and all language grammars. No-op after first call. */
const ensureTreeSitterLoaded = (): void => {
  if (treeSitterLoaded) return;
  treeSitterLoaded = true;

  Parser = _require('tree-sitter');
  parser = new Parser();

  const JavaScript = _require('tree-sitter-javascript');
  const TypeScript = _require('tree-sitter-typescript');
  const Python = _require('tree-sitter-python');
  const Java = _require('tree-sitter-java');
  const C = _require('tree-sitter-c');
  const CPP = _require('tree-sitter-cpp');
  const CSharp = _require('tree-sitter-c-sharp');
  const Go = _require('tree-sitter-go');
  const Rust = _require('tree-sitter-rust');
  const Kotlin = _require('tree-sitter-kotlin');
  const PHP = _require('tree-sitter-php');
  const Ruby = _require('tree-sitter-ruby');

  let Swift: any = null;
  try { Swift = _require('tree-sitter-swift'); } catch {}

  languageMap = {
    [SupportedLanguages.JavaScript]: JavaScript,
    [SupportedLanguages.TypeScript]: TypeScript.typescript,
    [`${SupportedLanguages.TypeScript}:tsx`]: TypeScript.tsx,
    [SupportedLanguages.Python]: Python,
    [SupportedLanguages.Java]: Java,
    [SupportedLanguages.C]: C,
    [SupportedLanguages.CPlusPlus]: CPP,
    [SupportedLanguages.CSharp]: CSharp,
    [SupportedLanguages.Go]: Go,
    [SupportedLanguages.Rust]: Rust,
    [SupportedLanguages.Kotlin]: Kotlin,
    [SupportedLanguages.PHP]: PHP.php_only,
    [SupportedLanguages.Ruby]: Ruby,
    ...(Swift ? { [SupportedLanguages.Swift]: Swift } : {}),
  };
};

// For non-COBOL repos, load eagerly at module init (no behavior change)
if (!isCobolOnlyMode) {
  ensureTreeSitterLoaded();
}
import { isNodeExported } from '../export-detection.js';
import { detectFrameworkFromAST } from '../framework-detection.js';
import { typeConfigs } from '../type-extractors/index.js';
import { generateId } from '../../../lib/utils.js';
import { extractNamedBindings } from '../named-binding-extraction.js';
import { appendKotlinWildcard } from '../resolvers/index.js';
import { callRouters } from '../call-routing.js';
import { extractPropertyDeclaredType } from '../type-extractors/shared.js';
import type { NodeLabel } from '../../graph/types.js';

// ============================================================================
// Types for serializable results
// ============================================================================

interface ParsedNode {
  id: string;
  label: string;
  properties: {
    name: string;
    filePath: string;
    startLine: number;
    endLine: number;
    language: SupportedLanguages;
    isExported: boolean;
    astFrameworkMultiplier?: number;
    astFrameworkReason?: string;
    description?: string;
    parameterCount?: number;
    returnType?: string;
  };
}

interface ParsedRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  confidence: number;
  reason: string;
}

interface ParsedSymbol {
  filePath: string;
  name: string;
  nodeId: string;
  type: NodeLabel;
  parameterCount?: number;
  returnType?: string;
  declaredType?: string;
  ownerId?: string;
}

export interface ExtractedImport {
  filePath: string;
  rawImportPath: string;
  language: SupportedLanguages;
  /** Named bindings from the import (e.g., import {User as U} → [{local:'U', exported:'User'}]) */
  namedBindings?: { local: string; exported: string }[];
}

export interface ExtractedCall {
  filePath: string;
  calledName: string;
  /** generateId of enclosing function, or generateId('File', filePath) for top-level */
  sourceId: string;
  argCount?: number;
  /** Discriminates free function calls from member/constructor calls */
  callForm?: 'free' | 'member' | 'constructor';
  /** Simple identifier of the receiver for member calls (e.g., 'user' in user.save()) */
  receiverName?: string;
  /** Resolved type name of the receiver (e.g., 'User' for user.save() when user: User) */
  receiverTypeName?: string;
  /**
   * Unified mixed chain when the receiver is a chain of field accesses and/or method calls.
   * Steps are ordered base-first (innermost to outermost). Examples:
   *   `svc.getUser().save()`        → chain=[{kind:'call',name:'getUser'}], receiverName='svc'
   *   `user.address.save()`         → chain=[{kind:'field',name:'address'}], receiverName='user'
   *   `svc.getUser().address.save()` → chain=[{kind:'call',name:'getUser'},{kind:'field',name:'address'}]
   * Length is capped at MAX_CHAIN_DEPTH (3).
   */
  receiverMixedChain?: MixedChainStep[];
}

export interface ExtractedAssignment {
  filePath: string;
  /** generateId of enclosing function, or generateId('File', filePath) for top-level */
  sourceId: string;
  /** Receiver text (e.g., 'user' from user.address = value) */
  receiverText: string;
  /** Property name being written (e.g., 'address') */
  propertyName: string;
  /** Resolved type name of the receiver if available from TypeEnv */
  receiverTypeName?: string;
}

export interface ExtractedHeritage {
  filePath: string;
  className: string;
  parentName: string;
  /** 'extends' | 'implements' | 'trait-impl' | 'include' | 'extend' | 'prepend' */
  kind: string;
}

export interface ExtractedRoute {
  filePath: string;
  httpMethod: string;
  routePath: string | null;
  controllerName: string | null;
  methodName: string | null;
  middleware: string[];
  prefix: string | null;
  lineNumber: number;
}

/** Constructor bindings keyed by filePath for cross-file type resolution */
export interface FileConstructorBindings {
  filePath: string;
  bindings: ConstructorBinding[];
}

export interface ParseWorkerResult {
  nodes: ParsedNode[];
  relationships: ParsedRelationship[];
  symbols: ParsedSymbol[];
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  assignments: ExtractedAssignment[];
  heritage: ExtractedHeritage[];
  routes: ExtractedRoute[];
  constructorBindings: FileConstructorBindings[];
  skippedLanguages: Record<string, number>;
  fileCount: number;
}

export interface ParseWorkerInput {
  path: string;
  content: string;
}

// ============================================================================
// COBOL regex-only processing (tree-sitter hangs on pathological files)
// ============================================================================

// ---------------------------------------------------------------------------
// COBOL deep indexing helpers (shared by processCobolRegexOnly)
// ---------------------------------------------------------------------------

/** Emit a node + DEFINES relationship + symbol entry in one call. */
const emitCobolNode = (
  result: ParseWorkerResult,
  label: NodeLabel,
  nodeId: string,
  name: string,
  filePath: string,
  line: number,
  fileId: string,
  opts?: { isExported?: boolean; description?: string },
): void => {
  result.nodes.push({
    id: nodeId, label,
    properties: {
      name, filePath, startLine: line, endLine: line,
      language: SupportedLanguages.COBOL,
      isExported: opts?.isExported ?? false,
      ...(opts?.description ? { description: opts.description } : {}),
    },
  });
  result.relationships.push({
    id: generateId('DEFINES', `${fileId}->${nodeId}`),
    sourceId: fileId, targetId: nodeId, type: 'DEFINES', confidence: 1.0, reason: '',
  });
  result.symbols.push({ filePath, name, nodeId, type: label });
};

/** Emit a relationship (non-DEFINES). */
const emitCobolRel = (
  result: ParseWorkerResult,
  type: string,
  sourceId: string,
  targetId: string,
  confidence = 1.0,
  reason = '',
): void => {
  result.relationships.push({
    id: generateId(type, `${sourceId}->${targetId}`),
    sourceId, targetId, type, confidence, reason,
  });
};

/** Build a description string from key-value parts, skipping undefined values. */
const buildDesc = (parts: Array<[string, string | number | undefined]>): string => {
  return parts.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}:${v}`).join(' ');
};

/** Get the node label for a data item based on its level number. */
const dataItemLabel = (level: number): string =>
  level === 1 || level === 0o1 ? 'Record' : 'Property';

const processCobolRegexOnly = (file: ParseWorkerInput, result: ParseWorkerResult): void => {
  const regexResults = extractCobolSymbolsWithRegex(file.content, file.path);
  const fileId = generateId('File', file.path);

  if (regexResults.programName) {
    const nodeId = generateId('Module', `${file.path}:${regexResults.programName}`);
    const metaDesc = buildDesc([
      ['author', regexResults.programMetadata.author],
      ['date', regexResults.programMetadata.dateWritten],
    ]);
    result.nodes.push({
      id: nodeId, label: 'Module',
      properties: {
        name: regexResults.programName, filePath: file.path, startLine: 0, endLine: 0,
        language: SupportedLanguages.COBOL, isExported: true,
        ...(metaDesc ? { description: metaDesc } : {}),
      },
    });
    result.relationships.push({
      id: generateId('DEFINES', `${fileId}->${nodeId}`),
      sourceId: fileId, targetId: nodeId, type: 'DEFINES', confidence: 1.0, reason: '',
    });
    result.symbols.push({ filePath: file.path, name: regexResults.programName, nodeId, type: 'Module' });
  }

  const moduleId = regexResults.programName
    ? generateId('Module', `${file.path}:${regexResults.programName}`)
    : fileId;

  for (const para of regexResults.paragraphs) {
    const nodeId = generateId('Function', `${file.path}:${para.name}`);
    emitCobolNode(result, 'Function', nodeId, para.name, file.path, para.line, fileId, { isExported: true });
  }

  for (const sec of regexResults.sections) {
    const nodeId = generateId('Namespace', `${file.path}:${sec.name}`);
    emitCobolNode(result, 'Namespace', nodeId, sec.name, file.path, sec.line, fileId, { isExported: true });
  }

  for (const copy of regexResults.copies) {
    result.imports.push({ filePath: file.path, rawImportPath: copy.target, language: SupportedLanguages.COBOL });
  }

  for (const call of regexResults.calls) {
    if (!isBuiltInOrNoise(call.target)) {
      result.calls.push({ filePath: file.path, calledName: call.target, sourceId: fileId });
    }
  }

  for (const perf of regexResults.performs) {
    if (!isBuiltInOrNoise(perf.target)) {
      const sourceId = perf.caller
        ? generateId('Function', `${file.path}:${perf.caller}`)
        : fileId;
      result.calls.push({ filePath: file.path, calledName: perf.target, sourceId });
    }
  }

  const MAX_DATA_ITEMS_PER_FILE = 500;
  const cappedDataItems = regexResults.dataItems.length > MAX_DATA_ITEMS_PER_FILE
    ? regexResults.dataItems.slice(0, MAX_DATA_ITEMS_PER_FILE)
    : regexResults.dataItems;

  for (const item of cappedDataItems) {
    if (item.values) {
      const nodeId = generateId('Const', `${file.path}:${item.name}`);
      const desc = `level:88 values:${item.values.join(',')}`;
      emitCobolNode(result, 'Const', nodeId, item.name, file.path, item.line, fileId, { description: desc });
    } else if (item.level === 1) {
      const nodeId = generateId('Record', `${file.path}:${item.name}`);
      const desc = buildDesc([['level', '01'], ['pic', item.pic], ['usage', item.usage], ['occurs', item.occurs], ['section', item.section]]);
      emitCobolNode(result, 'Record', nodeId, item.name, file.path, item.line, fileId, { description: desc });
      if (item.redefines) emitCobolRel(result, 'REDEFINES', nodeId, generateId('Record', `${file.path}:${item.redefines}`));
    } else {
      const nodeId = generateId('Property', `${file.path}:${item.name}`);
      const desc = buildDesc([['level', String(item.level).padStart(2, '0')], ['pic', item.pic], ['usage', item.usage], ['occurs', item.occurs], ['section', item.section]]);
      emitCobolNode(result, 'Property', nodeId, item.name, file.path, item.line, fileId, { description: desc });
      if (item.redefines) emitCobolRel(result, 'REDEFINES', nodeId, generateId('Property', `${file.path}:${item.redefines}`));
    }
  }

  const parentStack: Array<{ level: number; nodeId: string }> = [];
  for (const item of cappedDataItems) {
    if (item.values) continue;
    const label = dataItemLabel(item.level);
    const nodeId = generateId(label, `${file.path}:${item.name}`);
    while (parentStack.length > 0 && parentStack[parentStack.length - 1].level >= item.level) parentStack.pop();
    if (parentStack.length > 0) emitCobolRel(result, 'CONTAINS', parentStack[parentStack.length - 1].nodeId, nodeId);
    else emitCobolRel(result, 'CONTAINS', moduleId, nodeId);
    parentStack.push({ level: item.level, nodeId });
  }

  for (let i = 0; i < cappedDataItems.length; i++) {
    const item = cappedDataItems[i];
    if (!item.values) continue;
    for (let j = i - 1; j >= 0; j--) {
      if (!cappedDataItems[j].values) {
        const parentLabel = dataItemLabel(cappedDataItems[j].level);
        const parentId = generateId(parentLabel, `${file.path}:${cappedDataItems[j].name}`);
        emitCobolRel(result, 'CONTAINS', parentId, generateId('Const', `${file.path}:${item.name}`));
        break;
      }
    }
  }

  for (const fd of regexResults.fileDeclarations) {
    const nodeId = generateId('CodeElement', `${file.path}:SELECT:${fd.selectName}`);
    const descParts = ['select'];
    if (fd.organization) descParts.push(`org:${fd.organization}`);
    if (fd.access) descParts.push(`access:${fd.access}`);
    if (fd.recordKey) descParts.push(`key:${fd.recordKey}`);
    if (fd.fileStatus) descParts.push(`status:${fd.fileStatus}`);
    if (fd.assignTo) descParts.push(`assign:${fd.assignTo}`);
    emitCobolNode(result, 'CodeElement', nodeId, fd.selectName, file.path, fd.line, fileId, { description: descParts.join(' ') });
    if (fd.recordKey) emitCobolRel(result, 'RECORD_KEY_OF', generateId('Property', `${file.path}:${fd.recordKey}`), nodeId, 0.8, 'select-clause');
    if (fd.fileStatus) emitCobolRel(result, 'FILE_STATUS_OF', generateId('Property', `${file.path}:${fd.fileStatus}`), nodeId, 0.8, 'select-clause');
  }

  for (const fd of regexResults.fdEntries) {
    const nodeId = generateId('CodeElement', `${file.path}:FD:${fd.fdName}`);
    const fdDescParts = ['fd'];
    if (fd.recordName) fdDescParts.push(`record:${fd.recordName}`);
    emitCobolNode(result, 'CodeElement', nodeId, fd.fdName, file.path, fd.line, fileId, { description: fdDescParts.join(' ') });
    if (fd.recordName) emitCobolRel(result, 'CONTAINS', nodeId, generateId('Record', `${file.path}:${fd.recordName}`));
    emitCobolRel(result, 'CONTAINS', generateId('CodeElement', `${file.path}:SELECT:${fd.fdName}`), nodeId, 0.9, 'fd-select-link');
  }

  const emittedSqlIds = new Set<string>();
  for (const sql of regexResults.execSqlBlocks) {
    for (const table of sql.tables) {
      const tableId = generateId('CodeElement', `${file.path}:sql-table:${table}`);
      if (!emittedSqlIds.has(tableId)) {
        emittedSqlIds.add(tableId);
        emitCobolNode(result, 'CodeElement', tableId, table, file.path, sql.line, fileId, { description: `sql-table op:${sql.operation}` });
      }
      emitCobolRel(result, 'ACCESSES', moduleId, tableId, 0.9, 'exec-sql');
    }
    for (const cursor of sql.cursors) {
      const cursorId = generateId('CodeElement', `${file.path}:sql-cursor:${cursor}`);
      if (!emittedSqlIds.has(cursorId)) {
        emittedSqlIds.add(cursorId);
        emitCobolNode(result, 'CodeElement', cursorId, cursor, file.path, sql.line, fileId, { description: 'sql-cursor' });
      }
      emitCobolRel(result, 'ACCESSES', moduleId, cursorId, 0.9, 'exec-sql');
    }
  }

  const emittedCicsIds = new Set<string>();
  for (const cics of regexResults.execCicsBlocks) {
    if (cics.mapName) {
      const mapId = generateId('CodeElement', `${file.path}:cics-map:${cics.mapName}`);
      if (!emittedCicsIds.has(mapId)) {
        emittedCicsIds.add(mapId);
        emitCobolNode(result, 'CodeElement', mapId, cics.mapName, file.path, cics.line, fileId, { description: `cics-map cmd:${cics.command}` });
      }
      emitCobolRel(result, 'ACCESSES', moduleId, mapId, 0.9, 'exec-cics');
    }
    if (cics.programName) result.calls.push({ filePath: file.path, calledName: cics.programName, sourceId: moduleId });
    if (cics.transId) {
      const transIdNode = generateId('CodeElement', `${file.path}:cics-transid:${cics.transId}`);
      if (!emittedCicsIds.has(transIdNode)) {
        emittedCicsIds.add(transIdNode);
        emitCobolNode(result, 'CodeElement', transIdNode, cics.transId, file.path, cics.line, fileId, { description: `cics-transid cmd:${cics.command}` });
      }
      emitCobolRel(result, 'ACCESSES', moduleId, transIdNode, 0.9, 'exec-cics');
    }
  }

  for (const paramName of regexResults.procedureUsing) {
    emitCobolRel(result, 'RECEIVES', moduleId, generateId('Property', `${file.path}:${paramName}`), 0.8, 'procedure-using');
  }

  for (const entry of regexResults.entryPoints) {
    const entryId = generateId('Constructor', `${file.path}:${entry.name}`);
    const desc = entry.parameters.length > 0 ? `entry params:${entry.parameters.join(',')}` : 'entry';
    emitCobolNode(result, 'Constructor', entryId, entry.name, file.path, entry.line, fileId, { description: desc });
    emitCobolRel(result, 'CONTAINS', moduleId, entryId);
    result.symbols.push({ filePath: file.path, name: entry.name, nodeId: entryId, type: 'Constructor' });
  }

  result.fileCount++;
};

/**
 * Check if a language grammar is available in this worker.
 * Duplicated from parser-loader.ts because workers can't import from the main thread.
 * Extra filePath parameter needed to distinguish .tsx from .ts (different grammars
 * under the same SupportedLanguages.TypeScript key).
 */
const isLanguageAvailable = (language: SupportedLanguages, filePath: string): boolean => {
  const key = language === SupportedLanguages.TypeScript && filePath.endsWith('.tsx')
    ? `${language}:tsx`
    : language;
  return key in languageMap && languageMap[key] != null;
};

const setLanguage = (language: SupportedLanguages, filePath: string): void => {
  ensureTreeSitterLoaded();
  const key = language === SupportedLanguages.TypeScript && filePath.endsWith('.tsx')
    ? `${language}:tsx`
    : language;
  const lang = languageMap[key];
  if (!lang) throw new Error(`Unsupported language: ${language}`);
  parser.setLanguage(lang);
};

// isNodeExported imported from ../export-detection.js (shared module)

// ============================================================================
// Enclosing function detection (for call extraction)
// ============================================================================

/** Walk up AST to find enclosing function, return its generateId or null for top-level */
const findEnclosingFunctionId = (node: any, filePath: string): string | null => {
  let current = node.parent;
  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      const { funcName, label } = extractFunctionName(current);
      if (funcName) {
        return generateId(label, `${filePath}:${funcName}`);
      }
    }
    current = current.parent;
  }
  return null;
};

// ============================================================================
// Label detection from capture map
// ============================================================================

const getLabelFromCaptures = (captureMap: Record<string, any>): NodeLabel | null => {
  // Skip imports (handled separately) and calls
  if (captureMap['import'] || captureMap['call']) return null;
  if (!captureMap['name']) return null;

  if (captureMap['definition.function']) return 'Function';
  if (captureMap['definition.class']) return 'Class';
  if (captureMap['definition.interface']) return 'Interface';
  if (captureMap['definition.method']) return 'Method';
  if (captureMap['definition.struct']) return 'Struct';
  if (captureMap['definition.enum']) return 'Enum';
  if (captureMap['definition.namespace']) return 'Namespace';
  if (captureMap['definition.module']) return 'Module';
  if (captureMap['definition.trait']) return 'Trait';
  if (captureMap['definition.impl']) return 'Impl';
  if (captureMap['definition.type']) return 'TypeAlias';
  if (captureMap['definition.const']) return 'Const';
  if (captureMap['definition.static']) return 'Static';
  if (captureMap['definition.typedef']) return 'Typedef';
  if (captureMap['definition.macro']) return 'Macro';
  if (captureMap['definition.union']) return 'Union';
  if (captureMap['definition.property']) return 'Property';
  if (captureMap['definition.record']) return 'Record';
  if (captureMap['definition.delegate']) return 'Delegate';
  if (captureMap['definition.annotation']) return 'Annotation';
  if (captureMap['definition.constructor']) return 'Constructor';
  if (captureMap['definition.template']) return 'Template';
  return 'CodeElement';
};

// DEFINITION_CAPTURE_KEYS and getDefinitionNodeFromCaptures imported from ../utils.js


// ============================================================================
// Process a batch of files
// ============================================================================

const processBatch = (files: ParseWorkerInput[], onProgress?: (filesProcessed: number) => void): ParseWorkerResult => {
  const result: ParseWorkerResult = {
    nodes: [],
    relationships: [],
    symbols: [],
    imports: [],
    calls: [],
    assignments: [],
    heritage: [],
    routes: [],
    constructorBindings: [],
    skippedLanguages: {},
    fileCount: 0,
  };

  // Group by language to minimize setLanguage calls
  const byLanguage = new Map<SupportedLanguages, ParseWorkerInput[]>();
  for (const file of files) {
    const lang = getLanguageFromPath(file.path);
    if (!lang) continue;
    let list = byLanguage.get(lang);
    if (!list) {
      list = [];
      byLanguage.set(lang, list);
    }
    list.push(file);
  }

  let totalProcessed = 0;
  let lastReported = 0;
  const PROGRESS_INTERVAL = 100; // report every 100 files

  const onFileProcessed = onProgress ? () => {
    totalProcessed++;
    if (totalProcessed - lastReported >= PROGRESS_INTERVAL) {
      lastReported = totalProcessed;
      onProgress(totalProcessed);
    }
  } : undefined;

  for (const [language, langFiles] of byLanguage) {
    // COBOL: skip tree-sitter entirely — external scanner hangs on ~5% of files
    // with no way to timeout. Use regex-only extraction which is fast and reliable.
    if (language === SupportedLanguages.COBOL) {
      for (const file of langFiles) {
        processCobolRegexOnly(file, result);
        onFileProcessed?.();
      }
      continue;
    }

    const queryString = LANGUAGE_QUERIES[language];
    if (!queryString) continue;

    // Track if we need to handle tsx separately
    const tsxFiles: ParseWorkerInput[] = [];
    const regularFiles: ParseWorkerInput[] = [];

    if (language === SupportedLanguages.TypeScript) {
      for (const f of langFiles) {
        if (f.path.endsWith('.tsx')) {
          tsxFiles.push(f);
        } else {
          regularFiles.push(f);
        }
      }
    } else {
      regularFiles.push(...langFiles);
    }

    // Process regular files for this language
    if (regularFiles.length > 0) {
      if (isLanguageAvailable(language, regularFiles[0].path)) {
        try {
          setLanguage(language, regularFiles[0].path);
          processFileGroup(regularFiles, language, queryString, result, onFileProcessed);
        } catch {
          // parser unavailable — skip this language group
        }
      } else {
        result.skippedLanguages[language] = (result.skippedLanguages[language] || 0) + regularFiles.length;
      }
    }

    // Process tsx files separately (different grammar)
    if (tsxFiles.length > 0) {
      if (isLanguageAvailable(language, tsxFiles[0].path)) {
        try {
          setLanguage(language, tsxFiles[0].path);
          processFileGroup(tsxFiles, language, queryString, result, onFileProcessed);
        } catch {
          // parser unavailable — skip this language group
        }
      } else {
        result.skippedLanguages[language] = (result.skippedLanguages[language] || 0) + tsxFiles.length;
      }
    }
  }

  return result;
};

// ============================================================================
// PHP Eloquent metadata extraction
// ============================================================================

/** Eloquent model properties whose array values are worth indexing */
const ELOQUENT_ARRAY_PROPS = new Set(['fillable', 'casts', 'hidden', 'guarded', 'with', 'appends']);

/** Eloquent relationship method names */
const ELOQUENT_RELATIONS = new Set([
  'hasMany', 'hasOne', 'belongsTo', 'belongsToMany',
  'morphTo', 'morphMany', 'morphOne', 'morphToMany', 'morphedByMany',
  'hasManyThrough', 'hasOneThrough',
]);

function findDescendant(node: any, type: string): any {
  if (node.type === type) return node;
  for (const child of (node.children ?? [])) {
    const found = findDescendant(child, type);
    if (found) return found;
  }
  return null;
}

function extractStringContent(node: any): string | null {
  if (!node) return null;
  const content = node.children?.find((c: any) => c.type === 'string_content');
  if (content) return content.text;
  if (node.type === 'string_content') return node.text;
  return null;
}

/**
 * For a PHP property_declaration node, extract array values as a description string.
 * Returns null if not an Eloquent model property or no array values found.
 */
function extractPhpPropertyDescription(propName: string, propDeclNode: any): string | null {
  if (!ELOQUENT_ARRAY_PROPS.has(propName)) return null;

  const arrayNode = findDescendant(propDeclNode, 'array_creation_expression');
  if (!arrayNode) return null;

  const items: string[] = [];
  for (const child of (arrayNode.children ?? [])) {
    if (child.type !== 'array_element_initializer') continue;
    const children = child.children ?? [];
    const arrowIdx = children.findIndex((c: any) => c.type === '=>');
    if (arrowIdx !== -1) {
      // key => value pair (used in $casts)
      const key = extractStringContent(children[arrowIdx - 1]);
      const val = extractStringContent(children[arrowIdx + 1]);
      if (key && val) items.push(`${key}:${val}`);
    } else {
      // Simple value (used in $fillable, $hidden, etc.)
      const val = extractStringContent(children[0]);
      if (val) items.push(val);
    }
  }

  return items.length > 0 ? items.join(', ') : null;
}

/**
 * For a PHP method_declaration node, detect if it defines an Eloquent relationship.
 * Returns description like "hasMany(Post)" or null.
 */
function extractEloquentRelationDescription(methodNode: any): string | null {
  function findRelationCall(node: any): any {
    if (node.type === 'member_call_expression') {
      const children = node.children ?? [];
      const objectNode = children.find((c: any) => c.type === 'variable_name' && c.text === '$this');
      const nameNode = children.find((c: any) => c.type === 'name');
      if (objectNode && nameNode && ELOQUENT_RELATIONS.has(nameNode.text)) return node;
    }
    for (const child of (node.children ?? [])) {
      const found = findRelationCall(child);
      if (found) return found;
    }
    return null;
  }

  const callNode = findRelationCall(methodNode);
  if (!callNode) return null;

  const relType = callNode.children?.find((c: any) => c.type === 'name')?.text;
  const argsNode = callNode.children?.find((c: any) => c.type === 'arguments');
  let targetModel: string | null = null;
  if (argsNode) {
    const firstArg = argsNode.children?.find((c: any) => c.type === 'argument');
    if (firstArg) {
      const classConstant = firstArg.children?.find((c: any) =>
        c.type === 'class_constant_access_expression'
      );
      if (classConstant) {
        targetModel = classConstant.children?.find((c: any) => c.type === 'name')?.text ?? null;
      }
    }
  }

  if (relType && targetModel) return `${relType}(${targetModel})`;
  if (relType) return relType;
  return null;
}

// ============================================================================
// Laravel Route Extraction (procedural AST walk)
// ============================================================================

interface RouteGroupContext {
  middleware: string[];
  prefix: string | null;
  controller: string | null;
}

const ROUTE_HTTP_METHODS = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'options', 'any', 'match',
]);

const ROUTE_RESOURCE_METHODS = new Set(['resource', 'apiResource']);

const RESOURCE_ACTIONS = ['index', 'create', 'store', 'show', 'edit', 'update', 'destroy'];
const API_RESOURCE_ACTIONS = ['index', 'store', 'show', 'update', 'destroy'];

/** Check if node is a scoped_call_expression with object 'Route' */
function isRouteStaticCall(node: any): boolean {
  if (node.type !== 'scoped_call_expression') return false;
  const obj = node.childForFieldName?.('object') ?? node.children?.[0];
  return obj?.text === 'Route';
}

/** Get the method name from a scoped_call_expression or member_call_expression */
function getCallMethodName(node: any): string | null {
  const nameNode = node.childForFieldName?.('name') ??
    node.children?.find((c: any) => c.type === 'name');
  return nameNode?.text ?? null;
}

/** Get the arguments node from a call expression */
function getArguments(node: any): any {
  return node.children?.find((c: any) => c.type === 'arguments') ?? null;
}

/** Find the closure body inside arguments */
function findClosureBody(argsNode: any): any | null {
  if (!argsNode) return null;
  for (const child of argsNode.children ?? []) {
    if (child.type === 'argument') {
      for (const inner of child.children ?? []) {
        if (inner.type === 'anonymous_function' ||
            inner.type === 'arrow_function') {
          return inner.childForFieldName?.('body') ??
            inner.children?.find((c: any) => c.type === 'compound_statement');
        }
      }
    }
    if (child.type === 'anonymous_function' ||
        child.type === 'arrow_function') {
      return child.childForFieldName?.('body') ??
        child.children?.find((c: any) => c.type === 'compound_statement');
    }
  }
  return null;
}

/** Extract first string argument from arguments node */
function extractFirstStringArg(argsNode: any): string | null {
  if (!argsNode) return null;
  for (const child of argsNode.children ?? []) {
    const target = child.type === 'argument' ? child.children?.[0] : child;
    if (!target) continue;
    if (target.type === 'string' || target.type === 'encapsed_string') {
      return extractStringContent(target);
    }
  }
  return null;
}

/** Extract middleware from arguments — handles string or array */
function extractMiddlewareArg(argsNode: any): string[] {
  if (!argsNode) return [];
  for (const child of argsNode.children ?? []) {
    const target = child.type === 'argument' ? child.children?.[0] : child;
    if (!target) continue;
    if (target.type === 'string' || target.type === 'encapsed_string') {
      const val = extractStringContent(target);
      return val ? [val] : [];
    }
    if (target.type === 'array_creation_expression') {
      const items: string[] = [];
      for (const el of target.children ?? []) {
        if (el.type === 'array_element_initializer') {
          const str = el.children?.find((c: any) => c.type === 'string' || c.type === 'encapsed_string');
          const val = str ? extractStringContent(str) : null;
          if (val) items.push(val);
        }
      }
      return items;
    }
  }
  return [];
}

/** Extract Controller::class from arguments */
function extractClassArg(argsNode: any): string | null {
  if (!argsNode) return null;
  for (const child of argsNode.children ?? []) {
    const target = child.type === 'argument' ? child.children?.[0] : child;
    if (target?.type === 'class_constant_access_expression') {
      return target.children?.find((c: any) => c.type === 'name')?.text ?? null;
    }
  }
  return null;
}

/** Extract controller class name from arguments: [Controller::class, 'method'] or 'Controller@method' */
function extractControllerTarget(argsNode: any): { controller: string | null; method: string | null } {
  if (!argsNode) return { controller: null, method: null };

  const args: any[] = [];
  for (const child of argsNode.children ?? []) {
    if (child.type === 'argument') args.push(child.children?.[0]);
    else if (child.type !== '(' && child.type !== ')' && child.type !== ',') args.push(child);
  }

  // Second arg is the handler
  const handlerNode = args[1];
  if (!handlerNode) return { controller: null, method: null };

  // Array syntax: [UserController::class, 'index']
  if (handlerNode.type === 'array_creation_expression') {
    let controller: string | null = null;
    let method: string | null = null;
    const elements: any[] = [];
    for (const el of handlerNode.children ?? []) {
      if (el.type === 'array_element_initializer') elements.push(el);
    }
    if (elements[0]) {
      const classAccess = findDescendant(elements[0], 'class_constant_access_expression');
      if (classAccess) {
        controller = classAccess.children?.find((c: any) => c.type === 'name')?.text ?? null;
      }
    }
    if (elements[1]) {
      const str = findDescendant(elements[1], 'string');
      method = str ? extractStringContent(str) : null;
    }
    return { controller, method };
  }

  // String syntax: 'UserController@index'
  if (handlerNode.type === 'string' || handlerNode.type === 'encapsed_string') {
    const text = extractStringContent(handlerNode);
    if (text?.includes('@')) {
      const [controller, method] = text.split('@');
      return { controller, method };
    }
  }

  // Class reference: UserController::class (invokable controller)
  if (handlerNode.type === 'class_constant_access_expression') {
    const controller = handlerNode.children?.find((c: any) => c.type === 'name')?.text ?? null;
    return { controller, method: '__invoke' };
  }

  return { controller: null, method: null };
}

interface ChainedRouteCall {
  isRouteFacade: boolean;
  terminalMethod: string;
  attributes: { method: string; argsNode: any }[];
  terminalArgs: any;
  node: any;
}

/**
 * Unwrap a chained call like Route::middleware('auth')->prefix('api')->group(fn)
 */
function unwrapRouteChain(node: any): ChainedRouteCall | null {
  if (node.type !== 'member_call_expression') return null;

  const terminalMethod = getCallMethodName(node);
  if (!terminalMethod) return null;

  const terminalArgs = getArguments(node);
  const attributes: { method: string; argsNode: any }[] = [];

  let current = node.children?.[0];

  while (current) {
    if (current.type === 'member_call_expression') {
      const method = getCallMethodName(current);
      const args = getArguments(current);
      if (method) attributes.unshift({ method, argsNode: args });
      current = current.children?.[0];
    } else if (current.type === 'scoped_call_expression') {
      const obj = current.childForFieldName?.('object') ?? current.children?.[0];
      if (obj?.text !== 'Route') return null;

      const method = getCallMethodName(current);
      const args = getArguments(current);
      if (method) attributes.unshift({ method, argsNode: args });

      return { isRouteFacade: true, terminalMethod, attributes, terminalArgs, node };
    } else {
      break;
    }
  }

  return null;
}

/** Parse Route::group(['middleware' => ..., 'prefix' => ...], fn) array syntax */
function parseArrayGroupArgs(argsNode: any): RouteGroupContext {
  const ctx: RouteGroupContext = { middleware: [], prefix: null, controller: null };
  if (!argsNode) return ctx;

  for (const child of argsNode.children ?? []) {
    const target = child.type === 'argument' ? child.children?.[0] : child;
    if (target?.type === 'array_creation_expression') {
      for (const el of target.children ?? []) {
        if (el.type !== 'array_element_initializer') continue;
        const children = el.children ?? [];
        const arrowIdx = children.findIndex((c: any) => c.type === '=>');
        if (arrowIdx === -1) continue;
        const key = extractStringContent(children[arrowIdx - 1]);
        const val = children[arrowIdx + 1];
        if (key === 'middleware') {
          if (val?.type === 'string') {
            const s = extractStringContent(val);
            if (s) ctx.middleware.push(s);
          } else if (val?.type === 'array_creation_expression') {
            for (const item of val.children ?? []) {
              if (item.type === 'array_element_initializer') {
                const str = item.children?.find((c: any) => c.type === 'string');
                const s = str ? extractStringContent(str) : null;
                if (s) ctx.middleware.push(s);
              }
            }
          }
        } else if (key === 'prefix') {
          ctx.prefix = extractStringContent(val) ?? null;
        } else if (key === 'controller') {
          if (val?.type === 'class_constant_access_expression') {
            ctx.controller = val.children?.find((c: any) => c.type === 'name')?.text ?? null;
          }
        }
      }
    }
  }
  return ctx;
}

function extractLaravelRoutes(tree: any, filePath: string): ExtractedRoute[] {
  const routes: ExtractedRoute[] = [];

  function resolveStack(stack: RouteGroupContext[]): { middleware: string[]; prefix: string | null; controller: string | null } {
    const middleware: string[] = [];
    let prefix: string | null = null;
    let controller: string | null = null;
    for (const ctx of stack) {
      middleware.push(...ctx.middleware);
      if (ctx.prefix) prefix = prefix ? `${prefix}/${ctx.prefix}`.replace(/\/+/g, '/') : ctx.prefix;
      if (ctx.controller) controller = ctx.controller;
    }
    return { middleware, prefix, controller };
  }

  function emitRoute(
    httpMethod: string,
    argsNode: any,
    lineNumber: number,
    groupStack: RouteGroupContext[],
    chainAttrs: { method: string; argsNode: any }[],
  ) {
    const effective = resolveStack(groupStack);

    for (const attr of chainAttrs) {
      if (attr.method === 'middleware') effective.middleware.push(...extractMiddlewareArg(attr.argsNode));
      if (attr.method === 'prefix') {
        const p = extractFirstStringArg(attr.argsNode);
        if (p) effective.prefix = effective.prefix ? `${effective.prefix}/${p}` : p;
      }
      if (attr.method === 'controller') {
        const cls = extractClassArg(attr.argsNode);
        if (cls) effective.controller = cls;
      }
    }

    const routePath = extractFirstStringArg(argsNode);

    if (ROUTE_RESOURCE_METHODS.has(httpMethod)) {
      const target = extractControllerTarget(argsNode);
      const actions = httpMethod === 'apiResource' ? API_RESOURCE_ACTIONS : RESOURCE_ACTIONS;
      for (const action of actions) {
        routes.push({
          filePath, httpMethod, routePath,
          controllerName: target.controller ?? effective.controller,
          methodName: action,
          middleware: [...effective.middleware],
          prefix: effective.prefix,
          lineNumber,
        });
      }
    } else {
      const target = extractControllerTarget(argsNode);
      routes.push({
        filePath, httpMethod, routePath,
        controllerName: target.controller ?? effective.controller,
        methodName: target.method,
        middleware: [...effective.middleware],
        prefix: effective.prefix,
        lineNumber,
      });
    }
  }

  function walk(node: any, groupStack: RouteGroupContext[]) {
    // Case 1: Simple Route::get(...), Route::post(...), etc.
    if (isRouteStaticCall(node)) {
      const method = getCallMethodName(node);
      if (method && (ROUTE_HTTP_METHODS.has(method) || ROUTE_RESOURCE_METHODS.has(method))) {
        emitRoute(method, getArguments(node), node.startPosition.row, groupStack, []);
        return;
      }
      if (method === 'group') {
        const argsNode = getArguments(node);
        const groupCtx = parseArrayGroupArgs(argsNode);
        const body = findClosureBody(argsNode);
        if (body) {
          groupStack.push(groupCtx);
          walkChildren(body, groupStack);
          groupStack.pop();
        }
        return;
      }
    }

    // Case 2: Fluent chain — Route::middleware(...)->group(...) or Route::middleware(...)->get(...)
    const chain = unwrapRouteChain(node);
    if (chain) {
      if (chain.terminalMethod === 'group') {
        const groupCtx: RouteGroupContext = { middleware: [], prefix: null, controller: null };
        for (const attr of chain.attributes) {
          if (attr.method === 'middleware') groupCtx.middleware.push(...extractMiddlewareArg(attr.argsNode));
          if (attr.method === 'prefix') groupCtx.prefix = extractFirstStringArg(attr.argsNode);
          if (attr.method === 'controller') groupCtx.controller = extractClassArg(attr.argsNode);
        }
        const body = findClosureBody(chain.terminalArgs);
        if (body) {
          groupStack.push(groupCtx);
          walkChildren(body, groupStack);
          groupStack.pop();
        }
        return;
      }
      if (ROUTE_HTTP_METHODS.has(chain.terminalMethod) || ROUTE_RESOURCE_METHODS.has(chain.terminalMethod)) {
        emitRoute(chain.terminalMethod, chain.terminalArgs, node.startPosition.row, groupStack, chain.attributes);
        return;
      }
    }

    // Default: recurse into children
    walkChildren(node, groupStack);
  }

  function walkChildren(node: any, groupStack: RouteGroupContext[]) {
    for (const child of node.children ?? []) {
      walk(child, groupStack);
    }
  }

  walk(tree.rootNode, []);
  return routes;
}

const processFileGroup = (
  files: ParseWorkerInput[],
  language: SupportedLanguages,
  queryString: string,
  result: ParseWorkerResult,
  onFileProcessed?: () => void,
): void => {
  let query: any;
  try {
    const lang = parser.getLanguage();
    query = new Parser.Query(lang, queryString);
  } catch (err) {
    const message = `Query compilation failed for ${language}: ${err instanceof Error ? err.message : String(err)}`;
    if (parentPort) {
      parentPort.postMessage({ type: 'warning', message });
    } else {
      console.warn(message);
    }
    return;
  }

  for (const file of files) {
    // Skip files larger than the max tree-sitter buffer (32 MB)
    if (file.content.length > TREE_SITTER_MAX_BUFFER) continue;

    let tree;
    try {
      tree = parser.parse(file.content, undefined, { bufferSize: getTreeSitterBufferSize(file.content.length) });
    } catch (err) {
      console.warn(`Failed to parse file ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    result.fileCount++;
    onFileProcessed?.();

    // Build per-file type environment + constructor bindings in a single AST walk.
    // Constructor bindings are verified against the SymbolTable in processCallsFromExtracted.
    const typeEnv = buildTypeEnv(tree, language);
    const callRouter = callRouters[language];

    if (typeEnv.constructorBindings.length > 0) {
      result.constructorBindings.push({ filePath: file.path, bindings: [...typeEnv.constructorBindings] });
    }

    let matches;
    try {
      matches = query.matches(tree.rootNode);
    } catch (err) {
      console.warn(`Query execution failed for ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const match of matches) {
      const captureMap: Record<string, any> = {};
      for (const c of match.captures) {
        captureMap[c.name] = c.node;
      }

      // Extract import paths before skipping
      if (captureMap['import'] && captureMap['import.source']) {
        const rawImportPath = language === SupportedLanguages.Kotlin
          ? appendKotlinWildcard(captureMap['import.source'].text.replace(/['"<>]/g, ''), captureMap['import'])
          : captureMap['import.source'].text.replace(/['"<>]/g, '');
        const namedBindings = extractNamedBindings(captureMap['import'], language);
        result.imports.push({
          filePath: file.path,
          rawImportPath,
          language: language,
          ...(namedBindings ? { namedBindings } : {}),
        });
        continue;
      }

      // Extract assignment sites (field write access)
      if (captureMap['assignment'] && captureMap['assignment.receiver'] && captureMap['assignment.property']) {
        const receiverText = captureMap['assignment.receiver'].text;
        const propertyName = captureMap['assignment.property'].text;
        if (receiverText && propertyName) {
          const srcId = findEnclosingFunctionId(captureMap['assignment'], file.path)
            || generateId('File', file.path);
          let receiverTypeName: string | undefined;
          if (typeEnv) {
            receiverTypeName = typeEnv.lookup(receiverText, captureMap['assignment']) ?? undefined;
          }
          result.assignments.push({
            filePath: file.path,
            sourceId: srcId,
            receiverText,
            propertyName,
            ...(receiverTypeName ? { receiverTypeName } : {}),
          });
        }
        if (!captureMap['call']) continue;
      }

      // Extract call sites
      if (captureMap['call']) {
        const callNameNode = captureMap['call.name'];
        if (callNameNode) {
          const calledName = callNameNode.text;

          // Dispatch: route language-specific calls (heritage, properties, imports)
          const routed = callRouter(calledName, captureMap['call']);
          if (routed) {
            if (routed.kind === 'skip') continue;

            if (routed.kind === 'import') {
              result.imports.push({
                filePath: file.path,
                rawImportPath: routed.importPath,
                language,
              });
              continue;
            }

            if (routed.kind === 'heritage') {
              for (const item of routed.items) {
                result.heritage.push({
                  filePath: file.path,
                  className: item.enclosingClass,
                  parentName: item.mixinName,
                  kind: item.heritageKind,
                });
              }
              continue;
            }

            if (routed.kind === 'properties') {
              const propEnclosingClassId = findEnclosingClassId(captureMap['call'], file.path);
              for (const item of routed.items) {
                const nodeId = generateId('Property', `${file.path}:${item.propName}`);
                result.nodes.push({
                  id: nodeId,
                  label: 'Property',
                  properties: {
                    name: item.propName,
                    filePath: file.path,
                    startLine: item.startLine,
                    endLine: item.endLine,
                    language,
                    isExported: true,
                    description: item.accessorType,
                  },
                });
                result.symbols.push({
                  filePath: file.path,
                  name: item.propName,
                  nodeId,
                  type: 'Property',
                  ...(propEnclosingClassId ? { ownerId: propEnclosingClassId } : {}),
                  ...(item.declaredType ? { declaredType: item.declaredType } : {}),
                });
                const fileId = generateId('File', file.path);
                const relId = generateId('DEFINES', `${fileId}->${nodeId}`);
                result.relationships.push({
                  id: relId,
                  sourceId: fileId,
                  targetId: nodeId,
                  type: 'DEFINES',
                  confidence: 1.0,
                  reason: '',
                });
                if (propEnclosingClassId) {
                  result.relationships.push({
                    id: generateId('HAS_PROPERTY', `${propEnclosingClassId}->${nodeId}`),
                    sourceId: propEnclosingClassId,
                    targetId: nodeId,
                    type: 'HAS_PROPERTY',
                    confidence: 1.0,
                    reason: '',
                  });
                }
              }
              continue;
            }

            // kind === 'call' — fall through to normal call processing below
          }

          if (!isBuiltInOrNoise(calledName)) {
            const callNode = captureMap['call'];
            const sourceId = findEnclosingFunctionId(callNode, file.path)
              || generateId('File', file.path);
            const callForm = inferCallForm(callNode, callNameNode);
            let receiverName = callForm === 'member' ? extractReceiverName(callNameNode) : undefined;
            let receiverTypeName = receiverName ? typeEnv.lookup(receiverName, callNode) : undefined;
            let receiverMixedChain: MixedChainStep[] | undefined;

            // When the receiver is a complex expression (call chain, field chain, or mixed),
            // extractReceiverName returns undefined. Walk the receiver node to build a unified
            // mixed chain for deferred resolution in processCallsFromExtracted.
            if (callForm === 'member' && receiverName === undefined && !receiverTypeName) {
              const receiverNode = extractReceiverNode(callNameNode);
              if (receiverNode) {
                const extracted = extractMixedChain(receiverNode);
                if (extracted && extracted.chain.length > 0) {
                  receiverMixedChain = extracted.chain;
                  receiverName = extracted.baseReceiverName;
                  // Try the type environment immediately for the base receiver
                  // (covers explicitly-typed locals and annotated parameters).
                  if (receiverName) {
                    receiverTypeName = typeEnv.lookup(receiverName, callNode);
                  }
                }
              }
            }

            result.calls.push({
              filePath: file.path,
              calledName,
              sourceId,
              argCount: countCallArguments(callNode),
              ...(callForm !== undefined ? { callForm } : {}),
              ...(receiverName !== undefined ? { receiverName } : {}),
              ...(receiverTypeName !== undefined ? { receiverTypeName } : {}),
              ...(receiverMixedChain !== undefined ? { receiverMixedChain } : {}),
            });
          }
        }
        continue;
      }

      // Extract heritage (extends/implements)
      if (captureMap['heritage.class']) {
        if (captureMap['heritage.extends']) {
          // Go struct embedding: the query matches ALL field_declarations with
          // type_identifier, but only anonymous fields (no name) are embedded.
          // Named fields like `Breed string` also match — skip them.
          const extendsNode = captureMap['heritage.extends'];
          const fieldDecl = extendsNode.parent;
          const isNamedField = fieldDecl?.type === 'field_declaration'
            && fieldDecl.childForFieldName('name');
          if (!isNamedField) {
            result.heritage.push({
              filePath: file.path,
              className: captureMap['heritage.class'].text,
              parentName: captureMap['heritage.extends'].text,
              kind: 'extends',
            });
          }
        }
        if (captureMap['heritage.implements']) {
          result.heritage.push({
            filePath: file.path,
            className: captureMap['heritage.class'].text,
            parentName: captureMap['heritage.implements'].text,
            kind: 'implements',
          });
        }
        if (captureMap['heritage.trait']) {
          result.heritage.push({
            filePath: file.path,
            className: captureMap['heritage.class'].text,
            parentName: captureMap['heritage.trait'].text,
            kind: 'trait-impl',
          });
        }
        if (captureMap['heritage.extends'] || captureMap['heritage.implements'] || captureMap['heritage.trait']) {
          continue;
        }
      }

      const nodeLabel = getLabelFromCaptures(captureMap);
      if (!nodeLabel) continue;

      // C/C++: @definition.function is broad and also matches inline class methods (inside
      // a class/struct body). Those are already captured by @definition.method, so skip
      // the duplicate Function entry to prevent double-indexing in globalIndex.
      if (
        (language === SupportedLanguages.CPlusPlus || language === SupportedLanguages.C) &&
        nodeLabel === 'Function'
      ) {
        let ancestor = captureMap['definition.function']?.parent;
        while (ancestor) {
          if (ancestor.type === 'class_specifier' || ancestor.type === 'struct_specifier') {
            break; // inside a class body — duplicate of @definition.method
          }
          ancestor = ancestor.parent;
        }
        if (ancestor) continue; // found a class/struct ancestor → skip
      }

      const nameNode = captureMap['name'];
      // Synthesize name for constructors without explicit @name capture (e.g. Swift init)
      if (!nameNode && nodeLabel !== 'Constructor') continue;
      const nodeName = nameNode ? nameNode.text : 'init';
      const definitionNode = getDefinitionNodeFromCaptures(captureMap);
      const startLine = definitionNode ? definitionNode.startPosition.row : (nameNode ? nameNode.startPosition.row : 0);
      const nodeId = generateId(nodeLabel, `${file.path}:${nodeName}`);

      let description: string | undefined;
      if (language === SupportedLanguages.PHP) {
        if (nodeLabel === 'Property' && captureMap['definition.property']) {
          description = extractPhpPropertyDescription(nodeName, captureMap['definition.property']) ?? undefined;
        } else if (nodeLabel === 'Method' && captureMap['definition.method']) {
          description = extractEloquentRelationDescription(captureMap['definition.method']) ?? undefined;
        }
      }

      const frameworkHint = definitionNode
        ? detectFrameworkFromAST(language, (definitionNode.text || '').slice(0, 300))
        : null;

      let parameterCount: number | undefined;
      let returnType: string | undefined;
      let declaredType: string | undefined;
      if (nodeLabel === 'Function' || nodeLabel === 'Method' || nodeLabel === 'Constructor') {
        const sig = extractMethodSignature(definitionNode);
        parameterCount = sig.parameterCount;
        returnType = sig.returnType;

        // Language-specific return type fallback (e.g. Ruby YARD @return [Type])
        if (!returnType && definitionNode) {
          const tc = typeConfigs[language as keyof typeof typeConfigs];
          if (tc?.extractReturnType) {
            returnType = tc.extractReturnType(definitionNode);
          }
        }
      } else if (nodeLabel === 'Property' && definitionNode) {
        // Extract the declared type for property/field nodes.
        // Walk the definition node for type annotation children.
        declaredType = extractPropertyDeclaredType(definitionNode);
      }

      result.nodes.push({
        id: nodeId,
        label: nodeLabel,
        properties: {
          name: nodeName,
          filePath: file.path,
          startLine: definitionNode ? definitionNode.startPosition.row : startLine,
          endLine: definitionNode ? definitionNode.endPosition.row : startLine,
          language: language,
          isExported: isNodeExported(nameNode || definitionNode, nodeName, language),
          ...(frameworkHint ? {
            astFrameworkMultiplier: frameworkHint.entryPointMultiplier,
            astFrameworkReason: frameworkHint.reason,
          } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(parameterCount !== undefined ? { parameterCount } : {}),
          ...(returnType !== undefined ? { returnType } : {}),
        },
      });

      // Compute enclosing class for Method/Constructor/Property/Function — used for both ownerId and HAS_METHOD
      // Function is included because Kotlin/Rust/Python capture class methods as Function nodes
      const needsOwner = nodeLabel === 'Method' || nodeLabel === 'Constructor' || nodeLabel === 'Property' || nodeLabel === 'Function';
      const enclosingClassId = needsOwner ? findEnclosingClassId(nameNode || definitionNode, file.path) : null;

      result.symbols.push({
        filePath: file.path,
        name: nodeName,
        nodeId,
        type: nodeLabel,
        ...(parameterCount !== undefined ? { parameterCount } : {}),
        ...(returnType !== undefined ? { returnType } : {}),
        ...(declaredType !== undefined ? { declaredType } : {}),
        ...(enclosingClassId ? { ownerId: enclosingClassId } : {}),
      });

      const fileId = generateId('File', file.path);
      const relId = generateId('DEFINES', `${fileId}->${nodeId}`);
      result.relationships.push({
        id: relId,
        sourceId: fileId,
        targetId: nodeId,
        type: 'DEFINES',
        confidence: 1.0,
        reason: '',
      });

      // ── HAS_METHOD / HAS_PROPERTY: link member to enclosing class ──
      if (enclosingClassId) {
        const memberEdgeType = nodeLabel === 'Property' ? 'HAS_PROPERTY' : 'HAS_METHOD';
        result.relationships.push({
          id: generateId(memberEdgeType, `${enclosingClassId}->${nodeId}`),
          sourceId: enclosingClassId,
          targetId: nodeId,
          type: memberEdgeType,
          confidence: 1.0,
          reason: '',
        });
      }
    }

    // Extract Laravel routes from route files via procedural AST walk
    if (language === SupportedLanguages.PHP && (file.path.includes('/routes/') || file.path.startsWith('routes/')) && file.path.endsWith('.php')) {
      const extractedRoutes = extractLaravelRoutes(tree, file.path);
      result.routes.push(...extractedRoutes);
    }
  }
};

// ============================================================================
// Worker message handler — supports sub-batch streaming
// ============================================================================

/** Accumulated result across sub-batches */
let accumulated: ParseWorkerResult = {
  nodes: [], relationships: [], symbols: [],
  imports: [], calls: [], assignments: [], heritage: [], routes: [], constructorBindings: [], skippedLanguages: {}, fileCount: 0,
};
let cumulativeProcessed = 0;

const mergeResult = (target: ParseWorkerResult, src: ParseWorkerResult) => {
  target.nodes.push(...src.nodes);
  target.relationships.push(...src.relationships);
  target.symbols.push(...src.symbols);
  target.imports.push(...src.imports);
  target.calls.push(...src.calls);
  target.assignments.push(...src.assignments);
  target.heritage.push(...src.heritage);
  target.routes.push(...src.routes);
  target.constructorBindings.push(...src.constructorBindings);
  for (const [lang, count] of Object.entries(src.skippedLanguages)) {
    target.skippedLanguages[lang] = (target.skippedLanguages[lang] || 0) + count;
  }
  target.fileCount += src.fileCount;
};

parentPort!.on('message', (msg: any) => {
  try {
    // Sub-batch mode: { type: 'sub-batch', files: [...] }
    if (msg && msg.type === 'sub-batch') {
      const result = processBatch(msg.files, (filesProcessed) => {
        parentPort!.postMessage({ type: 'progress', filesProcessed: cumulativeProcessed + filesProcessed });
      });
      cumulativeProcessed += result.fileCount;
      mergeResult(accumulated, result);
      // Signal ready for next sub-batch
      parentPort!.postMessage({ type: 'sub-batch-done' });
      return;
    }

    // Flush: send accumulated results
    if (msg && msg.type === 'flush') {
      parentPort!.postMessage({ type: 'result', data: accumulated });
      // Reset for potential reuse
      accumulated = { nodes: [], relationships: [], symbols: [], imports: [], calls: [], assignments: [], heritage: [], routes: [], constructorBindings: [], skippedLanguages: {}, fileCount: 0 };
      cumulativeProcessed = 0;
      return;
    }

    // Legacy single-message mode (backward compat): array of files
    if (Array.isArray(msg)) {
      const result = processBatch(msg, (filesProcessed) => {
        parentPort!.postMessage({ type: 'progress', filesProcessed });
      });
      parentPort!.postMessage({ type: 'result', data: result });
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort!.postMessage({ type: 'error', error: message });
  }
});

parentPort!.postMessage({ type: 'ready' });
