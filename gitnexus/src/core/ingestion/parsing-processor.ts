import { KnowledgeGraph, GraphNode, GraphRelationship } from '../graph/types.js';
import Parser from 'tree-sitter';
import { loadParser, loadLanguage } from '../tree-sitter/parser-loader.js';
import { LANGUAGE_QUERIES } from './tree-sitter-queries.js';
import { generateId } from '../../lib/utils.js';
import { SymbolTable } from './symbol-table.js';
import { ASTCache } from './ast-cache.js';
import { getLanguageFromFilename, getLanguageFromPath, yieldToEventLoop, DEFINITION_CAPTURE_KEYS, getDefinitionNodeFromCaptures, findEnclosingClassId, extractMethodSignature, isBuiltInOrNoise } from './utils.js';
import { isNodeExported } from './export-detection.js';
import { preprocessCobolSource, extractCobolSymbolsWithRegex } from './cobol-preprocessor.js';
import { SupportedLanguages } from '../../config/supported-languages.js';
import { detectFrameworkFromAST } from './framework-detection.js';
import { WorkerPool } from './workers/worker-pool.js';
import type { ParseWorkerResult, ParseWorkerInput, ExtractedImport, ExtractedCall, ExtractedHeritage, ExtractedRoute } from './workers/parse-worker.js';
import { getTreeSitterBufferSize, TREE_SITTER_MAX_BUFFER } from './constants.js';

export type FileProgressCallback = (current: number, total: number, filePath: string) => void;

export interface WorkerExtractedData {
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  heritage: ExtractedHeritage[];
  routes: ExtractedRoute[];
  /** True when data came from the sequential fallback (only COBOL data present;
   *  non-COBOL files still need tree-sitter-based import/call processing). */
  sequentialFallback?: boolean;
}

// isNodeExported imported from ./export-detection.js (shared module)
// Re-export for backward compatibility with any external consumers
export { isNodeExported } from './export-detection.js';

// ============================================================================
// Worker-based parallel parsing
// ============================================================================

const processParsingWithWorkers = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  symbolTable: SymbolTable,
  astCache: ASTCache,
  workerPool: WorkerPool,
  onFileProgress?: FileProgressCallback,
): Promise<WorkerExtractedData> => {
  // Filter to parseable files only
  const parseableFiles: ParseWorkerInput[] = [];
  for (const file of files) {
    const lang = getLanguageFromPath(file.path);
    if (lang) parseableFiles.push({ path: file.path, content: file.content });
  }

  if (parseableFiles.length === 0) return { imports: [], calls: [], heritage: [], routes: [] };

  const total = files.length;

  // Dispatch to worker pool — pool handles splitting into chunks and sub-batching
  const chunkResults = await workerPool.dispatch<ParseWorkerInput, ParseWorkerResult>(
    parseableFiles,
    (filesProcessed) => {
      onFileProgress?.(Math.min(filesProcessed, total), total, 'Parsing...');
    },
  );

  // Merge results from all workers into graph and symbol table
  const allImports: ExtractedImport[] = [];
  const allCalls: ExtractedCall[] = [];
  const allHeritage: ExtractedHeritage[] = [];
  const allRoutes: ExtractedRoute[] = [];
  for (const result of chunkResults) {
    for (const node of result.nodes) {
      graph.addNode({
        id: node.id,
        label: node.label as any,
        properties: node.properties,
      });
    }

    for (const rel of result.relationships) {
      graph.addRelationship(rel as any);
    }

    for (const sym of result.symbols) {
      symbolTable.add(sym.filePath, sym.name, sym.nodeId, sym.type, {
        parameterCount: sym.parameterCount,
        ownerId: sym.ownerId,
      });
    }

    allImports.push(...result.imports);
    allCalls.push(...result.calls);
    allHeritage.push(...result.heritage);
    allRoutes.push(...result.routes);
  }

  // Final progress
  onFileProgress?.(total, total, 'done');
  return { imports: allImports, calls: allCalls, heritage: allHeritage, routes: allRoutes };
};

// ============================================================================
// Sequential fallback (original implementation)
// ============================================================================

