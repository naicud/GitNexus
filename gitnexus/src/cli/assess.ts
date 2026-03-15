/**
 * Assess Command
 *
 * Runs modernization assessment on an indexed repository.
 * Produces markdown + JSON report in .gitnexus/ directory.
 *
 * Flow:
 * 1. Resolve repo, verify indexed
 * 2. Open KuzuDB (existing index)
 * 3. Run analyzeDeadCode() -> progress
 * 4. Run computeMetrics() -> progress
 * 5. Run scoreModernization() -> progress
 * 6. Run generateReport() -> write files
 * 7. Print summary to console
 */

import path from 'path';
import { getStoragePaths, loadMeta } from '../storage/repo-manager.js';
import { getGitRoot } from '../storage/git.js';
import { initKuzu, executeQuery, closeKuzu } from '../core/kuzu/kuzu-adapter.js';
import { analyzeDeadCode } from '../core/analysis/dead-code.js';
import { computeMetrics } from '../core/analysis/metrics.js';
import { scoreModernization } from '../core/analysis/mod-scorer.js';
import { generateReport, type JclSummary } from '../core/analysis/report.js';

export interface AssessOptions {
  format?: string;
  output?: string;
  detailed?: boolean;
  yes?: boolean;
}

export async function assessCommand(targetPath: string | undefined, options: AssessOptions): Promise<void> {
  const repoPath = targetPath
    ? path.resolve(targetPath)
    : (getGitRoot(process.cwd()) ?? process.cwd());

  // Verify indexed
  const { storagePath } = getStoragePaths(repoPath);
  const meta = await loadMeta(storagePath);
  if (!meta?.indexedAt) {
    console.error('Repository is not indexed. Run: gitnexus analyze');
    process.exit(1);
  }

  const repoName = path.basename(repoPath);
  const format = (options.format ?? 'both') as 'markdown' | 'json' | 'both';
  const outputDir = options.output ?? path.join(storagePath);
  const detailed = options.detailed ?? false;

  console.log(`\nModernization Assessment: ${repoName}`);
  console.log('='.repeat(40));

  // Open KuzuDB
  const kuzuPath = path.join(storagePath, 'kuzu');
  await initKuzu(kuzuPath);

  const runQuery = async (cypher: string): Promise<any[]> => {
    return executeQuery(cypher);
  };

  try {
    // Phase 1: Dead code analysis
    console.log('\n[1/4] Analyzing dead code...');
    const deadCode = await analyzeDeadCode(runQuery);
    console.log(`  Unused paragraphs: ${deadCode.summary.unusedCount}`);
    console.log(`  Unreachable programs: ${deadCode.summary.unreachableCount}`);
    console.log(`  Orphan copybooks: ${deadCode.summary.orphanCount}`);

    // Phase 2: Metrics
    console.log('\n[2/4] Computing metrics...');
    const metrics = await computeMetrics(runQuery);
    console.log(`  Programs: ${metrics.global.totalPrograms}`);
    console.log(`  Avg fan-in: ${metrics.global.avgFanIn.toFixed(1)}, avg fan-out: ${metrics.global.avgFanOut.toFixed(1)}`);
    console.log(`  Communities: ${metrics.global.totalCommunities}`);

    // Phase 3: Modernization scoring
    console.log('\n[3/4] Scoring modernization candidates...');
    const modernization = await scoreModernization(metrics, deadCode, runQuery);
    const extractCount = modernization.candidates.filter(c => c.recommendation === 'extract').length;
    const refactorCount = modernization.candidates.filter(c => c.recommendation === 'refactor-first').length;
    console.log(`  Overall score: ${modernization.overallScore}/100`);
    console.log(`  Extract candidates: ${extractCount}`);
    console.log(`  Refactor-first: ${refactorCount}`);

    // Check for JCL data in the graph
    let jcl: JclSummary | undefined;
    try {
      const jclRows = await runQuery(`
        MATCH (ce:CodeElement)
        WHERE ce.description STARTS WITH 'jcl-'
        RETURN
          count(CASE WHEN ce.description STARTS WITH 'jcl-job' THEN 1 END) AS jobs,
          count(CASE WHEN ce.description STARTS WITH 'jcl-step' THEN 1 END) AS steps,
          count(CASE WHEN ce.description STARTS WITH 'jcl-dataset' THEN 1 END) AS datasets
      `);
      if (jclRows.length > 0) {
        const row = jclRows[0];
        const jobs = Number(row.jobs ?? row[0] ?? 0);
        const steps = Number(row.steps ?? row[1] ?? 0);
        const datasets = Number(row.datasets ?? row[2] ?? 0);
        if (jobs > 0 || steps > 0) {
          // Count program links
          const linkRows = await runQuery(`
            MATCH (ce:CodeElement)-[r:CodeRelation {type: 'CALLS'}]->(m:\`Module\`)
            WHERE ce.description STARTS WITH 'jcl-step'
            RETURN count(r) AS cnt
          `);
          const programLinks = Number(linkRows[0]?.cnt ?? linkRows[0]?.[0] ?? 0);
          jcl = { jobCount: jobs, stepCount: steps, datasetCount: datasets, programLinks };
        }
      }
    } catch {
      // No JCL data
    }

    // Phase 4: Generate report
    console.log('\n[4/4] Generating report...');
    const result = await generateReport({
      repoName,
      outputDir,
      format,
      detailed,
      deadCode,
      metrics,
      modernization,
      jcl,
    });

    // Summary
    console.log('\n' + '='.repeat(40));
    console.log(`Overall Readiness Score: ${modernization.overallScore}/100`);
    console.log(`Dead Code: ${deadCode.summary.deadCodePct.toFixed(1)}%`);

    if (result.markdownPath) {
      console.log(`\nMarkdown report: ${result.markdownPath}`);
    }
    if (result.jsonPath) {
      console.log(`JSON report: ${result.jsonPath}`);
    }

    // Top extraction candidates
    const topExtract = modernization.candidates
      .filter(c => c.recommendation === 'extract')
      .slice(0, 5);
    if (topExtract.length > 0) {
      console.log('\nTop extraction candidates:');
      for (const c of topExtract) {
        console.log(`  ${c.isolationScore}/100  ${c.label} (${c.programs.length} programs)`);
      }
    }
  } finally {
    await closeKuzu();
  }
}
