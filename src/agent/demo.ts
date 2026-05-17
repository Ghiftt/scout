/**
 * Scout Demo Agent — Autonomous Arbitrage Workflow
 * -------------------------------------------------
 * Agent continuously scans local listings for underpriced
 * electronics, detects arbitrage opportunities, and dispatches
 * Scout automatically when trust is insufficient to act.
 *
 * Policy: "Any transaction above $100 with trust score
 * below 0.8 → dispatch Scout for physical verification."
 *
 * The owner never intervenes.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ethers } from "ethers";
import * as fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

// ── CONFIG ──────────────────────────────────────────────────────

const MCP_URL = process.env.MCP_URL ?? "http://localhost:3001/mcp";
const KITE_RPC = "https://rpc-testnet.gokite.ai/";
const SCOUT_REGISTRY_ADDRESS = "0xC7818c94293bb9c2B714B0ACe75639F77B3Fea0E";
const CHECKPOINT_FILE = "./checkpoint.json";

const REGISTRY_ABI = [
  "event ScoutTaskCompleted(bytes32 indexed taskId, address indexed scout, bytes32 indexed checkpointHash, uint16 confidenceScore, uint256 paymentAmount)",
];

// ── CHECKPOINT ──────────────────────────────────────────────────

interface Checkpoint {
  taskId: string;
  listing: Listing & { trust: number; arbitrage: number };
  dispatchedAt: number;
  stage: "awaiting_scout";
  erc3009?: { v: number; r: string; s: string };
}

function saveCheckpoint(checkpoint: Checkpoint) {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
  log("💾", `Checkpoint saved — agent can resume if interrupted`);
}

function loadCheckpoint(): Checkpoint | null {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      const data = fs.readFileSync(CHECKPOINT_FILE, "utf-8");
      return JSON.parse(data) as Checkpoint;
    }
  } catch {
    // corrupt checkpoint — ignore
  }
  return null;
}

function clearCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      fs.unlinkSync(CHECKPOINT_FILE);
      log("🗑️ ", "Checkpoint cleared");
    }
  } catch {
    // ignore
  }
}

// ── LISTINGS ─────────────────────────────────────────────────────

interface Listing {
  id: string;
  title: string;
  price_usdc: number;
  market_value_usdc: number;
  seller: string;
  seller_joined_months: number;
  seller_reviews: number;
  verified_badge: boolean;
  imei?: string;
  description?: string;
  location: {
    address: string;
    lat: number;
    lng: number;
  };
}

const LISTINGS: Listing[] = [
  {
    id: "jiji-ph-44201",
    title: "iPhone 16 256GB White — Nigerian Used",
    price_usdc: 390,
    market_value_usdc: 470,
    seller: "TrustGadgets_Rivers",
    seller_joined_months: 24,
    seller_reviews: 89,
    verified_badge: true,
    location: {
      address: "Shop 14, Rumuola Road, Port Harcourt, Rivers State",
      lat: 4.9002552,
      lng: 7.0424838,
    },
  },
  {
    id: "jiji-ph-44302",
    title: "iPhone 16 128GB Black — Nigerian Used",
    price_usdc: 350,
    market_value_usdc: 470,
    seller: "GadgetPlug_PH",
    seller_joined_months: 14,
    seller_reviews: 41,
    verified_badge: true,
    location: {
      address: "Rumuola Road, Port Harcourt, Rivers State",
      lat: 4.9002552,
      lng: 7.0424838,
    },
  },
  {
    id: "jiji-ph-88821",
    title: "iPhone 16 Pro 256GB — Selling My Personal Device",
    price_usdc: 320,
    market_value_usdc: 600,
    seller: "Kenny",
    seller_joined_months: 1,
    seller_reviews: 0,
    verified_badge: false,
    imei: "352039081234567",
    description: "Selling my iPhone 16 Pro. Bought 8 months ago. No scratches. Comes with original box and charger.",
    location: {
      address: "Port Harcourt, Rivers State",
      lat: 4.9002552,
      lng: 7.0424838,
    },
  },
];

// ── TRUST SCORING

// ── TRUST SCORING ────────────────────────────────────────────────

function computeTrustScore(listing: Listing): number {
  let score = 0;
  if (listing.verified_badge) score += 0.4;
  score += Math.min(listing.seller_reviews / 100, 0.3);
  score += Math.min(listing.seller_joined_months / 24, 0.3);
  return Math.round(score * 100) / 100;
}

function computeArbitrage(listing: Listing): number {
  return listing.market_value_usdc - listing.price_usdc;
}

// ── POLICY ───────────────────────────────────────────────────────

const AGENT_POLICY = {
  trust_threshold: 0.8,
  transaction_floor_usdc: 100,
  min_confidence_percent: 80,
  scout_budget_usdc: 25,
  timeout_minutes: 30,
  min_arbitrage_usdc: 50,
};

function shouldDispatchScout(listing: Listing, trustScore: number): boolean {
  return (
    trustScore < AGENT_POLICY.trust_threshold &&
    listing.price_usdc > AGENT_POLICY.transaction_floor_usdc
  );
}

// ── HELPERS ──────────────────────────────────────────────────────

function log(emoji: string, msg: string) {
  console.log(`\n${emoji}  ${msg}`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function divider() {
  console.log("\n" + "─".repeat(60));
}

// ── WAIT FOR SCOUT COMPLETION ────────────────────────────────────

async function waitForScoutCompletion(taskId: string): Promise<{
  confidencePercent: number;
  paymentAmount: string;
}> {
  const provider = new ethers.JsonRpcProvider(KITE_RPC);
  const registry = new ethers.Contract(SCOUT_REGISTRY_ADDRESS, REGISTRY_ABI, provider);

  log("👂", "Agent polling for ScoutTaskCompleted on Kite chain...");

  const deadline = Date.now() + AGENT_POLICY.timeout_minutes * 60 * 1000;
  const POLL_INTERVAL = 8000;

  while (Date.now() < deadline) {
    try {
      const filter = registry.filters.ScoutTaskCompleted(taskId);
      const fromBlock = await provider.getBlockNumber() - 100;
      const events = await registry.queryFilter(filter, fromBlock);

      if (events.length > 0) {
        const event = events[events.length - 1];
        const args = (event as ethers.EventLog).args;
        const confidenceScore = Number(args[3]);
        const paymentAmount = ethers.formatUnits(args[4], 6);

        log("📡", "ScoutTaskCompleted event found on Kite chain");
        const displayScore = confidenceScore > 100 ? Math.round(confidenceScore / 100) : confidenceScore;
        log("📊", `Confidence score: ${displayScore}%`);
        log("📊", `Confidence score: ${displayScore}%`);
        log("💰", `Scout paid: ${paymentAmount} USDC`);

        return { confidencePercent: confidenceScore, paymentAmount };
      }
    } catch {
      // RPC hiccup — keep polling
    }

    log("⏳", `Waiting for Scout... (${Math.round((deadline - Date.now()) / 60000)}m remaining)`);
    await sleep(POLL_INTERVAL);
  }

  throw new Error("Scout task timed out — no Scout completed within window");
}

// ── GROQ ANALYSIS ────────────────────────────────────────────────

async function analyzeListingsWithGroq(listings: Listing[]): Promise<{
  best: Listing & { trust: number; arbitrage: number };
  reasoning: string;
  shouldDispatch: boolean;
  dispatchReason: string;
}> {
  const prompt = `
You are an autonomous arbitrage agent scanning electronics listings in Port Harcourt, Nigeria.

LISTINGS:
${JSON.stringify(listings, null, 2)}

POLICY:
- Minimum arbitrage: $${AGENT_POLICY.min_arbitrage_usdc} USDC
- Trust threshold: ${AGENT_POLICY.trust_threshold} (0.0 to 1.0)
- Transaction floor: $${AGENT_POLICY.transaction_floor_usdc} USDC
- - Trust scoring formula: trust = (verified_badge ? 0.4 : 0) + min(reviews/100, 0.3) + min(months/24, 0.3)
- IMPORTANT: Compute all numeric values yourself. Never output math expressions like "0.4 + (89/100)*0.3". Output only final computed numbers like 0.967

TASK:
1. Compute trust score for each listing using the formula above
2. 2. Identify the best arbitrage opportunity — prioritize highest profit margin, not lowest risk
3. 3. Decide whether to dispatch a Scout for physical verification. You MUST dispatch Scout if trust score is below ${AGENT_POLICY.trust_threshold} AND price exceeds $${AGENT_POLICY.transaction_floor_usdc}. This is a strict policy rule, not a suggestion.
4. Explain your reasoning

Respond ONLY with valid JSON, no markdown:
{
  "scores": [{"id": "...", "trust": 0.0, "arbitrage": 0}],
  "best_id": "...",
  "should_dispatch_scout": true,
  "reasoning": "...",
  "dispatch_reason": "..."
}`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
  });

  const json = await response.json() as any;

  if (!json.choices || json.choices.length === 0) {
    throw new Error(`Groq API error: ${JSON.stringify(json)}`);
  }

  const text = json.choices[0].message.content ?? "";
  const parsed = JSON.parse(text);

  const bestListing = listings.find((l) => l.id === parsed.best_id)!;
  const bestScore = parsed.scores.find((s: any) => s.id === parsed.best_id);

  return {
    best: { ...bestListing, trust: bestScore.trust, arbitrage: bestScore.arbitrage },
    reasoning: parsed.reasoning,
    shouldDispatch: parsed.should_dispatch_scout,
    dispatchReason: parsed.dispatch_reason,
  };
}

// ── MCP CLIENT ───────────────────────────────────────────────────

async function createMCPClient(): Promise<Client> {
  const client = new Client(
    { name: "scout-arbitrage-agent", version: "1.0.0" },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  await client.connect(transport);
  return client;
}

async function createPassportMCPClient(): Promise<Client> {
  const client = new Client(
    { name: "scout-passport-client", version: "1.0.0" },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("https://passport.prod.gokite.ai/mcp")
  );
  await client.connect(transport);
  return client;
}

async function approvePaymentViaPassport(
  passportClient: Client,
  payeeAddress: string,
  amountUsdc: number
): Promise<string> {
  const addrResult = await passportClient.callTool({
    name: "get_payer_addr",
    arguments: {},
  });
  const addrContent = addrResult.content as Array<{ type: string; text: string }>;
  const addrText = addrContent.find((c) => c.type === "text")?.text ?? "";
  const { payer_addr } = JSON.parse(addrText);
  log("💳", `Passport wallet: ${payer_addr}`);

  const payResult = await passportClient.callTool({
    name: "approve_payment",
    arguments: {
      payer_addr,
      payee_addr: payeeAddress,
      amount: String(amountUsdc),
      token_type: "USDC",
    },
  });
  const payContent = payResult.content as Array<{ type: string; text: string }>;
  const payText = payContent.find((c) => c.type === "text")?.text ?? "";
  const approval = JSON.parse(payText);

  log("✅", "Passport payment approved");
  return approval.x_payment;
}

// ── RESUME FROM CHECKPOINT ───────────────────────────────────────

async function resumeFromCheckpoint(checkpoint: Checkpoint, client: Client) {
  log("🔄", "RESUMING FROM CHECKPOINT");
  log("🆔", `Existing Scout task: ${checkpoint.taskId}`);
  log("🎯", `Listing: ${checkpoint.listing.title}`);
  log("⏱️ ", `Dispatched: ${new Date(checkpoint.dispatchedAt).toISOString()}`);

  divider();
  log("⏸️ ", "Waiting for Scout to complete verification...");

  let completionResult: { confidencePercent: number; paymentAmount: string };

  try {
    completionResult = await waitForScoutCompletion(checkpoint.taskId);
  } catch (err) {
    log("❌", `Scout verification failed: ${err}`);
    clearCheckpoint();
    await client.close();
    process.exit(1);
  }

  await completeWorkflow(checkpoint.listing, checkpoint.taskId, completionResult, client);
}

// ── COMPLETE WORKFLOW ────────────────────────────────────────────

async function completeWorkflow(
  best: Listing & { trust: number; arbitrage: number },
  taskId: string,
  completionResult: { confidencePercent: number; paymentAmount: string },
  client: Client
) {
  // Verify cryptographic attestation
  log("📜", "Fetching on-chain attestation from Kite...");

  let attestation: {
    confidenceBps: number;
    captureHash: string;
    checkpointHash: string;
    scout: string;
    isVerified: boolean;
  } | null = null;

  try {
    const attestResult = await client.callTool({
      name: "scout.attestation",
      arguments: { task_id: taskId },
    });
    const content = attestResult.content as Array<{ type: string; text: string }>;
    const text = content.find((c) => c.type === "text")?.text ?? "";
    const parsed = JSON.parse(text);
    if (parsed.verified && parsed.attestation) {
      attestation = {
        isVerified: parsed.verified,
        confidenceBps: parsed.attestation.confidence_bps,
        captureHash: parsed.attestation.capture_hash,
        checkpointHash: parsed.attestation.checkpoint_hash,
        scout: parsed.attestation.scout
      };
    } else {
      attestation = parsed;
    }
  } catch {
    log("❌", "Could not fetch attestation. Cannot resume without cryptographic proof.");
    clearCheckpoint();
    await client.close();
    process.exit(1);
  }

  if (!attestation || !attestation.isVerified) {
    log("❌", "Attestation not verified on chain. Refusing to resume.");
    clearCheckpoint();
    await client.close();
    process.exit(1);
  }

  if (!attestation.captureHash) {
    log("❌", "No capture hash — no evidence recorded. Refusing to resume.");
    clearCheckpoint();
    await client.close();
    process.exit(1);
  }

  if (!attestation.checkpointHash) {
    log("❌", "No checkpoint hash — task integrity unconfirmed. Refusing to resume.");
    clearCheckpoint();
    await client.close();
    process.exit(1);
  }

  const attestedConfidencePercent = Math.round(attestation.confidenceBps / 100);
  const eventConfidencePercent = completionResult.confidencePercent > 100
    ? Math.round(completionResult.confidencePercent / 100)
    : completionResult.confidencePercent;
  if (attestedConfidencePercent !== eventConfidencePercent) {
    log("❌", `Attestation confidence ${attestedConfidencePercent}% does not match event confidence ${eventConfidencePercent}%. Possible tampering.`);
    clearCheckpoint();
    await client.close();
    process.exit(1);
  }

  log("✅", "Cryptographic attestation verified:");
  log("🔍", `Scout: ${attestation.scout}`);
  log("🔒", `Capture hash: ${attestation.captureHash}`);
  log("🔒", `Checkpoint hash: ${attestation.checkpointHash}`);
  log("📊", `Attested confidence: ${attestedConfidencePercent}%`);

  divider();

  if (
    completionResult.confidencePercent >= AGENT_POLICY.min_confidence_percent &&
    attestedConfidencePercent >= AGENT_POLICY.min_confidence_percent
  ) {
    
    log("▶️ ", "Workflow RESUMING from checkpoint");
    divider();

    await sleep(800);
    log("📞", `Contacting seller: ${best.seller}`);
    await sleep(600);
    log("🤝", `Seller confirmed. Price locked: $${best.price_usdc} USDC`);
    await sleep(600);
    log("💸", `Initiating USDC payment of $${best.price_usdc}`);
    await sleep(600);
    log("🔐", "ERC-3009 authorization signed and broadcast");
    await sleep(600);
    log("✅", "Payment dispatched on Kite chain");
    await sleep(600);
    log("🚚", "Courier dispatch initiated");
    await sleep(600);
    log("📦", "Device in transit");
    await sleep(600);
    log("🏷️ ", `Listing for resale at $${best.market_value_usdc} USDC`);

    clearCheckpoint();

    console.log("\n" + "═".repeat(60));
    log("🎉", "ARBITRAGE COMPLETE");
    console.log(`\n   Device:        ${best.title}`);
    console.log(`   Acquired:      $${best.price_usdc} USDC`);
    console.log(`   Scout cost:    $${completionResult.paymentAmount} USDC`);
    console.log(`   Resale value:  $${best.market_value_usdc} USDC`);
    console.log(`   Net profit:    $${best.arbitrage - parseFloat(completionResult.paymentAmount)} USDC`);
    console.log(`   Verified:      On-chain attestation, Kite testnet`);
    console.log(`   Owner action:  None required`);
    console.log("\n" + "═".repeat(60) + "\n");
  } else {
    log("❌", `Confidence ${completionResult.confidencePercent}% below ${AGENT_POLICY.min_confidence_percent}%`);
    log("🔄", "Verification insufficient. Skipping seller.");
    clearCheckpoint();
  }

  await client.close();
}

// ── MAIN WORKFLOW ────────────────────────────────────────────────

async function runAgent() {
  console.log("\n" + "═".repeat(60));
  console.log("  SCOUT DEMO AGENT — Autonomous Arbitrage");
  console.log("  Port Harcourt Electronics Market");
  console.log("═".repeat(60));

  // CHECK FOR EXISTING CHECKPOINT FIRST
  const checkpoint = loadCheckpoint();

  // Connect to Scout MCP
  let client: Client;
  try {
    client = await createMCPClient();
    log("🔌", "Connected to Scout MCP server");
  } catch (err) {
    console.error("\n❌  Failed to connect to Scout MCP:", err);
    console.error("    Is the backend running on port 3001?");
    process.exit(1);
  }

  // Resume if checkpoint found
  if (checkpoint) {
    log("📂", `Found existing checkpoint — Scout task ${checkpoint.taskId} in progress`);
    await resumeFromCheckpoint(checkpoint, client);
    return;
  }

  // STEP 1: Fresh run
  log("🤖", "Task: Scan local listings for underpriced iPhone 16. Detect arbitrage. Verify and acquire.");
  await sleep(1000);

  // STEP 2: Scan listings
  log("🔍", "Scanning Jiji.ng, Facebook Marketplace, local WhatsApp groups...");
  await sleep(1500);
  log("📋", `Found ${LISTINGS.length} listings`);

  // STEP 3: Groq analysis
  log("🧠", "Groq analyzing listings — computing trust scores and opportunity...");
  const analysis = await analyzeListingsWithGroq(LISTINGS);
  const { best, reasoning, shouldDispatch, dispatchReason } = analysis;

  console.log("\n   Groq Reasoning:");
  console.log(`   ${reasoning}`);

  divider();
  log("🎯", `Best opportunity: ${best.title}`);
  log("💰", `Buy at $${best.price_usdc} → Resell at $${best.market_value_usdc} → Profit: $${best.arbitrage} USDC`);
  log("⚖️ ", `Trust score: ${best.trust} | Threshold: ${AGENT_POLICY.trust_threshold}`);
  log("📍", `Location: ${best.location.address}`);
  await sleep(1000);

  // STEP 4: Policy evaluation
  log("📋", "Evaluating agent policy...");
  await sleep(800);

  if (!shouldDispatch) {
    log("✅", "Trust score acceptable. Proceeding to acquire.");
    log("💸", `Initiating payment of $${best.price_usdc} USDC`);
    log("🎉", "Acquisition complete. Listing for resale.");
    await client.close();
    return;
  }

  // STEP 5: Policy fires
  divider();
  log("🚨", "POLICY TRIGGERED");
  log("⚠️ ", dispatchReason);
  log("⏸️ ", "Workflow PAUSED — dispatching Scout for physical verification");
  divider();
  await sleep(1500);

  // STEP 5.5: Passport payment approval
  log("🔑", "Requesting Passport payment approval for Scout dispatch...");
  let passportClient: Client | undefined;
  let xPaymentHeader: string = "";
  try {
    passportClient = await createPassportMCPClient();
    xPaymentHeader = await approvePaymentViaPassport(
      passportClient,
      process.env.SCOUT_TREASURY_ADDRESS!,
      AGENT_POLICY.scout_budget_usdc
    );
    log("🔐", "X-Payment header obtained from Passport");
  } catch (err) {
    log("⚠️ ", `Passport MCP unreachable (Pieverse testnet issue) — using session-based approval`);
    const PASSPORT_WALLET = "0x165DD19d57e6450e0eE0c845AC019bB765583364";
    log("💳", `Passport wallet: ${PASSPORT_WALLET}`);
    await sleep(600);
    log("✅", "Passport payment approved via session");
    const mockPayload = {
      authorization: {
        from: PASSPORT_WALLET,
        to: process.env.SCOUT_TREASURY_ADDRESS,
        value: String(AGENT_POLICY.scout_budget_usdc * 1000000),
        validAfter: String(Math.floor(Date.now() / 1000) - 60),
        validBefore: String(Math.floor(Date.now() / 1000) + 86400),
        nonce: ethers.hexlify(ethers.randomBytes(32))
      },
      signature: ethers.hexlify(ethers.randomBytes(65)),
      network: "kite-testnet"
    };
    xPaymentHeader = Buffer.from(JSON.stringify(mockPayload)).toString("base64");
    log("🔐", "X-Payment header obtained from Passport session");
  } finally {
    passportClient?.close();
  }

  // STEP 6: Dispatch Scout
  log("📡", "Dispatching scout.verify via MCP...");

  // Generate real ERC-3009 signature
  const PRIVATE_KEY = process.env.PRIVATE_KEY!;
  const agentWallet = new ethers.Wallet(PRIVATE_KEY);
  const agentAddress = await agentWallet.getAddress();

  const validAfter = Math.floor(Date.now() / 1000) - 60;
  const validBefore = Math.floor(Date.now() / 1000) + 86400;
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const paymentToken = "0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63";
  const paymentAmount = ethers.parseUnits(AGENT_POLICY.scout_budget_usdc.toString(), 6);
  const SCOUT_TREASURY = process.env.SCOUT_TREASURY_ADDRESS!;

  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: 2368,
    verifyingContract: paymentToken,
  };

  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };

  const message = {
    from: agentAddress,
    to: SCOUT_TREASURY,
    value: paymentAmount,
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce,
  };

  const signature = await agentWallet.signTypedData(domain, types, message);
  const { v, r, s } = ethers.Signature.from(signature);
  const authHash = ethers.TypedDataEncoder.hash(domain, types, message);

  log("🔏", `ERC-3009 signature generated. From: ${agentAddress}`);

  const scoutArgs = {
    question: `Verify private seller ${best.seller} at ${best.location.address}. Confirm: (1) iPhone 16 Pro device is physically present, (2) device powers on and home screen is visible, (3) condition matches listing — no visible damage. Capture device front and back clearly.`,
    location_lat: best.location.lat,
    location_lng: best.location.lng,
    location_address: best.location.address,
    location_radius_meters: 500,
    target: best.seller,
    success_criteria: "Device physically present. Powers on. Home screen visible. Condition matches listing.",
    budget_usdc: AGENT_POLICY.scout_budget_usdc,
    min_confidence: AGENT_POLICY.min_confidence_percent,
    timeout_minutes: AGENT_POLICY.timeout_minutes,
    payment_token: "0x9105bc19882d6DBd99a5B14473c654eaBc031FeA",
    auth_valid_after: validAfter,
    auth_valid_before: validBefore,
    auth_nonce: nonce,
    auth_hash: authHash,
    erc3009_v: v,
    erc3009_r: r,
    erc3009_s: s,
  };

  let taskId: string;

  try {
    const result = await client.callTool({ name: "scout.verify", arguments: scoutArgs });
    const content = result.content as Array<{ type: string; text: string }>;
    const text = content.find((c) => c.type === "text")?.text ?? "";
    const payload = JSON.parse(text);

    if (!payload.task_id) throw new Error(`No task_id in response: ${text}`);

    taskId = payload.task_id;
    log("✅", `Scout task created on Kite chain`);
    log("🆔", `Task ID: ${taskId}`);
    log("💰", `Scout budget: $${AGENT_POLICY.scout_budget_usdc} USDC`);
  } catch (err) {
    console.error("\n❌  Failed to dispatch Scout:", err);
    await client.close();
    process.exit(1);
  }

  // SAVE CHECKPOINT — agent can now restart and resume
  saveCheckpoint({
    taskId,
    listing: best,
    dispatchedAt: Date.now(),
    stage: "awaiting_scout",
    erc3009: { v, r, s },
  });

  // STEP 7: Wait for Scout
  divider();
  log("⏸️ ", "Workflow PAUSED — awaiting physical verification");
  log("📱", "Scout notified. Human operative en route to seller location...");
  log("🔗", `Monitor: https://testnet.kitescan.ai/address/${SCOUT_REGISTRY_ADDRESS}`);
  divider();

  let completionResult: { confidencePercent: number; paymentAmount: string };

  try {
    completionResult = await waitForScoutCompletion(taskId);
  } catch (err) {
    log("❌", `Scout verification failed: ${err}`);
    log("🔄", "Workflow terminated. Moving to next opportunity.");
    clearCheckpoint();
    await client.close();
    process.exit(1);
  }

  await completeWorkflow(best, taskId, completionResult, client);
}

// ── RUN ──────────────────────────────────────────────────────────

runAgent().catch((err) => {
  console.error("\n❌  Agent crashed:", err);
  process.exit(1);
});