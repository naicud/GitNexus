import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import type { IEmbeddingProvider, EmbeddingProviderConfig } from './types.js';

type Device = 'dml' | 'cuda' | 'cpu' | 'wasm';

function isCudaAvailable(): boolean {
  try {
    const out = execFileSync('ldconfig', ['-p'], { timeout: 3000, encoding: 'utf-8' });
    if (out.includes('libcublasLt.so.12')) return true;
  } catch {
    // ldconfig not available
  }

  for (const envVar of ['CUDA_PATH', 'LD_LIBRARY_PATH']) {
    const val = process.env[envVar];
    if (!val) continue;
    for (const dir of val.split(':').filter(Boolean)) {
      if (existsSync(join(dir, 'lib64', 'libcublasLt.so.12')) ||
          existsSync(join(dir, 'lib', 'libcublasLt.so.12')) ||
          existsSync(join(dir, 'libcublasLt.so.12'))) return true;
    }
  }

  return false;
}

function detectGpuDevice(): Device {
  if (process.platform === 'win32') return 'dml';
  if (isCudaAvailable()) return 'cuda';
  return 'cpu';
}

export class TransformersJsProvider implements IEmbeddingProvider {
  private readonly _model: string;
  private readonly _dimensions: number;
  private _pipeline: any | null = null;
  private _initPromise: Promise<void> | null = null;

  constructor(config: EmbeddingProviderConfig) {
    this._model = config.model;
    this._dimensions = config.dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    await this.ensureInitialized();

    const result = await this._pipeline!(texts, {
      pooling: 'mean',
      normalize: true,
    });

    const data = result.data as ArrayLike<number>;
    const embeddings: number[][] = [];

    for (let i = 0; i < texts.length; i++) {
      const start = i * this._dimensions;
      const end = start + this._dimensions;
      embeddings.push(Array.prototype.slice.call(data, start, end));
    }

    return embeddings;
  }

  dimensions(): number {
    return this._dimensions;
  }

  name(): string {
    return `local/${this._model}`;
  }

  maxBatchSize(): number {
    return 32;
  }

  async dispose(): Promise<void> {
    if (this._pipeline) {
      try {
        if ('dispose' in this._pipeline && typeof this._pipeline.dispose === 'function') {
          await this._pipeline.dispose();
        }
      } catch {
        // Ignore disposal errors
      }
      this._pipeline = null;
      this._initPromise = null;
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this._pipeline) return;
    if (this._initPromise) return this._initPromise;

    this._initPromise = this.loadPipeline();
    return this._initPromise;
  }

  private async loadPipeline(): Promise<void> {
    if (!process.env.ORT_LOG_LEVEL) {
      process.env.ORT_LOG_LEVEL = '3';
    }

    const { pipeline, env } = await import('@huggingface/transformers');
    env.allowLocalModels = false;

    const gpuDevice = detectGpuDevice();
    const devicesToTry: Device[] =
      gpuDevice === 'dml' || gpuDevice === 'cuda'
        ? [gpuDevice, 'cpu']
        : [gpuDevice];

    for (const device of devicesToTry) {
      try {
        this._pipeline = await (pipeline as any)(
          'feature-extraction',
          this._model,
          {
            device,
            dtype: 'fp32',
            session_options: { logSeverityLevel: 3 },
          },
        );
        return;
      } catch (err) {
        if (device === devicesToTry[devicesToTry.length - 1]) {
          this._initPromise = null;
          throw err;
        }
      }
    }

    this._initPromise = null;
    throw new Error('No suitable device found for embedding model');
  }
}
