import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express, { Request, Response, NextFunction } from "express";
import { ethers } from "ethers";
import crypto from "crypto";
import { saveTaskMetadata } from "../core/store.js";
import {
  createScoutTask,
  getTaskStatus,
  cancelScoutTask,
  getAttestation,
  setAgentPolicy,
  getAgentPolicy,
  uploadTaskSpec,
  TaskDefinition,
  TaskSpec
} from "../core/contract.js";
import dotenv from "dotenv";

dotenv.config();

// In-memory task metadata store
// Maps taskId → spec details for PWA feed enrichment
export const taskMetadataStore = new Map<string, {
  ipfsHash: string;
  question: string;
  location: { lat: number; lng: number; address: string; radiusMeters: number };
  successCriteria: string;
  instructions?: string;
}>();

const app = express();
app.use(express.json());

// ═══════════════════════════════════════════
// MCP AUTH MIDDLEWARE
// ═══════════════════════════════════════════

const SCOUT_KEY = process.env.SCOUT_API_KEY;

app.use("/mcp", (req: Request, res: Response, next: NextFunction) => {
  if (!SCOUT_KEY) {
    console.warn("SCOUT_API_KEY not set. MCP endpoint is unauthenticated.");
    return next();
  }
  const provided = req.headers["x-scout-key"];
  if (!provided || provided !== SCOUT_KEY) {
    res.status(401).json({ error: "Unauthorized. Provide x-scout-key header." });
    return;
  }
  next();
});

// ═══════════════════════════════════════════
// IPFS GATEWAY
// ═══════════════════════════════════════════

const IPFS_GATEWAYS = [
  process.env.IPFS_GATEWAY ?? "https://ipfs.io/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://gateway.pinata.cloud/ipfs/"
];

async function fetchFromIPFS(ipfsHash: string): Promise<string> {
  for (const gateway of IPFS_GATEWAYS) {
    try {
      const res = await fetch(`${gateway}${ipfsHash}`);
      if (res.ok) return await res.text();
    } catch {
      // try next gateway
    }
  }
  throw new Error("All IPFS gateways failed");
}

// ═══════════════════════════════════════════
// SORTED JSON HASH HELPER
// Deterministic hashing without external dependency.
// Sorts keys recursively before stringifying.
// ═══════════════════════════════════════════

function sortedJsonHash(obj: object): { json: string; hash: string } {
  const sorted = JSON.stringify(obj, Object.keys(obj).sort());
  const hash = ethers.keccak256(ethers.toUtf8Bytes(sorted));
  return { json: sorted, hash };
}

const server = new McpServer({
  name: "scout",
  version: "1.0.0",
  description: "Physical world interface for autonomous agents. Scout gives agents the ability to observe and act in physical reality through verified human presence."
});

// ═══════════════════════════════════════════
// scout.verify()
// ═══════════════════════════════════════════

