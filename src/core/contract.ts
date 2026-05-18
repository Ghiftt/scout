import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════

const RPC_URL = "https://rpc-testnet.gokite.ai/";
const SCOUT_REGISTRY_ADDRESS = "0xC7818c94293bb9c2B714B0ACe75639F77B3Fea0E";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  throw new Error("PRIVATE_KEY missing from environment");
}

export const provider = new ethers.JsonRpcProvider(RPC_URL);

// Health check on startup
await provider.getNetwork().catch(() => {
  throw new Error("Cannot connect to Kite RPC. Check network.");
});

const verifierWallet = new ethers.Wallet(PRIVATE_KEY, provider);

const scoutWallet = new ethers.Wallet(
  process.env.SCOUT_PRIVATE_KEY!,
  provider
);

// ═══════════════════════════════════════════
// ABI
// ═══════════════════════════════════════════

const REGISTRY_ABI = [
  "function createTask(bytes32 taskId, address paymentToken, uint256 paymentAmount, uint16 minConfidence, uint256 durationSeconds, bytes32 checkpointHash, uint8 taskType, string[] memory proofRequired, tuple(uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes32 authHash) auth) external",
  "function cancelTask(bytes32 taskId) external",
  "function acceptTask(bytes32 taskId) external",
  "function verifyAndPay(bytes32 taskId, uint16 confidenceScore, uint8 v, bytes32 r, bytes32 s) external",
  "function submitProof(bytes32 taskId, string memory captureURI) external",
  "function rejectTask(bytes32 taskId, string memory reason) external",
  "function failTaskPermanently(bytes32 taskId, string memory reason) external",
  "function getTask(bytes32 taskId) external view returns (tuple(bytes32 taskId, address agent, address scout, address paymentToken, uint256 paymentAmount, uint16 minConfidence, uint256 createdAt, uint256 expiresAt, uint8 status, bytes32 checkpointHash, string captureURI, uint8 taskType, string[] proofRequired, tuple(uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes32 authHash) auth))",
  "function setPolicy(bytes32 policyHash, string memory policyURI) external",
  "function getPolicy(address agent) external view returns (bytes32 policyHash, string memory policyURI)",
  "event PolicySet(address indexed agent, bytes32 policyHash, string policyURI)",
  "event ScoutTaskCompleted(bytes32 indexed taskId, address indexed scout, bytes32 indexed checkpointHash, uint16 confidenceScore, uint256 paymentAmount)",
  "event TaskSubmitted(bytes32 indexed taskId, address indexed scout, string captureURI, uint256 submittedAt)"
];

const ATTESTATION_ABI = [
  "function getAttestation(bytes32 taskId) external view returns (tuple(bytes32 taskId, address scout, address agent, uint16 confidenceBps, bytes32 checkpointHash, bytes32 captureHash, uint256 timestamp))",
  "function getScoutAttestations(address scout) external view returns (bytes32[])",
  "function isVerified(bytes32 taskId) external view returns (bool)"
];

export const attestationRead = new ethers.Contract(
  "0x2eF75C17637b0ec010e3b2748b0451095542C375",
  ATTESTATION_ABI,
  provider
);

// ═══════════════════════════════════════════
// CONTRACT INSTANCES
// ═══════════════════════════════════════════

export const registryContract = new ethers.Contract(
  SCOUT_REGISTRY_ADDRESS,
  REGISTRY_ABI,
  verifierWallet
);

export const registryContractAsScout = new ethers.Contract(
  SCOUT_REGISTRY_ADDRESS,
  REGISTRY_ABI,
  scoutWallet
);

export const registryRead = new ethers.Contract(
  SCOUT_REGISTRY_ADDRESS,
  REGISTRY_ABI,
  provider
);

// ═══════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════

export interface AuthSignature {
  validAfter: number;
  validBefore: number;
  nonce: string;
  authHash: string;
}

export interface ERC3009Signature {
  v: number;
  r: string;
  s: string;
}

export interface TaskDefinition {
  taskType: "Verify" | "Execute";
  question?: string;
  action?: string;
  location: {
    lat: number;
    lng: number;
    address: string;
    radiusMeters?: number;
  };
  target?: string;
  instructions?: string;
  successCriteria?: string;
  proofRequired?: string[];
  budgetUsdc: number;
  minConfidence?: number;
  timeoutMinutes: number;
  checkpointHash?: string;
  paymentToken: string;
  authSignature: AuthSignature;
  erc3009Signature: ERC3009Signature;
}

