# Scout

> Agents are brilliant until they hit the real world.
> **Scout is what happens next.**

**Scout is the physical interface layer for autonomous agents.**

When an agent encounters physical uncertainty during execution, Scout automatically dispatches a verified human to gather ground truth, submit cryptographic proof onchain, and allow the agent to resume autonomously — **without requiring manual owner verification in normal execution paths.**

The agent pauses. Scout verifies or executes in the real world. Proof is recorded onchain. The agent resumes exactly where it left off.

---

## The Problem

Agents can now execute digital workflows end-to-end.

They can:

✅ Find underpriced inventory
✅ Analyze opportunities
✅ Negotiate digitally
✅ Send payments on-chain
✅ Coordinate workflows autonomously

But physical reality breaks autonomy.

Agents cannot answer:

❌ Does this seller actually exist?
❌ Is the product real?
❌ What is the actual condition of the item?
❌ Is this location legitimate?
❌ Did the delivery actually happen?

An agent may know exactly what action to take.

But it cannot verify reality.
And it cannot physically act.

Without Scout, the owner must manually intervene to inspect, confirm, or execute. Autonomy dies.

---

## The Solution

Scout is an **agent-native physical execution and verification layer**.

It is not a gig marketplace.

It is an **interruptible physical oracle** that agents invoke natively through MCP.

* Agent owner sets policy once via Kite Passport
* Agent detects a physical trust gap during execution
* Scout dispatches a nearby human automatically
* Physical proof is captured and attested onchain
* Agent resumes autonomously with high-confidence ground truth

Scout is not discovered.

**It is invoked.**

It lives inside the execution layer.

```txt
Agent detects uncertainty
          ↓
Scout dispatched automatically
          ↓
Human verifies or executes task
          ↓
Proof written onchain
          ↓
Agent resumes autonomously
```

---

## Why Scout Is Different

Most human task systems are marketplaces.

Scout is infrastructure.

Humans are not the center of the workflow.
They are execution primitives inside an autonomous system.

Scout is:

* Policy-triggered
* Agent-native
* Invoked through MCP
* Cryptographically verifiable
* Event-driven
* Resumable by autonomous agents

The owner does not manually coordinate execution.
The agent handles it.

---

## What Scout Enables

### Verify

Gather trusted physical truth when digital information is insufficient.

* Verify seller legitimacy
* Confirm inventory exists
* Inspect product condition
* Validate property claims
* Confirm delivery completion

### Execute

Perform real-world tasks agents cannot do without a body.

* Pick up items from a location
* Coordinate safe handoffs
* Execute inventory checks
* Verify local presence
* Complete offline commerce workflows

### Resume

Return structured, cryptographically verifiable proof back to the agent so execution continues autonomously.

This is Scout’s core primitive:

> pause → verify/execute → attest → resume

---

## Why Now

Three shifts make Scout possible:

### 1. Agents are gaining spending authority

Tools like Kite Passport allow agents to operate with policy-constrained budgets.

### 2. Agents increasingly execute real workflows

Autonomous systems are already being used for sourcing, commerce, negotiation, logistics, and coordination.

### 3. Physical trust remains the missing bottleneck

Agents can reason digitally.

But they still cannot independently verify or execute in the real world.

Scout closes that gap.

---

## How Scout Works

1. Agent encounters physical uncertainty
2. Agent requests approval via Kite Passport policy
3. Scout task is created automatically
4. Nearby human Scout accepts the task
5. Proof is gathered on-site
6. Evidence is scored and attested onchain
7. Agent receives cryptographic proof
8. Agent resumes execution autonomously

```txt
Agent        → detects trust gap
Agent        → Passport: request payment approval within policy
Passport     → Agent: approves payment
Agent        → Kite: createScoutTask()
Kite         → Scout PWA: task appears in feed
Human        → Scout: accepts task, GPS locks
Human        → Scout: records proof on-site
Scout        → Gemini Vision: score evidence
Gemini       → Kite: confidence score computed
Kite         → Kite: verifyAndPay() + ERC-3009 transfer
Kite         → Kite: ScoutAttestation written on-chain
Kite         → Agent: ScoutTaskCompleted event fires
Agent        → Agent: verifies attestation and resumes workflow
```

---

## Demo: Autonomous Arbitrage

An autonomous arbitrage agent finds an underpriced iPhone 16 Pro listed at **$320** in Port Harcourt.

Market value: **$600**.

### Without Scout

Agent pauses → Owner manually verifies seller → Owner decides whether to proceed → Owner pays.

**Autonomy dies.**

### With Scout

Agent detects trust gap:

* unknown seller
* unverified condition
* no trusted physical proof

Policy fires automatically.

Scout dispatches a nearby human.

The Scout visits the seller location, records video evidence, and submits proof.

Gemini Vision scores evidence at **95% confidence**.

Proof is attested onchain.

ScoutTaskCompleted fires.

The agent verifies the attestation, resumes execution, purchases the device, and relists for resale.

**Net profit: $255.**

No manual owner verification required.

---

## Why Passport + Scout = Autonomous Physical Commerce

Passport gives agents controlled spending power.

Scout gives agents controlled physical presence.

* **Passport → Financial authority**
* **Scout → Physical authority**

Together, they enable autonomous physical commerce with no owner in the loop during normal execution paths.

---

## Users

### Agent Owner

