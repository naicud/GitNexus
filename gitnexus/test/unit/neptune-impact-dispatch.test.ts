import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Neptune impact dispatch', () => {
  it('should not call raw executeQuery in impact enrichment block', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/mcp/local/local-backend.ts'),
      'utf-8',
    );
    const enrichmentStart = src.indexOf('Enrichment: affected processes');
    const enrichmentEnd = src.indexOf('Risk scoring', enrichmentStart);

    // Guard: ensure we actually found the block (prevents vacuous pass)
    expect(enrichmentStart).toBeGreaterThan(-1);
    expect(enrichmentEnd).toBeGreaterThan(enrichmentStart);

    const enrichmentBlock = src.slice(enrichmentStart, enrichmentEnd);
    expect(enrichmentBlock.length).toBeGreaterThan(100);

    // Should NOT contain raw executeQuery calls
    const rawCalls = enrichmentBlock.match(/\bexecuteQuery\s*\(/g);
    expect(rawCalls).toBeNull();

    // Should contain this.runQuery or this.runParameterized calls
    const dispatchCalls = enrichmentBlock.match(/this\.(runQuery|runParameterized)\s*\(/g);
    expect(dispatchCalls).not.toBeNull();
    expect(dispatchCalls!.length).toBeGreaterThanOrEqual(3);
  });
});