export interface TaskStatus {
  taskId: string;
  status: string;
  taskType: string;
  scout: string;
  agent: string;
  paymentAmount: string;
  minConfidence: number;
  createdAt: number;
  expiresAt: number;
  captureURI: string;
  proofRequired: string[];
}

// ═══════════════════════════════════════════
// STATUS MAPS
// ═══════════════════════════════════════════

const STATUS_MAP: Record<number, string> = {
  0: "Open",
  1: "Accepted",
  2: "Submitted",
  3: "Verified",
  4: "Failed",
  5: "Expired",
  6: "Cancelled",
  7: "Rejected"
};

const TASK_TYPE_MAP: Record<number, string> = {
  0: "Verify",
  1: "Execute"
};

// ═══════════════════════════════════════════
// FUNCTIONS
// ═══════════════════════════════════════════

export async function createScoutTask(
  definition: TaskDefinition
): Promise<{ taskId: string }> {
  const signer = await verifierWallet.getAddress();

  const taskId = ethers.keccak256(
    ethers.solidityPacked(
      ["address", "uint256", "bytes32"],
      [
        signer,
        BigInt(Date.now()),
        ethers.hexlify(ethers.randomBytes(32))
      ]
    )
  );

  const checkpointHash =
    definition.checkpointHash ??
    ethers.keccak256(ethers.toUtf8Bytes(`checkpoint-${taskId}`));

  const minConfidence = definition.minConfidence ?? 85;

  if (minConfidence < 0 || minConfidence > 100) {
    throw new Error("minConfidence must be between 0 and 100");
  }

  try {
    const tx = await registryContract.createTask(
      taskId,
      definition.paymentToken,
      ethers.parseUnits(definition.budgetUsdc.toString(), 6),
      minConfidence,
      definition.timeoutMinutes * 60,
      checkpointHash,
      definition.taskType === "Verify" ? 0 : 1,
      definition.proofRequired ?? [],
      definition.authSignature
    );

    const receipt = await tx.wait();

    if (!receipt || receipt.status !== 1) {
      throw new Error("Task creation transaction failed");
    }

    return { taskId };
  } catch (error) {
    throw new Error(`Failed to create Scout task: ${String(error)}`);
  }
}

export async function getTaskStatus(taskId: string): Promise<TaskStatus> {
  try {
    const task = await registryRead.getTask(taskId);

    return {
      taskId,
      status: STATUS_MAP[Number(task.status)] ?? "Unknown",
      taskType: TASK_TYPE_MAP[Number(task.taskType)] ?? "Unknown",
      scout: task.scout,
      agent: task.agent,
      paymentAmount: ethers.formatUnits(task.paymentAmount, 6),
      minConfidence: Number(task.minConfidence),
      createdAt: Number(task.createdAt),
      expiresAt: Number(task.expiresAt),
      captureURI: task.captureURI,
      proofRequired: task.proofRequired
    };
  } catch (error) {
    throw new Error(`Failed to get task status for ${taskId}: ${String(error)}`);
  }
}

export async function cancelScoutTask(taskId: string): Promise<void> {
  try {
    const tx = await registryContract.cancelTask(taskId);
    const receipt = await tx.wait();

    if (!receipt || receipt.status !== 1) {
      throw new Error("Cancel transaction failed");
    }
  } catch (error) {
    throw new Error(`Failed to cancel task ${taskId}: ${String(error)}`);
  }
}

export async function verifyAndPay(
  taskId: string,
  confidenceScore: number,
  v: number,
  r: string,
  s: string
): Promise<string> {
  if (confidenceScore < 0 || confidenceScore > 10000) {
    throw new Error("confidenceScore must be between 0 and 10000");
  }

  try {
    const tx = await registryContract.verifyAndPay(
      taskId,
      confidenceScore,
      v,
      r,
      s
    );

    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error("VerifyAndPay transaction failed");
    }
    return receipt.hash;
  } catch (error) {
    throw new Error(`Failed to verify and pay task ${taskId}: ${String(error)}`);
  }
  return "";
  }

export async function rejectTask(taskId: string, reason: string): Promise<void> {
  try {
    const tx = await registryContract.rejectTask(taskId, reason);
    const receipt = await tx.wait();

    if (!receipt || receipt.status !== 1) {
      throw new Error("Reject transaction failed");
    }
  } catch (error) {
    throw new Error(`Failed to reject task ${taskId}: ${String(error)}`);
  }
}

