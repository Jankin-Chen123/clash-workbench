import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";

if (existsSync(resolve(".env"))) process.loadEnvFile?.(resolve(".env"));

export const dataDir = resolve(process.env.DATA_DIR || "data");
mkdirSync(dataDir, { recursive: true });
const keyFile = resolve(dataDir, "encryption.key");
let key = process.env.ENCRYPTION_KEY;
if (!key) {
  if (process.env.NODE_ENV === "production")
    throw new Error("Production requires ENCRYPTION_KEY");
  if (!existsSync(keyFile))
    writeFileSync(keyFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  key = readFileSync(keyFile, "utf8").trim();
}
if (!/^[0-9a-f]{64}$/i.test(key))
  throw new Error("ENCRYPTION_KEY must be 64 hexadecimal characters");
const encryptionKey = Buffer.from(key, "hex");
export const publicUrl = (
  process.env.PUBLIC_URL || "http://localhost:5173"
).replace(/\/$/, "");
export const secureCookies = new URL(publicUrl).protocol === "https:";

export function encrypt(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function decrypt<T>(value: string): T {
  const buffer = Buffer.from(value, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey,
    buffer.subarray(0, 12),
  );
  decipher.setAuthTag(buffer.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      decipher.update(buffer.subarray(28)),
      decipher.final(),
    ]).toString(),
  );
}

export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
