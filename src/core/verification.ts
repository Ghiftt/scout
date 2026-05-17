import { GoogleGenerativeAI } from "@google/generative-ai";
import { ethers } from "ethers";
import { verifyAndPay, rejectTask, failTask, getTaskStatus } from "./contract.js";
import { createHash } from "crypto";
import dotenv from "dotenv";
import { provider } from "./contract.js";

dotenv.config();

// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════


({
  model: "gemini-2.0-flash",
  generationConfig: {
    responseMimeType: "application/json"
  }
});

const MAX_RADIUS_METERS = 5000;
const MAX_VIDEO_BYTES = 25 * 1024 * 1024; // 25MB
const ALLOWED_MIME_TYPES = ["video/mp4", "video/webm", "video/quicktime"];

// Composite scoring weights
const GPS_WEIGHT = 0.35;
const TIMESTAMP_WEIGHT = 0.15;
const GEMINI_WEIGHT = 0.50;

// ═══════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════

export interface CaptureBundle {
  taskId: string;
  scoutAddress: string;
  videoBase64: string;
  videoMimeType: string;
  gps: {
    lat: number;
    lng: number;
    accuracy: number;
    timestamp: number;
  };
  deviceTimestamp: number;
  bundleHash: string;
}

export interface VerificationResult {
  passed: boolean;
  confidenceScore: number;
  reason: string;
  txHash?: string;
  observations: {
    item_present?: boolean;
    price_confirmed?: string;
    condition?: string;
    action_completed?: boolean;
    proof_items?: string[];
    notes?: string;
  };
  captureURI: string;
  scoreBreakdown: {
    gpsScore: number;
    timestampScore: number;
    geminiScore: number;
    finalScore: number;
  };
}

// ═══════════════════════════════════════════
// INPUT SANITIZATION
// ═══════════════════════════════════════════

