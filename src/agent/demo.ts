
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
import dotenv from "dotenv";
dotenv.config({ path: "../.env" });

// ── CONFIG ──────────────────────────────────────────────────────

const MCP_URL = process.env.MCP_URL ?? "http://localhost:3001/mcp";
const KITE_RPC = "https://rpc-testnet.gokite.ai/";
const SCOUT_REGISTRY_ADDRESS = "0xC7818c94293bb9c2B714B0ACe75639F77B3Fea0E";

const REGISTRY_ABI = [
  "event ScoutTaskCompleted(bytes32 indexed taskId, address indexed scout, bytes32 indexed checkpointHash, uint16 confidenceScore, uint256 paymentAmount)",
];

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
      lat: 4.903222,
      lng: 7.026528,
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
      lat: 4.903222,
      lng: 7.026528,
    },
  },
  {
    id: "jiji-ph-88821",
    title: "iPhone 16 Pro 256GB — Selling My Personal Device",
    price_usdc: 320,
    market_value_usdc: 600,
    seller: "KennyPH_Sells",
    seller_joined_months: 1,
    seller_reviews: 0,
    verified_badge: false,
    imei: "352039081234567",
    description: "Selling my iPhone 16 Pro. Bought 8 months ago. No scratches. Comes with original box and charger.",
    location: {
      address: "Port Harcourt, Rivers State",
      lat: 4.903222,
      lng: 7.026528,
    },
  },
];

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
        log("📊", `Confidence score: ${confidenceScore}%`);
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

// ── MAIN WORKFLOW ────────────────────────────────────────────────