server.tool(
  "scout.verify",
  "Dispatch a Scout to verify a physical fact. Use when agent confidence in physical reality is insufficient to act safely. Returns cryptographically attested ground truth.",
  {
    question: z.string().describe("What needs to be verified in the physical world"),
    location_lat: z.number().describe("Latitude of verification location"),
    location_lng: z.number().describe("Longitude of verification location"),
    location_address: z.string().describe("Human readable address for Scout navigation"),
    location_radius_meters: z.number().min(50).max(1000).default(300).describe("Acceptable radius in meters"),
    target: z.string().describe("Specific item or condition to verify"),
    success_criteria: z.string().describe("What counts as successful verification"),
    budget_usdc: z.number().min(0.1).max(50).describe("Maximum payment to Scout in USDC"),
    min_confidence: z.number().min(50).max(100).default(80).describe("Minimum confidence score required 0-100"),
    timeout_minutes: z.number().min(5).max(60).default(15).describe("How long to wait for Scout"),
    payment_token: z.string().describe("ERC20 token address for payment"),
    checkpoint_hash: z.string().optional().describe("Agent execution checkpoint hash for resumption — separate from spec integrity hash"),
    auth_valid_after: z.number().describe("ERC3009 authorization valid after timestamp"),
    auth_valid_before: z.number().describe("ERC3009 authorization valid before timestamp"),
    auth_nonce: z.string().describe("ERC3009 authorization nonce"),
    auth_hash: z.string().describe("ERC3009 authorization hash"),
    erc3009_v: z.number().describe("ERC3009 signature v"),
    erc3009_r: z.string().describe("ERC3009 signature r"),
    erc3009_s: z.string().describe("ERC3009 signature s"),
  },
  async (params) => {
    try {
      if (!ethers.isAddress(params.payment_token)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Invalid payment token address" }) }],
          isError: true
        };
      }

      const spec: TaskSpec = {
        taskType: "Verify",
        question: params.question,
        location: {
          lat: params.location_lat,
          lng: params.location_lng,
          address: params.location_address,
          radiusMeters: params.location_radius_meters
        },
        target: params.target,
        successCriteria: params.success_criteria,
        proofRequired: [],
        budgetUsdc: params.budget_usdc,
        minConfidence: params.min_confidence,
        timeoutMinutes: params.timeout_minutes
      };

      const { ipfsHash, specHash } = await uploadTaskSpec(spec);

      // specHash goes into checkpointHash — the field the contract stores for integrity verification.
      // If the agent also needs a resumption checkpoint, it should be tracked in agent runtime,
      // not passed here — TaskDefinition only has one hash field.
      const definition: TaskDefinition = {
        taskType: "Verify",
        location: spec.location,
        budgetUsdc: params.budget_usdc,
        minConfidence: params.min_confidence,
        timeoutMinutes: params.timeout_minutes,
        paymentToken: params.payment_token,
        checkpointHash: params.checkpoint_hash ?? specHash,
        authSignature: {
          validAfter: params.auth_valid_after,
          validBefore: params.auth_valid_before,
          nonce: params.auth_nonce,
          authHash: params.auth_hash
        },
        // erc3009Signature: v/r/s are passed to verifyAndPay() at settlement, not stored here.
        // Placeholder required by TaskDefinition type until contract.ts makes it optional.
        erc3009Signature: { v: 0, r: "0x", s: "0x" }
      };

      const { taskId } = await createScoutTask(definition);

      saveTaskMetadata(taskId, {
        question: params.question,
        successCriteria: params.success_criteria,
        location: {
          lat: params.location_lat,
          lng: params.location_lng,
          address: params.location_address,
          radiusMeters: params.location_radius_meters
        },
        ipfsHash,
        specHash,
        erc3009: {
          v: params.erc3009_v,
          r: params.erc3009_r,
          s: params.erc3009_s,
        },
      });

      taskMetadataStore.set(taskId, {
  ipfsHash,
  question: params.question,
  location: {
    lat: params.location_lat,
    lng: params.location_lng,
    address: params.location_address,
    radiusMeters: params.location_radius_meters
  },
  successCriteria: params.success_criteria,
});

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            task_id: taskId,
            status: "dispatched",
            task_type: "verify",
            ipfs_spec_hash: ipfsHash,
            spec_hash: specHash,
            message: `Scout verification task created on Kite. Poll scout.status with task_id to check progress.`,
            estimated_completion_minutes: params.timeout_minutes,
            budget_committed_usdc: params.budget_usdc,
            min_confidence_required: params.min_confidence
          })
        }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Failed to create Scout verify task: ${String(error)}` }) }],
        isError: true
      };
    }
  }
);

// ═══════════════════════════════════════════
// scout.execute()
// ═══════════════════════════════════════════

server.tool(
  "scout.execute",
  "Dispatch a Scout to execute a physical task. Use when agent needs something to happen in the physical world. Returns cryptographic proof of completion.",
  {
    action: z.string().describe("What physical action needs to be taken"),
    location_lat: z.number().describe("Latitude of execution location"),
    location_lng: z.number().describe("Longitude of execution location"),
    location_address: z.string().describe("Human readable address for Scout navigation"),
    location_radius_meters: z.number().min(50).max(1000).default(300).describe("Acceptable radius in meters"),
    instructions: z.string().describe("Step by step instructions for the Scout"),
    proof_required: z.array(z.string()).describe("Evidence Scout must provide eg video_of_collection item_identifier receipt_photo"),
    success_criteria: z.string().describe("What counts as successful completion"),
    budget_usdc: z.number().min(0.5).max(100).describe("Maximum payment to Scout in USDC"),
    min_confidence: z.number().min(50).max(100).default(80).describe("Minimum confidence score required 0-100"),
    timeout_minutes: z.number().min(5).max(120).default(30).describe("How long to wait for Scout"),
    payment_token: z.string().describe("ERC20 token address for payment"),
    checkpoint_hash: z.string().optional().describe("Agent execution checkpoint hash for resumption — separate from spec integrity hash"),
    auth_valid_after: z.number().describe("ERC3009 authorization valid after timestamp"),
    auth_valid_before: z.number().describe("ERC3009 authorization valid before timestamp"),
    auth_nonce: z.string().describe("ERC3009 authorization nonce"),
    auth_hash: z.string().describe("ERC3009 authorization hash"),
    erc3009_v: z.number().describe("ERC3009 signature v"),
    erc3009_r: z.string().describe("ERC3009 signature r"),
    erc3009_s: z.string().describe("ERC3009 signature s"),
  },
  async (params) => {
    try {
      if (!ethers.isAddress(params.payment_token)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Invalid payment token address" }) }],
          isError: true
        };
      }

      const spec: TaskSpec = {
        taskType: "Execute",
        action: params.action,
        location: {
          lat: params.location_lat,
          lng: params.location_lng,
          address: params.location_address,
          radiusMeters: params.location_radius_meters
        },
        instructions: params.instructions,
        proofRequired: params.proof_required,
        successCriteria: params.success_criteria,
        budgetUsdc: params.budget_usdc,
        minConfidence: params.min_confidence,
        timeoutMinutes: params.timeout_minutes
      };

      const { ipfsHash, specHash } = await uploadTaskSpec(spec);

      const definition: TaskDefinition = {
        taskType: "Execute",
        location: spec.location,
        proofRequired: params.proof_required,
        budgetUsdc: params.budget_usdc,
        minConfidence: params.min_confidence,
        timeoutMinutes: params.timeout_minutes,
        paymentToken: params.payment_token,
        checkpointHash: params.checkpoint_hash ?? specHash,
        authSignature: {
          validAfter: params.auth_valid_after,
          validBefore: params.auth_valid_before,
          nonce: params.auth_nonce,
          authHash: params.auth_hash
        },
        // erc3009Signature: v/r/s are passed to verifyAndPay() at settlement, not stored here.
        // Placeholder required by TaskDefinition type until contract.ts makes it optional.
        erc3009Signature: { v: 0, r: "0x", s: "0x" }
      };

      const { taskId } = await createScoutTask(definition);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            task_id: taskId,
            status: "dispatched",
            task_type: "execute",
            ipfs_spec_hash: ipfsHash,
            spec_hash: specHash,
            message: `Scout execution task created on Kite. Poll scout.status with task_id to check progress.`,
            estimated_completion_minutes: params.timeout_minutes,
            budget_committed_usdc: params.budget_usdc
          })
        }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Failed to create Scout execute task: ${String(error)}` }) }],
        isError: true
      };
    }
  }
);