function sanitize(input: string): string {
  return input.replace(/[{}<>`]/g, "").slice(0, 500);
}

// ═══════════════════════════════════════════
// BUNDLE INTEGRITY
// ═══════════════════════════════════════════

function verifyBundleHash(bundle: CaptureBundle): boolean {
  const canonical = JSON.stringify({
    videoBase64: bundle.videoBase64,
    gps: {
      lat: bundle.gps.lat,
      lng: bundle.gps.lng,
      accuracy: bundle.gps.accuracy,
      timestamp: bundle.gps.timestamp
    },
    deviceTimestamp: bundle.deviceTimestamp
  });
  const computed = "0x" + createHash("sha256")
  .update(canonical)
  .digest("hex");

  return computed === bundle.bundleHash;
}

function validateMimeType(mimeType: string): void {
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    throw new Error(`Unsupported video type: ${mimeType}. Allowed: ${ALLOWED_MIME_TYPES.join(", ")}`);
  }
}

function validateVideoSize(videoBase64: string): void {
  const size = Buffer.byteLength(videoBase64, "base64");
  if (size > MAX_VIDEO_BYTES) {
    throw new Error(`Video exceeds size limit of ${MAX_VIDEO_BYTES / 1024 / 1024}MB`);
  }
}

// ═══════════════════════════════════════════
// GPS VALIDATION
// ═══════════════════════════════════════════

function calculateDistance(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) *
    Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function scoreGPS(
  scoutLat: number, scoutLng: number,
  taskLat: number, taskLng: number,
  radiusMeters: number = MAX_RADIUS_METERS
): { score: number; distanceMeters: number; valid: boolean } {
  const distance = calculateDistance(scoutLat, scoutLng, taskLat, taskLng);
  const valid = distance <= radiusMeters;

  // Score decreases linearly from 100 at center to 0 at radius boundary
  const score = valid
    ? Math.round(100 * (1 - distance / radiusMeters))
    : 0;

  return { score, distanceMeters: Math.round(distance), valid };
}

// ═══════════════════════════════════════════
// TIMESTAMP VALIDATION
// ═══════════════════════════════════════════

async function scoreTimestamp(
  captureTimestamp: number,
  taskCreatedAt: number,
  taskExpiresAt: number,
  chainTimestamp: number
): Promise<{ score: number; valid: boolean; reason: string }> {
  const captureTime = captureTimestamp * 1000;
  const taskStart = taskCreatedAt * 1000;
  const taskEnd = taskExpiresAt * 1000;
  const chainTime = chainTimestamp * 1000;

  if (captureTime < taskStart) {
    return { score: 0, valid: false, reason: "Capture happened before task was created" };
  }

  if (captureTime > taskEnd) {
    return { score: 0, valid: false, reason: "Capture happened after task expired" };
  }

  // Allow 5 minute clock drift between device and chain
  const drift = Math.abs(captureTime - chainTime);
  if (drift > 5 * 60 * 1000) {
    return { score: 0, valid: false, reason: `Device clock drift too large: ${Math.round(drift / 1000)}s` };
  }

  return { score: 100, valid: true, reason: "Timestamp valid" };
}

// ═══════════════════════════════════════════
// GEMINI VISION SCORING
// ═══════════════════════════════════════════

async function extractFirstFrame(videoBase64: string, mimeType: string): Promise<string> {
  // Write video to temp file, extract frame with ffmpeg
  const { execSync } = await import("child_process");
  const { writeFileSync, readFileSync, unlinkSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { join } = await import("path");

  const ext = mimeType.includes("mp4") ? "mp4" : "webm";
  const inputPath = join(tmpdir(), `scout-video-${Date.now()}.${ext}`);
  const outputPath = join(tmpdir(), `scout-frame-${Date.now()}.jpg`);

  try {
    writeFileSync(inputPath, Buffer.from(videoBase64, "base64"));
    execSync(`ffmpeg -i "${inputPath}" -vframes 1 -q:v 2 "${outputPath}" -y`, { stdio: "ignore" });
    const frameBase64 = readFileSync(outputPath).toString("base64");
    return frameBase64;
  } finally {
    try { unlinkSync(inputPath); } catch {}
    try { unlinkSync(outputPath); } catch {}
  }
}

async function scoreWithGemini(
  videoBase64: string,
  mimeType: string,
  taskType: string,
  successCriteria: string,
  proofRequired: string[]
): Promise<{
  score: number;
  observations: VerificationResult["observations"];
  reasoning: string;
}> {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY missing from environment");

  const cleanCriteria = sanitize(successCriteria);
  const cleanProof = proofRequired.map(sanitize).join(", ") || "standard visual verification";
  const isVerify = taskType === "Verify";

  const prompt = isVerify
    ? `You are verifying physical reality for an autonomous AI agent.
Task type: VERIFICATION
Success criteria: ${cleanCriteria}
Required proof items: ${cleanProof}

Respond ONLY with JSON, no markdown:
{
  "score": <number 0-100>,
  "item_present": <boolean>,
  "price_confirmed": "<string or null>",
  "condition": "<good|fair|poor|damaged|unknown>",
  "notes": "<brief observation>",
  "reasoning": "<why you gave this score>"
}

Score guide: 90-100 all criteria met, 70-89 most met, 50-69 partial, 0-49 insufficient.`
    : `You are verifying physical task completion for an autonomous AI agent.
Task type: EXECUTION
Success criteria: ${cleanCriteria}
Required proof items: ${cleanProof}

Respond ONLY with JSON, no markdown:
{
  "score": <number 0-100>,
  "action_completed": <boolean>,
  "proof_items": [<evidence items visible>],
  "notes": "<brief observation>",
  "reasoning": "<why you gave this score>"
}

Score guide: 90-100 all proof present, 70-89 most present, 50-69 partial, 0-49 insufficient.`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [
        {
          role: "user",
          content: [
            {
            type: "image_url",
            image_url: {
             url: `data:image/jpeg;base64,${await extractFirstFrame(videoBase64, mimeType)}`
           }
        },
            {
              type: "text",
              text: prompt
            }
          ]
        }
      ],
      response_format: { type: "json_object" },
      max_tokens: 500,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq vision error: ${response.status} ${err}`);
  }

  const json = await response.json() as {
    choices: Array<{ message: { content: string } }>
  };

  const parsed = JSON.parse(json.choices[0].message.content);

  return {
    score: Math.min(100, Math.max(0, Number(parsed.score) || 0)),
    observations: {
      item_present: parsed.item_present,
      price_confirmed: parsed.price_confirmed,
      condition: parsed.condition,
      action_completed: parsed.action_completed,
      proof_items: parsed.proof_items,
      notes: parsed.notes
    },
    reasoning: parsed.reasoning || "No reasoning provided"
  };
}

