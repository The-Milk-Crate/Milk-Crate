// The few things the processing step needs from a platform's modules. They match the shapes in
// core/src/platform/ (Database, ObjectStorage, JobResult), written out here so this folder can
// be copied into each worker image on its own. A platform's modules fit these as they are.

export type SqlParam = string | number | boolean | null;

export interface Queryable {
  query<Row = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<Row[]>;
}

export interface WorkerDatabase extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

export interface WorkerStorage {
  read(key: string): Promise<ReadableStream<Uint8Array>>;
  put(key: string, body: ReadableStream<Uint8Array>, options: { contentType: string; sizeBytes: number }): Promise<void>;
  delete(prefix: string): Promise<void>;
}

export type JobResult = { ok: true } | { ok: false; message: string };

export interface JobToRun {
  jobId: string;
  releaseId: string;
}

export type AudioFormat = "wav" | "aiff" | "flac";