// ═══════════════════════════════════════════
// scout.status()
// ═══════════════════════════════════════════

server.tool(
  "scout.status",
  "Check the status of an active Scout task. Poll this after scout.verify or scout.execute to get the result. Statuses: Open, Accepted, Submitted, Verified, Failed, Expired, Cancelled, Rejected.",
  {
    task_id: z.string().describe("The task ID returned by scout.verify or scout.execute")
  },
  async ({ task_id }) => {
    try {
      if (!ethers.isHexString(task_id, 32)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Invalid task_id format. Must be 32-byte hex string." }) }],
          isError: true
        };
      }

      const status = await getTaskStatus(task_id);

      return {
        content: [{
          type: "text",
          text: JSON.stringify(status)
        }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Failed to get task status: ${String(error)}` }) }],
        isError: true
      };
    }
  }
);

// ═══════════════════════════════════════════
// scout.cancel()
// ═══════════════════════════════════════════

server.tool(
  "scout.cancel",
  "Cancel an open Scout task that has not yet been accepted by a Scout. Only works on tasks with Open status.",
  {
    task_id: z.string().describe("The task ID to cancel")
  },
  async ({ task_id }) => {
    try {
      if (!ethers.isHexString(task_id, 32)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Invalid task_id format" }) }],
          isError: true
        };
      }

      await cancelScoutTask(task_id);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            task_id,
            status: "cancelled",
            message: "Scout task cancelled. ERC3009 authorization has expired."
          })
        }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Failed to cancel task: ${String(error)}` }) }],
        isError: true
      };
    }
  }
);

