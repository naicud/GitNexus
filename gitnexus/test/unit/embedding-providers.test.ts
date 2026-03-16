import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Embedding Providers', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('OllamaProvider', () => {
    it('embeds texts via /api/embed', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]] }),
      });

      const { OllamaProvider } = await import('../../src/core/embeddings/providers/ollama-provider.js');
      const provider = new OllamaProvider({ provider: 'ollama', model: 'nomic-embed-text', dimensions: 3 });

      const result = await provider.embed(['hello', 'world']);

      expect(result).toEqual([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(provider.dimensions()).toBe(3);
      expect(provider.name()).toBe('ollama/nomic-embed-text');
      expect(provider.maxBatchSize()).toBe(128);
    });

    it('uses default endpoint http://localhost:11434', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: [[1, 2]] }),
      });

      const { OllamaProvider } = await import('../../src/core/embeddings/providers/ollama-provider.js');
      const provider = new OllamaProvider({ provider: 'ollama', model: 'test', dimensions: 2 });
      await provider.embed(['test']);

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toContain('localhost:11434');
    });

    it('uses custom endpoint when provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: [[1, 2]] }),
      });

      const { OllamaProvider } = await import('../../src/core/embeddings/providers/ollama-provider.js');
      const provider = new OllamaProvider({ provider: 'ollama', model: 'test', dimensions: 2, endpoint: 'http://myserver:11434' });
      await provider.embed(['test']);

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toContain('myserver:11434');
    });

    it('returns empty array for empty input', async () => {
      const { OllamaProvider } = await import('../../src/core/embeddings/providers/ollama-provider.js');
      const provider = new OllamaProvider({ provider: 'ollama', model: 'test', dimensions: 2 });
      const result = await provider.embed([]);
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('CohereProvider', () => {
    it('embeds texts via /v2/embed', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: { float: [[0.1, 0.2], [0.3, 0.4]] } }),
      });

      const { CohereProvider } = await import('../../src/core/embeddings/providers/cohere-provider.js');
      const provider = new CohereProvider({ provider: 'cohere', model: 'embed-english-light-v3.0', dimensions: 2, apiKey: 'test-key' });

      const result = await provider.embed(['hello', 'world']);
      expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
      expect(provider.dimensions()).toBe(2);
      expect(provider.maxBatchSize()).toBe(96);
    });

    it('throws without API key', async () => {
      const origEnv = process.env.COHERE_API_KEY;
      delete process.env.COHERE_API_KEY;
      try {
        const { CohereProvider } = await import('../../src/core/embeddings/providers/cohere-provider.js');
        expect(() => new CohereProvider({ provider: 'cohere', model: 'test', dimensions: 2 })).toThrow();
      } finally {
        if (origEnv) process.env.COHERE_API_KEY = origEnv;
      }
    });
  });

  describe('OpenAIProvider', () => {
    it('embeds texts via /embeddings', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { index: 0, embedding: [0.1, 0.2] },
            { index: 1, embedding: [0.3, 0.4] },
          ],
        }),
      });

      const { OpenAIProvider } = await import('../../src/core/embeddings/providers/openai-provider.js');
      const provider = new OpenAIProvider({ provider: 'openai', model: 'text-embedding-3-small', dimensions: 2, apiKey: 'test-key' });

      const result = await provider.embed(['hello', 'world']);
      expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
      expect(provider.dimensions()).toBe(2);
      expect(provider.maxBatchSize()).toBe(256);
    });

    it('sorts response by index', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { index: 1, embedding: [0.3, 0.4] },
            { index: 0, embedding: [0.1, 0.2] },
          ],
        }),
      });

      const { OpenAIProvider } = await import('../../src/core/embeddings/providers/openai-provider.js');
      const provider = new OpenAIProvider({ provider: 'openai', model: 'test', dimensions: 2, apiKey: 'test-key' });
      const result = await provider.embed(['a', 'b']);
      expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    });

    it('throws without API key', async () => {
      const origGN = process.env.GITNEXUS_EMBED_API_KEY;
      const origOA = process.env.OPENAI_API_KEY;
      delete process.env.GITNEXUS_EMBED_API_KEY;
      delete process.env.OPENAI_API_KEY;
      try {
        const { OpenAIProvider } = await import('../../src/core/embeddings/providers/openai-provider.js');
        expect(() => new OpenAIProvider({ provider: 'openai', model: 'test', dimensions: 2 })).toThrow();
      } finally {
        if (origGN) process.env.GITNEXUS_EMBED_API_KEY = origGN;
        if (origOA) process.env.OPENAI_API_KEY = origOA;
      }
    });
  });

  describe('Factory', () => {
    it('creates OllamaProvider for ollama type', async () => {
      const { createEmbeddingProvider } = await import('../../src/core/embeddings/providers/factory.js');
      const provider = await createEmbeddingProvider({ provider: 'ollama', model: 'test', dimensions: 384 });
      expect(provider.name()).toBe('ollama/test');
    });

    it('creates CohereProvider for cohere type', async () => {
      const { createEmbeddingProvider } = await import('../../src/core/embeddings/providers/factory.js');
      const provider = await createEmbeddingProvider({ provider: 'cohere', model: 'test', dimensions: 384, apiKey: 'key' });
      expect(provider.name()).toContain('cohere');
    });

    it('creates OpenAIProvider for openai type', async () => {
      const { createEmbeddingProvider } = await import('../../src/core/embeddings/providers/factory.js');
      const provider = await createEmbeddingProvider({ provider: 'openai', model: 'test', dimensions: 384, apiKey: 'key' });
      expect(provider.name()).toContain('openai');
    });

    it('throws for unknown provider', async () => {
      const { createEmbeddingProvider } = await import('../../src/core/embeddings/providers/factory.js');
      await expect(createEmbeddingProvider({ provider: 'unknown' as any, model: 'test', dimensions: 384 }))
        .rejects.toThrow('Unknown embedding provider');
    });
  });
});
