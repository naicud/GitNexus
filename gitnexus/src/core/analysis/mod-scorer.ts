/**
 * Modernization Scorer
 *
 * Computes a composite isolation score per community to identify
 * candidates for microservice extraction.
 *
 * Score formula:
 *   isolationScore =
 *     0.35 * cohesion +
 *     0.25 * (1 - couplingRatio) +
 *     0.15 * (1 - sharedCopybookRatio) +
 *     0.10 * (1 - complexityNorm) +
 *     0.10 * deadCodeRatio +
 *     0.05 * jclIsolation
 *
 * Thresholds:
 *   >= 70 -> extract (good microservice candidate)
 *   >= 40 -> refactor-first (needs decoupling)
 *   <  40 -> leave-in-place (modernize in-place)
 */

import type { MetricsResult, CommunityMetrics } from './metrics.js';
import type { DeadCodeResults } from './dead-code.js';

export interface ModernizationCandidate {
  communityId: string;
  label: string;
  isolationScore: number; // 0-100
  programs: string[];
  recommendation: 'extract' | 'refactor-first' | 'leave-in-place';
  rationale: string;
  breakdown: {
    cohesion: number;
    decoupling: number;
    copybookIsolation: number;
    complexity: number;
    deadCode: number;
    jclIsolation: number;
  };
}

export interface ModernizationResult {
  candidates: ModernizationCandidate[];
  overallScore: number;
}

/**
 * Score communities for modernization readiness.
 *
 * @param metrics - Computed metrics from the graph
 * @param deadCode - Dead code analysis results
 * @param runQuery - Executes a Cypher string and returns rows
 */
