/**
 * Vectorize ids are capped at 64 bytes. A raw `${source}::${chunkId}` id
 * (as originally used) overflows that for ordinary long filenames, which
 * makes the upsert throw. Hashing the source keeps the id short and
 * bounded regardless of filename length, while staying deterministic so
 * re-ingesting the same source produces the same ids (overwrite, not
 * duplicate).
 */
function hashSource(source: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function chunkVectorId(source: string, chunkId: number): string {
  return `${hashSource(source)}::${chunkId}`;
}
