import { describe, it, expect } from 'vitest';
import { getEmbeddingDims, isEmbedderReady } from '../../src/mcp/core/embedder.js';

describe('embedder (MCP query-time)', () => {
  describe('getEmbeddingDims', () => {
    it('returns 384 when no config provided (backward compat)', () => {
      expect(getEmbeddingDims()).toBe(384);
    });

    it('returns configured dimensions when config provided', () => {
      expect(getEmbeddingDims({ dimensions: 768 })).toBe(768);
      expect(getEmbeddingDims({ dimensions: 256 })).toBe(256);
    });
  });

  describe('isEmbedderReady', () => {
    it('returns false before initialization', () => {
      expect(isEmbedderReady()).toBe(false);
    });
  });
});
