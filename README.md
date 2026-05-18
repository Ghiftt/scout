

\# Scout



> Agents are brilliant until they hit the real world.  

> \*\*Scout is what happens next.\*\*



\*\*Scout is the physical interface layer for autonomous agents.\*\*



When an agent encounters physical uncertainty during execution, Scout automatically dispatches a verified human to gather ground truth, submit cryptographic proof onchain, and allow the agent to resume autonomously \*\*without requiring manual owner verification in normal execution paths.\*\*



\---



\## The Problem



Agents can execute digital workflows end-to-end.



But physical reality breaks autonomy.



An agent can:



✅ Find underpriced inventory  

✅ Analyze arbitrage opportunities  

✅ Negotiate digitally  

✅ Send payments on-chain



But it cannot answer:



❌ Does this seller actually exist?  

❌ Is the product real?  

❌ What is the actual condition of the item?  

❌ Is this location legitimate?





Without Scout, the owner must manually verify reality.



Autonomy breaks.



\---



\## The Solution: 



Scout is not a gig marketplace.



It is an \*\*interruptible physical oracle\*\* that agents call natively through MCP.



\- Agent Owner sets policy \*\*once\*\* via Kite Passport

\- Agent triggers Scout automatically when uncertainty is detected

\- Human Scouts complete location-based verification tasks

\- Proof is attested onchain

\- Agent resumes with high-confidence ground truth



Scout isn't discovered. It is invoked.



It lives inside the execution layer.



\---



\## What Scout Enables



\- Autonomous sourcing agents  

\- Physical inventory verification  

\- Delivery confirmation  

\- Trustless local commerce  

\- On-site inspections for AI workflows  

\- Autonomous physical commerce



\---



\## Why Now



Three shifts make Scout possible:



\- \*\*Autonomous agents are gaining spending authority\*\* through tools like Kite Passport.

\- \*\*Agents increasingly operate independently\*\* in commerce, sourcing, and execution workflows.

\- \*\*Physical verification remains the missing bottleneck\*\* preventing true autonomy.



Scout closes that gap.



\---



\## Core Capabilities



\### Observe



Verify physical facts agents cannot trust from digital records alone.



\- Is this seller real and present?

\- Does the product exist and match the listing?

\- What is the actual condition of the item?

\- Did the delivery occur as claimed?



\### Act



Execute real-world tasks agents cannot perform without a body.



\- Collect a package from a location

\- Conduct a safe handoff of goods

\- Perform an on-site inventory check

\- Confirm physical presence at a location



\---



\## How Scout Works



1\. Agent encounters physical uncertainty  

2\. Agent automatically dispatches a Scout  

3\. Human Scout gathers proof on-site  

4\. Proof is verified and attested onchain  

5\. Agent resumes execution autonomously



