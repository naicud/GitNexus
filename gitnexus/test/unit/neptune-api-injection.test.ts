import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Neptune API search injection safety', () => {
  it('should NOT use string interpolation for query parameters in Neptune search', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/server/api.ts'),
      'utf-8',
    );
    const neptuneSearchStart = src.indexOf('Neptune: CONTAINS-based text search');
    expect(neptuneSearchStart).toBeGreaterThan(-1);

    const neptuneSearchEnd = src.indexOf('return;', neptuneSearchStart);
    expect(neptuneSearchEnd).toBeGreaterThan(neptuneSearchStart);

    const block = src.slice(neptuneSearchStart, neptuneSearchEnd);

    // Should NOT contain string interpolation of query variable
    expect(block).not.toContain("'${query");
    expect(block).not.toContain("${query");

    // Should use parameterized query ($query or $q)
    expect(block).toMatch(/\$q(uery)?/);
  });
});
