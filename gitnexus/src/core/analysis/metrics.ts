/**
 * Metrics Calculator
 *
 * Computes on-the-fly metrics from the LadybugDB graph (not persisted).
 * ~6-8 aggregate Cypher queries.
 *
 * Per-program: fan-in, fan-out, paragraph count, COPY count, EXEC SQL/CICS count
 * Per-copybook: fan-in (how many programs import it)
 * Per-community: cohesion, internal/external edges, coupling ratio
 */

export interface ProgramMetrics {
  name: string;
  filePath: string;
  fanIn: number;
  fanOut: number;
  paragraphCount: number;
  copyCount: number;
  execSqlCount: number;
  execCicsCount: number;
}

export interface CopybookMetrics {
  name: string;
  filePath: string;
  fanIn: number;
}

export interface CommunityMetrics {
  id: string;
  label: string;
  cohesion: number;
  internalEdges: number;
  externalEdges: number;
  couplingRatio: number;
}

export interface GlobalMetrics {
  totalPrograms: number;
  totalParagraphs: number;
  totalCopybooks: number;
  totalCommunities: number;
  avgFanIn: number;
  avgFanOut: number;
  maxFanIn: number;
  maxFanOut: number;
  maxPerformDepth: number;
}

export interface MetricsResult {
  programs: ProgramMetrics[];
  copybooks: CopybookMetrics[];
  communities: CommunityMetrics[];
  global: GlobalMetrics;
}

/**
 * Compute all metrics from the indexed graph.
 *
 * @param runQuery - Executes a Cypher string and returns rows
 */
