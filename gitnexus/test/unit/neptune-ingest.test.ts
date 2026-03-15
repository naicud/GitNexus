/**
 * Unit Tests: Neptune Ingestion
 *
 * Tests loadGraphToNeptune and getNeptuneStats. AWS SDK is fully mocked.
 * Verifies: data clearing, node grouping by label, batched inserts,
 * relationship insertion, progress callbacks, and stats retrieval.
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

  it('clears existing data as the first operation', async () => {
    const graph = createMockGraph(2, 1);
    await loadGraphToNeptune(graph, testConfig);

    // The first send call should be the DETACH DELETE
    const firstCall = (ExecuteOpenCypherQueryCommand as any).mock.calls[0][0];
    expect(firstCall.openCypherQuery).toBe('MATCH (n) DETACH DELETE n');
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
    expect(messages.some((m: string) => m.includes('Clearing'))).toBe(true);
    expect(messages.some((m: string) => m.includes('Inserting'))).toBe(true);
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
    expect(result.edgesInserted).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it('attempts to create indexes for standard labels', async () => {
    const graph = createMockGraph(1, 0);
    await loadGraphToNeptune(graph, testConfig);

    const cypherCalls = (ExecuteOpenCypherQueryCommand as any).mock.calls.map(
      (call: any[]) => call[0].openCypherQuery,
    );
    const indexCalls = cypherCalls.filter((q: string) => q.includes('CREATE INDEX'));
    // Should attempt indexes for Function, File, Class, Method, Interface, Module,
    // Namespace, Variable, Property, CodeElement
    expect(indexCalls.length).toBe(10);
  });

  it('destroys client in finally block', async () => {
    const graph = createMockGraph(1, 0);
    await loadGraphToNeptune(graph, testConfig);
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it('destroys client even when send fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('Neptune down'));
    const graph = createMockGraph(1, 0);
    try {
      await loadGraphToNeptune(graph, testConfig);
    } catch {
      // expected
    }
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