export async function scoreModernization(
  metrics: MetricsResult,
  deadCode: DeadCodeResults,
  runQuery: (cypher: string) => Promise<any[]>,
): Promise<ModernizationResult> {
  // Build lookup maps
  const communityMetricsMap = new Map<string, CommunityMetrics>();
  for (const c of metrics.communities) {
    communityMetricsMap.set(c.id, c);
  }

  // Get community -> programs mapping
  const communityPrograms = new Map<string, string[]>();
  try {
    const rows = await runQuery(`
      MATCH (m:\`Module\`)-[r:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
      RETURN c.id AS communityId, collect(m.name) AS programs
    `);
    for (const row of rows) {
      const cid = row.communityId ?? row[0];
      const progs = row.programs ?? row[1] ?? [];
      communityPrograms.set(cid, Array.isArray(progs) ? progs : [progs]);
    }
  } catch {
    // Fallback: all programs with no community grouping
  }

  // Shared copybooks: copybooks imported by programs in multiple communities
  const copybookToCommunities = new Map<string, Set<string>>();
  try {
    const rows = await runQuery(`
      MATCH (m:\`Module\`)-[r1:CodeRelation {type: 'IMPORTS'}]->(f:File),
            (m)-[r2:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
      RETURN f.name AS copybook, c.id AS communityId
    `);
    for (const row of rows) {
      const cb = row.copybook ?? row[0];
      const cid = row.communityId ?? row[1];
      if (!copybookToCommunities.has(cb)) {
        copybookToCommunities.set(cb, new Set());
      }
      copybookToCommunities.get(cb)!.add(cid);
    }
  } catch {
    // Skip copybook analysis if query fails
  }

  const totalCopybooks = copybookToCommunities.size;
  const sharedCopybooks = new Map<string, number>(); // communityId -> shared count
  for (const [, communities] of copybookToCommunities) {
    if (communities.size > 1) {
      for (const cid of communities) {
        sharedCopybooks.set(cid, (sharedCopybooks.get(cid) ?? 0) + 1);
      }
    }
  }

  // JCL isolation: how many JCL jobs reference programs in this community exclusively
  const jclIsolationMap = new Map<string, number>(); // communityId -> ratio
  try {
    const rows = await runQuery(`
      MATCH (ce:CodeElement)-[r:CodeRelation {type: 'CALLS'}]->(m:\`Module\`),
            (m)-[r2:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
      WHERE ce.description STARTS WITH 'jcl-step'
      RETURN ce.name AS step, collect(DISTINCT c.id) AS communities
    `);

    // Count steps that touch only one community
    const communitySingleSteps = new Map<string, number>();
    const communityTotalSteps = new Map<string, number>();

    for (const row of rows) {
      const comms: string[] = row.communities ?? row[1] ?? [];
      for (const cid of comms) {
        communityTotalSteps.set(cid, (communityTotalSteps.get(cid) ?? 0) + 1);
        if (comms.length === 1) {
          communitySingleSteps.set(cid, (communitySingleSteps.get(cid) ?? 0) + 1);
        }
      }
    }

    for (const [cid, total] of communityTotalSteps) {
      const single = communitySingleSteps.get(cid) ?? 0;
      jclIsolationMap.set(cid, total > 0 ? single / total : 1);
    }
  } catch {
    // No JCL data — assign neutral 0.5 isolation
  }

  // Dead code by program -> community
  const deadProgramNames = new Set(deadCode.unreachablePrograms.map(p => p.name));
  const unusedParagraphsByFile = new Map<string, number>();
  for (const p of deadCode.unusedParagraphs) {
    unusedParagraphsByFile.set(p.filePath, (unusedParagraphsByFile.get(p.filePath) ?? 0) + 1);
  }

  // Complexity normalization: max fan-out across all programs
  const maxFanOut = metrics.global.maxFanOut || 1;

  // Score each community
  const candidates: ModernizationCandidate[] = [];

  for (const community of metrics.communities) {
    const cid = community.id;
    const programs = communityPrograms.get(cid) ?? [];

    // 1. Cohesion (0-1) — directly from community detection
    const cohesion = community.cohesion;

    // 2. Decoupling (0-1) = 1 - couplingRatio
    const decoupling = 1 - community.couplingRatio;

    // 3. Shared copybook ratio (0-1) — proportion of community's copybooks that are shared
    const communitySharedCount = sharedCopybooks.get(cid) ?? 0;
    const communityCopyCount = programs.length > 0 ? Math.max(communitySharedCount, 1) : 1;
    const sharedCopybookRatio = totalCopybooks > 0 ? communitySharedCount / communityCopyCount : 0;
    const copybookIsolation = 1 - Math.min(sharedCopybookRatio, 1);

    // 4. Complexity (0-1) — average fan-out of community programs, normalized
    const communityProgMetrics = metrics.programs.filter(p => programs.includes(p.name));
    const avgFanOut = communityProgMetrics.length > 0
      ? communityProgMetrics.reduce((s, p) => s + p.fanOut, 0) / communityProgMetrics.length
      : 0;
    const complexityNorm = Math.min(avgFanOut / maxFanOut, 1);
    const complexityScore = 1 - complexityNorm;

    // 5. Dead code ratio (0-1) — proportion of programs that are dead/unreachable
    const deadInCommunity = programs.filter(p => deadProgramNames.has(p)).length;
    const deadCodeRatio = programs.length > 0 ? deadInCommunity / programs.length : 0;

    // 6. JCL isolation (0-1)
    const jclIsolation = jclIsolationMap.get(cid) ?? 0.5; // neutral if no JCL

    // Composite score
    const isolationScore = Math.round(
      (0.35 * cohesion +
       0.25 * decoupling +
       0.15 * copybookIsolation +
       0.10 * complexityScore +
       0.10 * deadCodeRatio +
       0.05 * jclIsolation) * 100,
    );

    // Recommendation
    let recommendation: ModernizationCandidate['recommendation'];
    let rationale: string;

    if (isolationScore >= 70) {
      recommendation = 'extract';
      rationale = `High isolation score (${isolationScore}). Community "${community.label}" has strong cohesion (${(cohesion * 100).toFixed(0)}%), low coupling (${(community.couplingRatio * 100).toFixed(0)}%), and ${programs.length} programs. Good candidate for microservice extraction.`;
    } else if (isolationScore >= 40) {
      recommendation = 'refactor-first';
      const issues: string[] = [];
      if (cohesion < 0.5) issues.push('low cohesion');
      if (community.couplingRatio > 0.5) issues.push('high coupling');
      if (sharedCopybookRatio > 0.5) issues.push('many shared copybooks');
      if (complexityNorm > 0.7) issues.push('high complexity');
      rationale = `Moderate isolation score (${isolationScore}). Needs decoupling before extraction: ${issues.join(', ') || 'mixed metrics'}.`;
    } else {
      recommendation = 'leave-in-place';
      rationale = `Low isolation score (${isolationScore}). Community "${community.label}" is tightly coupled with the rest of the system. Modernize in-place.`;
    }

    candidates.push({
      communityId: cid,
      label: community.label,
      isolationScore,
      programs,
      recommendation,
      rationale,
      breakdown: {
        cohesion: Math.round(cohesion * 100),
        decoupling: Math.round(decoupling * 100),
        copybookIsolation: Math.round(copybookIsolation * 100),
        complexity: Math.round(complexityScore * 100),
        deadCode: Math.round(deadCodeRatio * 100),
        jclIsolation: Math.round(jclIsolation * 100),
      },
    });
  }

  // Sort by isolation score descending
  candidates.sort((a, b) => b.isolationScore - a.isolationScore);

  // Overall score: weighted average by program count
  const totalPrograms = candidates.reduce((s, c) => s + c.programs.length, 0);
  const overallScore = totalPrograms > 0
    ? Math.round(
        candidates.reduce((s, c) => s + c.isolationScore * c.programs.length, 0) / totalPrograms,
      )
    : 0;

  return { candidates, overallScore };
}