```mermaid

sequenceDiagram

&#x20;   participant Agent

&#x20;   participant Passport

&#x20;   participant Kite

&#x20;   participant Scout

&#x20;   participant Human

&#x20;   participant Groq



&#x20;   Agent->>Agent: Detects trust gap

&#x20;   Agent->>Passport: Requests payment approval within policy

&#x20;   Passport->>Agent: Approves payment

&#x20;   Agent->>Kite: createScoutTask()

&#x20;   Kite->>Scout: Task appears in PWA feed

&#x20;   Human->>Scout: Accepts task, GPS locks

&#x20;   Human->>Scout: Records proof on-site

&#x20;   Scout->>Gemini: Scores evidence via Vision API

&#x20;   Gemini->>Kite: Confidence score computed

&#x20;   Kite->>Kite: verifyAndPay() + ERC-3009 transfer

&#x20;   Kite->>Kite: ScoutAttestation written on-chain

&#x20;   Kite->>Agent: ScoutTaskCompleted event fires

&#x20;   Agent->>Agent: Verifies attestation and resumes workflow





\---



Demo: Autonomous Arbitrage



An arbitrage agent finds an underpriced iPhone 16 Pro listed at $320 in Port Harcourt.



Without Scout



Agent pauses

→ Owner manually verifies seller

→ Owner decides whether to proceed

→ Owner pays



Autonomy dies.



With Scout



Agent detects trust gap (unknown seller, unverified condition)

→ Policy fires automatically

→ Scout dispatched to seller location

→ Human Scout records device on-site

→ Gemini Vision scores evidence: 95% confidence

→ Proof attested onchain

→ Agent resumes and purchases item

→ Item relisted for $600



No manual owner verification required.



\---



Why Passport + Scout = Autonomous Physical Commerce



Passport gives agents controlled spending power.

Scout gives agents controlled physical presence.



Passport → Financial authority

Scout → Physical authority



Together, they enable autonomous physical commerce with no owner in the loop during normal execution paths.





\---



Users



Agent Owner



Configures spending policy once via Kite Passport, funds the session, and allows the agent to operate autonomously.



Human Scout



Opens the Scout PWA, sees nearby verification tasks, accepts a job, travels to the location, captures proof, submits verification, and receives instant payment.



The Agent



Detects physical uncertainty, dispatches Scout through MCP, waits for verified proof, and resumes execution autonomously.





\---



Architecture



Execution Layer



Autonomous Agent (TypeScript)



Policy Engine (trust-gap detection)



Scout MCP (7 native tools)



Kite Passport MCP (payment approval)





Coordination Layer



Scout Backend (Express + Railway)



x402 + Pieverse payment flow



ERC-3009 gasless delegated transfer





Verification Layer



Scout PWA (Vercel)



GPS location locking



Video evidence capture



Gemini Vision scoring





Trust Layer



ScoutRegistry (task lifecycle)



ScoutAttestation (permanent proof record)



Goldsky Subgraph (real-time indexing)



Event-driven workflow resumption







\---



Kite Primitives Used



Primitive	Role



Kite Passport MCP	Spending sessions and payment approval

x402 + Pieverse	Payment protocol for Scout dispatch

ERC-3009	Gasless delegated USDC transfer

ScoutRegistry	On-chain task lifecycle management

ScoutAttestation	Permanent cryptographic verification record

Goldsky	Real-time indexing and audit trail

MCP (7 tools)	Native agent integration layer







\---



Deployed Contracts (Kite Testnet — Chain ID 2368)



Contract	Address



ScoutRegistry	0xC7818c...Fea0E

ScoutAttestation	0x2eF75C...C375

MockUSDC	0x9105bc...FeA





Goldsky Subgraph:

https://api.goldsky.com/api/public/project\_cmp5ztad7km2b01uk2nwo0lpu/subgraphs/scout-registry/1.0.1/gn





\---



Live Demo



Scout PWA

https://scout-pwa.vercel.app



Scout Backend

https://scout-production-5c3a.up.railway.app



Demo Video

\[link]





\---



Challenges



Pieverse x402 non-functional for Kite testnet



The /v2/verify and /v2/settle endpoints currently return errors for eip155:2368.



I implemented a session-based fallback that preserves the intended Passport → x402 → ERC-3009 architecture.



The full x402 flow is expected to work correctly on mainnet.



The native testnet USDT does not implement transferWithAuthorization.



To preserve the correct payment architecture, we deployed MockUSDC (0x9105bc...) with a compliant ERC-3009 implementation so the full gasless payment flow could be demonstrated end-to-end.



The architecture remains mainnet-ready.



Kite RPC intermittent connectivity



The Kite testnet RPC (rpc-testnet.gokite.ai) experienced intermittent ECONNRESET and timeout errors during development.



I added retry logic to all on-chain reads and designed the agent checkpoint system so workflows can resume safely across RPC failures without losing state



Cryptographic proof chain



Designing a verification system an agent can trust required more than a confidence score.



We implemented a complete cryptographic proof chain:



Bundle hash computed client-side



Submitted onchain via submitProof()



Permanently attested through ScoutAttestation



Verified by the agent before resuming execution





The agent refuses to proceed if any link in the chain is missing or mismatched.





\---



Running Locally



git clone https://github.com/Ghiftt/scout

git clone https://github.com/Ghiftt/scout-pwa



\# Terminal 1 — Backend

cd scout \&\& npm start



\# Terminal 2 — MCP Server

cd scout \&\& npm run mcp



\# Terminal 3 — Agent

cd scout \&\& npm run agent



Clear state before each run:



rm -f checkpoint.json scout.db





\---



Vision



AI agents should not stop at the browser.



They should operate safely in the physical world: verifying sellers, confirming deliveries, inspecting goods, and executing commerce without requiring human intervention for routine verification.



Scout turns physical uncertainty into a solvable infrastructure problem.