Configures spending policy once via Kite Passport, funds the session, and allows the agent to operate autonomously.

### Human Scout

Opens the Scout PWA, sees nearby verification tasks, accepts a job, travels to the location, captures proof, submits verification, and receives payment.

### The Agent

Detects physical uncertainty, dispatches Scout through MCP, waits for verified proof, and resumes execution autonomously.

---

## Architecture

### Execution Layer

* Autonomous Agent (TypeScript)
* Trust-Gap Detection Engine
* Kite Passport MCP (payment approval)
* Scout MCP (7 native tools)

| Tool              | Description                                                    |
| ----------------- | -------------------------------------------------------------- |
| scout.verify      | Dispatch a Scout to verify a physical fact on-site             |
| scout.execute     | Dispatch a Scout to execute a physical task                    |
| scout.status      | Poll status of an active Scout task                            |
| scout.cancel      | Cancel an open task before Scout accepts it                    |
| scout.policy.set  | Set agent dispatch policy — triggers, budgets, thresholds      |
| scout.policy.get  | Retrieve and verify active policy from chain + IPFS            |
| scout.attestation | Fetch permanent cryptographic attestation for a completed task |

### Coordination Layer

* Scout Backend (Express + Railway)
* x402 + Pieverse payment flow
* ERC-3009 gasless delegated transfer

### Verification Layer

* Scout PWA (Vercel)
* GPS location locking
* Video evidence capture
* Gemini Vision scoring

### Trust Layer

* ScoutRegistry (task lifecycle)
* ScoutAttestation (permanent proof record)
* Goldsky Subgraph (real-time indexing)
* Event-driven workflow resumption

---

## Kite Primitives Used

| Primitive         | Role                                        |
| ----------------- | ------------------------------------------- |
| Kite Passport MCP | Spending sessions and payment approval      |
| x402 + Pieverse   | Payment protocol for Scout dispatch         |
| ERC-3009          | Gasless delegated USDC transfer             |
| ScoutRegistry     | On-chain task lifecycle management          |
| ScoutAttestation  | Permanent cryptographic verification record |
| Goldsky           | Real-time indexing and audit trail          |
| MCP (7 tools)     | Native agent integration layer              |

---

## Deployed Contracts (Kite Testnet — Chain ID 2368)

| Contract         | Address                                    |
| ---------------- | ------------------------------------------ |
| ScoutRegistry    | 0xC7818c94293bb9c2B714B0ACe75639F77B3Fea0E |
| ScoutAttestation | 0x2eF75C17637b0ec010e3b2748b0451095542C375 |
| MockUSDC         | 0x9105bc19882d6DBd99a5B14473c654eaBc031FeA |

Goldsky Subgraph:

[https://api.goldsky.com/api/public/project_cmp5ztad7km2b01uk2nwo0lpu/subgraphs/scout-registry/1.0.1/gn](https://api.goldsky.com/api/public/project_cmp5ztad7km2b01uk2nwo0lpu/subgraphs/scout-registry/1.0.1/gn)

---

## Live Demo

Scout PWA: [https://scout-pwa.vercel.app](https://scout-pwa.vercel.app)

Scout Backend: [https://scout-production-5c3a.up.railway.app](https://scout-production-5c3a.up.railway.app)

Demo Video: [https://youtu.be/Kv1ODQTP25g](https://youtu.be/Kv1ODQTP25g)

Scout PWA repo: [https://github.com/Ghiftt/scout-pwa](https://github.com/Ghiftt/scout-pwa)

---

## Challenges

### Pieverse x402 non-functional for Kite testnet

The `/v2/verify` and `/v2/settle` endpoints currently return errors for `eip155:2368`.

I implemented a session-based fallback that preserves the intended Passport → x402 → ERC-3009 architecture.

The full x402 flow is expected to function correctly on mainnet.

### Native testnet USDT does not implement `transferWithAuthorization`

To preserve the intended payment architecture, I deployed MockUSDC (`0x9105bc19882d6DBd99a5B14473c654eaBc031FeA`) with a compliant ERC-3009 implementation so the full gasless payment flow could be demonstrated end-to-end.

The architecture remains mainnet-ready.

### Kite RPC intermittent connectivity

The Kite testnet RPC (`rpc-testnet.gokite.ai`) experienced intermittent `ECONNRESET` and timeout errors during development.

I added retry logic to all on-chain reads and designed the agent checkpoint system so workflows resume safely across RPC failures without losing state.

### Cryptographic proof chain

Designing a verification system an agent could trust required more than a confidence score.

I implemented a complete cryptographic proof chain:

bundle hash computed client-side → submitted onchain via `submitProof()` → permanently attested through ScoutAttestation → verified by the agent before resuming execution.

The agent refuses to proceed if any link in the chain is missing or mismatched.

---

## Running Locally

```bash
git clone https://github.com/Ghiftt/scout
git clone https://github.com/Ghiftt/scout-pwa

# Terminal 1 — Backend
cd scout && npm start

# Terminal 2 — MCP Server
cd scout && npm run mcp

# Terminal 3 — Agent
cd scout && npm run agent

# Clear state before each run
rm -f checkpoint.json scout.db
```

---

## Vision

AI agents should not stop at the browser.

They should safely operate in the physical world: verifying sellers, confirming deliveries, inspecting goods, and executing commerce without requiring human intervention for routine verification. 

Scout turns physical uncertainty into a solvable infrastructure problem.