const processParsingSequential = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  symbolTable: SymbolTable,
  astCache: ASTCache,
  onFileProgress?: FileProgressCallback
): Promise<WorkerExtractedData | null> => {
  const parser = await loadParser();
  const total = files.length;

  // Collect COBOL extracted data so the pipeline can resolve calls/imports
  // (tree-sitter-based processCalls/processImports skip COBOL files)
  const cobolImports: ExtractedImport[] = [];
  const cobolCalls: ExtractedCall[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    onFileProgress?.(i + 1, total, file.path);

    if (i % 20 === 0) await yieldToEventLoop();

    const language = getLanguageFromPath(file.path);

    if (!language) continue;

    // COBOL: skip tree-sitter entirely — external scanner hangs on ~5% of files
    // with no way to timeout. Use regex-only extraction which is fast and reliable.
    if (language === SupportedLanguages.COBOL) {
      const regexResults = extractCobolSymbolsWithRegex(file.content, file.path);
      const fileId = generateId('File', file.path);

      // --- Helper: emit node + DEFINES rel + symbol in one call ---
      const emitNode = (label: string, nodeId: string, name: string, line: number, opts?: { isExported?: boolean; description?: string }): void => {
        graph.addNode({
          id: nodeId, label: label as any,
          properties: {
            name, filePath: file.path, startLine: line, endLine: line,
            language: SupportedLanguages.COBOL,
            isExported: opts?.isExported ?? false,
            ...(opts?.description ? { description: opts.description } : {}),
          },
        });
        graph.addRelationship({
          id: generateId('DEFINES', `${fileId}->${nodeId}`),
          sourceId: fileId, targetId: nodeId, type: 'DEFINES', confidence: 1.0, reason: '',
        });
        symbolTable.add(file.path, name, nodeId, label);
      };

      // --- Helper: emit a non-DEFINES relationship ---
      const emitRel = (type: string, sourceId: string, targetId: string, confidence = 1.0, reason = ''): void => {
        graph.addRelationship({
          id: generateId(type, `${sourceId}->${targetId}`),
          sourceId, targetId, type: type as any, confidence, reason,
        });
      };

      // --- Helper: build description from key-value pairs ---
      const buildDesc = (parts: Array<[string, string | number | undefined]>): string =>
        parts.filter(([, v]) => v !== undefined).map(([k, v]) => `${k}:${v}`).join(' ');

      // --- Helper: node label for a data item by level ---
      const dataItemLabel = (level: number): string => (level === 1 ? 'Record' : 'Property');

      // Program name → Module node (with metadata)
      if (regexResults.programName) {
        const nodeId = generateId('Module', `${file.path}:${regexResults.programName}`);
        const metaDesc = buildDesc([
          ['author', regexResults.programMetadata.author],
          ['date', regexResults.programMetadata.dateWritten],
        ]);
        graph.addNode({
          id: nodeId, label: 'Module' as any,
          properties: {
            name: regexResults.programName, filePath: file.path, startLine: 0, endLine: 0,
            language: SupportedLanguages.COBOL, isExported: true,
            ...(metaDesc ? { description: metaDesc } : {}),
          },
        });
        graph.addRelationship({
          id: generateId('DEFINES', `${fileId}->${nodeId}`),
          sourceId: fileId, targetId: nodeId, type: 'DEFINES', confidence: 1.0, reason: '',
        });
        symbolTable.add(file.path, regexResults.programName, nodeId, 'Module');
      }

      const moduleId = regexResults.programName
        ? generateId('Module', `${file.path}:${regexResults.programName}`)
        : fileId;

      for (const para of regexResults.paragraphs) {
        const nodeId = generateId('Function', `${file.path}:${para.name}`);
        emitNode('Function', nodeId, para.name, para.line, { isExported: true });
      }

      for (const sec of regexResults.sections) {
        const nodeId = generateId('Namespace', `${file.path}:${sec.name}`);
        emitNode('Namespace', nodeId, sec.name, sec.line, { isExported: true });
      }

      // =====================================================================
      // Deep indexing: data items, file declarations, FD entries
      // =====================================================================

      // --- Data Items → Record / Property / Const nodes ---
      // Cap data items per file to prevent copy-expansion explosion:
      // after COPY expansion a program can have thousands of copybook data
      // items, all with unique file-scoped IDs, which pushes the in-memory
      // relationship Map past the 16.7M V8 limit across thousands of files.
      const MAX_DATA_ITEMS_PER_FILE = 500;
      const cappedDataItems = regexResults.dataItems.length > MAX_DATA_ITEMS_PER_FILE
        ? regexResults.dataItems.slice(0, MAX_DATA_ITEMS_PER_FILE)
        : regexResults.dataItems;

      for (const item of cappedDataItems) {
        if (item.values) {
          const nodeId = generateId('Const', `${file.path}:${item.name}`);
          const desc = `level:88 values:${item.values.join(',')}`;
          emitNode('Const', nodeId, item.name, item.line, { description: desc });
        } else if (item.level === 1) {
          const nodeId = generateId('Record', `${file.path}:${item.name}`);
          const desc = buildDesc([
            ['level', '01'], ['pic', item.pic], ['usage', item.usage],
            ['occurs', item.occurs], ['section', item.section],
          ]);
          emitNode('Record', nodeId, item.name, item.line, { description: desc });
          if (item.redefines) {
            emitRel('REDEFINES', nodeId, generateId('Record', `${file.path}:${item.redefines}`));
          }
        } else {
          const nodeId = generateId('Property', `${file.path}:${item.name}`);
          const desc = buildDesc([
            ['level', String(item.level).padStart(2, '0')], ['pic', item.pic],
            ['usage', item.usage], ['occurs', item.occurs], ['section', item.section],
          ]);
          emitNode('Property', nodeId, item.name, item.line, { description: desc });
          if (item.redefines) {
            emitRel('REDEFINES', nodeId, generateId('Property', `${file.path}:${item.redefines}`));
          }
        }
      }

      // --- CONTAINS hierarchy from level structure ---
      const parentStack: Array<{ level: number; nodeId: string }> = [];
      for (const item of cappedDataItems) {
        if (item.values) continue; // 88-level handled separately below

        const label = dataItemLabel(item.level);
        const nodeId = generateId(label, `${file.path}:${item.name}`);

        while (parentStack.length > 0 && parentStack[parentStack.length - 1].level >= item.level) {
          parentStack.pop();
        }

        if (parentStack.length > 0) {
          emitRel('CONTAINS', parentStack[parentStack.length - 1].nodeId, nodeId);
        } else {
          emitRel('CONTAINS', moduleId, nodeId);
        }

        parentStack.push({ level: item.level, nodeId });
      }

      // 88-level Const → parent Property/Record via CONTAINS
      for (let i = 0; i < cappedDataItems.length; i++) {
        const item = cappedDataItems[i];
        if (!item.values) continue;
        for (let j = i - 1; j >= 0; j--) {
          if (!cappedDataItems[j].values) {
            const parentLabel = dataItemLabel(cappedDataItems[j].level);
            const parentId = generateId(parentLabel, `${file.path}:${cappedDataItems[j].name}`);
            const constId = generateId('Const', `${file.path}:${item.name}`);
            emitRel('CONTAINS', parentId, constId);
            break;
          }
        }
      }

      // --- File Declarations → CodeElement nodes ---
      for (const fd of regexResults.fileDeclarations) {
        const nodeId = generateId('CodeElement', `${file.path}:SELECT:${fd.selectName}`);
        const descParts = ['select'];
        if (fd.organization) descParts.push(`org:${fd.organization}`);
        if (fd.access) descParts.push(`access:${fd.access}`);
        if (fd.recordKey) descParts.push(`key:${fd.recordKey}`);
        if (fd.fileStatus) descParts.push(`status:${fd.fileStatus}`);
        if (fd.assignTo) descParts.push(`assign:${fd.assignTo}`);
        emitNode('CodeElement', nodeId, fd.selectName, fd.line, { description: descParts.join(' ') });

        if (fd.recordKey) {
          emitRel('RECORD_KEY_OF', generateId('Property', `${file.path}:${fd.recordKey}`), nodeId, 0.8, 'select-clause');
        }
        if (fd.fileStatus) {
          emitRel('FILE_STATUS_OF', generateId('Property', `${file.path}:${fd.fileStatus}`), nodeId, 0.8, 'select-clause');
        }
      }

      // --- FD Entries → CodeElement nodes ---
      for (const fd of regexResults.fdEntries) {
        const nodeId = generateId('CodeElement', `${file.path}:FD:${fd.fdName}`);
        const fdDescParts = ['fd'];
        if (fd.recordName) fdDescParts.push(`record:${fd.recordName}`);
        emitNode('CodeElement', nodeId, fd.fdName, fd.line, { description: fdDescParts.join(' ') });

        if (fd.recordName) {
          emitRel('CONTAINS', nodeId, generateId('Record', `${file.path}:${fd.recordName}`));
        }
        emitRel('CONTAINS', generateId('CodeElement', `${file.path}:SELECT:${fd.fdName}`), nodeId, 0.9, 'fd-select-link');
      }

      // =====================================================================
      // Phase 2: EXEC SQL blocks → CodeElement nodes + ACCESSES edges
      // =====================================================================

      const emittedSqlIds = new Set<string>();

      for (const sql of regexResults.execSqlBlocks) {
        for (const table of sql.tables) {
          const tableId = generateId('CodeElement', `${file.path}:sql-table:${table}`);
          if (!emittedSqlIds.has(tableId)) {
            emittedSqlIds.add(tableId);
            emitNode('CodeElement', tableId, table, sql.line, {
              description: `sql-table op:${sql.operation}`,
            });
          }
          emitRel('ACCESSES', moduleId, tableId, 0.9, 'exec-sql');
        }

        for (const cursor of sql.cursors) {
          const cursorId = generateId('CodeElement', `${file.path}:sql-cursor:${cursor}`);
          if (!emittedSqlIds.has(cursorId)) {
            emittedSqlIds.add(cursorId);
            emitNode('CodeElement', cursorId, cursor, sql.line, {
              description: 'sql-cursor',
            });
          }
          emitRel('ACCESSES', moduleId, cursorId, 0.9, 'exec-sql');
        }
      }

      // =====================================================================
      // Phase 2: EXEC CICS blocks → CodeElement nodes + ACCESSES/CALLS edges
      // =====================================================================

      const emittedCicsIds = new Set<string>();

      for (const cics of regexResults.execCicsBlocks) {
        if (cics.mapName) {
          const mapId = generateId('CodeElement', `${file.path}:cics-map:${cics.mapName}`);
          if (!emittedCicsIds.has(mapId)) {
            emittedCicsIds.add(mapId);
            emitNode('CodeElement', mapId, cics.mapName, cics.line, {
              description: `cics-map cmd:${cics.command}`,
            });
          }
          emitRel('ACCESSES', moduleId, mapId, 0.9, 'exec-cics');
        }

        if (cics.programName) {
          // CICS LINK/XCTL program calls — emit as CALLS relationship directly
          const calledModuleId = generateId('Module', `${cics.programName}`);
          emitRel('CALLS', moduleId, calledModuleId, 0.9, 'exec-cics');
        }

        if (cics.transId) {
          const transIdNode = generateId('CodeElement', `${file.path}:cics-transid:${cics.transId}`);
          if (!emittedCicsIds.has(transIdNode)) {
            emittedCicsIds.add(transIdNode);
            emitNode('CodeElement', transIdNode, cics.transId, cics.line, {
              description: `cics-transid cmd:${cics.command}`,
            });
          }
          emitRel('ACCESSES', moduleId, transIdNode, 0.9, 'exec-cics');
        }
      }

      // =====================================================================
      // Phase 3: PROCEDURE DIVISION USING → RECEIVES edges
      // =====================================================================

      for (const paramName of regexResults.procedureUsing) {
        const propId = generateId('Property', `${file.path}:${paramName}`);
        emitRel('RECEIVES', moduleId, propId, 0.8, 'procedure-using');
      }

      // =====================================================================
      // Phase 3: ENTRY points → Constructor nodes
      // =====================================================================

      for (const entry of regexResults.entryPoints) {
        const entryId = generateId('Constructor', `${file.path}:${entry.name}`);
        const desc = entry.parameters.length > 0 ? `entry params:${entry.parameters.join(',')}` : 'entry';
        emitNode('Constructor', entryId, entry.name, entry.line, { description: desc });
        emitRel('CONTAINS', moduleId, entryId);
        symbolTable.add(file.path, entry.name, entryId, 'Constructor');
      }

      // NOTE: DATA_FLOW edges from MOVE statements are intentionally omitted.
      // They are intra-file (Property → Property with file-scoped IDs), not in
      // REL_TYPES, and generate O(moves × files) relationships that push the
      // in-memory Map past V8's 16.7M limit on large COBOL repos.

      // Collect COBOL imports/calls for pipeline resolution (mirrors worker path).
      // Without this, the sequential fallback produces nodes but no CALLS/IMPORTS
      // edges — tree-sitter-based processCalls/processImports skip COBOL files.
      for (const copy of regexResults.copies) {
        cobolImports.push({ filePath: file.path, rawImportPath: copy.target, language: SupportedLanguages.COBOL });
      }
      for (const call of regexResults.calls) {
        if (!isBuiltInOrNoise(call.target)) {
          cobolCalls.push({ filePath: file.path, calledName: call.target, sourceId: fileId });
        }
      }
      for (const perf of regexResults.performs) {
        if (!isBuiltInOrNoise(perf.target)) {
          const perfSourceId = perf.caller
            ? generateId('Function', `${file.path}:${perf.caller}`)
            : fileId;
          cobolCalls.push({ filePath: file.path, calledName: perf.target, sourceId: perfSourceId });
        }
      }

      continue;
    }

    // Skip files larger than the max tree-sitter buffer (32 MB)
    if (file.content.length > TREE_SITTER_MAX_BUFFER) continue;

    try {
      await loadLanguage(language, file.path);
    } catch {
      continue;  // parser unavailable — already warned in pipeline
    }

    const parseContent = file.content;

    let tree;
    try {
      tree = parser.parse(parseContent, undefined, { bufferSize: getTreeSitterBufferSize(parseContent.length) });
    } catch (parseError) {
      console.warn(`Skipping unparseable file: ${file.path}`);
      continue;
    }

    astCache.set(file.path, tree);

    const queryString = LANGUAGE_QUERIES[language];
    if (!queryString) {
      continue;
    }

    let query;
    let matches;
    try {
      const language = parser.getLanguage();
      query = new Parser.Query(language, queryString);
      matches = query.matches(tree.rootNode);
    } catch (queryError) {
      console.warn(`Query error for ${file.path}:`, queryError);
      continue;
    }

    matches.forEach(match => {
      const captureMap: Record<string, any> = {};

      match.captures.forEach(c => {
        captureMap[c.name] = c.node;
      });

      if (captureMap['import']) {
        return;
      }

      if (captureMap['call']) {
        return;
      }

      const nameNode = captureMap['name'];
      // Synthesize name for constructors without explicit @name capture (e.g. Swift init)
      if (!nameNode && !captureMap['definition.constructor']) return;
      const nodeName = nameNode ? nameNode.text : 'init';

      let nodeLabel = 'CodeElement';

      if (captureMap['definition.function']) nodeLabel = 'Function';
      else if (captureMap['definition.class']) nodeLabel = 'Class';
      else if (captureMap['definition.interface']) nodeLabel = 'Interface';
      else if (captureMap['definition.method']) nodeLabel = 'Method';
      else if (captureMap['definition.struct']) nodeLabel = 'Struct';
      else if (captureMap['definition.enum']) nodeLabel = 'Enum';
      else if (captureMap['definition.namespace']) nodeLabel = 'Namespace';
      else if (captureMap['definition.module']) nodeLabel = 'Module';
      else if (captureMap['definition.trait']) nodeLabel = 'Trait';
      else if (captureMap['definition.impl']) nodeLabel = 'Impl';
      else if (captureMap['definition.type']) nodeLabel = 'TypeAlias';
      else if (captureMap['definition.const']) nodeLabel = 'Const';
      else if (captureMap['definition.static']) nodeLabel = 'Static';
      else if (captureMap['definition.typedef']) nodeLabel = 'Typedef';
      else if (captureMap['definition.macro']) nodeLabel = 'Macro';
      else if (captureMap['definition.union']) nodeLabel = 'Union';
      else if (captureMap['definition.property']) nodeLabel = 'Property';
      else if (captureMap['definition.record']) nodeLabel = 'Record';
      else if (captureMap['definition.delegate']) nodeLabel = 'Delegate';
      else if (captureMap['definition.annotation']) nodeLabel = 'Annotation';
      else if (captureMap['definition.constructor']) nodeLabel = 'Constructor';
      else if (captureMap['definition.template']) nodeLabel = 'Template';

      const definitionNodeForRange = getDefinitionNodeFromCaptures(captureMap);
      const startLine = definitionNodeForRange ? definitionNodeForRange.startPosition.row : (nameNode ? nameNode.startPosition.row : 0);
      const nodeId = generateId(nodeLabel, `${file.path}:${nodeName}`);

      const definitionNode = getDefinitionNodeFromCaptures(captureMap);
      const frameworkHint = definitionNode
        ? detectFrameworkFromAST(language, (definitionNode.text || '').slice(0, 300))
        : null;

      // Extract method signature for Method/Constructor nodes
      const methodSig = (nodeLabel === 'Function' || nodeLabel === 'Method' || nodeLabel === 'Constructor')
        ? extractMethodSignature(definitionNode)
        : undefined;

      const node: GraphNode = {
        id: nodeId,
        label: nodeLabel as any,
        properties: {
          name: nodeName,
          filePath: file.path,
          startLine: definitionNodeForRange ? definitionNodeForRange.startPosition.row : startLine,
          endLine: definitionNodeForRange ? definitionNodeForRange.endPosition.row : startLine,
          language: language,
          isExported: isNodeExported(nameNode || definitionNodeForRange, nodeName, language),
          ...(frameworkHint ? {
            astFrameworkMultiplier: frameworkHint.entryPointMultiplier,
            astFrameworkReason: frameworkHint.reason,
          } : {}),
          ...(methodSig ? {
            parameterCount: methodSig.parameterCount,
            returnType: methodSig.returnType,
          } : {}),
        },
      };

      graph.addNode(node);

      // Compute enclosing class for Method/Constructor/Property/Function — used for both ownerId and HAS_METHOD
      // Function is included because Kotlin/Rust/Python capture class methods as Function nodes
      const needsOwner = nodeLabel === 'Method' || nodeLabel === 'Constructor' || nodeLabel === 'Property' || nodeLabel === 'Function';
      const enclosingClassId = needsOwner ? findEnclosingClassId(nameNode || definitionNodeForRange, file.path) : null;

      symbolTable.add(file.path, nodeName, nodeId, nodeLabel, {
        parameterCount: methodSig?.parameterCount,
        ownerId: enclosingClassId ?? undefined,
      });

      const fileId = generateId('File', file.path);

      const relId = generateId('DEFINES', `${fileId}->${nodeId}`);

      const relationship: GraphRelationship = {
        id: relId,
        sourceId: fileId,
        targetId: nodeId,
        type: 'DEFINES',
        confidence: 1.0,
        reason: '',
      };

      graph.addRelationship(relationship);

      // ── HAS_METHOD: link method/constructor/property to enclosing class ──
      if (enclosingClassId) {
        graph.addRelationship({
          id: generateId('HAS_METHOD', `${enclosingClassId}->${nodeId}`),
          sourceId: enclosingClassId,
          targetId: nodeId,
          type: 'HAS_METHOD',
          confidence: 1.0,
          reason: '',
        });
      }
    });
  }

  // Return collected COBOL extracted data (if any) so the pipeline can resolve
  // calls/imports via processCallsFromExtracted / processImportsFromExtracted.
  if (cobolImports.length > 0 || cobolCalls.length > 0) {
    return { imports: cobolImports, calls: cobolCalls, heritage: [], routes: [], sequentialFallback: true };
  }
  return null;
};

// ============================================================================
// Public API
// ============================================================================

export const processParsing = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  symbolTable: SymbolTable,
  astCache: ASTCache,
  onFileProgress?: FileProgressCallback,
  workerPool?: WorkerPool,
): Promise<WorkerExtractedData | null> => {
  if (workerPool) {
    try {
      return await processParsingWithWorkers(graph, files, symbolTable, astCache, workerPool, onFileProgress);
    } catch (err) {
      console.warn('Worker pool parsing failed, falling back to sequential:', err instanceof Error ? err.message : err);
    }
  }

  // Fallback: sequential parsing — returns COBOL extracted data if present
  return await processParsingSequential(graph, files, symbolTable, astCache, onFileProgress);
};
