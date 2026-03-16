/**
 * Unit Tests: Neptune Adapter (Read Path)
 *
 * Tests NeptuneAdapter: constructor, executeQuery, executeParameterized,
 * close, and the static test() method. AWS SDK is fully mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock AWS SDK before any imports that use it ──────────────────────
const mockSend = vi.fn();
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

import { NeptuneAdapter } from '../../src/core/db/neptune/neptune-adapter.js';
import { NeptunedataClient, ExecuteOpenCypherQueryCommand } from '@aws-sdk/client-neptunedata';
import type { NeptuneDbConfig } from '../../src/core/db/interfaces.js';

const testConfig: NeptuneDbConfig = {
  type: 'neptune',
  endpoint: 'test-cluster.us-east-1.neptune.amazonaws.com',
  region: 'us-east-1',
  port: 8182,
};

// ── Tests ────────────────────────────────────────────────────────────

describe('NeptuneAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── constructor ──────────────────────────────────────────────────

  describe('constructor', () => {
    it('creates client with correct endpoint URL and region', () => {
      new NeptuneAdapter(testConfig);
      expect(NeptunedataClient).toHaveBeenCalledWith({
        endpoint: 'https://test-cluster.us-east-1.neptune.amazonaws.com:8182',
        region: 'us-east-1',
      });
    });

    it('uses custom port in endpoint URL', () => {
      new NeptuneAdapter({ ...testConfig, port: 9999 });
      expect(NeptunedataClient).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'https://test-cluster.us-east-1.neptune.amazonaws.com:9999',
        }),
      );
    });

    it('uses custom region', () => {
      new NeptuneAdapter({ ...testConfig, region: 'eu-west-1' });
      expect(NeptunedataClient).toHaveBeenCalledWith(
        expect.objectContaining({ region: 'eu-west-1' }),
      );
    });
  });

  // ── executeQuery ─────────────────────────────────────────────────

  describe('executeQuery', () => {
    it('sends openCypher query and returns normalized results', async () => {
      // Neptune SDK response shape: response.results is the raw value
      // passed to normalizeResults. normalizeResults expects an object
      // with a 'results' array property (Neptune openCypher response format).
      mockSend.mockResolvedValueOnce({
        results: {
          results: [
            { name: 'foo', type: 'Function' },
            { name: 'bar', type: 'Class' },
          ],
        },
      });

      const adapter = new NeptuneAdapter(testConfig);
      const results = await adapter.executeQuery('MATCH (n) RETURN n.name AS name');

      expect(ExecuteOpenCypherQueryCommand).toHaveBeenCalledWith({
        openCypherQuery: 'MATCH (n) RETURN n.name AS name',
      });
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ name: 'foo', type: 'Function' });
      expect(results[1]).toEqual({ name: 'bar', type: 'Class' });
    });

    it('returns empty array when results is null', async () => {
      mockSend.mockResolvedValueOnce({ results: null });
      const adapter = new NeptuneAdapter(testConfig);
      const results = await adapter.executeQuery('MATCH (n) RETURN n');
      expect(results).toEqual([]);
    });

    it('returns empty array when results is undefined', async () => {
      mockSend.mockResolvedValueOnce({});
      const adapter = new NeptuneAdapter(testConfig);
      const results = await adapter.executeQuery('MATCH (n) RETURN n');
      expect(results).toEqual([]);
    });

    it('returns empty array when response is not an object', async () => {
      mockSend.mockResolvedValueOnce({ results: 'not-an-object' });
      const adapter = new NeptuneAdapter(testConfig);
      const results = await adapter.executeQuery('MATCH (n) RETURN n');
      // normalizeResults receives 'not-an-object' (a string) which is not an object
      // so it returns []
      expect(results).toEqual([]);
    });

    it('propagates SDK errors', async () => {
      mockSend.mockRejectedValueOnce(new Error('Neptune timeout'));
      const adapter = new NeptuneAdapter(testConfig);
      await expect(adapter.executeQuery('MATCH (n) RETURN n')).rejects.toThrow('Neptune timeout');
    });
  });

  // ── executeParameterized ─────────────────────────────────────────

  describe('executeParameterized', () => {
    it('passes parameters as JSON string', async () => {
      mockSend.mockResolvedValueOnce({
        results: {
          results: [{ id: 'test-id', name: 'test' }],
        },
      });

      const adapter = new NeptuneAdapter(testConfig);
      const results = await adapter.executeParameterized(
        'MATCH (n) WHERE n.id = $id RETURN n',
        { id: 'test-id' },
      );

      expect(ExecuteOpenCypherQueryCommand).toHaveBeenCalledWith({
        openCypherQuery: 'MATCH (n) WHERE n.id = $id RETURN n',
        parameters: JSON.stringify({ id: 'test-id' }),
      });
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ id: 'test-id', name: 'test' });
    });

    it('handles complex parameter objects', async () => {
      mockSend.mockResolvedValueOnce({ results: [] });

      const adapter = new NeptuneAdapter(testConfig);
      await adapter.executeParameterized('MATCH (n) WHERE n.id = $id RETURN n', {
        id: 'node-1',
        labels: ['Function', 'Method'],
        depth: 3,
      });

      expect(ExecuteOpenCypherQueryCommand).toHaveBeenCalledWith({
        openCypherQuery: 'MATCH (n) WHERE n.id = $id RETURN n',
        parameters: JSON.stringify({
          id: 'node-1',
          labels: ['Function', 'Method'],
          depth: 3,
        }),
      });
    });

    it('returns empty array for null results', async () => {
      mockSend.mockResolvedValueOnce({ results: null });
      const adapter = new NeptuneAdapter(testConfig);
      const results = await adapter.executeParameterized('MATCH (n) RETURN n', {});
      expect(results).toEqual([]);
    });
  });

  // ── close ────────────────────────────────────────────────────────

  describe('close', () => {
    it('destroys the client', async () => {
      const adapter = new NeptuneAdapter(testConfig);
      await adapter.close();
      expect(mockDestroy).toHaveBeenCalledTimes(1);
    });

    it('can be called multiple times without error', async () => {
      const adapter = new NeptuneAdapter(testConfig);
      await adapter.close();
      await adapter.close();
      expect(mockDestroy).toHaveBeenCalledTimes(2);
    });
  });

  // ── static test() ────────────────────────────────────────────────

  describe('test (static)', () => {
    it('returns latency on successful connection', async () => {
      mockSend.mockResolvedValueOnce({ results: [{ c: 42 }] });
      const result = await NeptuneAdapter.test(testConfig);
      expect(result).toHaveProperty('latencyMs');
      expect(typeof result.latencyMs).toBe('number');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('destroys client after successful test', async () => {
      mockSend.mockResolvedValueOnce({ results: [{ c: 0 }] });
      await NeptuneAdapter.test(testConfig);
      expect(mockDestroy).toHaveBeenCalledTimes(1);
    });

    it('throws on connection failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('Connection refused'));
      await expect(NeptuneAdapter.test(testConfig)).rejects.toThrow('Connection refused');
    });

    it('destroys client even on failure (finally block)', async () => {
      mockSend.mockRejectedValueOnce(new Error('Network error'));
      try {
        await NeptuneAdapter.test(testConfig);
      } catch {
        // expected
      }
      expect(mockDestroy).toHaveBeenCalledTimes(1);
    });
  });
});
