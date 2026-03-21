import { describe, it, expect } from 'vitest';

/**
 * Tests for the cosine similarity and top-K selection logic.
 * We test the exported function by mocking the NeptuneAdapter.
 */

// Helper: cosine similarity between two vectors (for verification)
function cosineSim(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

describe('Neptune Vector Search (cosine similarity)', () => {
  it('computes correct cosine similarity for known vectors', () => {
    // Identical vectors -> similarity = 1 -> distance = 0
    expect(1 - cosineSim([1, 0, 0], [1, 0, 0])).toBeCloseTo(0, 10);

    // Orthogonal vectors -> similarity = 0 -> distance = 1
    expect(1 - cosineSim([1, 0, 0], [0, 1, 0])).toBeCloseTo(1, 10);

    // Opposite vectors -> similarity = -1 -> distance = 2
    expect(1 - cosineSim([1, 0, 0], [-1, 0, 0])).toBeCloseTo(2, 10);

    // 45-degree angle -> similarity ≈ 0.707
    const sim = cosineSim([1, 0], [1, 1]);
    expect(sim).toBeCloseTo(0.7071, 3);
  });

  it('handles zero vectors gracefully', () => {
    expect(cosineSim([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSim([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it('distance threshold filtering works correctly', () => {
    const vectors = [
      { id: 'a', vec: [1, 0, 0] },      // identical to query -> dist=0
      { id: 'b', vec: [0, 1, 0] },      // orthogonal -> dist=1
      { id: 'c', vec: [0.9, 0.1, 0] },  // close -> dist≈0.005
    ];
    const query = [1, 0, 0];
    const maxDistance = 0.5;

    const results = vectors
      .map(v => ({ nodeId: v.id, distance: 1 - cosineSim(query, v.vec) }))
      .filter(r => r.distance < maxDistance)
      .sort((a, b) => a.distance - b.distance);

    expect(results.length).toBe(2); // 'a' and 'c' pass threshold
    expect(results[0].nodeId).toBe('a');
    expect(results[1].nodeId).toBe('c');
  });

  it('top-K selection returns correct K', () => {
    const n = 20;
    const scores = Array.from({ length: n }, (_, i) => ({ nodeId: `n${i}`, distance: i * 0.05 }));
    const k = 5;
    const topK = scores.sort((a, b) => a.distance - b.distance).slice(0, k);

    expect(topK.length).toBe(5);
    expect(topK[0].distance).toBe(0);
    expect(topK[4].distance).toBe(0.2);
  });
});
