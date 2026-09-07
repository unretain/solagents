/**
 * Custody for live runs.
 *
 * One internal wallet per user, created the moment they connect, so an address
 * to fund exists before they have decided what to run. Agents trade from it,
 * and a run's bankroll is the cap on what that run may commit.
 *
 * It is separate from the wallet they connected with on purpose. We never hold
 * the key to the wallet somebody signs in with; this one exists only to be
 * funded deliberately, and its balance is the entire amount at risk.
 *
 * The secret key is encrypted at rest with AES-256-GCM under LIVE_WALLET_KEY,
 * which exists only in the server environment. A dump of the database is not
 * enough to move money. GCM rather than CBC because it authenticates: a
 * tampered ciphertext fails to decrypt instead of yielding a different key.
 *
 * No function here returns a secret key, and none accepts a destination from a
 * caller. Withdrawals go to the wallet that created the run and nowhere else.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey,
  SystemProgram, Transaction,
} from "@solana/web3.js";
import { q } from "../db.js";

/** Our own validator. No rate limit, and the lowest latency available to us. */
const RPC = process.env.SOLANA_RPC || "http://127.0.0.1:8899";

export const connection = new Connection(RPC, "confirmed");

function encryptionKey(): Buffer {
  const hex = (process.env.LIVE_WALLET_KEY || "").trim();
  if (!hex) throw new Error("LIVE_WALLET_KEY is not set - live trading is disabled");
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) throw new Error("LIVE_WALLET_KEY must be 32 bytes of hex (64 characters)");
  return key;
}

/** True when the server is configured to hold funds at all. */
export function liveEnabled(): boolean {
  try { encryptionKey(); return true; } catch { return false; }
}

function encrypt(secret: Uint8Array): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const body = Buffer.concat([c.update(Buffer.from(secret)), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}

function decrypt(blob: string): Uint8Array {
  const [iv, tag, body] = blob.split(":");
  const d = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return new Uint8Array(Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]));
}

/**
 * The signer for a run.
 *
 * Exported for execute.ts only, which needs it to sign swaps. It is addressed
 * by account and nothing else: there is no way to ask for "the key for this
 * public address", so a caller can only sign for an account it already
 * authenticated as.
 */
export async function signerForOwner(ownerId: string): Promise<Keypair> {
  const [row] = await q<{ secret_enc: string }>(
    `SELECT secret_enc FROM sa_wallet WHERE owner_id = $1`, [ownerId],
  );
  if (!row) throw new Error("no wallet for this account");
  return Keypair.fromSecretKey(decrypt(row.secret_enc));
}

/**
 * The account's wallet, created on first sight. Returns only the address.
 *
 * ON CONFLICT DO NOTHING plus a re-read, rather than "check then insert": two
 * sign-ins arriving together would both see no row and both generate a keypair,
 * and the loser's would be the one the user was shown and might have funded.
 */
export async function ensureWallet(ownerId: string): Promise<string> {
  const kp = Keypair.generate();
  await q(
    `INSERT INTO sa_wallet (owner_id, pubkey, secret_enc) VALUES ($1,$2,$3)
     ON CONFLICT (owner_id) DO NOTHING`,
    [ownerId, kp.publicKey.toBase58(), encrypt(kp.secretKey)],
  );
  const [row] = await q<{ pubkey: string }>(
    `SELECT pubkey FROM sa_wallet WHERE owner_id = $1`, [ownerId],
  );
  return row.pubkey;
}

export interface WalletView {
  pubkey: string;
  lamports: number;
  sol: number;
}

export async function walletFor(ownerId: string): Promise<WalletView | null> {
  const [row] = await q<{ pubkey: string }>(
    `SELECT pubkey FROM sa_wallet WHERE owner_id = $1`, [ownerId],
  );
  if (!row) return null;
  const lamports = await connection.getBalance(new PublicKey(row.pubkey));
  return { pubkey: row.pubkey, lamports, sol: lamports / LAMPORTS_PER_SOL };
}

/**
 * Rent exemption for an empty account, left behind on a full withdrawal.
 *
 * Solana deletes an account that drops below this, and a deleted account cannot
 * receive the change from an in-flight trade. Sweeping to exactly zero is how
 * bots lose the last transfer, so the floor stays.
 */
const RENT_FLOOR = 890_880;

/** Fee for the one transfer we are about to send, plus a margin. */
const FEE_BUFFER = 10_000;

/**
 * Move funds out, to the connected wallet only.
 *
 * The destination is not a parameter: it is the account id, which IS the
 * Solana address the user signed in with. Someone holding a stolen session can
 * therefore only send the money to the wallet they already control, which makes
 * a stolen session useless for theft.
 */
export async function withdraw(ownerId: string, lamports?: number): Promise<{
  signature: string; lamports: number;
}> {
  const [row] = await q<{ pubkey: string }>(
    `SELECT pubkey FROM sa_wallet WHERE owner_id = $1`, [ownerId],
  );
  if (!row) throw new Error("no wallet for this account");

  const balance = await connection.getBalance(new PublicKey(row.pubkey));
  const spendable = balance - RENT_FLOOR - FEE_BUFFER;
  if (spendable <= 0) throw new Error("nothing to withdraw");
  const amount = lamports ? Math.min(lamports, spendable) : spendable;

  const signer = await signerForOwner(ownerId);
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: signer.publicKey,
    toPubkey: new PublicKey(ownerId),
    lamports: amount,
  }));
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;
  tx.sign(signer);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false, maxRetries: 3,
  });
  await q(
    `INSERT INTO sa_withdrawal (id, owner_id, to_pubkey, lamports, signature)
     VALUES ($1,$2,$3,$4,$5)`,
    [`wd_${randomBytes(8).toString("hex")}`, ownerId, ownerId, amount, signature],
  );
  return { signature, lamports: amount };
}
