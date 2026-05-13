import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { ethers } from "ethers";
import { processVerification, CaptureBundle } from "../core/verification.js";
import { createScoutTask, getTaskStatus, fetchTaskSpec, cancelScoutTask, provider, TaskDefinition } from "../core/contract.js";
import { x402Middleware, extractERC3009, KitePaymentPayload } from "./x402.js";

const SCOUT_TREASURY_ADDRESS = process.env.SCOUT_TREASURY_ADDRESS;
if (!SCOUT_TREASURY_ADDRESS) {
  throw new Error("SCOUT_TREASURY_ADDRESS missing from environment");
}

const app = express();
app.use(express.json({ limit: "15mb" }));

// ═══════════════════════════════════════════
// AUTH MIDDLEWARE
// ═══════════════════════════════════════════

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
if (!INTERNAL_API_KEY) {
  throw new Error("INTERNAL_API_KEY missing from environment");
}

function requireApiKey(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const key = req.headers["x-api-key"];
  if (key !== INTERNAL_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ═══════════════════════════════════════════
// ASYNC HANDLER
// ═══════════════════════════════════════════

const asyncHandler = (
  fn: (req: express.Request, res: express.Response) => Promise<void>
) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};

// ═══════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════

app.get("/health", asyncHandler(async (_req, res) => {
  try {
    await provider.getBlockNumber();
    res.json({ status: "ok", chain: "reachable", service: "scout-verification" });
  } catch {
    res.status(503).json({ status: "degraded", chain: "unreachable" });
  }
}));

// ═══════════════════════════════════════════
// CREATE VERIFY TASK — x402 protected
// ═══════════════════════════════════════════

app.post("/task/verify", x402Middleware("verify", "Scout physical verification task dispatch"), asyncHandler(async (req, res) => {
  const payment = (req as unknown as { x402Payment: KitePaymentPayload }).x402Payment;
  const erc3009 = extractERC3009(payment);

  const { taskDefinition } = req.body as {
    taskDefinition: TaskDefinition;
  };

  if (!taskDefinition) {
    res.status(400).json({ error: "Missing taskDefinition" });
    return;
  }

  taskDefinition.erc3009Signature = {
    v: erc3009.v,
    r: erc3009.r,
    s: erc3009.s
  };

  taskDefinition.authSignature = {
    validAfter: erc3009.validAfter,
    validBefore: erc3009.validBefore,
    nonce: erc3009.nonce,
    authHash: ethers.keccak256(
      ethers.solidityPacked(
        ["address", "address", "uint256", "uint256", "uint256", "bytes32"],
        [
          erc3009.from,
          SCOUT_TREASURY_ADDRESS,
          taskDefinition.budgetUsdc,
          erc3009.validAfter,
          erc3009.validBefore,
          erc3009.nonce
        ]
      )
    )
  };

  const { taskId } = await createScoutTask(taskDefinition);

  res
    .setHeader("PAYMENT-RESPONSE", Buffer.from(JSON.stringify({
      success: true,
      taskId,
      network: "eip155:2368",
      transaction: taskId
    })).toString("base64"))
    .json({ taskId, status: "dispatched" });
}));

// ═══════════════════════════════════════════
// CREATE EXECUTE TASK — x402 protected
// ═══════════════════════════════════════════

app.post("/task/execute", x402Middleware("execute", "Scout physical execution task dispatch"), asyncHandler(async (req, res) => {
  const payment = (req as unknown as { x402Payment: KitePaymentPayload }).x402Payment;
  const erc3009 = extractERC3009(payment);

  const { taskDefinition } = req.body as {
    taskDefinition: TaskDefinition;
  };

  if (!taskDefinition) {
    res.status(400).json({ error: "Missing taskDefinition" });
    return;
  }

  taskDefinition.erc3009Signature = {
    v: erc3009.v,
    r: erc3009.r,
    s: erc3009.s
  };

  const { taskId } = await createScoutTask(taskDefinition);

  res
    .setHeader("PAYMENT-RESPONSE", Buffer.from(JSON.stringify({
      success: true,
      taskId,
      network: "eip155:2368",
      transaction: taskId
    })).toString("base64"))
    .json({ taskId, status: "dispatched" });
}));

// ═══════════════════════════════════════════
// GET TASK STATUS — public endpoint for Scout PWA
// ═══════════════════════════════════════════

app.get("/task/:taskId", asyncHandler(async (req, res) => {
  const { taskId } = req.params;

  if (!ethers.isHexString(taskId, 32)) {
    res.status(400).json({ error: "Invalid taskId format" });
    return;
  }

  const status = await getTaskStatus(taskId);
  res.json(status);
}));

// ═══════════════════════════════════════════
// SUBMIT PROOF — called by Scout PWA
// Auth required — Scout PWA must include API key
// ═══════════════════════════════════════════

app.post("/verify", requireApiKey, asyncHandler(async (req, res) => {
  const {
    bundle,
    ipfsSpecHash,
    erc3009Sig
  } = req.body as {
    bundle: CaptureBundle;
    ipfsSpecHash: string;
    erc3009Sig: {
      v: number;
      r: string;
      s: string;
    };
  };

  // Input validation
  if (!bundle?.taskId) {
    res.status(400).json({ error: "Missing bundle or taskId" });
    return;
  }

  if (!ethers.isHexString(bundle.taskId, 32)) {
    res.status(400).json({ error: "Invalid taskId format" });
    return;
  }

  if (!bundle.videoBase64) {
    res.status(400).json({ error: "Missing video data" });
    return;
  }

  if (!ipfsSpecHash) {
    res.status(400).json({ error: "Missing IPFS spec hash" });
    return;
  }

  if (
    erc3009Sig?.v === undefined ||
    !erc3009Sig.r ||
    !erc3009Sig.s
  ) {
    res.status(400).json({ error: "Missing or invalid ERC3009 signature" });
    return;
  }

  // Fetch task from chain
  const task = await getTaskStatus(bundle.taskId);

  if (task.status !== "Submitted") {
    res.status(400).json({ error: `Invalid task state: ${task.status}. Expected Submitted.` });
    return;
  }

  // Fetch and verify task spec from IPFS
  // checkpointHash on-chain IS the spec hash
  const taskSpec = await fetchTaskSpec(ipfsSpecHash, task.taskId);

  const taskLocation = {
    lat: taskSpec.location.lat,
    lng: taskSpec.location.lng,
    radiusMeters: taskSpec.location.radiusMeters
  };

  const result = await processVerification(
    bundle,
    taskLocation,
    erc3009Sig
  );

  res.json(result);
}));

// ═══════════════════════════════════════════
// ERROR MIDDLEWARE
// ═══════════════════════════════════════════

app.use((
  err: Error,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction
) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: err.message });
});

// ═══════════════════════════════════════════
// START
// ═══════════════════════════════════════════

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Scout verification service running on port ${PORT}`);
});

export default app;