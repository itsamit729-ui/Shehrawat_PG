import { createHash, createHmac } from "node:crypto";
import type { StorageProvider } from "./index.js";

const hmac = (key: string | Buffer, text: string) => createHmac("sha256", key).update(text).digest();
const encode = (text: string) =>
  encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface PresignInput {
  method: "GET" | "PUT" | "HEAD" | "DELETE";
  host: string;
  path: string;
  region: string;
  accessKey: string;
  secretKey: string;
  seconds: number;
  now?: Date;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

/** AWS Signature Version 4 query signing, which S3-compatible stores accept. */
export function presignS3(input: PresignInput) {
  const stamp = (input.now ?? new Date()).toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = stamp.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const headers: Record<string, string> = { host: input.host };
  for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = value.trim();
  const names = Object.keys(headers).sort();
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.accessKey}/${scope}`,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": String(input.seconds),
    "X-Amz-SignedHeaders": names.join(";"),
    ...input.query,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encode(k)}=${encode(query[k]!)}`)
    .join("&");
  const path = input.path.split("/").map(encode).join("/");
  const canonical = [
    input.method,
    path,
    canonicalQuery,
    names.map((n) => `${n}:${headers[n]}\n`).join(""),
    names.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretKey}`, day), input.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `https://${input.host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export function createStorage(config: {
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
}): StorageProvider {
  const host = new URL(config.endpoint).host;
  const sign = (method: PresignInput["method"], key: string, seconds: number, extra: Partial<PresignInput> = {}) =>
    presignS3({
      method,
      host,
      path: `/${config.bucket}/${key}`,
      region: config.region,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      seconds,
      ...extra,
    });
  const timeout = () => AbortSignal.timeout(10_000);
  return {
    presignPut: async (key, contentType, seconds) =>
      sign("PUT", key, seconds, { headers: { "content-type": contentType } }),
    presignGet: async (key, seconds, fileName) =>
      sign("GET", key, seconds, {
        query: { "response-content-disposition": `attachment; filename="${fileName.replace(/[^\w.-]/g, "_")}"` },
      }),
    async head(key) {
      const response = await fetch(sign("HEAD", key, 60), { method: "HEAD", signal: timeout() });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Storage answered ${response.status}`);
      return {
        size: Number(response.headers.get("content-length") ?? 0),
        contentType: response.headers.get("content-type") ?? "",
      };
    },
    async readStart(key, bytes) {
      const response = await fetch(sign("GET", key, 60), {
        headers: { Range: `bytes=0-${bytes - 1}` },
        signal: timeout(),
      });
      if (!response.ok) throw new Error(`Storage answered ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
    async remove(key) {
      const response = await fetch(sign("DELETE", key, 60), { method: "DELETE", signal: timeout() });
      if (!response.ok && response.status !== 404) throw new Error(`Storage answered ${response.status}`);
    },
  };
}
