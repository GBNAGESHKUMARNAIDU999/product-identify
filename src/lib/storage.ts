import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

// Object-storage abstraction. Dev/local driver writes to .data/storage on disk.
// Swap `putObject`/`getObject` for S3 SDK calls in production (see DECISIONS.md).

const ROOT = path.join(process.cwd(), ".data", "storage");

function safeKey(key: string): string {
  // Prevent path traversal; keys are generated internally but validate anyway.
  const norm = path.normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
  if (norm.includes("..")) throw new Error("invalid storage key");
  return norm;
}

export async function putObject(key: string, data: Buffer): Promise<string> {
  const full = path.join(ROOT, safeKey(key));
  await fs.mkdir(path.dirname(full), { recursive: true });
  // Write bytes verbatim — no re-encoding, ever (constraint #2).
  await fs.writeFile(full, data);
  return key;
}

export async function getObject(key: string): Promise<Buffer> {
  return fs.readFile(path.join(ROOT, safeKey(key)));
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await fs.access(path.join(ROOT, safeKey(key)));
    return true;
  } catch {
    return false;
  }
}

export function newKey(prefix: string, ext = "bin"): string {
  return `${prefix}/${crypto.randomUUID()}.${ext}`;
}

export function contentTypeFor(filenameOrKey: string): string {
  const ext = filenameOrKey.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png": return "image/png";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "bmp": return "image/bmp";
    case "svg": return "image/svg+xml";
    default: return "image/jpeg";
  }
}
