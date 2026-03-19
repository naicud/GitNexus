import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Neptune CONTAINS query safety', () => {
  it('should NOT scan n.content in Neptune text search fallback', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/mcp/local/local-backend.ts'),
      'utf-8',
    );
    const neptuneStart = src.indexOf('if (isNeptune) {');
    expect(neptuneStart).toBeGreaterThan(-1);

    // Find the end of this Neptune block (next semantic search reference)
    const neptuneEnd = src.indexOf('semanticSearch', neptuneStart);
    expect(neptuneEnd).toBeGreaterThan(neptuneStart);

    const neptuneBlock = src.slice(neptuneStart, neptuneEnd);

    // Should NOT scan n.content — causes full-scan timeout on Neptune
    expect(neptuneBlock).not.toContain('n.content');
  });
});
