/**
 * Phantom wallet sign-in.
 *
 * Proving you hold a Solana keypair is a signature check, not a password:
 *   1. server issues a one-time nonce
 *   2. wallet signs it
 *   3. server verifies the ed25519 signature against the claimed pubkey
 *
 * The nonce is what stops a replay - without it, a signature captured once
 * could be resent forever. It is single-use and expires in two minutes.
 *
 * No dependency is added for any of this. Node verifies ed25519 natively once
 * the raw 32-byte key is wrapped in its SPKI DER header, and base58 is 30 lines.
 */
import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as edVerify } from "node:crypto";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58decode(s: string): Buffer {
  const bytes: number[] = [0];
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error("bad base58");
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  // Leading '1's are leading zero bytes.
  for (const ch of s) { if (ch !== "1") break; bytes.push(0); }
  return Buffer.from(bytes.reverse());
}

/** DER header for an Ed25519 SubjectPublicKeyInfo; the raw key follows it. */
const SPKI = Buffer.from("302a300506032b6570032100", "hex");

function verifySignature(pubkeyB58: string, message: string, sigB58: string): boolean {
  try {
    const raw = b58decode(pubkeyB58);
    const sig = b58decode(sigB58);
    if (raw.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({
      key: Buffer.concat([SPKI, raw]), format: "der", type: "spki",
    });
    return edVerify(null, Buffer.from(message, "utf8"), key, sig);
  } catch {
    return false;
  }
}

// ── nonces ────────────────────────────────────────────────────────
const nonces = new Map<string, number>();

export function issueNonce(): string {
  const nonce = randomBytes(18).toString("base64url");
  nonces.set(nonce, Date.now() + 120_000);
  if (nonces.size > 5000) {
    for (const [k, exp] of nonces) if (exp < Date.now()) nonces.delete(k);
  }
  return nonce;
}

function burnNonce(nonce: string): boolean {
  const exp = nonces.get(nonce);
  if (!exp || exp < Date.now()) return false;
  nonces.delete(nonce); // single use
  return true;
}

export function messageFor(nonce: string): string {
  // Shown verbatim in the Phantom prompt, so it has to read like a sentence a
  // person can consent to - not an opaque blob.
  return `Sign in to Pump Lab.\n\nThis proves you own this wallet. It authorises no transaction and moves no funds.\n\nNonce: ${nonce}`;
}

// ── sessions ──────────────────────────────────────────────────────
/**
 * Session signing key.
 *
 * There is deliberately no default. A fallback constant in a public repository
 * is not a fallback, it is a published signing key: anyone could mint a session
 * for any wallet and appear on the leaderboard as its owner. Development gets a
 * random key per process instead, which costs a re-login on restart and cannot
 * be known off the machine.
 */
const SECRET = (() => {
  const configured = process.env.AUTH_SECRET || process.env.INTERNAL_API_KEY;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET (or INTERNAL_API_KEY) must be set in production");
  }
  console.warn("[auth] no AUTH_SECRET - using a random per-process key; sessions end on restart");
  return randomBytes(32).toString("hex");
})();
const TTL_MS = 30 * 24 * 3600 * 1000;

function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

/** `<pubkey>.<expiry>.<hmac>` - stateless, so restarts do not sign everyone out. */
export function issueSession(pubkey: string): string {
  const payload = `${pubkey}.${Date.now() + TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

export function readSession(token: string | undefined): string | null {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const payload = token.slice(0, i);
  const mac = token.slice(i + 1);
  const want = sign(payload);
  // timingSafeEqual throws on length mismatch, which is itself a signal.
  if (mac.length !== want.length) return null;
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  const [pubkey, expStr] = payload.split(".");
  if (!pubkey || Number(expStr) < Date.now()) return null;
  return pubkey;
}

export interface VerifyInput { pubkey: string; signature: string; nonce: string }

export function verifyWallet(v: VerifyInput): { ok: true; token: string } | { ok: false; error: string } {
  if (!burnNonce(v.nonce)) return { ok: false, error: "nonce expired or already used" };
  if (!verifySignature(v.pubkey, messageFor(v.nonce), v.signature)) {
    return { ok: false, error: "signature does not match that wallet" };
  }
  return { ok: true, token: issueSession(v.pubkey) };
}
