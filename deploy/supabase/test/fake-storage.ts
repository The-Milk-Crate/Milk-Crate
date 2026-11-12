// Test only: an in-memory Supabase Storage, at its HTTP edge, with the routes the storage
// module and a TUS client use. It checks the secret key on server routes and the signed upload
// token on TUS routes, as Supabase does.

export const BASE = "https://abcd.supabase.co";
export const SERVICE_KEY = "sb_secret_test_only";
export const PUBLISHABLE_KEY = "sb_publishable_test_only";

interface Obj { bytes: Uint8Array; modified: number; contentType: string }
interface Upload { bucket: string; key: string; length: number; bytes: number[]; contentType: string; gone: boolean }

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

export function fakeStorage(limits: Record<string, { max: number | null; mimes: string[] | null }>) {
  const objects = new Map<string, Obj>(); // "bucket/key"
  const uploads = new Map<string, Upload>();
  const tokens = new Map<string, { bucket: string; key: string; exp: number }>();
  const requests: { method: string; path: string; headers: Record<string, string> }[] = [];
  let n = 0;

  const serverAuth = (req: Request) => req.headers.get("apikey") === SERVICE_KEY;
  const tokenFor = (req: Request) => tokens.get(req.headers.get("x-signature") ?? "");
  const deny = () => new Response(JSON.stringify({ message: "denied" }), { status: 403 });

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname.replace(/^\/storage\/v1/, ""));
    requests.push({ method: req.method, path, headers: Object.fromEntries(req.headers) });
    let m: RegExpExecArray | null;

    if (req.method === "POST" && (m = /^\/object\/upload\/sign\/([^/]+)\/(.+)$/.exec(path))) {
      if (!serverAuth(req)) return deny();
      const exp = Math.floor(Date.now() / 1000) + 7200;
      const token = `${b64url({ alg: "HS256" })}.${b64url({ url: `${m[1]}/${m[2]}`, exp })}.sig${++n}`;
      tokens.set(token, { bucket: m[1], key: m[2], exp });
      return Response.json({ url: `/object/upload/sign/${m[1]}/${m[2]}?token=${token}` });
    }

    if (req.method === "POST" && path === "/upload/resumable/sign") {
      const t = tokenFor(req);
      if (!t) return deny();
      const meta = Object.fromEntries(
        (req.headers.get("upload-metadata") ?? "").split(",").map((p) => {
          const [k, v] = p.trim().split(" ");
          return [k, Buffer.from(v ?? "", "base64").toString()];
        }),
      );
      if (meta.bucketName !== t.bucket || meta.objectName !== t.key) return deny();
      const length = Number(req.headers.get("upload-length"));
      const limit = limits[t.bucket];
      if (limit.max !== null && length > limit.max) return new Response("too large", { status: 413 });
      if (limit.mimes && !limit.mimes.includes(meta.contentType)) return new Response("bad type", { status: 415 });
      const id = `u${++n}`;
      uploads.set(id, { bucket: t.bucket, key: t.key, length, bytes: [], contentType: meta.contentType, gone: false });
      return new Response(null, { status: 201, headers: { location: `/storage/v1/upload/resumable/sign/${id}` } });
    }

    if ((m = /^\/upload\/resumable\/sign\/([^/]+)$/.exec(path))) {
      const u = uploads.get(m[1]);
      const t = tokenFor(req);
      if (!u || u.gone) return new Response(null, { status: 404 });
      if (!t || t.bucket !== u.bucket || t.key !== u.key) return deny();
      if (req.method === "HEAD") {
        return new Response(null, { status: 200, headers: { "upload-offset": String(u.bytes.length), "upload-length": String(u.length) } });
      }
      if (req.method === "PATCH") {
        if (Number(req.headers.get("upload-offset")) !== u.bytes.length) return new Response("offset", { status: 409 });
        const chunk = new Uint8Array(await req.arrayBuffer());
        if (u.bytes.length + chunk.length > u.length) return new Response("too long", { status: 400 });
        u.bytes.push(...chunk);
        if (u.bytes.length === u.length) {
          objects.set(`${u.bucket}/${u.key}`, { bytes: Uint8Array.from(u.bytes), modified: Date.now(), contentType: u.contentType });
        }
        return new Response(null, { status: 204, headers: { "upload-offset": String(u.bytes.length) } });
      }
    }

    if ((m = /^\/object\/authenticated\/([^/]+)\/(.+)$/.exec(path))) {
      if (!serverAuth(req)) return deny();
      const o = objects.get(`${m[1]}/${m[2]}`);
      if (!o) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
      const headers = { "content-length": String(o.bytes.length), "last-modified": new Date(o.modified).toUTCString() };
      if (req.method === "HEAD") return new Response(null, { status: 200, headers });
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("range") ?? "");
      if (!range) return new Response(o.bytes.slice() as Uint8Array<ArrayBuffer>, { status: 200, headers });
      const part = o.bytes.slice(Number(range[1]), Number(range[2]) + 1) as Uint8Array<ArrayBuffer>;
      return new Response(part, { status: 206, headers: { "content-length": String(part.length) } });
    }

    if (req.method === "POST" && (m = /^\/object\/sign\/([^/]+)\/(.+)$/.exec(path))) {
      if (!serverAuth(req)) return deny();
      if (!objects.has(`${m[1]}/${m[2]}`)) return new Response(JSON.stringify({ message: "Object not found" }), { status: 400 });
      const { expiresIn } = await req.json();
      return Response.json({ signedURL: `/object/sign/${m[1]}/${m[2]}?token=read${++n}.${expiresIn}` });
    }

    if (req.method === "POST" && (m = /^\/object\/list\/([^/]+)$/.exec(path))) {
      if (!serverAuth(req)) return deny();
      const { prefix, limit, offset } = await req.json();
      const folder = `${prefix}/`;
      const entries = new Map<string, string | null>();
      for (const k of objects.keys()) {
        const [bucket, ...rest] = k.split("/");
        const key = rest.join("/");
        if (bucket !== m[1] || !key.startsWith(folder)) continue;
        const tail = key.slice(folder.length);
        const slash = tail.indexOf("/");
        if (slash < 0) entries.set(tail, `id-${tail}`);
        else entries.set(tail.slice(0, slash), null);
      }
      const list = [...entries].sort().map(([name, id]) => ({ name, id })).slice(offset, offset + limit);
      return Response.json(list);
    }

    if (req.method === "DELETE" && (m = /^\/object\/([^/]+)$/.exec(path))) {
      if (!serverAuth(req)) return deny();
      const { prefixes } = await req.json();
      for (const p of prefixes as string[]) objects.delete(`${m[1]}/${p}`);
      return Response.json([]);
    }

    return new Response(`no route ${req.method} ${path}`, { status: 501 });
  }

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init))) as typeof fetch;
  return { fetch: fetchFn, objects, uploads, requests, tokens };
}

/** A TUS client: PATCHes `bytes` from `from` to `to` with the session's endpoint and headers. */
export async function tusSend(
  f: typeof fetch,
  session: { endpoint: string; headers?: Record<string, string> },
  bytes: Uint8Array,
  from: number,
  to = bytes.length,
): Promise<number> {
  const response = await f(session.endpoint, {
    method: "PATCH",
    headers: {
      ...session.headers,
      "tus-resumable": "1.0.0",
      "upload-offset": String(from),
      "content-type": "application/offset+octet-stream",
    },
    body: bytes.slice(from, to),
  });
  if (response.status !== 204) throw new Error(`PATCH failed: ${response.status}`);
  return Number(response.headers.get("upload-offset"));
}