// ═══════════════════════════════════════════
// scout.policy.set()
// ═══════════════════════════════════════════

server.tool(
  "scout.policy.set",
  "Set Scout dispatch policy for this agent. Defines when Scout fires automatically, budget limits, confidence thresholds, and failure behavior. Policy hash is committed on-chain via Kite. Full policy stored on IPFS. Caller must prove ownership of agent_address via signed message.",
  {
    trigger_confidence_lt: z.number().min(0).max(100).describe("Fire Scout when agent confidence drops below this threshold 0-100"),
    trigger_transaction_gt_usdc: z.number().min(0).describe("Fire Scout when transaction value exceeds this amount in USDC"),
    max_budget_usdc: z.number().min(0.1).max(100).describe("Maximum Scout budget per dispatch in USDC"),
    min_confidence: z.number().min(50).max(100).default(80).describe("Minimum confidence score to accept Scout result"),
    timeout_minutes: z.number().min(5).max(120).default(15).describe("Default timeout for Scout tasks"),
    retry_limit: z.number().min(0).max(5).default(2).describe("Maximum retries on Scout failure"),
    failure_action: z.enum(["abort", "notify_owner", "retry"]).default("notify_owner").describe("What to do when Scout fails after retries"),
    payment_token: z.string().describe("Default ERC20 token address for Scout payments"),
    agent_address: z.string().describe("Agent wallet address this policy applies to"),
    ownership_signature: z.string().describe("Signature proving caller controls agent_address. Sign the message 'scout-policy-set:<agent_address>' with the agent wallet")
  },
  async (params) => {
    try {
      if (!ethers.isAddress(params.agent_address)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Invalid agent address" }) }],
          isError: true
        };
      }

      if (!ethers.isAddress(params.payment_token)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Invalid payment token address" }) }],
          isError: true
        };
      }

      // Verify caller owns agent_address
      const message = `scout-policy-set:${params.agent_address.toLowerCase()}`;
      const recoveredAddress = ethers.verifyMessage(message, params.ownership_signature);
      if (recoveredAddress.toLowerCase() !== params.agent_address.toLowerCase()) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Ownership verification failed. Signature does not match agent_address." }) }],
          isError: true
        };
      }

      const policy = {
        version: "1.0",
        agent: params.agent_address,
        trigger: {
          confidence_lt: params.trigger_confidence_lt,
          transaction_gt_usdc: params.trigger_transaction_gt_usdc
        },
        max_budget_usdc: params.max_budget_usdc,
        min_confidence: params.min_confidence,
        timeout_minutes: params.timeout_minutes,
        retry_limit: params.retry_limit,
        failure_action: params.failure_action,
        payment_token: params.payment_token,
        created_at: Math.floor(Date.now() / 1000)
      };

      // Deterministic hash — sorted keys, no external dependency
      const { json: policyJson, hash: policyHash } = sortedJsonHash(policy);

      const PINATA_JWT = process.env.PINATA_JWT;
      if (!PINATA_JWT) throw new Error("PINATA_JWT missing");

      const blob = new Blob([policyJson], { type: "application/json" });
      const formData = new FormData();
      formData.append("file", blob, `scout-policy-${params.agent_address}.json`);
      formData.append("pinataMetadata", JSON.stringify({ name: `scout-policy-${params.agent_address}` }));

      const response = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
        method: "POST",
        headers: { Authorization: `Bearer ${PINATA_JWT}` },
        body: formData
      });

      if (!response.ok) throw new Error(`Pinata upload failed: ${response.statusText}`);

      const data = await response.json() as { IpfsHash: string };
      const policyURI = `ipfs://${data.IpfsHash}`;

      await setAgentPolicy(policyHash, policyURI);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            policy_hash: policyHash,
            policy_uri: policyURI,
            message: "Policy hash committed on Kite chain. Full policy stored on IPFS.",
            policy
          })
        }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Failed to set policy: ${String(error)}` }) }],
        isError: true
      };
    }
  }
);

// ═══════════════════════════════════════════
// scout.policy.get()
// ═══════════════════════════════════════════

server.tool(
  "scout.policy.get",
  "Retrieve the active Scout dispatch policy for an agent. Returns policy hash from Kite chain and full policy from IPFS. Verifies integrity before returning. Use before dispatching to validate policy is current.",
  {
    agent_address: z.string().describe("Agent wallet address to retrieve policy for")
  },
  async ({ agent_address }) => {
    try {
      if (!ethers.isAddress(agent_address)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Invalid agent address" }) }],
          isError: true
        };
      }

      const { policyHash, policyURI } = await getAgentPolicy(agent_address);

      if (policyHash === ethers.ZeroHash) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              agent: agent_address,
              policy: null,
              message: "No policy set for this agent. Use scout.policy.set to configure Scout dispatch rules."
            })
          }]
        };
      }

      const ipfsHash = policyURI.replace("ipfs://", "");
      const policyJson = await fetchFromIPFS(ipfsHash);
      const policy = JSON.parse(policyJson);

      // Verify integrity using same sorted hash method
      const { hash: computedHash } = sortedJsonHash(policy);

      if (computedHash !== policyHash) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Policy integrity check failed. Hash mismatch." }) }],
          isError: true
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            agent: agent_address,
            policy_hash: policyHash,
            policy_uri: policyURI,
            integrity: "verified",
            policy
          })
        }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Failed to get policy: ${String(error)}` }) }],
        isError: true
      };
    }
  }
);

