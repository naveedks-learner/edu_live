export interface PageText {
  page: number;
  text: string;
}

export interface Chunk {
  text: string;
  page: number;
  pageEnd: number;
  chunkId: number;
  source: string;
  wordStart: number;
  wordEnd: number;
  chunkSize: number;
  overlap: number;
}
