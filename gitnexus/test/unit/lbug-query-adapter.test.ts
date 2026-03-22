import { describe, it, expect, vi } from 'vitest';
import { LbugQueryAdapter } from '../../src/core/db/lbug-query-adapter.js';

describe('LbugQueryAdapter', () => {
  it('implements IDbQueryAdapter with correct id', () => {
    const adapter = new LbugQueryAdapter('test-repo', vi.fn(), vi.fn());
    expect(adapter.id).toBe('lbug:test-repo');
  });

  it('delegates executeQuery to provided function', async () => {
    const mockExec = vi.fn().mockResolvedValue([{ count: 42 }]);
    const adapter = new LbugQueryAdapter('repo1', mockExec, vi.fn());
    const result = await adapter.executeQuery('MATCH (n) RETURN count(n) AS count');
    expect(mockExec).toHaveBeenCalledWith('MATCH (n) RETURN count(n) AS count');
    expect(result).toEqual([{ count: 42 }]);
  });

  it('delegates executeParameterized to provided function', async () => {
    const mockExecParam = vi.fn().mockResolvedValue([{ name: 'foo' }]);
    const adapter = new LbugQueryAdapter('repo2', vi.fn(), mockExecParam);
    const result = await adapter.executeParameterized(
      'MATCH (n {id: $id}) RETURN n.name AS name',
      { id: 'node1' },
    );
    expect(mockExecParam).toHaveBeenCalledWith(
      'MATCH (n {id: $id}) RETURN n.name AS name',
      { id: 'node1' },
    );
    expect(result).toEqual([{ name: 'foo' }]);
  });

  it('close() is a noop (does not throw)', async () => {
    const adapter = new LbugQueryAdapter('repo3', vi.fn(), vi.fn());
    await expect(adapter.close()).resolves.toBeUndefined();
  });
});
