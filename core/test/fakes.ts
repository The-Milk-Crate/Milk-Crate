// Fake modules for the handler tests: identity, storage, jobs, schedules and email. The
// database is the real throwaway PostgreSQL (test/pg.ts), because the handlers lean on session
// B's SQL functions and transactions.
import type {
  AccountType,
  Caller,
  ConfirmUploadInput,
  ConfirmUploadResult,
  Database,
  EmailTemplate,
  Identity,
  JobRequest,
  JobResult,
  Jobs,
  Modules,
  ObjectKey,
  ObjectStorage,
  PutOptions,
  ReadGrantBody,
  Schedules,
  SecretsAndEmail,
  SignedPart,
  SignReadInput,
  StartUploadInput,
  StorageUpload,
} from "../src/platform/index.ts";

/** Like session E's and F's StorageError. */
export class StorageError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "StorageError";
    this.status = status;
  }
}

/** The token is "Bearer <userId> <accountType>". No header, or a bad one, is no caller. */
export const fakeIdentity: Identity = {
  async whoIs(request: Request): Promise<Caller | null> {
    const m = /^Bearer ([0-9a-f-]{36}) ([a-z_]+)$/.exec(request.headers.get("authorization") ?? "");
    return m ? { userId: m[1], accountType: m[2] as AccountType } : null;
  },
};

export const PART_SIZE = 8 * 1024 * 1024;

interface FakeUpload {
  key: ObjectKey;
  sizeBytes: number;
  format: string;
  expiresAt: string;
}

/** In-memory storage. `method` picks Supabase's tus or AWS's s3_multipart shape. */
export class FakeStorage implements ObjectStorage {
  method: "tus" | "s3_multipart";
  uploads = new Map<string, FakeUpload>();
  objects = new Map<ObjectKey, Uint8Array>();
  deleted: string[] = [];
  signedReads: SignReadInput[] = [];
  confirms: ConfirmUploadInput[] = [];
  /** Over this, startUpload throws status 413, as on a free Supabase project. */
  sizeLimit = Number.POSITIVE_INFINITY;
  /** What the next confirmUpload says. */
  confirmResult: ConfirmUploadResult = { ok: true };
  failDelete = false;
  private next = 0;

  constructor(method: "tus" | "s3_multipart" = "tus") {
    this.method = method;
  }

  private session(id: string, u: FakeUpload, offset: number): StorageUpload {
    if (this.method === "tus") {
      return {
        method: "tus",
        providerUploadId: id,
        endpoint: "https://storage.example.invalid/upload/resumable",
        headers: { "x-signature": "fake" },
        offset,
        expiresAt: u.expiresAt,
      };
    }
    const partCount = Math.max(1, Math.ceil(u.sizeBytes / PART_SIZE));
    return {
      method: "s3_multipart",
      providerUploadId: id,
      partSize: PART_SIZE,
      partCount,
      parts: this.sign(u.key, Array.from({ length: Math.min(partCount, 3) }, (_, i) => i + 1)),
      completedParts: [],
      expiresAt: u.expiresAt,
    };
  }

  private sign(key: ObjectKey, partNumbers: number[]): SignedPart[] {
    return partNumbers.map((n) => ({
      partNumber: n,
      url: `https://s3.example.invalid/${key}?partNumber=${n}`,
      expiresAt: "2030-01-01T00:00:00.000Z",
    }));
  }

  async startUpload(input: StartUploadInput): Promise<StorageUpload> {
    if (input.sizeBytes > this.sizeLimit) {
      throw new StorageError(413, `this deployment takes files up to ${this.sizeLimit} bytes (its plan's file size limit)`);
    }
    const id = `${this.method}-${++this.next}`;
    const u = { key: input.key, sizeBytes: input.sizeBytes, format: input.format, expiresAt: "2030-01-01T00:00:00.000Z" };
    this.uploads.set(id, u);
    return this.session(id, u, 0);
  }

  async getUpload(key: ObjectKey, providerUploadId: string): Promise<StorageUpload> {
    const u = this.uploads.get(providerUploadId) ?? { key, sizeBytes: 1, format: "wav", expiresAt: "2030-01-01T00:00:00.000Z" };
    return this.session(providerUploadId, u, this.objects.has(key) ? u.sizeBytes : 0);
  }

  async signParts(key: ObjectKey, _providerUploadId: string, partNumbers: number[]): Promise<SignedPart[]> {
    if (this.method === "tus") throw new Error("signParts is for s3_multipart; Supabase uploads use tus");
    return this.sign(key, partNumbers);
  }

