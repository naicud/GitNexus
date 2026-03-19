/**
 * Unit Tests: Neptune Ingestion
 *
 * Tests loadGraphToNeptune and getNeptuneStats. AWS SDK is fully mocked.
 * Verifies: idempotent upsert, node grouping by label, batched inserts,
 * fault-tolerant edge insertion, progress callbacks, orphan cleanup, and stats retrieval.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock AWS SDK before any imports that use it ──────────────────────
const mockSend = vi.fn().mockResolvedValue({});
const mockDestroy = vi.fn();

vi.mock('@aws-sdk/client-neptunedata', () => {
  // Must use regular function (not arrow) so it can be called with `new`
  const MockClient = vi.fn().mockImplementation(function (this: any) {
    this.send = mockSend;
    this.destroy = mockDestroy;
  });
  const MockCommand = vi.fn().mockImplementation(function (this: any, params: any) {
    Object.assign(this, params);
  });
  return {
    NeptunedataClient: MockClient,
    ExecuteOpenCypherQueryCommand: MockCommand,
  };
});

import { loadGraphToNeptune, getNeptuneStats } from '../../src/core/db/neptune/neptune-ingest.js';
import { ExecuteOpenCypherQueryCommand } from '@aws-sdk/client-neptunedata';
import type { NeptuneDbConfig } from '../../src/core/db/interfaces.js';
import type { KnowledgeGraph, GraphNode, GraphRelationship } from '../../src/core/graph/types.js';

const testConfig: NeptuneDbConfig = {
  type: 'neptune',
  endpoint: 'test.neptune.amazonaws.com',
  region: 'us-east-1',
  port: 8182,
};

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Create a minimal mock KnowledgeGraph with the forEachNode/forEachRelationship
 * interface that neptune-ingest.ts uses.
 */
function createMockGraph(nodeCount: number, edgeCount: number): KnowledgeGraph {
  const nodes: GraphNode[] = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      id: `node-${i}`,
      label: i % 2 === 0 ? 'Function' : 'Class',
      properties: { name: `item-${i}`, filePath: `/src/file-${i}.ts` },
    });
  }
  const relationships: GraphRelationship[] = [];
  for (let i = 0; i < edgeCount && i < nodeCount - 1; i++) {
    relationships.push({
      id: `rel-${i}`,
      sourceId: `node-${i}`,
      targetId: `node-${i + 1}`,
      type: 'CALLS',
      confidence: 0.9,
      reason: '',
    });
  }

  return {
    nodes,
    relationships,
    iterNodes: function* () { yield* nodes; },
    iterRelationships: function* () { yield* relationships; },
    forEachNode: (fn) => nodes.forEach(fn),
    forEachRelationship: (fn) => relationships.forEach(fn),
    getNode: (id) => nodes.find((n) => n.id === id),
    nodeCount: nodes.length,
    relationshipCount: relationships.length,
    addNode: () => {},
    addRelationship: () => {},
    removeNode: () => false,
    removeNodesByFile: () => 0,
  };
}

// ── Tests: loadGraphToNeptune ────────────────────────────────────────

