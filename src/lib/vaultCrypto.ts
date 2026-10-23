/**
 * End-to-end encryption for BrewLM Sync.
 *
 * One random 256-bit VAULT KEY protects a user's whole library. Three keys are
 * derived from it with HKDF-SHA256:
 *   - records: AES-256-GCM for every synced row
 *   - blobs:   AES-256-GCM for media files and oversized records
 *   - ids:     HMAC-SHA256 that hides server-side names, so the server can't
 *              tell which table/row a record is, or recognise a file by its
 *              content hash
 * Each ciphertext is bound (as AES-GCM associated data) to the id it's stored
 * under, so the server can't swap one record or file for another.
 *
 * The server only ever holds the vault key WRAPPED, in a small "envelope":
 * once under a key derived from the user's password (Argon2id, 64 MiB), and
 * once under the printable recovery key. Either unlocks it; losing both loses
 * the cloud copy (local data is unaffected). What the server still sees:
 * sizes, timing, and random device ids.
 */
import { argon2id } from "hash-wasm";

export interface Kdf {
  alg: "argon2id";
  /** Memory in KiB. */
  m: number;
  t: number;
  p: number;
}

/** ~0.5–1 s on a laptop; stored in the envelope so it can be raised later. */
export const DEFAULT_KDF: Kdf = { alg: "argon2id", m: 64 * 1024, t: 3, p: 1 };

export interface VaultKeys {
  records: CryptoKey;
  blobs: CryptoKey;
  ids: CryptoKey;
}

/** What the server stores to let a device with the password (or recovery key) in. */
export interface Envelope {
  v: 1;
  kdf: Kdf & { salt: string };
  byPassword: string;
  byRecovery: string;
}

/** The password or recovery key didn't unlock the vault (or data was tampered with). */
export class WrongSecretError extends Error {
  constructor() {
    super("That doesn't unlock this vault.");
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const RECORD_PREFIX = "e1.";
const BLOB_VERSION = 1;
const WRAP_AAD = enc.encode("brewlm/v1/vault-key");

/* -------------------------------- bytes ---------------------------------- */

const buf = (b: Uint8Array): BufferSource => b as BufferSource;

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/* --------------------------------- keys ---------------------------------- */

export function newVaultKey(): Uint8Array {
  return randomBytes(32);
}

export async function deriveKeys(vaultKey: Uint8Array): Promise<VaultKeys> {
  const base = await crypto.subtle.importKey("raw", buf(vaultKey), "HKDF", false, ["deriveKey"]);
  const derive = (info: string, alg: AesKeyGenParams | HmacKeyGenParams, usages: KeyUsage[]) =>
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode(info) },
      base,
      alg,
      false,
      usages
    );
  const aes: AesKeyGenParams = { name: "AES-GCM", length: 256 };
  return {
    records: await derive("brewlm/v1/records", aes, ["encrypt", "decrypt"]),
    blobs: await derive("brewlm/v1/blobs", aes, ["encrypt", "decrypt"]),
    ids: await derive("brewlm/v1/ids", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]),
  };
}

async function seal(key: CryptoKey, plain: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(aad) }, key, buf(plain))
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

async function open(key: CryptoKey, sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < 12 + 16) throw new WrongSecretError();
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: buf(sealed.subarray(0, 12)), additionalData: buf(aad) },
        key,
        buf(sealed.subarray(12))
      )
    );
  } catch {
    throw new WrongSecretError();
  }
}

/* ------------------------------ records/blobs ----------------------------- */

/** The server-side name for `label` (a record's `tbl:id`, a file name…): 64 hex chars. */
export async function hiddenId(keys: VaultKeys, label: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", keys.ids, enc.encode(label))));
}

export async function encryptRecord(keys: VaultKeys, serverKey: string, json: string): Promise<string> {
  return RECORD_PREFIX + toBase64(await seal(keys.records, enc.encode(json), enc.encode(serverKey)));
}