export async function computeMetrics(
  runQuery: (cypher: string) => Promise<any[]>,
): Promise<MetricsResult> {
  // 1. Per-program fan-out (how many distinct modules this module CALLs)
  const fanOutRows = await runQuery(`
    MATCH (m:\`Module\`)-[r:CodeRelation {type: 'CALLS'}]->(target:\`Module\`)
    RETURN m.name AS name, m.filePath AS filePath, count(DISTINCT target) AS fanOut
    ORDER BY fanOut DESC
  `).catch(() => []);

  // 2. Per-program fan-in (how many distinct modules CALL this module)
  const fanInRows = await runQuery(`
    MATCH (caller:\`Module\`)-[r:CodeRelation {type: 'CALLS'}]->(m:\`Module\`)
    RETURN m.name AS name, m.filePath AS filePath, count(DISTINCT caller) AS fanIn
    ORDER BY fanIn DESC
  `).catch(() => []);

  // 3. Per-program paragraph count
  const paragraphCountRows = await runQuery(`
    MATCH (f:Function)
    RETURN f.filePath AS filePath, count(f) AS cnt
  `).catch(() => []);

  // 4. Per-program COPY count (IMPORTS edges from Module)
  const copyCountRows = await runQuery(`
    MATCH (m:\`Module\`)-[r:CodeRelation {type: 'IMPORTS'}]->()
    RETURN m.name AS name, m.filePath AS filePath, count(r) AS cnt
  `).catch(() => []);

  // 5. EXEC SQL/CICS count from CodeElement descriptions
  const execSqlRows = await runQuery(`
    MATCH (ce:CodeElement)
    WHERE ce.description STARTS WITH 'exec-sql'
    RETURN ce.filePath AS filePath, count(ce) AS cnt
  `).catch(() => []);

  const execCicsRows = await runQuery(`
    MATCH (ce:CodeElement)
    WHERE ce.description STARTS WITH 'exec-cics'
    RETURN ce.filePath AS filePath, count(ce) AS cnt
  `).catch(() => []);

  // Build per-program metrics map
  const programMap = new Map<string, ProgramMetrics>();

  const getOrCreate = (name: string, filePath: string): ProgramMetrics => {
    const key = filePath || name;
    let m = programMap.get(key);
    if (!m) {
      m = { name, filePath, fanIn: 0, fanOut: 0, paragraphCount: 0, copyCount: 0, execSqlCount: 0, execCicsCount: 0 };
      programMap.set(key, m);
    }
    return m;
  };

  for (const row of fanOutRows) {
    const m = getOrCreate(row.name ?? row[0], row.filePath ?? row[1]);
    m.fanOut = Number(row.fanOut ?? row[2] ?? 0);
  }

  for (const row of fanInRows) {
    const m = getOrCreate(row.name ?? row[0], row.filePath ?? row[1]);
    m.fanIn = Number(row.fanIn ?? row[2] ?? 0);
  }

  // Paragraph counts are by filePath — need to match to module
  const paragraphsByFile = new Map<string, number>();
  for (const row of paragraphCountRows) {
    paragraphsByFile.set(row.filePath ?? row[0], Number(row.cnt ?? row[1] ?? 0));
  }

  const copyByFile = new Map<string, number>();
  for (const row of copyCountRows) {
    const fp = row.filePath ?? row[1];
    copyByFile.set(fp, Number(row.cnt ?? row[2] ?? 0));
  }

  const sqlByFile = new Map<string, number>();
  for (const row of execSqlRows) {
    sqlByFile.set(row.filePath ?? row[0], Number(row.cnt ?? row[1] ?? 0));
  }

  const cicsByFile = new Map<string, number>();
  for (const row of execCicsRows) {
    cicsByFile.set(row.filePath ?? row[0], Number(row.cnt ?? row[1] ?? 0));
  }

  // Also ensure all modules are represented (even with 0 fan-in/fan-out)
  const allModuleRows = await runQuery(`
    MATCH (m:\`Module\`)
    RETURN m.name AS name, m.filePath AS filePath
  `).catch(() => []);

  for (const row of allModuleRows) {
    getOrCreate(row.name ?? row[0], row.filePath ?? row[1]);
  }

  // Apply file-level metrics to programs
  for (const m of programMap.values()) {
    m.paragraphCount = paragraphsByFile.get(m.filePath) ?? 0;
    m.copyCount = copyByFile.get(m.filePath) ?? 0;
    m.execSqlCount = sqlByFile.get(m.filePath) ?? 0;
    m.execCicsCount = cicsByFile.get(m.filePath) ?? 0;
  }

  const programs = [...programMap.values()];

  // 6. Per-copybook fan-in
  const copybookRows = await runQuery(`
    MATCH (caller)-[r:CodeRelation {type: 'IMPORTS'}]->(f:File)
    RETURN f.name AS name, f.filePath AS filePath, count(DISTINCT caller) AS fanIn
    ORDER BY fanIn DESC
  `).catch(() => []);

  const copybooks: CopybookMetrics[] = copybookRows.map(row => ({
    name: row.name ?? row[0],
    filePath: row.filePath ?? row[1],
    fanIn: Number(row.fanIn ?? row[2] ?? 0),
  }));

  // 7. Community metrics: cohesion, internal/external edges, coupling
  const communityRows = await runQuery(`
    MATCH (c:Community)
    RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel,
           c.cohesion AS cohesion, c.symbolCount AS symbolCount
    ORDER BY c.symbolCount DESC
  `).catch(() => []);

  const communities: CommunityMetrics[] = [];
  for (const row of communityRows) {
    const id = row.id ?? row[0];
    const label = row.heuristicLabel ?? row.label ?? row[2] ?? row[1];
    const cohesion = Number(row.cohesion ?? row[3] ?? 0);

    // Count internal edges (both endpoints in same community)
    let internalEdges = 0;
    let externalEdges = 0;
    try {
      const edgeRows = await runQuery(`
        MATCH (a)-[r1:CodeRelation {type: 'MEMBER_OF'}]->(c:Community {id: '${id.replace(/'/g, "''")}'}),
              (a)-[call:CodeRelation]->(b)
        WHERE call.type IN ['CALLS', 'IMPORTS']
        OPTIONAL MATCH (b)-[r2:CodeRelation {type: 'MEMBER_OF'}]->(c2:Community {id: '${id.replace(/'/g, "''")}' })
        RETURN count(CASE WHEN r2 IS NOT NULL THEN 1 END) AS internal,
               count(CASE WHEN r2 IS NULL THEN 1 END) AS external
      `);
      if (edgeRows.length > 0) {
        internalEdges = Number(edgeRows[0].internal ?? edgeRows[0][0] ?? 0);
        externalEdges = Number(edgeRows[0].external ?? edgeRows[0][1] ?? 0);
      }
    } catch {
      // Complex query may fail on some LadybugDB versions — use simpler fallback
      try {
        const memberRows = await runQuery(`
          MATCH (a)-[r:CodeRelation {type: 'MEMBER_OF'}]->(c:Community {id: '${id.replace(/'/g, "''")}'})
          MATCH (a)-[call:CodeRelation]->(b)
          WHERE call.type IN ['CALLS', 'IMPORTS']
          RETURN b.id AS targetId
        `);
        const memberIds = new Set<string>();
        try {
          const allMembers = await runQuery(`
            MATCH (a)-[r:CodeRelation {type: 'MEMBER_OF'}]->(c:Community {id: '${id.replace(/'/g, "''")}'})
            RETURN a.id AS id
          `);
          for (const mr of allMembers) memberIds.add(mr.id ?? mr[0]);
        } catch { /* skip */ }

        for (const er of memberRows) {
          const targetId = er.targetId ?? er[0];
          if (memberIds.has(targetId)) internalEdges++;
          else externalEdges++;
        }
      } catch {
        // Skip community edge counting if queries fail
      }
    }

    const totalEdges = internalEdges + externalEdges;
    const couplingRatio = totalEdges > 0 ? externalEdges / totalEdges : 0;

    communities.push({ id, label, cohesion, internalEdges, externalEdges, couplingRatio });
  }

  // 8. PERFORM chain depth — attempt recursive query with fallback
  let maxPerformDepth = 0;
  try {
    const depthRows = await runQuery(`
      MATCH (f1:Function)-[r:CodeRelation {type: 'CALLS'}*1..10]->(f2:Function)
      RETURN max(length(r)) AS maxDepth
    `);
    if (depthRows.length > 0) {
      maxPerformDepth = Number(depthRows[0].maxDepth ?? depthRows[0][0] ?? 0);
    }
  } catch {
    // Recursive variable-length path may not be supported — try iterative
    for (let depth = 10; depth >= 1; depth--) {
      try {
        const rows = await runQuery(`
          MATCH (f1:Function)-[r:CodeRelation {type: 'CALLS'}*${depth}..${depth}]->(f2:Function)
          RETURN count(*) AS cnt LIMIT 1
        `);
        if (rows.length > 0 && Number(rows[0].cnt ?? rows[0][0] ?? 0) > 0) {
          maxPerformDepth = depth;
          break;
        }
      } catch {
        continue;
      }
    }
  }

  // Compute global metrics
  const totalPrograms = programs.length;
  const totalParagraphs = programs.reduce((s, p) => s + p.paragraphCount, 0);
  const totalCopybooks = copybooks.length;
  const totalCommunities = communities.length;

  const fanIns = programs.map(p => p.fanIn);
  const fanOuts = programs.map(p => p.fanOut);

  const avgFanIn = totalPrograms > 0 ? fanIns.reduce((a, b) => a + b, 0) / totalPrograms : 0;
  const avgFanOut = totalPrograms > 0 ? fanOuts.reduce((a, b) => a + b, 0) / totalPrograms : 0;
  const maxFanIn = fanIns.length > 0 ? Math.max(...fanIns) : 0;
  const maxFanOut = fanOuts.length > 0 ? Math.max(...fanOuts) : 0;

  return {
    programs,
    copybooks,
    communities,
    global: {
      totalPrograms,
      totalParagraphs,
      totalCopybooks,
      totalCommunities,
      avgFanIn,
      avgFanOut,
      maxFanIn,
      maxFanOut,
      maxPerformDepth,
    },
  };
}