describe('loadGraphToNeptune', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
  });

  it('does not clear data before inserting (idempotent upsert)', async () => {
    const graph = createMockGraph(2, 1);
    await loadGraphToNeptune(graph, testConfig);

    // No DETACH DELETE should appear before the MERGE inserts
    const cypherCalls = (ExecuteOpenCypherQueryCommand as any).mock.calls.map(
      (call: any[]) => call[0].openCypherQuery,
    );
    const firstMerge = cypherCalls.findIndex((q: string) => q.includes('MERGE'));
    const firstDelete = cypherCalls.findIndex((q: string) => q.includes('DETACH DELETE'));
    // Cleanup (delete) should come AFTER upserts, not before
    if (firstDelete !== -1) {
      expect(firstDelete).toBeGreaterThan(firstMerge);
    }
  });

  it('returns correct node count', async () => {
    const graph = createMockGraph(4, 0);
    const result = await loadGraphToNeptune(graph, testConfig);
    expect(result.nodesInserted).toBe(4);
  });

  it('returns correct edge count', async () => {
    const graph = createMockGraph(3, 2);
    const result = await loadGraphToNeptune(graph, testConfig);
    expect(result.edgesInserted).toBe(2);
  });

  it('returns empty warnings array', async () => {
    const graph = createMockGraph(1, 0);
    const result = await loadGraphToNeptune(graph, testConfig);
    expect(result.warnings).toEqual([]);
  });

  it('groups nodes by label before insertion', async () => {
    // 4 nodes: indices 0,2 = Function, indices 1,3 = Class
    const graph = createMockGraph(4, 0);
    const result = await loadGraphToNeptune(graph, testConfig);

    expect(result.nodesInserted).toBe(4);

    // Check that UNWIND queries contain the label names
    const cypherCalls = (ExecuteOpenCypherQueryCommand as any).mock.calls.map(
      (call: any[]) => call[0].openCypherQuery,
    );
    const unwindCalls = cypherCalls.filter((q: string) => q.includes('UNWIND'));
    expect(unwindCalls.some((q: string) => q.includes('Function'))).toBe(true);
    expect(unwindCalls.some((q: string) => q.includes('Class'))).toBe(true);
  });

  it('inserts relationships with UNWIND+MERGE', async () => {
    const graph = createMockGraph(3, 2);
    await loadGraphToNeptune(graph, testConfig);

    const cypherCalls = (ExecuteOpenCypherQueryCommand as any).mock.calls.map(
      (call: any[]) => call[0].openCypherQuery,
    );
    // Should have a relationship insert query with CodeRelation
    expect(cypherCalls.some((q: string) => q.includes('CodeRelation'))).toBe(true);
  });

  it('calls onProgress callback with stage messages', async () => {
    const graph = createMockGraph(2, 1);
    const onProgress = vi.fn();
    await loadGraphToNeptune(graph, testConfig, onProgress);

    expect(onProgress).toHaveBeenCalled();
    const messages = onProgress.mock.calls.map((c: any[]) => c[0]);
    expect(messages.some((m: string) => m.includes('Upserting'))).toBe(true);
    expect(messages.some((m: string) => m.includes('complete'))).toBe(true);
  });

  it('works without onProgress callback', async () => {
    const graph = createMockGraph(1, 0);
    // Should not throw when onProgress is undefined
    const result = await loadGraphToNeptune(graph, testConfig);
    expect(result.nodesInserted).toBe(1);
  });

  it('handles empty graph (zero nodes, zero edges)', async () => {
    const graph = createMockGraph(0, 0);
    const result = await loadGraphToNeptune(graph, testConfig);
    expect(result.nodesInserted).toBe(0);
    expect(result.nodesFailed).toBe(0);
    expect(result.edgesInserted).toBe(0);
    expect(result.edgesFailed).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it('skips failed edge batches and reports them in warnings', async () => {
    const graph = createMockGraph(4, 3);
    let callCount = 0;
    mockSend.mockImplementation(async () => {
      callCount++;
      // Fail the relationship MERGE calls (non-retryable error)
      // Node MERGEs come first, then indexes, then edges
      // We need to identify edge calls — they happen after index calls
      // For simplicity, fail on a later call that would be an edge batch
      return {};
    });

    // Override: fail only on edge-related sendCypher calls
    // We do this by failing after the node insertion calls
    const nodeInsertCalls = 2; // 2 label groups (Function, Class)
    let sendCount = 0;
    mockSend.mockImplementation(async () => {
      sendCount++;
      // After nodes, the edge calls start.
      // Fail the first edge batch with a non-retryable error.
      if (sendCount === nodeInsertCalls + 1) {
        const err = new Error('ConcurrentModificationException');
        err.name = 'NonRetryableError';
        throw err;
      }
      return {};
    });

    const result = await loadGraphToNeptune(graph, testConfig);
    // Some edges should have failed
    expect(result.edgesFailed).toBeGreaterThan(0);
    expect(result.warnings.some((w: string) => w.includes('relationships failed'))).toBe(true);
  });

  it('returns nodesFailed and edgesFailed as zero on success', async () => {
    const graph = createMockGraph(2, 1);
    const result = await loadGraphToNeptune(graph, testConfig);
    expect(result.nodesFailed).toBe(0);
    expect(result.edgesFailed).toBe(0);
  });

  it('should NOT send CREATE INDEX queries (Neptune manages indexes automatically)', async () => {
    const graph = createMockGraph(1, 0);
    await loadGraphToNeptune(graph, testConfig);

    const cypherCalls = (ExecuteOpenCypherQueryCommand as any).mock.calls.map(
      (call: any[]) => call[0].openCypherQuery,
    );
    const indexCalls = cypherCalls.filter((q: string) => q.includes('CREATE INDEX'));
    expect(indexCalls.length).toBe(0);
  });

  it('destroys client in finally block', async () => {
    const graph = createMockGraph(1, 0);
    await loadGraphToNeptune(graph, testConfig);
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it('destroys client even when send fails', async () => {
    // With fault tolerance, node batch failures are skipped.
    // Client should still be destroyed.
    mockSend.mockRejectedValue(new Error('Neptune down'));
    const graph = createMockGraph(1, 0);
    const result = await loadGraphToNeptune(graph, testConfig);
    expect(result.nodesFailed).toBeGreaterThan(0);
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });
});

// ── Tests: getNeptuneStats ───────────────────────────────────────────

describe('getNeptuneStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns node and edge counts', async () => {
    mockSend
      .mockResolvedValueOnce({ results: [{ c: 100 }] })  // node count
      .mockResolvedValueOnce({ results: [{ c: 250 }] }); // edge count

    const stats = await getNeptuneStats(testConfig);
    expect(stats).toEqual({ nodes: 100, edges: 250 });
  });

  it('returns zeros when results are empty arrays', async () => {
    mockSend
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [] });

    const stats = await getNeptuneStats(testConfig);
    expect(stats).toEqual({ nodes: 0, edges: 0 });
  });

  it('returns zeros when results are null', async () => {
    mockSend
      .mockResolvedValueOnce({ results: null })
      .mockResolvedValueOnce({ results: null });

    const stats = await getNeptuneStats(testConfig);
    expect(stats).toEqual({ nodes: 0, edges: 0 });
  });

  it('destroys client after fetching stats', async () => {
    mockSend
      .mockResolvedValueOnce({ results: [{ c: 10 }] })
      .mockResolvedValueOnce({ results: [{ c: 20 }] });

    await getNeptuneStats(testConfig);
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it('destroys client even on failure', async () => {
    mockSend.mockRejectedValueOnce(new Error('Connection failed'));
    try {
      await getNeptuneStats(testConfig);
    } catch {
      // expected
    }
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });
});
