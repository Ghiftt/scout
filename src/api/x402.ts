import { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";

dotenv.config();

// ═══════════════════════════════════════════
// KITE x402 IMPLEMENTATION
// Follows Kite's gokite-aa scheme
// Facilitator: Pieverse (https://facilitator.pieverse.io)
// Docs: https://docs.gokite.ai/kite-agent-passport/service-provider-guide
// ═══════════════════════════════════════════

const SCOUT_TREASURY = process.env.SCOUT_TREASURY_ADDRESS;
if (!SCOUT_TREASURY) {
  throw new Error("SCOUT_TREASURY_ADDRESS missing from environment");
}

// Kite testnet payment token
// https://testnet.kitescan.ai/token/0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63
export const KITE_TESTNET_TOKEN = "0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63";

// Kite Pieverse facilitator
export const KITE_FACILITATOR_URL = "https://facilitator.pieverse.io";
export const KITE_FACILITATOR_ADDRESS = "0x12343e649e6b2b2b77649DFAb88f103c02F3C78b";

// Kite x402 scheme and network
const KITE_SCHEME = "gokite-aa";
const KITE_NETWORK = "kite-testnet";

// Scout task pricing in token units (18 decimals)
// 0.01 token = 10000000000000000 wei
export const TASK_PRICES: Record<string, string> = {
  verify: "10000000000000000",   // 0.01 token per verify task
  execute: "50000000000000000"   // 0.05 token per execute task
};

// ═══════════════════════════════════════════
// 402 PAYMENT REQUIRED RESPONSE
// Matches Kite's exact format from docs
// ═══════════════════════════════════════════

export function send402(
  res: Response,
  taskType: "verify" | "execute",
  resource: string,
  description: string
): void {
  const amount = TASK_PRICES[taskType];

  const paymentRequired = {
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
          input: {
            discoverable: true,
            method: "POST",
            type: "http"
          },
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
  };

  res.status(402).json(paymentRequired);
}

// ═══════════════════════════════════════════
// PARSE X-PAYMENT HEADER
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
// SETTLE VIA PIEVERSE FACILITATOR
// ═══════════════════════════════════════════

export async function settlePayment(
  payment: KitePaymentPayload
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const response = await fetch(`${KITE_FACILITATOR_URL}/v2/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        authorization: payment.authorization,
        signature: payment.signature,
        network: KITE_NETWORK
      })
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error };
    }

    const result = await response.json() as { txHash: string };
    return { success: true, txHash: result.txHash };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// ═══════════════════════════════════════════
// VERIFY PAYMENT VIA PIEVERSE FACILITATOR
// ═══════════════════════════════════════════

export async function verifyPayment(
  payment: KitePaymentPayload,
  taskType: "verify" | "execute"
): Promise<{ valid: boolean; reason: string }> {
  try {
    const response = await fetch(`${KITE_FACILITATOR_URL}/v2/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        authorization: payment.authorization,
        signature: payment.signature,
        network: KITE_NETWORK,
        expectedAmount: TASK_PRICES[taskType],
        expectedPayTo: SCOUT_TREASURY
      })
    });

    if (!response.ok) {
      return { valid: false, reason: `Facilitator verification failed: ${response.statusText}` };
    }

    const result = await response.json() as { valid: boolean; reason?: string };
    return { valid: result.valid, reason: result.reason || "Verified" };
  } catch (error) {
    return { valid: false, reason: `Facilitator error: ${String(error)}` };
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

    if (!xPayment) {
      send402(res, taskType, req.path, description);
      return;
    }

    const payment = parseXPayment(xPayment);

    if (!payment) {
      res.status(400).json({ error: "Invalid X-PAYMENT header" });
      return;
    }

    // Verify via Pieverse facilitator
    const verification = await verifyPayment(payment, taskType);

    if (!verification.valid) {
      res.status(402).json({ error: verification.reason });
      return;
    }

    // Settle payment via Pieverse facilitator
    const settlement = await settlePayment(payment);

    if (!settlement.success) {
      res.status(402).json({ error: `Payment settlement failed: ${settlement.error}` });
      return;
    }

    // Attach payment info to request
    (req as Request & {
      x402Payment: KitePaymentPayload;
      x402TxHash: string;
    }).x402Payment = payment;

    (req as Request & {
      x402Payment: KitePaymentPayload;
      x402TxHash: string;
    }).x402TxHash = settlement.txHash || "";

    next();
  };
}

// ═══════════════════════════════════════════
// EXTRACT ERC3009 FROM KITE PAYMENT
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