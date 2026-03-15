import { createKnowledgeGraph } from '../graph/graph.js';
import { processStructure } from './structure-processor.js';
import { processParsing } from './parsing-processor.js';
import {
  processImports,
  processImportsFromExtracted,
  createImportMap,
  createPackageMap,
  createNamedImportMap,
  buildImportResolutionContext
} from './import-processor.js';
import { processCalls, processCallsFromExtracted, processRoutesFromExtracted } from './call-processor.js';
import { processHeritage, processHeritageFromExtracted } from './heritage-processor.js';
import { computeMRO } from './mro-processor.js';
import { processCommunities } from './community-processor.js';
import { processProcesses } from './process-processor.js';
import { createSymbolTable } from './symbol-table.js';
import { createASTCache } from './ast-cache.js';
import { PipelineProgress, PipelineResult } from '../../types/pipeline.js';
import { walkRepositoryPaths, readFileContents } from './filesystem-walker.js';
import { getLanguageFromFilename, getLanguageFromPath } from './utils.js';
import { isLanguageAvailable } from '../tree-sitter/parser-loader.js';
import { createWorkerPool, WorkerPool } from './workers/worker-pool.js';
import { expandCopies, DEFAULT_MAX_DEPTH } from './cobol-copy-expander.js';
import { SupportedLanguages } from '../../config/supported-languages.js';
import { KnowledgeGraph } from '../graph/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const isDev = process.env.NODE_ENV === 'development' || !!process.env.GITNEXUS_VERBOSE;

/** Max bytes of source content to load per parse chunk. Each chunk's source +
 *  parsed ASTs + extracted records + worker serialization overhead all live in
 *  memory simultaneously, so this must be conservative. 20MB source ≈ 200-400MB
 *  peak working memory per chunk after parse expansion. */
const CHUNK_BYTE_BUDGET = 20 * 1024 * 1024; // 20MB

/** Max AST trees to keep in LRU cache */
const AST_CACHE_CAP = 50;

/** Extensions that identify a COBOL file as a copybook (not a program). */
const COPYBOOK_EXTENSIONS = new Set([
  '.cpy', '.copy',
  '.gnm', '.fd', '.wrk', '.sel', '.open', '.close', '.ini', '.def',
]);

/** COBOL program extensions — files with these are source programs, not copybooks. */
const COBOL_PROGRAM_EXTENSIONS = new Set(['.cbl', '.cob', '.cobol']);

/**
 * Determine if a COBOL file is a copybook based on its path.
 * A file is a copybook if:
 * - It has a recognized copybook extension (.cpy, .copy, .GNM, .FD, etc.)
 * - OR: it's an extensionless file in a COBOL directory whose name does NOT
 *   match a program extension — we conservatively treat extensionless files
 *   that are NOT in the program source directory as potential copybooks.
 *   (Refinement: files in GITNEXUS_COBOL_DIRS named "c" or containing "copy"
 *   in the path segment are classified as copybooks.)
 */
function isCobolCopybook(filePath: string): boolean {
  const basename = filePath.split('/').pop() || '';
  const dotIdx = basename.lastIndexOf('.');
  if (dotIdx >= 0) {
    const ext = basename.substring(dotIdx).toLowerCase();
    if (COPYBOOK_EXTENSIONS.has(ext)) return true;
    if (COBOL_PROGRAM_EXTENSIONS.has(ext)) return false;
  }

  // Extensionless file: check path segments for copybook directory hints
  const segments = filePath.toLowerCase().split('/');
  for (const segment of segments) {
    if (segment === 'c' || segment === 'copy' || segment === 'copybooks' ||
        segment === 'copylib' || segment === 'cpy') {
      return true;
    }
  }

  return false;
}

/**
 * Extract a copybook name from a file path.
 * Returns the basename without extension, uppercased (COBOL convention).
 */
function getCopybookName(filePath: string): string {
  const basename = filePath.split('/').pop() || filePath;
  const dotIdx = basename.lastIndexOf('.');
  const name = dotIdx >= 0 ? basename.substring(0, dotIdx) : basename;
  return name.toUpperCase();
}

/**
 * Expand COBOL COPY statements in a set of files.
 * Mutates the chunkFiles array in-place, replacing content with expanded content.
 *
 * @param chunkFiles    - Files to process (content is replaced in-place)
 * @param allCobolFiles - All COBOL files in the repo (for copybook resolution)
 * @param allContents   - Content map for all COBOL files (path -> content)
 */
