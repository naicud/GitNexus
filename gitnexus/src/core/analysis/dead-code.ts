/**
 * Dead Code Analyzer
 *
 * Queries Cypher against KuzuDB to identify:
 * 1. Unused paragraphs — Function nodes with zero incoming CALLS
 * 2. Unreachable programs — Module nodes with zero incoming CALLS and zero JCL refs
 * 3. Orphan copybooks — File nodes in copybook dirs with zero incoming IMPORTS
 *
 * No schema changes required — works against existing graph.
 */

export interface DeadCodeResults {
  unusedParagraphs: Array<{ name: string; filePath: string; programName: string; line: number }>;
  unreachablePrograms: Array<{ name: string; filePath: string; hasJclRef: boolean }>;
  orphanCopybooks: Array<{ name: string; filePath: string }>;
  summary: {
    totalParagraphs: number;
    unusedCount: number;
    unreachableCount: number;
    orphanCount: number;
    deadCodePct: number;
  };
}

/**
 * Analyze the indexed graph for dead code.
 *
 * @param runQuery - Executes a Cypher string and returns rows
 */
export async function analyzeDeadCode(
  runQuery: (cypher: string) => Promise<any[]>,
): Promise<DeadCodeResults> {
  // 1. Unused paragraphs: Function nodes with zero incoming CALLS
  //    Exclude the first paragraph of each program (implicitly executed).
  const [unusedRows, totalParagraphRows] = await Promise.all([
    runQuery(`
      MATCH (f:Function)
      WHERE NOT EXISTS {
        MATCH ()-[r:CodeRelation {type: 'CALLS'}]->(f)
      }
      // Exclude first paragraph per file — it's the implicit entry point
      AND NOT EXISTS {
        MATCH (file:File)-[r:CodeRelation {type: 'CONTAINS'}]->(f)
        WHERE f.startLine = (
          SELECT min(f2.startLine)
          FROM Function f2
          WHERE f2.filePath = f.filePath
        )
      }
      RETURN f.name AS name, f.filePath AS filePath, f.startLine AS line
      ORDER BY f.filePath, f.startLine
    `).catch(() =>
      // Fallback: simpler query without correlated subquery
      runQuery(`
        MATCH (f:Function)
        WHERE NOT EXISTS {
          MATCH ()-[r:CodeRelation {type: 'CALLS'}]->(f)
        }
        RETURN f.name AS name, f.filePath AS filePath, f.startLine AS line
        ORDER BY f.filePath, f.startLine
      `),
    ),
    runQuery(`MATCH (f:Function) RETURN count(f) AS cnt`),
  ]);

  // Build a map of first paragraph per file to filter from unused results
  const firstParagraphByFile = new Map<string, number>();
  try {
    const firstRows = await runQuery(`
      MATCH (f:Function)
      RETURN f.filePath AS filePath, min(f.startLine) AS minLine
    `);
    for (const row of firstRows) {
      const fp = row.filePath ?? row[0];
      const ml = Number(row.minLine ?? row[1] ?? 0);
      if (fp) firstParagraphByFile.set(fp, ml);
    }
  } catch {
    // If grouping query fails, skip first-paragraph filtering
  }

  // Build program name map: filePath -> module name
  const programNameMap = new Map<string, string>();
  try {
    const moduleRows = await runQuery(`
      MATCH (m:\`Module\`)
      RETURN m.name AS name, m.filePath AS filePath
    `);
    for (const row of moduleRows) {
      const name = row.name ?? row[0];
      const fp = row.filePath ?? row[1];
      if (name && fp) programNameMap.set(fp, name);
    }
  } catch {
    // Module table may be empty
  }

  const unusedParagraphs: DeadCodeResults['unusedParagraphs'] = [];
  for (const row of unusedRows) {
    const name = row.name ?? row[0];
    const filePath = row.filePath ?? row[1];
    const line = Number(row.line ?? row[2] ?? 0);

    // Skip first paragraph of each file (implicit entry point)
    const firstLine = firstParagraphByFile.get(filePath);
    if (firstLine !== undefined && line <= firstLine) continue;

    unusedParagraphs.push({
      name,
      filePath,
      programName: programNameMap.get(filePath) || '',
      line,
    });
  }

  const totalParagraphs = Number(
    totalParagraphRows[0]?.cnt ?? totalParagraphRows[0]?.[0] ?? 0,
  );

  // 2. Unreachable programs: Module nodes with zero incoming CALLS
  //    Also check for JCL step references (CodeElement with jcl-step description)
  const unreachableRows = await runQuery(`
    MATCH (m:\`Module\`)
    WHERE NOT EXISTS {
      MATCH ()-[r:CodeRelation {type: 'CALLS'}]->(m)
    }
    RETURN m.name AS name, m.filePath AS filePath
    ORDER BY m.name
  `);

  // Check which unreachable programs have JCL step references
  const jclRefPrograms = new Set<string>();
  try {
    const jclRows = await runQuery(`
      MATCH (ce:CodeElement)-[r:CodeRelation {type: 'CALLS'}]->(m:\`Module\`)
      WHERE ce.description STARTS WITH 'jcl-step'
      RETURN DISTINCT m.name AS name
    `);
    for (const row of jclRows) {
      jclRefPrograms.add(row.name ?? row[0]);
    }
  } catch {
    // No JCL data in graph — that's fine
  }

  const unreachablePrograms: DeadCodeResults['unreachablePrograms'] = [];
  for (const row of unreachableRows) {
    const name = row.name ?? row[0];
    const filePath = row.filePath ?? row[1];
    const hasJclRef = jclRefPrograms.has(name);
    // If the program is called from JCL, it's not truly unreachable
    if (!hasJclRef) {
      unreachablePrograms.push({ name, filePath, hasJclRef });
    }
  }

  // 3. Orphan copybooks: File nodes in copybook directories with zero incoming IMPORTS
  const orphanRows = await runQuery(`
    MATCH (f:File)
    WHERE NOT EXISTS {
      MATCH ()-[r:CodeRelation {type: 'IMPORTS'}]->(f)
    }
    RETURN f.name AS name, f.filePath AS filePath
    ORDER BY f.name
  `).catch(() => []);

  // Filter to only files that look like copybooks (in c/, copy/, cpy/ directories
  // or with copybook extensions)
  const COPYBOOK_DIR_SEGMENTS = new Set(['c', 'copy', 'copybooks', 'copylib', 'cpy']);
  const COPYBOOK_EXTENSIONS = new Set(['.cpy', '.copy', '.gnm', '.fd', '.wrk', '.sel', '.def']);

  const orphanCopybooks: DeadCodeResults['orphanCopybooks'] = [];
  for (const row of orphanRows) {
    const name = row.name ?? row[0];
    const filePath = row.filePath ?? row[1];
    if (!filePath) continue;

    const segments = filePath.toLowerCase().split('/');
    const isCopybookDir = segments.some(s => COPYBOOK_DIR_SEGMENTS.has(s));
    const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
    const isCopybookExt = COPYBOOK_EXTENSIONS.has(ext);

    if (isCopybookDir || isCopybookExt) {
      orphanCopybooks.push({ name, filePath });
    }
  }

  const totalSymbols = totalParagraphs + unreachablePrograms.length + orphanCopybooks.length;
  const deadCount = unusedParagraphs.length + unreachablePrograms.length + orphanCopybooks.length;

  return {
    unusedParagraphs,
    unreachablePrograms,
    orphanCopybooks,
    summary: {
      totalParagraphs,
      unusedCount: unusedParagraphs.length,
      unreachableCount: unreachablePrograms.length,
      orphanCount: orphanCopybooks.length,
      deadCodePct: totalSymbols > 0 ? (deadCount / totalSymbols) * 100 : 0,
    },
  };
}
