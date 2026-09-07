/**
 * Real fills.
 *
 * Routing goes through Jupiter, which quotes across the pump.fun bonding curve
 * and the AMMs a graduated coin moves to. Writing our own curve maths would
 * mean re-deriving it every time pump.fun changes, and getting it subtly wrong
 * costs real money rather than a failed test.
 *
 * The transaction is SENT through our own validator. That is the one part of
 * this that a hosted bot cannot copy: the node that told us about the launch is
 * the node that submits the buy, so there is no public RPC queue in between.
 *
 * Every function here takes an account id and derives the signer from it. None
 * accepts a keypair, so no caller can trade with a wallet it was not
 * authenticated as.
 */
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { connection, signerForOwner } from "./wallet.js";

const JUP = process.env.JUPITER_API || "https://lite-api.jup.ag/swap/v1";
export const WSOL = "So11111111111111111111111111111111111111112";

export interface Quote {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: unknown[];
  [k: string]: unknown;
}

/**
 * Slippage is a cap, not a target.
 *
 * These coins move several percent inside one second, so a tight cap does not
 * get a better price - it gets no fill, after the quote has already gone stale.
 * The backtester charges 2-5% round trip, so accepting up to 3% on a leg keeps
 * live costs inside what the backtest assumed rather than flattering it.
 */
const DEFAULT_SLIPPAGE_BPS = 300;

export async function quote(
  inputMint: string, outputMint: string, amount: number, slippageBps = DEFAULT_SLIPPAGE_BPS,
): Promise<Quote> {
  const u = new URL(`${JUP}/quote`);
  u.searchParams.set("inputMint", inputMint);
  u.searchParams.set("outputMint", outputMint);
  u.searchParams.set("amount", String(Math.floor(amount)));
  u.searchParams.set("slippageBps", String(slippageBps));
  // Direct routes only. A multi-hop route through an illiquid memecoin is where
  // the quoted price and the filled price diverge most.
  u.searchParams.set("onlyDirectRoutes", "true");

  const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`no route (${r.status})`);
  const j = (await r.json()) as Quote;
  if (!j.outAmount || j.outAmount === "0") throw new Error("no route");
  return j;
}

export interface FillResult {
  signature: string;
  inAmount: number;
  outAmount: number;
  priceImpactPct: number;
}

/**
 * Execute a quote and wait for it to land.
 *
 * Confirmation is not optional here. A signature is a receipt that the network
 * ACCEPTED the transaction, not that it succeeded - recording a position from
 * the signature alone is how a bot ends up believing it holds a coin it never
 * bought.
 */
export async function swap(ownerId: string, q: Quote): Promise<FillResult> {
  const signer = await signerForOwner(ownerId);

  const r = await fetch(`${JUP}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: q,
      userPublicKey: signer.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      // Pay for priority. On a launch the difference between landing in this
      // block and the next one is most of the move.
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: {
        maxLamports: 1_000_000, priorityLevel: "high",
      } },
      dynamicComputeUnitLimit: true,
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!r.ok) throw new Error(`swap build failed (${r.status})`);
  const { swapTransaction } = (await r.json()) as { swapTransaction: string };

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([signer]);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,          // the quote already simulated it; preflight costs a round trip
    maxRetries: 3,
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const done = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight }, "confirmed",
  );
  if (done.value.err) throw new Error(`transaction failed on chain: ${JSON.stringify(done.value.err)}`);

  return {
    signature,
    inAmount: Number(q.inAmount),
    outAmount: Number(q.outAmount),
    priceImpactPct: Number(q.priceImpactPct ?? 0),
  };
}

/** Buy `mint` with `lamports` of SOL. */
export async function buy(ownerId: string, mint: string, lamports: number): Promise<FillResult> {
  return swap(ownerId, await quote(WSOL, mint, lamports));
}

/**
 * Sell the whole position.
 *
 * The size comes from the chain, not from our own accounting. A partial fill, a
 * transfer fee or a rounding difference all leave the real balance below what
 * our books say, and a sell for more than is held simply fails.
 */
export async function sellAll(ownerId: string, mint: string): Promise<FillResult | null> {
  const signer = await signerForOwner(ownerId);
  const accounts = await connection.getParsedTokenAccountsByOwner(
    signer.publicKey, { mint: new PublicKey(mint) },
  );
  const raw = accounts.value[0]?.account.data.parsed.info.tokenAmount.amount;
  const held = Number(raw ?? 0);
  if (!held) return null;
  return swap(ownerId, await quote(mint, WSOL, held));
}