// ═══════════════════════════════════════════
// PINATA UPLOAD
// ═══════════════════════════════════════════

async function uploadToPinata(
  videoBase64: string,
  taskId: string,
  mimeType: string
): Promise<string> {
  const PINATA_JWT = process.env.PINATA_JWT;
  if (!PINATA_JWT) {
    throw new Error("PINATA_JWT missing from environment");
  }

  const buffer = Buffer.from(videoBase64, "base64");
  const blob = new Blob([buffer], { type: mimeType });
  const formData = new FormData();
  formData.append("file", blob, `scout-capture-${taskId}.mp4`);
  formData.append(
    "pinataMetadata",
    JSON.stringify({ name: `scout-capture-${taskId}` })
  );

  const response = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${PINATA_JWT}` },
    body: formData
  });

  if (!response.ok) {
    throw new Error(`Pinata upload failed: ${response.statusText}`);
  }

  const data = await response.json() as { IpfsHash: string };
  return `ipfs://${data.IpfsHash}`;
}

// ═══════════════════════════════════════════
// MAIN VERIFICATION FUNCTION
// ═══════════════════════════════════════════

export async function processVerification(
  bundle: CaptureBundle,
  taskLocation: { lat: number; lng: number; radiusMeters?: number },
  erc3009Sig: { v: number; r: string; s: string }
): Promise<VerificationResult> {

  // Step 1 — Fetch task state from chain
  const task = await getTaskStatus(bundle.taskId);

  if (task.status !== "Submitted" && task.status !== "Open") {
    throw new Error(`Invalid task state: ${task.status}. Expected Open or Submitted.`);
  }

  // Step 2 — Input validation
  try {
    validateMimeType(bundle.videoMimeType);
    validateVideoSize(bundle.videoBase64);
  } catch (error) {
    await failTask(bundle.taskId, String(error));
    return {
      passed: false,
      confidenceScore: 0,
      reason: String(error),
      observations: {},
      captureURI: "",
      scoreBreakdown: { gpsScore: 0, timestampScore: 0, geminiScore: 0, finalScore: 0 }
    };
  }

  // Step 3 — Bundle integrity check
  if (!verifyBundleHash(bundle)) {
    await failTask(bundle.taskId, "Bundle hash verification failed. Data may have been tampered with.");
    return {
      passed: false,
      confidenceScore: 0,
      reason: "Bundle integrity check failed",
      observations: {},
      captureURI: "",
      scoreBreakdown: { gpsScore: 0, timestampScore: 0, geminiScore: 0, finalScore: 0 }
    };
  }

  // Step 4 — GPS scoring
  const gpsResult = scoreGPS(
    bundle.gps.lat,
    bundle.gps.lng,
    taskLocation.lat,
    taskLocation.lng,
    taskLocation.radiusMeters
  );

  if (!gpsResult.valid) {
    await rejectTask(
      bundle.taskId,
      `GPS validation failed. Scout was ${gpsResult.distanceMeters}m from required location.`
    );
    return {
      passed: false,
      confidenceScore: 0,
      reason: `Scout too far: ${gpsResult.distanceMeters}m from required location`,
      observations: {},
      captureURI: "",
      scoreBreakdown: { gpsScore: 0, timestampScore: 0, geminiScore: 0, finalScore: 0 }
    };
  }

  // Step 5 — Timestamp scoring using chain time
  const chainBlock = await provider.getBlock("latest");
  const chainTimestamp = chainBlock?.timestamp ?? Math.floor(Date.now() / 1000);

  const timestampResult = await scoreTimestamp(
    bundle.deviceTimestamp,
    task.createdAt,
    task.expiresAt,
    chainTimestamp
  );

  if (!timestampResult.valid) {
    await rejectTask(bundle.taskId, timestampResult.reason);
    return {
      passed: false,
      confidenceScore: 0,
      reason: timestampResult.reason,
      observations: {},
      captureURI: "",
      scoreBreakdown: { gpsScore: gpsResult.score, timestampScore: 0, geminiScore: 0, finalScore: 0 }
    };
  }

  // Step 6 — Gemini scoring
  let geminiResult;
  try {
    geminiResult = await scoreWithGemini(
      bundle.videoBase64,
      bundle.videoMimeType,
      task.taskType,
      task.proofRequired.join(", ") || "verify physical reality",
      task.proofRequired
    );
  } catch (error) {
    await failTask(bundle.taskId, `Vision scoring failed: ${String(error)}`);
    return {
      passed: false,
      confidenceScore: 0,
      reason: `Vision scoring failed: ${String(error)}`,
      observations: {},
      captureURI: "",
      scoreBreakdown: { gpsScore: gpsResult.score, timestampScore: timestampResult.score, geminiScore: 0, finalScore: 0 }
    };
  }

  // Step 7 — Composite scoring
  const finalScore = Math.round(
    gpsResult.score * GPS_WEIGHT +
    timestampResult.score * TIMESTAMP_WEIGHT +
    geminiResult.score * GEMINI_WEIGHT
  );

  const passed = finalScore >= task.minConfidence;

  // Step 8 — Upload to Pinata only if passed or high gemini score (audit retention)
  let captureURI = "";
  if (passed || geminiResult.score >= 60) {
    try {
      captureURI = await uploadToPinata(
        bundle.videoBase64,
        bundle.taskId,
        bundle.videoMimeType
      );
    } catch (error) {
      await failTask(bundle.taskId, `Storage upload failed: ${String(error)}`);
      return {
        passed: false,
        confidenceScore: finalScore,
        reason: `Upload failed: ${String(error)}`,
        observations: geminiResult.observations,
        captureURI: "",
        scoreBreakdown: {
          gpsScore: gpsResult.score,
          timestampScore: timestampResult.score,
          geminiScore: geminiResult.score,
          finalScore
        }
      };
    }
  }

  // Step 9 — Settle on chain
  // Step 9 — Settle on chain
  let verifyTxHash = "";
  if (passed) {
    const txHash = await verifyAndPay(
      bundle.taskId,
      finalScore * 100,
      erc3009Sig.v,
      erc3009Sig.r,
      erc3009Sig.s
    );
    verifyTxHash = txHash;
  } else {
    await rejectTask(
      bundle.taskId,
      `Composite score ${finalScore} below threshold ${task.minConfidence}. GPS: ${gpsResult.score}, Timestamp: ${timestampResult.score}, Vision: ${geminiResult.score}`
    );
  }

  return {
    passed,
    confidenceScore: finalScore,
    reason: geminiResult.reasoning,
    observations: geminiResult.observations,
    captureURI,
    txHash: verifyTxHash,
    scoreBreakdown: {
      gpsScore: gpsResult.score,
      timestampScore: timestampResult.score,
      geminiScore: geminiResult.score,
      finalScore
    }
  };
}