function expandCobolCopies(
  chunkFiles: Array<{ path: string; content: string }>,
  allCobolFiles: string[],
  allContents: Map<string, string>,
): void {
  // 1. Build copybook content map: name (uppercase) -> { path, content }
  const copybookMap = new Map<string, { path: string; content: string }>();
  for (const filePath of allCobolFiles) {
    if (isCobolCopybook(filePath)) {
      const content = allContents.get(filePath);
      if (content !== undefined) {
        const name = getCopybookName(filePath);
        // First match wins — prefer exact name match
        if (!copybookMap.has(name)) {
          copybookMap.set(name, { path: filePath, content });
        }
      }
    }
  }

  if (copybookMap.size === 0) return;

  // 2. Build resolver functions
  const resolveFile = (name: string): string | null => {
    const upper = name.toUpperCase();

    // Try exact match
    const exact = copybookMap.get(upper);
    if (exact) return upper;

    // Try stripping common extensions from the name
    for (const ext of ['.CPY', '.COPY', '.GNM', '.FD', '.WRK', '.SEL', '.OPEN', '.CLOSE', '.INI', '.DEF']) {
      if (upper.endsWith(ext)) {
        const stripped = upper.substring(0, upper.length - ext.length);
        const match = copybookMap.get(stripped);
        if (match) return stripped;
      }
    }

    // Try adding common extensions
    for (const ext of ['.CPY', '.COPY']) {
      const withExt = copybookMap.get(upper + ext);
      if (withExt) return upper + ext;
    }

    return null;
  };

  const readFile = (resolvedKey: string): string | null => {
    const entry = copybookMap.get(resolvedKey);
    return entry?.content ?? null;
  };

  // 3. Expand each COBOL source file in the chunk.
  // Share a single warnedCircular set across all files so each circular
  // copybook (e.g. ANAZI includes itself) is only reported once total.
  const warnedCircular = new Set<string>();
  let expandedCount = 0;
  for (const file of chunkFiles) {
    if (isCobolCopybook(file.path)) continue; // Don't expand copybooks themselves

    try {
      const result = expandCopies(file.content, file.path, resolveFile, readFile, DEFAULT_MAX_DEPTH, warnedCircular);
      if (result.copyResolutions.length > 0) {
        file.content = result.expandedContent;
        expandedCount++;
      }
    } catch (err) {
      console.warn(`[pipeline] COPY expansion failed for ${file.path}: ${(err as Error).message}. Using original content.`);
    }
  }

  if (isDev && expandedCount > 0) {
    console.log(`[pipeline] Expanded COPY statements in ${expandedCount} COBOL file(s) using ${copybookMap.size} copybook(s)`);
  }
}

/**
 * Detect cross-program contracts: when two programs that CALL each other
 * also share a COPY of the same copybook, it implies a data contract.
 * Adds CONTRACTS edges to the graph.
 */
function detectCrossProgamContracts(graph: KnowledgeGraph): number {
  // 1. Build map: moduleId -> set of imported copybook basenames
  const moduleImports = new Map<string, Set<string>>();

  graph.forEachRelationship(rel => {
    if (rel.type !== 'IMPORTS') return;

    // Check if the source is a Module node
    const sourceNode = graph.getNode(rel.sourceId);
    if (!sourceNode || sourceNode.label !== 'Module') return;

    // Check if the target looks like a COBOL file (copybook)
    const targetNode = graph.getNode(rel.targetId);
    if (!targetNode) return;

    const targetPath = targetNode.properties.filePath || targetNode.id;
    const lang = getLanguageFromPath(targetPath);
    if (lang !== SupportedLanguages.COBOL) return;

    if (!moduleImports.has(rel.sourceId)) {
      moduleImports.set(rel.sourceId, new Set());
    }
    moduleImports.get(rel.sourceId)!.add(getCopybookName(targetPath));
  });

  // 2. For each CALLS edge between modules, check for shared copybooks
  let contractCount = 0;

  graph.forEachRelationship(rel => {
    if (rel.type !== 'CALLS') return;

    const callerImports = moduleImports.get(rel.sourceId);
    const calleeImports = moduleImports.get(rel.targetId);
    if (!callerImports || !calleeImports) return;

    // Find shared copybooks
    const shared: string[] = [];
    for (const copybook of callerImports) {
      if (calleeImports.has(copybook)) {
        shared.push(copybook);
      }
    }

    if (shared.length === 0) return;

    // Add CONTRACTS edge for each shared copybook
    for (const copybook of shared) {
      const contractId = `${rel.sourceId}_contracts_${rel.targetId}_${copybook}`;
      graph.addRelationship({
        id: contractId,
        type: 'CONTRACTS',
        sourceId: rel.sourceId,
        targetId: rel.targetId,
        confidence: 0.9,
        reason: `shared-copybook:${copybook}`,
      });
      contractCount++;
    }
  });

  return contractCount;
}