export async function failTask(taskId: string, reason: string): Promise<void> {
  try {
    const tx = await registryContract.failTaskPermanently(taskId, reason);
    const receipt = await tx.wait();

    if (!receipt || receipt.status !== 1) {
      throw new Error("Fail transaction failed");
    }
  } catch (error) {
    throw new Error(`Failed to permanently fail task ${taskId}: ${String(error)}`);
  }
}

export function listenForSubmissions(
  callback: (taskId: string, scout: string, captureURI: string) => void
): () => void {
  const handler = (taskId: string, scout: string, captureURI: string) => {
    callback(taskId, scout, captureURI);
  };

  registryRead.on("TaskSubmitted", handler);

  return () => {
    registryRead.off("TaskSubmitted", handler);
  };
}

export interface TaskSpec {
  taskType: "Verify" | "Execute";
  question?: string;
  action?: string;
  location: {
    lat: number;
    lng: number;
    address: string;
    radiusMeters: number;
  };
  target?: string;
  instructions?: string;
  successCriteria: string;
  proofRequired: string[];
  budgetUsdc: number;
  minConfidence: number;
  timeoutMinutes: number;
  checkpointStep?: number;
  resumeAction?: string;
  failureAction?: string;
}

export async function uploadTaskSpec(spec: TaskSpec): Promise<{ ipfsHash: string; specHash: string }> {
  const PINATA_JWT = process.env.PINATA_JWT;
  if (!PINATA_JWT) {
    throw new Error("PINATA_JWT missing from environment");
  }

  const specJson = JSON.stringify(spec);
  const specHash = ethers.keccak256(ethers.toUtf8Bytes(specJson));

  const blob = new Blob([specJson], { type: "application/json" });
  const formData = new FormData();
  formData.append("file", blob, `task-spec-${specHash}.json`);
  formData.append("pinataMetadata", JSON.stringify({ name: `task-spec-${specHash}` }));

  const response = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${PINATA_JWT}` },
    body: formData
  });

  if (!response.ok) {
    throw new Error(`Pinata upload failed: ${response.statusText}`);
  }

  const data = await response.json() as { IpfsHash: string };
  return { ipfsHash: data.IpfsHash, specHash };
}

export async function fetchTaskSpec(ipfsHash: string, expectedHash: string): Promise<TaskSpec> {
  const response = await fetch(`https://ipfs.io/ipfs/${ipfsHash}`, {});

  if (!response.ok) {
    throw new Error(`Failed to fetch task spec from IPFS: ${response.statusText}`);
  }

  const specJson = await response.text();
  const computedHash = ethers.keccak256(ethers.toUtf8Bytes(specJson));

  if (computedHash !== expectedHash) {
    throw new Error("Task spec hash mismatch. Data may have been tampered with.");
  }

  return JSON.parse(specJson) as TaskSpec;
}

export async function setAgentPolicy(
  policyHash: string,
  policyURI: string
): Promise<void> {
  try {
    const tx = await registryContract.setPolicy(policyHash, policyURI);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error("setPolicy transaction failed");
    }
  } catch (error) {
    throw new Error(`Failed to set policy: ${String(error)}`);
  }
}

export async function getAgentPolicy(
  agentAddress: string
): Promise<{ policyHash: string; policyURI: string }> {
  try {
    const [policyHash, policyURI] = await registryRead.getPolicy(agentAddress);
    return { policyHash, policyURI };
  } catch (error) {
    throw new Error(`Failed to get policy for ${agentAddress}: ${String(error)}`);
  }
}

export async function getAttestation(taskId: string): Promise<{
  taskId: string;
  scout: string;
  agent: string;
  confidenceBps: number;
  checkpointHash: string;
  captureHash: string;
  timestamp: number;
  isVerified: boolean;
} | null> {
  try {
    const isVerified = await attestationRead.isVerified(taskId);
    if (!isVerified) return null;

    const att = await attestationRead.getAttestation(taskId);

    return {
      taskId,
      scout: att.scout,
      agent: att.agent,
      confidenceBps: Number(att.confidenceBps),
      checkpointHash: att.checkpointHash,
      captureHash: att.captureHash,
      timestamp: Number(att.timestamp),
      isVerified: true
    };
  } catch (error) {
    throw new Error(`Failed to get attestation for ${taskId}: ${String(error)}`);
  }
}