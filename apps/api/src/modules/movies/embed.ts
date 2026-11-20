import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
export const EMBEDDING_DTYPE = 'q8';
export const EMBEDDING_DIMENSIONS = 384;
export const EMBEDDING_VERSION = `all-MiniLM-L6-v2@${EMBEDDING_REVISION}/${EMBEDDING_DTYPE}/mean/normalized/1`;

export type Embedder = (texts: string[]) => Promise<number[][]>;

export async function createEmbedder(): Promise<Embedder> {
  env.cacheDir =
    process.env.TRANSFORMERS_CACHE ??
    fileURLToPath(new URL('../../../.cache/transformers', import.meta.url));

  const extractor = await pipeline('feature-extraction', EMBEDDING_MODEL, {
    revision: EMBEDDING_REVISION,
    dtype: EMBEDDING_DTYPE,
  });

  return async (texts) => {
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    const vectors = output.tolist() as unknown as number[][];

    if (vectors.length !== texts.length) {
      throw new Error(`Expected ${texts.length} embeddings, received ${vectors.length}`);
    }

    for (const vector of vectors) {
      if (
        vector.length !== EMBEDDING_DIMENSIONS ||
        vector.some((value) => !Number.isFinite(value))
      ) {
        throw new Error('Embedding model returned an unexpected vector');
      }
    }

    return vectors;
  };
}