async function runAgent() {
  console.log("\n" + "═".repeat(60));
  console.log("  SCOUT DEMO AGENT — Autonomous Arbitrage");
  console.log("  Port Harcourt Electronics Market");
  console.log("═".repeat(60));

  // STEP 1: Receive task
  log("🤖", "Task: Scan local listings for underpriced iPhone 16. Detect arbitrage. Verify and acquire.");
  await sleep(1000);

  // STEP 2: Scan listings
  log("🔍", "Scanning Jiji.ng, Facebook Marketplace, local WhatsApp groups...");
  await sleep(1500);
  log("📋", `Found ${LISTINGS.length} listings`);

  console.log("\n   Listings:");
  for (const listing of LISTINGS) {
    const trust = computeTrustScore(listing);
    const arbitrage = computeArbitrage(listing);
    console.log(`\n   • ${listing.title}`);
    console.log(`     Price: $${listing.price_usdc} USDC | Market: $${listing.market_value_usdc} USDC | Arbitrage: +$${arbitrage}`);
    console.log(`     Seller: ${listing.seller} | Trust: ${trust} | Reviews: ${listing.seller_reviews}`);
  }

  // STEP 3: Rank by arbitrage opportunity
  await sleep(1000);
  const ranked = [...LISTINGS]
    .map((l) => ({ ...l, trust: computeTrustScore(l), arbitrage: computeArbitrage(l) }))
    .filter((l) => l.arbitrage >= AGENT_POLICY.min_arbitrage_usdc)
    .sort((a, b) => b.arbitrage - a.arbitrage);

  log("📊", `${ranked.length} arbitrage opportunities detected above $${AGENT_POLICY.min_arbitrage_usdc} threshold`);

  const best = ranked[0];
  const trustScore = best.trust;
  const arbitrage = best.arbitrage;

  divider();
  log("🎯", `Best opportunity: ${best.title}`);
  log("💰", `Buy at $${best.price_usdc} → Resell at $${best.market_value_usdc} → Profit: $${arbitrage} USDC`);
  log("⚖️ ", `Trust score: ${trustScore} | Threshold: ${AGENT_POLICY.trust_threshold}`);
  log("📍", `Location: ${best.location.address}`);
  await sleep(1000);

  // STEP 4: Policy evaluation
  log("📋", "Evaluating agent policy...");
  await sleep(800);

  if (!shouldDispatchScout(best, trustScore)) {
    log("✅", "Trust score acceptable. Proceeding to acquire.");
    log("💸", `Initiating payment of $${best.price_usdc} USDC`);
    log("🎉", "Acquisition complete. Listing for resale.");
    return;
  }

  // STEP 5: Policy fires
  divider();
  log("🚨", "POLICY TRIGGERED");
  log("⚠️ ", `Trust score ${trustScore} below threshold ${AGENT_POLICY.trust_threshold}`);
  log("💰", `Transaction $${best.price_usdc} USDC exceeds floor $${AGENT_POLICY.transaction_floor_usdc} USDC`);
  log("⏸️ ", "Workflow PAUSED — dispatching Scout for physical verification");
  divider();
  await sleep(1500);

  // STEP 6: Connect MCP and dispatch Scout
  let client: Client;
  try {
    client = await createMCPClient();
    log("🔌", "Connected to Scout MCP server");
  } catch (err) {
    console.error("\n❌  Failed to connect to Scout MCP:", err);
    console.error("    Is the backend running on port 3001?");
    process.exit(1);
  }

  log("📡", "Dispatching scout.verify via MCP...");

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
    payment_token: "0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63",
    auth_valid_after: Math.floor(Date.now() / 1000) - 60,
    auth_valid_before: Math.floor(Date.now() / 1000) + 86400,
    auth_nonce: ethers.hexlify(ethers.randomBytes(32)),
    auth_hash: ethers.keccak256(ethers.toUtf8Bytes(`scout-${Date.now()}`)),
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
    log("💰", `Scout bounty: $${AGENT_POLICY.scout_budget_usdc} USDC locked`);
  } catch (err) {
    console.error("\n❌  Failed to dispatch Scout:", err);
    await client.close();
    process.exit(1);
  }

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
    await client.close();
    process.exit(1);
  }

  // STEP 8: Fetch attestation
  log("📜", "Fetching on-chain attestation...");
  try {
    const attestResult = await client.callTool({
      name: "scout.attestation",
      arguments: { task_id: taskId },
    });
    const content = attestResult.content as Array<{ type: string; text: string }>;
    const text = content.find((c) => c.type === "text")?.text ?? "";
    const attestation = JSON.parse(text);
    log("📜", `Attestation recorded on Kite — confidence ${attestation.confidence_bps ?? attestation.confidenceBps} bps`);
  } catch {
    log("⚠️ ", "Attestation fetch failed (non-fatal)");
  }

  // STEP 9: Resume or reject
  divider();

  if (completionResult.confidencePercent >= AGENT_POLICY.min_confidence_percent) {
    log("✅", `Confidence ${completionResult.confidencePercent}% meets requirement of ${AGENT_POLICY.min_confidence_percent}%`);
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

    console.log("\n" + "═".repeat(60));
    log("🎉", "ARBITRAGE COMPLETE");
    console.log(`\n   Device:        ${best.title}`);
    console.log(`   Acquired:      $${best.price_usdc} USDC`);
    console.log(`   Scout cost:    $${completionResult.paymentAmount} USDC`);
    console.log(`   Resale value:  $${best.market_value_usdc} USDC`);
    console.log(`   Net profit:    $${arbitrage - parseFloat(completionResult.paymentAmount)} USDC`);
    console.log(`   Verified:      On-chain attestation, Kite testnet`);
    console.log(`   Owner action:  None required`);
    console.log("\n" + "═".repeat(60) + "\n");
  } else {
    log("❌", `Confidence ${completionResult.confidencePercent}% below ${AGENT_POLICY.min_confidence_percent}%`);
    log("🔄", "Verification insufficient. Skipping seller.");
    log("🔍", "Scanning next opportunity...");
  }

  await client.close();
}

// ── RUN ──────────────────────────────────────────────────────────

runAgent().catch((err) => {
  console.error("\n❌  Agent crashed:", err);
  process.exit(1);
});