export async function decryptRecord(keys: VaultKeys, serverKey: string, payload: string): Promise<string> {
  if (!payload.startsWith(RECORD_PREFIX)) throw new WrongSecretError();
  return dec.decode(await open(keys.records, fromBase64(payload.slice(RECORD_PREFIX.length)), enc.encode(serverKey)));
}

export async function encryptBlob(keys: VaultKeys, id: string, bytes: Uint8Array): Promise<Uint8Array> {
  const sealed = await seal(keys.blobs, bytes, enc.encode(id));
  const out = new Uint8Array(1 + sealed.length);
  out[0] = BLOB_VERSION;
  out.set(sealed, 1);
  return out;
}

export async function decryptBlob(keys: VaultKeys, id: string, bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes[0] !== BLOB_VERSION) throw new WrongSecretError();
  return open(keys.blobs, bytes.subarray(1), enc.encode(id));
}

/* ------------------------------- envelope -------------------------------- */

async function passwordKey(password: string, kdf: Kdf, salt: Uint8Array): Promise<CryptoKey> {
  const raw = await argon2id({
    password: password.normalize("NFC"),
    salt,
    iterations: kdf.t,
    parallelism: kdf.p,
    memorySize: kdf.m,
    hashLength: 32,
    outputType: "binary",
  });
  return crypto.subtle.importKey("raw", buf(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function recoveryKeyKey(recovery: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", buf(recovery), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode("brewlm/v1/recovery") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function createEnvelope(
  vaultKey: Uint8Array,
  password: string,
  recovery: Uint8Array,
  kdf: Kdf = DEFAULT_KDF
): Promise<Envelope> {
  const env = await rewrapPassword(
    { v: 1, kdf: { ...kdf, salt: "" }, byPassword: "", byRecovery: "" },
    vaultKey,
    password,
    kdf
  );
  return rewrapRecovery(env, vaultKey, recovery);
}

export async function unlockWithPassword(env: Envelope, password: string): Promise<Uint8Array> {
  const key = await passwordKey(password, env.kdf, fromBase64(env.kdf.salt));
  return open(key, fromBase64(env.byPassword), WRAP_AAD);
}

export async function unlockWithRecovery(env: Envelope, recoveryText: string): Promise<Uint8Array> {
  const recovery = parseRecoveryKey(recoveryText);
  if (!recovery) throw new WrongSecretError();
  return open(await recoveryKeyKey(recovery), fromBase64(env.byRecovery), WRAP_AAD);
}

/** A new password (fresh salt); the vault key and the recovery key stay the same. */
export async function rewrapPassword(
  env: Envelope,
  vaultKey: Uint8Array,
  password: string,
  kdf: Kdf = env.kdf
): Promise<Envelope> {
  const salt = randomBytes(16);
  const sealed = await seal(await passwordKey(password, kdf, salt), vaultKey, WRAP_AAD);
  return { ...env, kdf: { alg: kdf.alg, m: kdf.m, t: kdf.t, p: kdf.p, salt: toBase64(salt) }, byPassword: toBase64(sealed) };
}

/** A new recovery key; the old one stops working. */
export async function rewrapRecovery(env: Envelope, vaultKey: Uint8Array, recovery: Uint8Array): Promise<Envelope> {
  return { ...env, byRecovery: toBase64(await seal(await recoveryKeyKey(recovery), vaultKey, WRAP_AAD)) };
}

/* ----------------------------- recovery key ------------------------------ */

// Crockford base32: no I, L, O or U, so it reads and types cleanly.
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 200 random bits. */
export function newRecoveryKey(): Uint8Array {
  return randomBytes(25);
}

/** 40 characters in groups of five: `7K3QX-…`. */
export function formatRecoveryKey(key: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of key) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out.match(/.{1,5}/g)!.join("-");
}

/** Accepts any case, spaces or dashes, and the usual look-alikes (I/L → 1, O → 0). */
export function parseRecoveryKey(text: string): Uint8Array | null {
  const clean = text.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  if (clean.length !== 40) return null;
  const out = new Uint8Array(25);
  let bits = 0;
  let value = 0;
  let i = 0;
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out[i++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return out;
}
