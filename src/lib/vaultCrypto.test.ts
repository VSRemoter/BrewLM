import { describe, expect, it } from "vitest";
import {
  createEnvelope,
  decryptBlob,
  decryptRecord,
  deriveKeys,
  encryptBlob,
  encryptRecord,
  formatLinkCode,
  formatRecoveryKey,
  hiddenId,
  linkId,
  linkUri,
  newLinkSecret,
  openLink,
  parseLink,
  sealForLink,
  type Kdf,
  newRecoveryKey,
  newVaultKey,
  parseRecoveryKey,
  rewrapPassword,
  rewrapRecovery,
  unlockWithPassword,
  unlockWithRecovery,
  WrongSecretError,
} from "./vaultCrypto";

// Small Argon2 cost so the suite stays fast; the format is the same.
const FAST: Kdf = { alg: "argon2id", m: 256, t: 1, p: 1 };

describe("records and blobs", () => {
  it("round-trips and binds ciphertext to its server key", async () => {
    const keys = await deriveKeys(newVaultKey());
    const key = await hiddenId(keys, "notebooks:abc");
    const payload = await encryptRecord(keys, key, '{"title":"Poker Theory"}');
    expect(payload.startsWith("e1.")).toBe(true);
    expect(payload).not.toContain("Poker");
    expect(await decryptRecord(keys, key, payload)).toBe('{"title":"Poker Theory"}');
    // The same ciphertext stored under another record's key is rejected.
    const other = await hiddenId(keys, "notebooks:xyz");
    await expect(decryptRecord(keys, other, payload)).rejects.toBeInstanceOf(WrongSecretError);
  });

  it("rejects tampering and other vaults' keys", async () => {
    const keys = await deriveKeys(newVaultKey());
    const key = await hiddenId(keys, "chats:1");
    const payload = await encryptRecord(keys, key, "hello");
    const flipped = payload.slice(0, -4) + (payload.endsWith("AAAA") ? "BBBB" : "AAAA");
    await expect(decryptRecord(keys, key, flipped)).rejects.toBeInstanceOf(WrongSecretError);
    const stranger = await deriveKeys(newVaultKey());
    await expect(decryptRecord(stranger, key, payload)).rejects.toBeInstanceOf(WrongSecretError);
  });

  it("hides names deterministically per vault", async () => {
    const vk = newVaultKey();
    const a = await hiddenId(await deriveKeys(vk), "file.m4a");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hiddenId(await deriveKeys(vk), "file.m4a")).toBe(a);
    expect(await hiddenId(await deriveKeys(newVaultKey()), "file.m4a")).not.toBe(a);
  });

  it("round-trips files", async () => {
    const keys = await deriveKeys(newVaultKey());
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) & 255);
    const sealed = await encryptBlob(keys, "id1", bytes);
    expect(sealed.length).toBe(bytes.length + 1 + 12 + 16);
    expect(await decryptBlob(keys, "id1", sealed)).toEqual(bytes);
    await expect(decryptBlob(keys, "id2", sealed)).rejects.toBeInstanceOf(WrongSecretError);
  });
});

describe("envelope", () => {
  it("unlocks with the password or the recovery key, and nothing else", async () => {
    const vk = newVaultKey();
    const rk = newRecoveryKey();
    const env = await createEnvelope(vk, "correct horse battery", rk, FAST);
    expect(JSON.stringify(env)).not.toContain("correct horse");
    expect(await unlockWithPassword(env, "correct horse battery")).toEqual(vk);
    await expect(unlockWithPassword(env, "wrong horse battery")).rejects.toBeInstanceOf(WrongSecretError);
    // Typed casually: lower case, spaces instead of dashes, l for 1.
    const typed = formatRecoveryKey(rk).toLowerCase().replace(/-/g, " ").replace(/1/g, "l");
    expect(await unlockWithRecovery(env, typed)).toEqual(vk);
    await expect(unlockWithRecovery(env, formatRecoveryKey(newRecoveryKey()))).rejects.toBeInstanceOf(
      WrongSecretError
    );
  });

  it("changes the password or recovery key without changing the vault key", async () => {
    const vk = newVaultKey();
    const rk = newRecoveryKey();
    const env = await createEnvelope(vk, "first password!", rk, FAST);
    const env2 = await rewrapPassword(env, vk, "second password!");
    expect(env2.kdf.salt).not.toBe(env.kdf.salt);
    expect(await unlockWithPassword(env2, "second password!")).toEqual(vk);
    await expect(unlockWithPassword(env2, "first password!")).rejects.toBeInstanceOf(WrongSecretError);
    expect(await unlockWithRecovery(env2, formatRecoveryKey(rk))).toEqual(vk);

    const rk2 = newRecoveryKey();
    const env3 = await rewrapRecovery(env2, vk, rk2);
    expect(await unlockWithRecovery(env3, formatRecoveryKey(rk2))).toEqual(vk);
    await expect(unlockWithRecovery(env3, formatRecoveryKey(rk))).rejects.toBeInstanceOf(WrongSecretError);
  });
});

describe("recovery key text", () => {
  it("is 40 characters in groups of five and round-trips", () => {
    const rk = newRecoveryKey();
    const text = formatRecoveryKey(rk);
    expect(text).toMatch(/^([0-9A-HJKMNP-TV-Z]{5}-){7}[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(parseRecoveryKey(text)).toEqual(rk);
    expect(parseRecoveryKey("too short")).toBeNull();
    expect(parseRecoveryKey(text.replace(/.$/, "U"))).toBeNull(); // U isn't in the alphabet
  });
});

describe("device links", () => {
  it("hands the vault key over with the secret, and only with it", async () => {
    const vk = newVaultKey();
    const secret = newLinkSecret();
    const sealed = await sealForLink(secret, vk);
    expect(await openLink(secret, sealed)).toEqual(vk);
    await expect(openLink(newLinkSecret(), sealed)).rejects.toBeInstanceOf(WrongSecretError);
    expect(await linkId(secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(await linkId(secret)).not.toBe(await linkId(newLinkSecret()));
  });

  it("reads a scanned link or a typed code", () => {
    const secret = newLinkSecret();
    expect(parseLink(linkUri("my-vault", secret))).toEqual({ vault: "my-vault", secret });
    const typed = formatLinkCode(secret).toLowerCase().replace(/-/g, " ");
    expect(parseLink(typed)).toEqual({ vault: null, secret });
    expect(formatLinkCode(secret)).toHaveLength(52 + 10); // 52 characters + dashes
    expect(parseLink("brewlm-link:1:v:TOOSHORT")).toBeNull();
    expect(parseLink("hello")).toBeNull();
  });
});
