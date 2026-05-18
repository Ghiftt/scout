import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { ethers } from "ethers";
import { processVerification, CaptureBundle } from "../core/verification.js";
import { createScoutTask, getTaskStatus, fetchTaskSpec, cancelScoutTask, getAttestation, provider, registryContract, TaskDefinition } from "../core/contract.js";
import { getOpenTasksFromGoldsky, getCompletedTasksFromGoldsky } from "../core/goldsky.js";
import { getTaskMetadata, getAllTaskMetadata } from "../core/store.js";
import { x402Middleware, extractERC3009, KitePaymentPayload } from "./x402.js";
import { createProxyMiddleware } from "http-proxy-middleware";

const scoutWallet = new ethers.Wallet(
  process.env.SCOUT_PRIVATE_KEY!,
  provider
);
console.log("Scout wallet address:", scoutWallet.address);

const scoutRegistryContract = new ethers.Contract(
  "0xC7818c94293bb9c2B714B0ACe75639F77B3Fea0E",
  [
    "function acceptTask(bytes32 taskId) external",
    "function submitProof(bytes32 taskId, string memory captureURI) external"
  ],
  scoutWallet
);
console.log("Scout wallet address:", await scoutWallet.getAddress());

const SCOUT_TREASURY_ADDRESS = process.env.SCOUT_TREASURY_ADDRESS;
if (!SCOUT_TREASURY_ADDRESS) {
  throw new Error("SCOUT_TREASURY_ADDRESS missing from environment");
}