  async confirmUpload(input: ConfirmUploadInput): Promise<ConfirmUploadResult> {
    this.confirms.push(input);
    return this.confirmResult;
  }

  async readHead(key: ObjectKey, maxBytes: number): Promise<Uint8Array> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new StorageError(404, `no object at ${key}`);
    return bytes.slice(0, maxBytes);
  }

  async read(key: ObjectKey): Promise<ReadableStream<Uint8Array>> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new StorageError(404, `no object at ${key}`);
    const copy = bytes.slice();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(copy);
        controller.close();
      },
    });
  }

  async put(key: ObjectKey, body: ReadableStream<Uint8Array>, options: PutOptions): Promise<void> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    if (size !== options.sizeBytes) throw new Error(`put: the body was ${size} bytes, not ${options.sizeBytes}`);
    const out = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    this.objects.set(key, out);
  }

  async signRead(input: SignReadInput): Promise<ReadGrantBody> {
    if (input.key.startsWith("masters/")) throw new Error("signRead never signs a master");
    this.signedReads.push(input);
    if (this.method === "tus") {
      return { method: "signed_url", url: `https://storage.example.invalid/${input.key}?token=fake`, expiresAt: "2030-01-01T00:10:00.000Z" };
    }
    return {
      method: "cloudfront_cookies",
      streamUrl: `https://cdn.example.invalid/${input.key}`,
      cookies: [{ name: "CloudFront-Policy", value: "fake" }],
      expiresAt: "2030-01-01T00:10:00.000Z",
    };
  }

  async delete(prefix: ObjectKey): Promise<void> {
    if (this.failDelete) throw new StorageError(500, "delete failed");
    this.deleted.push(prefix);
    for (const key of [...this.objects.keys()]) if (key.startsWith(prefix)) this.objects.delete(key);
  }
}

/** Jobs over the real database: `enqueue` makes the job row with session B's api_create_job. */
export class FakeJobs implements Jobs {
  enqueued: { job: JobRequest; jobId: string }[] = [];
  reported: { jobId: string; result: JobResult }[] = [];
  private database: Database;
  constructor(database: Database) {
    this.database = database;
  }
  async enqueue(job: JobRequest): Promise<{ jobId: string }> {
    const [row] = await this.database.query<{ id: string }>("select public.api_create_job($1::uuid, $2::text)::text as id", [
      job.releaseId,
      job.kind,
    ]);
    this.enqueued.push({ job, jobId: row.id });
    return { jobId: row.id };
  }
  async reportResult(jobId: string, result: JobResult): Promise<void> {
    this.reported.push({ jobId, result });
  }
}

export class FakeSchedules implements Schedules {
  set: { name: string; fn: string; args?: Record<string, string | number | boolean | null>; at: Date }[] = [];
  fail = false;
  async runSqlFunctionAt(input: { name: string; fn: string; args?: Record<string, string | number | boolean | null>; at: Date }) {
    if (this.fail) throw new Error("the scheduler is down");
    this.set.push(input);
  }
}

export class FakeEmail implements SecretsAndEmail {
  sent: { template: EmailTemplate; to: string; data: Record<string, string> }[] = [];
  fail = false;
  async getSecret(name: string): Promise<string> {
    throw new Error(`no secret ${name} in tests`);
  }
  async sendTemplate(input: { template: EmailTemplate; to: string; data: Record<string, string> }): Promise<void> {
    if (this.fail) throw new Error("email is down");
    // Session E's templates refuse a missing field; so does this fake.
    const needs: Record<EmailTemplate, string[]> = {
      split_invitation: ["releaseTitle", "artistName", "inviteCode", "expiresAt"],
      review_needs_changes: ["releaseTitle", "reason"],
      release_taken_down: ["releaseTitle", "reason"],
    };
    const missing = needs[input.template].filter((k) => typeof input.data[k] !== "string" || input.data[k] === "");
    if (missing.length) throw new Error(`${input.template} needs ${missing.join(", ")}`);
    this.sent.push(input);
  }
}

export interface FakeModules extends Modules {
  storage: FakeStorage;
  jobs: FakeJobs;
  schedules: FakeSchedules;
  secretsAndEmail: FakeEmail;
}

export function fakeModules(database: Database, method: "tus" | "s3_multipart" = "tus"): FakeModules {
  return {
    database,
    identity: fakeIdentity,
    storage: new FakeStorage(method),
    jobs: new FakeJobs(database),
    schedules: new FakeSchedules(),
    secretsAndEmail: new FakeEmail(),
  };
}
