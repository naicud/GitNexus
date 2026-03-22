import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Neptune API search injection safety', () => {
  it('should NOT use string interpolation for query parameters in Neptune search', () => {
    // Neptune search logic lives in LocalBackend.searchForApi (moved from api.ts)
    const src = readFileSync(
      resolve(__dirname, '../../src/mcp/local/local-backend.ts'),
      'utf-8',
    );
    const neptuneSearchStart = src.indexOf('CONTAINS toLower($q)');
    expect(neptuneSearchStart).toBeGreaterThan(-1);

    // Find the enclosing searchForApi method — look for the next closing brace pattern
    const neptuneSearchEnd = src.indexOf('// LadybugDB path', neptuneSearchStart);
    expect(neptuneSearchEnd).toBeGreaterThan(neptuneSearchStart);

    const block = src.slice(neptuneSearchStart, neptuneSearchEnd);

    // Should NOT contain string interpolation of query variable
    expect(block).not.toContain("'${query");
    expect(block).not.toContain("${query");

    // Should use parameterized query ($query or $q)
    expect(block).toMatch(/\$q(uery)?/);
  });
});