const app = express();
app.use(express.json({ limit: "15mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key, X-Payment");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// ═══════════════════════════════════════════
// KITE PASSPORT MERCHANT REGISTRATION
// ═══════════════════════════════════════════

app.get("/.well-known/kite-payment.json", (_req, res) => {
  res.json({
    name: "Scout — Physical World Interface for Agents",
    description: "Physical verification service for autonomous agents. Scout dispatches humans to verify real-world facts and returns cryptographic proof.",
    payTo: process.env.SCOUT_TREASURY_ADDRESS,
    asset: "0x9105bc19882d6DBd99a5B14473c654eaBc031FeA",
    network: "kite-testnet",
    scheme: "gokite-aa",
    maxAmountRequired: "25000000",
    supportedTaskTypes: ["verify", "execute"]
  });
});

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
// IN-MEMORY SCOUT ACCEPT REGISTRY
// Tracks scout acceptance since contract has
// no on-chain acceptTask function.
// Replaced by on-chain accept when contracts
// are redeployed with passportSession (Gap 2).
// ═══════════════════════════════════════════

const acceptedTasks = new Map<string, {
  scoutAddress: string;
  acceptedAt: number;
}>();

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

app.get("/.well-known/kite-payment.json", (_req, res) => {
  res.json({
    name: "Scout Verification Service",
    description: "Physical world verification for autonomous agents",
    payTo: process.env.SCOUT_TREASURY_ADDRESS,
    asset: "0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63",
    network: "kite-testnet",
    scheme: "gokite-aa"
  });
});

app.use("/mcp", createProxyMiddleware({
  target: "http://localhost:3001",
  changeOrigin: true,
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
  const acceptedByScout = acceptedTasks.get(bundle.taskId);

  // Validate task state
  if (!["Open", "Accepted", "Submitted"].includes(task.status)) {
    res.status(400).json({ error: `Invalid task state: ${task.status}` });
    return;
  }

  if (task.status === "Open" && !acceptedByScout) {
    res.status(400).json({ error: "Task not accepted. Call POST /task/:taskId/accept first." });
    return;
  }

  // Submit proof on chain to move task to Submitted status
  if (task.status === "Open" || task.status === "Accepted") {
    try {
      const captureURI = `ipfs://pending-${bundle.taskId}`;
      const tx = await scoutRegistryContract.submitProof(bundle.taskId, captureURI);
      await tx.wait();
      console.log(`[verify] Task ${bundle.taskId} submitted on chain`);
    } catch (err) {
      console.error(`[verify] submitProof failed:`, err);
      res.status(500).json({ error: `Failed to submit proof on chain: ${String(err)}` });
      return;
    }
  }

  // Fetch task spec from IPFS using real hash from SQLite,
  // falling back to ipfsSpecHash from PWA
  const meta = getTaskMetadata(bundle.taskId);
  const realIpfsHash = (meta?.ipfsHash || ipfsSpecHash).replace("ipfs://", "");
  const realSpecHash = meta?.specHash || task.taskId;
  let taskLocation = { lat: 4.9002552, lng: 7.0424838, radiusMeters: 500 };
try {
  const taskSpec = await fetchTaskSpec(realIpfsHash, realSpecHash);
  console.log(`[verify] taskSpec.location:`, JSON.stringify(taskSpec.location));
  taskLocation = {
    lat: taskSpec.location.lat,
    lng: taskSpec.location.lng,
    radiusMeters: taskSpec.location.radiusMeters
  };
} catch (err) {
  console.warn("[verify] IPFS fetch failed, using default location:", err);
}

  // Use real ERC-3009 signature from SQLite if available
  const realErc3009 = meta?.erc3009 ?? erc3009Sig;

  const result = await processVerification(
    bundle,
    taskLocation,
    realErc3009
  );

res.json({
    ...result,
    captureURI: `https://testnet.kitescan.ai/tx/${result.txHash ?? ""}`,
  });
}));


// ═══════════════════════════════════════════
// POST /task/:taskId/accept — Scout PWA accept
// ═══════════════════════════════════════════

app.post("/task/:taskId/accept", asyncHandler(async (req, res) => {
  const { taskId } = req.params;
  const { scoutAddress } = req.body as { scoutAddress: string };

  if (!ethers.isHexString(taskId, 32)) {
    res.status(400).json({ error: "Invalid taskId format" });
    return;
  }

  if (!scoutAddress) {
    res.status(400).json({ error: "Missing scoutAddress" });
    return;
  }

  const task = await getTaskStatus(taskId);

  if (task.status === "Accepted") {
    // Already accepted on chain — treat as success
    acceptedTasks.set(taskId, { scoutAddress, acceptedAt: Date.now() });
    res.json({ success: true, taskId, scoutAddress, alreadyAccepted: true });
    return;
  }

  if (task.status !== "Open") {
    res.status(400).json({ error: `Task is not open. Current status: ${task.status}` });
    return;
  }
  

  // Call acceptTask on chain
  try {
    console.log("[accept] signing with:", scoutWallet.address);
const tx = await scoutRegistryContract.acceptTask(taskId);
    await tx.wait();
    console.log(`[accept] Task ${taskId} accepted on chain`);
  } catch (err) {
    console.error(`[accept] acceptTask on chain failed:`, err);
    res.status(500).json({ error: `Failed to accept task on chain: ${String(err)}` });
    return;
  }

  acceptedTasks.set(taskId, {
    scoutAddress,
    acceptedAt: Date.now(),
  });
 console.log(`Task ${taskId} accepted by scout ${scoutAddress}`);
  res.json({ success: true, taskId, scoutAddress });
}));

// ═══════════════════════════════════════════
// GET /tasks — PWA feed via Goldsky
// ═══════════════════════════════════════════

app.get("/tasks", asyncHandler(async (_req, res) => {
  try {
    const goldskyTasks = await getOpenTasksFromGoldsky();

    // Also read all tasks from SQLite that may not be indexed by Goldsky yet
    const sqliteTasks = getAllTaskMetadata();
    
    // Merge — SQLite tasks not in Goldsky get added
    const goldskyIds = new Set(goldskyTasks.map(gt => gt.taskId));
    const sqliteOnlyTasks = sqliteTasks
      .filter(t => !goldskyIds.has(t.taskId))
      .map(t => ({
        taskId: t.taskId,
        agent: "",
        taskType: "0",
        paymentAmount: "25000000",
        createdAt: String(Math.floor(Date.now() / 1000)),
      }));

    const allTasks = [...goldskyTasks, ...sqliteOnlyTasks];

    const tasks = await Promise.all(
      allTasks.map(async (gt) => {
        try {
          const status = await getTaskStatus(gt.taskId);

          console.log(`Task ${gt.taskId}: status=${status.status} expires=${status.expiresAt} now=${Math.floor(Date.now()/1000)}`);
          if (status.status !== "Open" && status.status !== "Accepted") {
            return null;
          }
          if (status.expiresAt < Math.floor(Date.now() / 1000)) {
            return null;
          }

          const meta = getTaskMetadata(gt.taskId);
          const rawTitle = meta?.question ?? "Physical verification required";
const title = rawTitle.length > 60 ? rawTitle.slice(0, 57) + "..." : rawTitle;
          const instructions = meta?.instructions ?? "Record a clear video of the item. Ensure it is powered on and visible.";
          const successCriteria = meta?.successCriteria ? [meta.successCriteria] : [
            "Item is physically present",
            "Item powers on and is functional",
            "Condition matches listing description",
            "GPS within task radius"
          ];
          const location = meta?.location ?? {
            lat: 4.9002552,
            lng: 7.0424838,
            address: "Port Harcourt, Rivers State",
            radiusMeters: 5000
          };

          return {
            id: gt.taskId,
            taskId: gt.taskId,
            type: gt.taskType === "0" ? "Verify" : "Execute",
            title,
            description: title,
            instructions,
            successCriteria,
            location,
            distanceMiles: 0.3,
            timeoutMinutes: Math.max(0, Math.floor((status.expiresAt - Date.now() / 1000) / 60)),
            paymentUsdc: parseFloat(status.paymentAmount),
            minConfidence: status.minConfidence,
            status: status.status,
            createdAt: status.createdAt * 1000,
            expiresAt: status.expiresAt * 1000,
            proofRequired: status.proofRequired.length > 0
              ? status.proofRequired
              : ["video_burst", "gps_location", "timestamp"],
            agent: status.agent,
            checkpointHash: gt.taskId,
            ipfsHash: meta?.ipfsHash ?? "",
          };
        } catch (e) {
          console.error(`Failed processing task ${gt.taskId}:`, e);
          return null;
        }
      })
    );

    res.json(tasks.filter(Boolean));
  } catch (e) {
    console.error("GET /tasks error:", e);
    res.json([]);
  }
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

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Scout verification service running on port ${PORT}`);
});

export default app;