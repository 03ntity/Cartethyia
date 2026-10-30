/**
 * Extracts the Qoder UMID `runtime-info` Linux x86-64 binary from the
 * `@qoder-ai/qodercli` npm package into `vendor/qoder-umid/`.
 *
 * The official CLI package embeds the native bridge as long base64 blobs inside
 * `package/bundle/qoder-worker-runtime.mjs`. We pick the `elf-x86_64` blob
 * (identified via magic bytes) because the gateway's first-class deployment
 * target is Linux. Run from the repo root:
 *
 *   bun run scripts/tools/extract-qoder-umid.ts
 *
 * The output is idempotent: the file is only rewritten when its content
 * changes (atomic replace + chmod 755).
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const REGISTRY_URL = "https://registry.npmjs.org/@qoder-ai/qodercli/latest";
const BUNDLE_MEMBER = "package/bundle/qoder-worker-runtime.mjs";
const TARGET = join(process.cwd(), "vendor", "qoder-umid", "runtime-info");
const MIN_BLOB = 4000;

async function fetchLatestMetadata(): Promise<{ version: string; tarball: string; sha512: string }> {
  const res = await fetch(REGISTRY_URL);
  if (!res.ok) throw new Error(`registry responded ${res.status}`);
  const meta = await res.json() as { version: string; dist: { tarball: string; integrity: string } };
  return { version: meta.version, tarball: meta.dist.tarball, sha512: meta.dist.integrity };
}

async function fetchTarball(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`tarball responded ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function extractBundle(tgz: Uint8Array): Promise<string> {
  // Bun's built-in gunzip; the tarball is a single gzip stream.
  const inflated = gunzipSync(Buffer.from(tgz));
  // Tarball is a concatenation of 512-byte headers + payloads; we only need
  // the member named BUNDLE_MEMBER. Parse the ustar header minimally.
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 512 <= inflated.length) {
    const header = inflated.subarray(offset, offset + 512);
    const name = decoder.decode(header.subarray(0, 100)).split("\0")[0] ?? "";
    if (name.length === 0) break;
    const sizeField = decoder.decode(header.subarray(124, 136)).replace(/[^0-9]/g, "");
    const size = parseInt(sizeField || "0", 8);
    const payloadStart = offset + 512;
    const payloadEnd = payloadStart + size;
    if (name === BUNDLE_MEMBER) {
      return decoder.decode(inflated.subarray(payloadStart, payloadEnd));
    }
    const padded = Math.ceil(size / 512) * 512;
    offset = payloadStart + padded;
  }
  throw new Error("bundle member not found in tarball");
}

function scanBlobCandidates(text: string): { index: number; data: Uint8Array }[] {
  const out: { index: number; data: Uint8Array }[] = [];
  // Long base64 literals appear as quoted strings; scan for runs of base64.
  const re = /"([A-Za-z0-9+/=]{4000,})"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    try {
      const data = Buffer.from(match[1]!, "base64");
      if (data.length >= MIN_BLOB) out.push({ index: out.length, data });
    } catch {
      // not valid base64; skip
    }
  }
  return out;
}

function isElfX64(data: Uint8Array): boolean {
  if (data.length < 20) return false;
  if (data[0] !== 0x7f || data[1] !== 0x45 || data[2] !== 0x4c || data[3] !== 0x46) return false;
  // EI_CLASS=2 (64-bit), EI_DATA=1 (LSB) -> e_machine at offset 18 (0x3E = x86-64)
  return data[4] === 2 && data[5] === 1 && data[18] === 0x3e && data[19] === 0x00;
}

async function main(): Promise<void> {
  console.log("[extract-qoder-umid] fetching latest @qoder-ai/qodercli metadata...");
  const meta = await fetchLatestMetadata();
  console.log(`[extract-qoder-umid] version ${meta.version}, tarball ${meta.tarball}`);
  const tgz = await fetchTarball(meta.tarball);
  console.log(`[extract-qoder-umid] tarball ${(tgz.length / 1e6).toFixed(1)} MB`);
  const bundle = await extractBundle(tgz);
  console.log(`[extract-qoder-umid] bundle ${(bundle.length / 1e6).toFixed(1)} MB, scanning blobs...`);
  const candidates = scanBlobCandidates(bundle);
  console.log(`[extract-qoder-umid] found ${candidates.length} candidate blobs`);
  const elf = candidates.find((c) => isElfX64(c.data));
  if (!elf) throw new Error("no elf-x86_64 blob found in bundle");
  const sha = createHash("sha256").update(elf.data).digest("hex");
  console.log(`[extract-qoder-umid] elf-x86_64 blob ${elf.data.length} bytes, sha256 ${sha}`);
  const tmp = join(tmpdir(), `qoder-umid-${process.pid}.bin`);
  writeFileSync(tmp, elf.data);
  chmodSync(tmp, 0o755);
  const changed = !existsSync(TARGET) || !Buffer.from(elf.data).equals(readFileSync(TARGET));
  if (changed) {
    renameSync(tmp, TARGET);
    console.log(`[extract-qoder-umid] wrote ${TARGET}`);
  } else {
    rmSync(tmp);
    console.log(`[extract-qoder-umid] ${TARGET} unchanged`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