export const runPipelineFromRepo = async (
  repoPath: string,
  onProgress: (progress: PipelineProgress) => void
): Promise<PipelineResult> => {
  const graph = createKnowledgeGraph();
  const symbolTable = createSymbolTable();
  let astCache = createASTCache(AST_CACHE_CAP);
  const importMap = createImportMap();
  const packageMap = createPackageMap();
  const namedImportMap = createNamedImportMap();

  const cleanup = () => {
    astCache.clear();
    symbolTable.clear();
  };

  try {
    // ── Phase 1: Scan paths only (no content read) ─────────────────────
    onProgress({
      phase: 'extracting',
      percent: 0,
      message: 'Scanning repository...',
    });

    const scannedFiles = await walkRepositoryPaths(repoPath, (current, total, filePath) => {
      const scanProgress = Math.round((current / total) * 15);
      onProgress({
        phase: 'extracting',
        percent: scanProgress,
        message: 'Scanning repository...',
        detail: filePath,
        stats: { filesProcessed: current, totalFiles: total, nodesCreated: graph.nodeCount },
      });
    });

    const totalFiles = scannedFiles.length;

    onProgress({
      phase: 'extracting',
      percent: 15,
      message: 'Repository scanned successfully',
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
    });

    // ── Phase 2: Structure (paths only — no content needed) ────────────
    onProgress({
      phase: 'structure',
      percent: 15,
      message: 'Analyzing project structure...',
      stats: { filesProcessed: 0, totalFiles, nodesCreated: graph.nodeCount },
    });

    const allPaths = scannedFiles.map(f => f.path);
    processStructure(graph, allPaths);

    onProgress({
      phase: 'structure',
      percent: 20,
      message: 'Project structure analyzed',
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
    });

    // ── Phase 3+4: Chunked read + parse ────────────────────────────────
    // Group parseable files into byte-budget chunks so only ~20MB of source
    // is in memory at a time. Each chunk is: read → parse → extract → free.

    const parseableScanned = scannedFiles.filter(f => {
      const lang = getLanguageFromPath(f.path);
      return lang && isLanguageAvailable(lang);
    });

    // Warn about files skipped due to unavailable parsers
    const skippedByLang = new Map<string, number>();
    for (const f of scannedFiles) {
      const lang = getLanguageFromPath(f.path);
      if (lang && !isLanguageAvailable(lang)) {
        skippedByLang.set(lang, (skippedByLang.get(lang) || 0) + 1);
      }
    }
    for (const [lang, count] of skippedByLang) {
      console.warn(`Skipping ${count} ${lang} file(s) — ${lang} parser not available (native binding may not have built). Try: npm rebuild tree-sitter-${lang}`);
    }

    const totalParseable = parseableScanned.length;

    if (totalParseable === 0) {
      onProgress({
        phase: 'parsing',
        percent: 82,
        message: 'No parseable files found — skipping parsing phase',
        stats: { filesProcessed: 0, totalFiles: 0, nodesCreated: graph.nodeCount },
      });
    }

    // Build byte-budget chunks
    const chunks: string[][] = [];
    let currentChunk: string[] = [];
    let currentBytes = 0;
    for (const file of parseableScanned) {
      if (currentChunk.length > 0 && currentBytes + file.size > CHUNK_BYTE_BUDGET) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentBytes = 0;
      }
      currentChunk.push(file.path);
      currentBytes += file.size;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    const numChunks = chunks.length;

    if (isDev) {
      const totalMB = parseableScanned.reduce((s, f) => s + f.size, 0) / (1024 * 1024);
      console.log(`📂 Scan: ${totalFiles} paths, ${totalParseable} parseable (${totalMB.toFixed(0)}MB), ${numChunks} chunks @ ${CHUNK_BYTE_BUDGET / (1024 * 1024)}MB budget`);
    }

    onProgress({
      phase: 'parsing',
      percent: 20,
      message: `Parsing ${totalParseable} files in ${numChunks} chunk${numChunks !== 1 ? 's' : ''}...`,
      stats: { filesProcessed: 0, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
    });

    // Create worker pool once, reuse across chunks.
    // For COBOL repos, use smaller sub-batches (200 vs 1500) to prevent worker
    // timeouts — COBOL tree-sitter + preprocessing + regex takes ~150ms/file.
    let workerPool: WorkerPool | undefined;
    try {
      let workerUrl = new URL('./workers/parse-worker.js', import.meta.url);
      // When running under vitest, import.meta.url points to src/ where no .js exists.
      // Fall back to the compiled dist/ worker so the pool can spawn real worker threads.
      const thisDir = fileURLToPath(new URL('.', import.meta.url));
      if (!fs.existsSync(fileURLToPath(workerUrl))) {
        const distWorker = path.resolve(thisDir, '..', '..', '..', 'dist', 'core', 'ingestion', 'workers', 'parse-worker.js');
        if (fs.existsSync(distWorker)) {
          workerUrl = pathToFileURL(distWorker) as URL;
        }
      }
      const cobolSubBatch = process.env.GITNEXUS_COBOL_DIRS ? 200 : undefined;
      workerPool = createWorkerPool(workerUrl, undefined, cobolSubBatch);
      if (isDev && cobolSubBatch) {
        console.log(`🔧 Worker pool: ${workerPool.size} workers, sub-batch=${cobolSubBatch} (COBOL mode)`);
      }
    } catch (err) {
      if (isDev) console.warn('Worker pool creation failed, using sequential fallback:', (err as Error).message);
    }

    let filesParsedSoFar = 0;

    // AST cache sized for one chunk (sequential fallback uses it for import/call/heritage)
    const maxChunkFiles = chunks.reduce((max, c) => Math.max(max, c.length), 0);
    astCache = createASTCache(maxChunkFiles);

    // Build import resolution context once — suffix index, file lists, resolve cache.
    // Reused across all chunks to avoid rebuilding O(files × path_depth) structures.
    const importCtx = buildImportResolutionContext(allPaths);
    const allPathObjects = allPaths.map(p => ({ path: p }));

    // Single-pass: parse + resolve imports/calls/heritage per chunk.
    // Calls/heritage use the symbol table built so far (symbols from earlier chunks
    // are already registered). This trades ~5% cross-chunk resolution accuracy for
    // 200-400MB less memory — critical for Linux-kernel-scale repos.
    const sequentialChunkPaths: string[][] = [];

    // ── COBOL COPY expansion: pre-build copybook content map ──────────
    // Identify all COBOL files and their copybooks so we can expand COPY
    // statements before dispatching files to workers.
    const allCobolPaths = allPaths.filter(p => getLanguageFromPath(p) === SupportedLanguages.COBOL);
    const hasCobolFiles = allCobolPaths.length > 0;
    let cobolCopybookContents: Map<string, string> | undefined;

    if (hasCobolFiles) {
      // Read all copybook files upfront (they are typically small)
      const copybookPaths = allCobolPaths.filter(p => isCobolCopybook(p));
      if (copybookPaths.length > 0) {
        cobolCopybookContents = await readFileContents(repoPath, copybookPaths);
        if (isDev) {
          console.log(`[pipeline] COBOL COPY expansion: ${copybookPaths.length} copybook(s) loaded, ${allCobolPaths.length} total COBOL files`);
        }
      }
    }

    try {
      for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
        const chunkPaths = chunks[chunkIdx];

        // Read content for this chunk only
        const chunkContents = await readFileContents(repoPath, chunkPaths);
        const chunkFiles = chunkPaths
          .filter(p => chunkContents.has(p))
          .map(p => ({ path: p, content: chunkContents.get(p)! }));

        // ── COBOL COPY expansion (per-chunk) ────────────────────────────
        // Expand COPY statements in COBOL files before parsing. This gives
        // the regex extractor visibility into copybook symbols (data items,
        // paragraphs, etc.) that would otherwise be invisible.
        if (hasCobolFiles && cobolCopybookContents && cobolCopybookContents.size > 0) {
          const cobolChunkFiles = chunkFiles.filter(
            f => getLanguageFromPath(f.path) === SupportedLanguages.COBOL,
          );
          if (cobolChunkFiles.length > 0) {
            // Merge chunk content into the copybook map (chunk may contain
            // copybooks not yet in the pre-loaded set)
            const mergedContents = new Map(cobolCopybookContents);
            for (const f of chunkFiles) {
              if (!mergedContents.has(f.path)) {
                mergedContents.set(f.path, f.content);
              }
            }
            expandCobolCopies(cobolChunkFiles, allCobolPaths, mergedContents);
          }
        }

        // Parse this chunk (workers or sequential fallback)
        const chunkWorkerData = await processParsing(
          graph, chunkFiles, symbolTable, astCache,
          (current, _total, filePath) => {
            const globalCurrent = filesParsedSoFar + current;
            const parsingProgress = 20 + ((globalCurrent / totalParseable) * 62);
            onProgress({
              phase: 'parsing',
              percent: Math.round(parsingProgress),
              message: `Parsing chunk ${chunkIdx + 1}/${numChunks}...`,
              detail: filePath,
              stats: { filesProcessed: globalCurrent, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
            });
          },
          workerPool,
        );

        if (chunkWorkerData) {
          // Imports
          await processImportsFromExtracted(graph, allPathObjects, chunkWorkerData.imports, importMap, undefined, repoPath, importCtx, packageMap, namedImportMap);
          // Calls + Heritage + Routes — resolve in parallel (no shared mutable state between them)
          // This is safe because each writes disjoint relationship types into idempotent id-keyed Maps,
          // and the single-threaded event loop prevents races between synchronous addRelationship calls.
          await Promise.all([
            processCallsFromExtracted(
              graph, 
              chunkWorkerData.calls, 
              symbolTable, importMap, 
              packageMap, 
              undefined, 
              namedImportMap
            ),
            processHeritageFromExtracted(
              graph, 
              chunkWorkerData.heritage, 
              symbolTable, 
              importMap, 
              packageMap
            ),
            processRoutesFromExtracted(
              graph, 
              chunkWorkerData.routes ?? [], 
              symbolTable, 
              importMap, 
              packageMap
            ),
          ]);
        } else {
          // Pool failed — disable for all remaining chunks to avoid 120s timeout per chunk.
          if (workerPool) {
            await workerPool.terminate();
            workerPool = undefined;
          }
          await processImports(graph, chunkFiles, astCache, importMap, undefined, repoPath, allPaths, packageMap, namedImportMap);
          sequentialChunkPaths.push(chunkPaths);
        }

        filesParsedSoFar += chunkFiles.length;

        // Clear AST cache between chunks to free memory
        astCache.clear();
        // chunkContents + chunkFiles + chunkWorkerData go out of scope → GC reclaims
      }
    } finally {
      await workerPool?.terminate();
    }

    // Sequential fallback chunks: re-read source for call/heritage resolution
    for (const chunkPaths of sequentialChunkPaths) {
      const chunkContents = await readFileContents(repoPath, chunkPaths);
      const chunkFiles = chunkPaths
        .filter(p => chunkContents.has(p))
        .map(p => ({ path: p, content: chunkContents.get(p)! }));
      astCache = createASTCache(chunkFiles.length);
      const rubyHeritage = await processCalls(graph, chunkFiles, astCache, symbolTable, importMap, packageMap, undefined, namedImportMap);
      await processHeritage(graph, chunkFiles, astCache, symbolTable, importMap, packageMap);
      if (rubyHeritage.length > 0) {
        await processHeritageFromExtracted(graph, rubyHeritage, symbolTable, importMap, packageMap);
      }
      astCache.clear();
    }

    // Free import resolution context — suffix index + resolve cache no longer needed
    // (allPathObjects and importCtx hold ~94MB+ for large repos)
    allPathObjects.length = 0;
    importCtx.resolveCache.clear();
    (importCtx as any).suffixIndex = null;
    (importCtx as any).normalizedFileList = null;

    // ── Phase 4.5: Method Resolution Order ──────────────────────────────
    onProgress({
      phase: 'parsing',
      percent: 81,
      message: 'Computing method resolution order...',
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
    });

    const mroResult = computeMRO(graph);
    if (isDev && mroResult.entries.length > 0) {
      console.log(`🔀 MRO: ${mroResult.entries.length} classes analyzed, ${mroResult.ambiguityCount} ambiguities found, ${mroResult.overrideEdges} OVERRIDES edges`);
    }

    // ── Phase 4b: Cross-program contract detection (COBOL) ────────────
    // After all imports and calls are resolved, detect shared copybook
    // contracts between COBOL programs that CALL each other.
    if (hasCobolFiles) {
      const contractCount = detectCrossProgamContracts(graph);
      if (isDev && contractCount > 0) {
        console.log(`[pipeline] Detected ${contractCount} cross-program CONTRACTS edge(s) via shared copybooks`);
      }
    }

    // ── Phase 4c: JCL job stream integration ────────────────────────
    if (process.env.GITNEXUS_JCL_DIRS) {
      const { isJclFile } = await import('./utils.js');
      const jclPaths = allPaths.filter(p => isJclFile(p));
      if (jclPaths.length > 0) {
        const { processJclFiles } = await import('./jcl-processor.js');
        const jclContents = await readFileContents(repoPath, jclPaths);
        const jclResult = processJclFiles(graph, jclPaths, jclContents);
        if (isDev) {
          console.log(`[pipeline] JCL integration: ${jclResult.jobCount} jobs, ${jclResult.stepCount} steps, ${jclResult.programLinks} program links`);
        }
      }
    }

    // Free copybook content map — no longer needed
    cobolCopybookContents = undefined;

    // ── Phase 5: Communities ───────────────────────────────────────────
    onProgress({
      phase: 'communities',
      percent: 82,
      message: 'Detecting code communities...',
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
    });

    const communityResult = await processCommunities(graph, (message, progress) => {
      const communityProgress = 82 + (progress * 0.10);
      onProgress({
        phase: 'communities',
        percent: Math.round(communityProgress),
        message,
        stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
      });
    });

    if (isDev) {
      console.log(`🏘️ Community detection: ${communityResult.stats.totalCommunities} communities found (modularity: ${communityResult.stats.modularity.toFixed(3)})`);
    }

    communityResult.communities.forEach(comm => {
      graph.addNode({
        id: comm.id,
        label: 'Community' as const,
        properties: {
          name: comm.label,
          filePath: '',
          heuristicLabel: comm.heuristicLabel,
          cohesion: comm.cohesion,
          symbolCount: comm.symbolCount,
        }
      });
    });

    communityResult.memberships.forEach(membership => {
      graph.addRelationship({
        id: `${membership.nodeId}_member_of_${membership.communityId}`,
        type: 'MEMBER_OF',
        sourceId: membership.nodeId,
        targetId: membership.communityId,
        confidence: 1.0,
        reason: 'leiden-algorithm',
      });
    });

    // ── Phase 6: Processes ─────────────────────────────────────────────
    onProgress({
      phase: 'processes',
      percent: 94,
      message: 'Detecting execution flows...',
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
    });

    let symbolCount = 0;
    graph.forEachNode(n => { if (n.label !== 'File') symbolCount++; });
    const dynamicMaxProcesses = Math.max(20, Math.min(300, Math.round(symbolCount / 10)));

    const processResult = await processProcesses(
      graph,
      communityResult.memberships,
      (message, progress) => {
        const processProgress = 94 + (progress * 0.05);
        onProgress({
          phase: 'processes',
          percent: Math.round(processProgress),
          message,
          stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
        });
      },
      { maxProcesses: dynamicMaxProcesses, minSteps: 3 }
    );

    if (isDev) {
      console.log(`🔄 Process detection: ${processResult.stats.totalProcesses} processes found (${processResult.stats.crossCommunityCount} cross-community)`);
    }

    processResult.processes.forEach(proc => {
      graph.addNode({
        id: proc.id,
        label: 'Process' as const,
        properties: {
          name: proc.label,
          filePath: '',
          heuristicLabel: proc.heuristicLabel,
          processType: proc.processType,
          stepCount: proc.stepCount,
          communities: proc.communities,
          entryPointId: proc.entryPointId,
          terminalId: proc.terminalId,
        }
      });
    });

    processResult.steps.forEach(step => {
      graph.addRelationship({
        id: `${step.nodeId}_step_${step.step}_${step.processId}`,
        type: 'STEP_IN_PROCESS',
        sourceId: step.nodeId,
        targetId: step.processId,
        confidence: 1.0,
        reason: 'trace-detection',
        step: step.step,
      });
    });

    onProgress({
      phase: 'complete',
      percent: 100,
      message: `Graph complete! ${communityResult.stats.totalCommunities} communities, ${processResult.stats.totalProcesses} processes detected.`,
      stats: {
        filesProcessed: totalFiles,
        totalFiles,
        nodesCreated: graph.nodeCount
      },
    });

    astCache.clear();

    return { graph, repoPath, totalFileCount: totalFiles, communityResult, processResult };
  } catch (error) {
    cleanup();
    throw error;
  }
};
