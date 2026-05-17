import { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";

dotenv.config();

const SCOUT_TREASURY = process.env.SCOUT_TREASURY_ADDRESS;
if (!SCOUT_TREASURY) {
  throw new Error("SCOUT_TREASURY_ADDRESS missing from environment");
}

export const KITE_TESTNET_TOKEN = "0x9105bc19882d6DBd99a5B14473c654eaBc031FeA";
export const KITE_FACILITATOR_URL = "https://facilitator.pieverse.io";
export const KITE_FACILITATOR_ADDRESS = "0x12343e649e6b2b2b77649DFAb88f103c02F3C78b";

const KITE_SCHEME = "gokite-aa";
const KITE_NETWORK = "kite-testnet";

export const TASK_PRICES: Record<string, string> = {
  verify: "10000000000000000",
  execute: "50000000000000000"
};

// ═══════════════════════════════════════════
// 402 PAYMENT REQUIRED RESPONSE
// ═══════════════════════════════════════════

export function send402(
  res: Response,
  taskType: "verify" | "execute",
  resource: string,
  description: string
): void {
  const amount = TASK_PRICES[taskType];

  res.status(402).json({
    error: "X-PAYMENT header is required",
    accepts: [
      {
        scheme: KITE_SCHEME,
        network: KITE_NETWORK,
        maxAmountRequired: amount,
        resource,
        description,
        mimeType: "application/json",
        outputSchema: {
          input: { discoverable: true, method: "POST", type: "http" },
          output: {
            properties: {
              taskId: { description: "Scout task ID", type: "string" },
              status: { description: "Task dispatch status", type: "string" }
            },
            required: ["taskId", "status"],
            type: "object"
          }
        },
        payTo: SCOUT_TREASURY,
        maxTimeoutSeconds: 300,
        asset: KITE_TESTNET_TOKEN,
        extra: null,
        merchantName: "Scout — Physical World Interface for Agents"
      }
    ],
    x402Version: 1
  });
}

// ═══════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════

export interface KitePaymentPayload {
  authorization: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
    v: number;
    r: string;
    s: string;
  };
  signature: string;
  network: string;
}

export function parseXPayment(header: string): KitePaymentPayload | null {
  try {
    const decoded = Buffer.from(header, "base64").toString("utf8");
    return JSON.parse(decoded) as KitePaymentPayload;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════
// VERIFY PAYMENT — with Pieverse mock fallback
// Pieverse broken on eip155:2368 as of May 12.
// Attempts real verification, falls back to mock
// on failure. Documented in README.
// ═══════════════════════════════════════════

export async function verifyPayment(
  payment: KitePaymentPayload,
  taskType: "verify" | "execute"
): Promise<{ valid: boolean; reason: string; mocked: boolean }> {
  try {
    const response = await fetch(`${KITE_FACILITATOR_URL}/v2/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        authorization: payment.authorization,
        signature: payment.signature,
        network: KITE_NETWORK,
      }),
      signal: AbortSignal.timeout(5000)
    });

    if (response.ok) {
      const result = await response.json() as { valid: boolean; reason?: string };
      console.log(`[x402] Pieverse /v2/verify: ${result.valid ? "valid" : "invalid"}`);
      return { valid: result.valid, reason: result.reason || "Verified", mocked: false };
    }

    // Pieverse returned error — fall through to mock
    console.warn(`[x402] Pieverse /v2/verify returned ${response.status} — using mock settlement. Known infrastructure issue on eip155:2368.`);
    return { valid: true, reason: "mock-pieverse-unavailable", mocked: true };

  } catch (err) {
    // Pieverse unreachable — fall through to mock
    console.warn(`[x402] Pieverse /v2/verify unreachable — using mock settlement: ${String(err)}`);
    return { valid: true, reason: "mock-pieverse-unreachable", mocked: true };
  }
}

// ═══════════════════════════════════════════
// SETTLE PAYMENT — with Pieverse mock fallback
// ═══════════════════════════════════════════

export async function settlePayment(
  payment: KitePaymentPayload
): Promise<{ success: boolean; txHash?: string; error?: string; mocked: boolean }> {
  try {
    const response = await fetch(`${KITE_FACILITATOR_URL}/v2/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        authorization: payment.authorization,
        signature: payment.signature,
        network: KITE_NETWORK
      }),
      signal: AbortSignal.timeout(5000)
    });

    if (response.ok) {
      const result = await response.json() as { txHash: string };
      console.log(`[x402] Pieverse /v2/settle: success txHash=${result.txHash}`);
      return { success: true, txHash: result.txHash, mocked: false };
    }

    // Pieverse returned error — mock settlement
    const mockTxHash = `mock-${Date.now()}-pieverse-unavailable`;
    console.warn(`[x402] Pieverse /v2/settle returned ${response.status} — mock txHash: ${mockTxHash}`);
    return { success: true, txHash: mockTxHash, mocked: true };

  } catch (err) {
    const mockTxHash = `mock-${Date.now()}-pieverse-unreachable`;
    console.warn(`[x402] Pieverse /v2/settle unreachable — mock txHash: ${mockTxHash}`);
    return { success: true, txHash: mockTxHash, mocked: true };
  }
}

// ═══════════════════════════════════════════
// x402 MIDDLEWARE
// ═══════════════════════════════════════════

export function x402Middleware(
  taskType: "verify" | "execute",
  description: string
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const xPayment = req.headers["x-payment"] as string;
    console.log("[x402] RAW X-PAYMENT:", xPayment);

    if (!xPayment) {
      const fullResource = `${req.protocol}://${req.get("host")}${req.path}`;
      send402(res, taskType, fullResource, description);
      return;
    }

    const payment = parseXPayment(xPayment);
    console.dir(payment, { depth: null });

    if (!payment) {
      res.status(400).json({ error: "Invalid X-PAYMENT header — could not decode base64 payload" });
      return;
    }
    const verification = await verifyPayment(payment, taskType);

    if (!verification.valid) {
      res.status(402).json({ error: verification.reason });
      return;
    }

    const settlement = await settlePayment(payment);

    if (!settlement.success) {
      res.status(402).json({ error: `Payment settlement failed: ${settlement.error}` });
      return;
    }

    if (settlement.mocked) {
      console.warn(`[x402] Payment mocked for task ${taskType}. Pieverse infrastructure issue — see README.`);
    }

    (req as Request & { x402Payment: KitePaymentPayload; x402TxHash: string }).x402Payment = payment;
    (req as Request & { x402Payment: KitePaymentPayload; x402TxHash: string }).x402TxHash = settlement.txHash || "";

    next();
  };
}

// ═══════════════════════════════════════════
// EXTRACT ERC3009
// ═══════════════════════════════════════════

export function extractERC3009(payment: KitePaymentPayload): {
  v: number;
  r: string;
  s: string;
  from: string;
  validAfter: number;
  validBefore: number;
  nonce: string;
} {
  const auth = payment.authorization;
  return {
    v: auth.v,
    r: auth.r,
    s: auth.s,
    from: auth.from,
    validAfter: Number(auth.validAfter),
    validBefore: Number(auth.validBefore),
    nonce: auth.nonce
  };
}