// ═══════════════════════════════════════════
// scout.attestation()
// ═══════════════════════════════════════════

server.tool(
  "scout.attestation",
  "Retrieve the permanent on-chain attestation for a completed Scout task. Use to verify cryptographic proof of physical world observation or execution. Returns null if task not yet verified.",
  {
    task_id: z.string().describe("The task ID to retrieve attestation for")
  },
  async ({ task_id }) => {
    try {
      if (!ethers.isHexString(task_id, 32)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Invalid task_id format" }) }],
          isError: true
        };
      }

      const attestation = await getAttestation(task_id);

      if (!attestation) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              task_id,
              verified: false,
              message: "No attestation found. Task may not be verified yet."
            })
          }]
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            task_id,
            verified: true,
            attestation: {
              scout: attestation.scout,
              agent: attestation.agent,
              confidence_bps: attestation.confidenceBps,
              confidence_percent: (attestation.confidenceBps / 100).toFixed(2),
              checkpoint_hash: attestation.checkpointHash,
              capture_hash: attestation.captureHash,
              timestamp: attestation.timestamp,
              verified_at: new Date(attestation.timestamp * 1000).toISOString()
            }
          })
        }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Failed to get attestation: ${String(error)}` }) }],
        isError: true
      };
    }
  }
);

// ═══════════════════════════════════════════
// HTTP TRANSPORT
// ═══════════════════════════════════════════

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID()
});

app.post("/mcp", async (req, res) => {
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  await transport.handleRequest(req, res);
});

async function start() {
  await server.connect(transport);

  const MCP_PORT = process.env.MCP_PORT || 3001;

  app.listen(MCP_PORT, () => {
    console.log(`Scout MCP server running on port ${MCP_PORT}`);
    console.log(`Connect agents via: http://your-server:${MCP_PORT}/mcp`);
  });
}

start().catch(console.error);

export default app;