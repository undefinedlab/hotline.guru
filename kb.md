# hotline.guru — Knowledge Base (idea stage)

> Working notes for an Encode / Circle Arc hackathon build. Not a build plan — collect ideas, contrasts, and stack notes.
> Last updated: 2026-07-19

---

## 1. One-liner (our idea)

**Call or text your agent. Tell it what to do. It spends USDC on Arc — securely, with policy limits — no bank, no app, no Uniswap.**

Working name: **hotline.guru**  
Inspiration: [Text-to-Chain](https://github.com/minrawsjar/Text-to-Chain) (SMS → DeFi), extended to **voice** and narrowed to **USDC-native agentic economy on Arc**.

---

## 2. Inspiration: Text-to-Chain (what they did)

**Repo:** https://github.com/minrawsjar/Text-to-Chain  
**Tagline:** DeFi for feature-phone users via SMS + AI agents. Built for ETHglobal / Circle Arc track.

### Problem they solve
- 2.5B feature-phone users; no smartphone / MetaMask / bank on-ramp
- Crypto UX (seed phrases, gas, chains) is the barrier, not “interest”
- Meet people on **SMS** (and USSD / airtime in Africa)

### What the user experiences
| Command | Effect |
|---------|--------|
| `JOIN alice` | Create wallet + ENS subdomain `alice.ttcip.eth` |
| `BALANCE` / `DEPOSIT` | Check funds / get address |
| `SEND 10 TXTC TO bob.ttcip.eth` | Transfer (Yellow Network batched) |
| `SWAP` / `BRIDGE` / `CASHOUT` | DeFi actions via SMS |
| `PIN` / `CONTACTS` | Security + address book |

### Their architecture (compressed)
```
Feature phone → SMS → Twilio → Rust webhook
  → Backend (TS) / Yellow batch / Arc-CCTP / Airtime
  → Sepolia (TXTC, Uniswap, ENS) ──CCTP──► Arc (USDC + Circle wallets)
```

### Stack they used
| Piece | Role |
|-------|------|
| Twilio | SMS gateway |
| Rust + Axum | Command parser + auth (phone → wallet) |
| Postgres/SQLite | Users, vouchers, contacts; **encrypted keys server-side** |
| TXTC ERC-20 + vouchers | Local economy token |
| Uniswap V3 | Swaps (TXTC ↔ ETH/USDC path) |
| Yellow / Nitrolite | Cheap batched SEND |
| ENS `*.ttcip.eth` | Human-readable identity |
| Circle Dev-Controlled Wallets + CCTP V2 | Cashout to Arc USDC |
| Li.Fi | Multi-chain bridges |
| Airtime / USSD | Fiat-ish on-ramp via mobile credit |

### Trust model (important)
- Keys live on the **server** (phone → encrypted private key). User never sees a seed phrase.
- Optional PIN for sensitive ops.
- Docs mention TEE / secure server as the desired hardening path.
- Carrier phone number = weak identity binding.

### What we explicitly **do not** want to copy
- Custom token (TXTC) + Uniswap pools + Sepolia-as-home chain
- Li.Fi / multi-chain bridge surface as core product
- Yellow Network as a hard dependency
- “Full DeFi suite over SMS” scope (swap, bridge, cashout pipeline)

### What we **do** want to keep / remix
- **Telephony as the UI** — no smartphone, no wallet app
- **Human-readable identity** (names → wallets)
- **Phone ↔ wallet binding** + PIN / spend limits
- **Circle + Arc + USDC** as settlement (they already cash out *to* Arc; we start *on* Arc)
- Inclusion narrative: agentic economy without bank / without “internet apps”

---

## 3. Our twist: Voice + SMS agent hotline (USDC-only)

### Pitch
Anyone can **call** (or text) their personal agent hotline, say what they want in natural language, and the agent executes **on-chain USDC actions on Arc** within hard spending policies — pay someone, pay an API (x402), check balance, register a name — without a bank account or a crypto UI.

### Channels
| Channel | Role | Notes |
|---------|------|-------|
| **Voice (primary differentiator)** | Call in → STT → agent → confirm → act → TTS reply | Twilio Voice / Vonage / similar; works on feature phones that can dial |
| **SMS (parity with Text-to-Chain)** | Short commands *or* natural language | Same agent backend as voice |
| Optional later | WhatsApp / USSD | Same agent; different ingress |

### Money model (simplified vs Text-to-Chain)
- **Asset:** USDC only (native gas on Arc — no ETH mental model)
- **Chain:** Arc Testnet first (`5042002`), settlement home — not Sepolia + cashout
- **Wallets:** Circle **Agent Wallets** (policy limits) and/or Developer-Controlled Wallets per phone
- **Payments:** transfers + **x402 / Gateway nanopayments** (pay APIs / agent services)
- **No:** Uniswap, TXTC, Li.Fi as v0 scope

### “Agentic economy without internet or bank”
Nuance to keep honest in the story:
- User device may have **no data / no smartphone apps** — only cellular voice/SMS.
- Backend *does* need connectivity to Arc / Circle / LLM; the **user** doesn’t.
- “Without bank” = value moves in **USDC**, not via bank rails for the end user (on-ramps still exist somewhere in the world; user can receive USDC via agent peers, vouchers, airtime, etc.).

---

## 4. Example user journeys (idea sketches)

### A. Onboard by call
1. Dial `+1-…-HOTLINE` (or short code).
2. Agent: “Say your name to join.” → creates Circle wallet + optional name (`alice.hotline` / ArcNS / HotlineNS).
3. Agent: “Set a 4-digit PIN.”
4. SMS confirmation with deposit address / name.

### B. Send money by voice
1. Call: “Send five dollars to bob.”
2. Agent resolves `bob` (contacts / name service) → quotes → “Confirm with your PIN.”
3. User speaks PIN (or DTMF digits).
4. Agent executes USDC transfer on Arc → spoken + SMS receipt.

### C. Pay for a service (agentic)
1. “Find Bitcoin price and pay if under a cent.”
2. Agent searches Circle Agent Marketplace / x402 → pays via Gateway nanopayment → reads result aloud.

### D. SMS fallback
Same intents as text: `SEND 5 USDC TO bob`, `BALANCE`, or free-form “pay bob five bucks”.

---

## 5. Security & trust (must design early)

| Concern | Direction |
|---------|-----------|
| Auth | Phone number + PIN (tDTMF preferred for voice — don’t speak PIN over clear channel if avoidable) |
| Spend limits | Circle Agent Wallet policies (global caps, per-service caps, allowlists, session TTL) |
| Confirmation | High-risk actions always confirm (amount + recipient + PIN) |
| Key custody | Prefer Circle-managed agent / developer wallets over rolling our own EOAs like Text-to-Chain |
| Voice phishing | Caller-ID spoofing is real — PIN + optional callback / SMS challenge for large amounts |
| Audit trail | SMS receipt + on-chain tx hash for every spend |
| Privacy | Minimize storing transcripts; redact PIN from logs |

---

## 6. Identity layer options

| Option | Fit |
|--------|-----|
| **ArcNS** (`.arc` / `.circle`) — https://arcname.services | Live ENS-like on Arc Testnet; integrate first |
| **Fork / HotlineNS** | Own TLD (e.g. `.hotline`); resolve to agent wallet + x402 endpoint |
| **Contacts book** (phone → name) | Like Text-to-Chain `SAVE` / `CONTACTS` — needed either way |
| Circle agent session email | Ops identity for CLI; not end-user naming |

For hackathon: **ArcNS or contacts first**; own name service only if it strengthens the demo story.

---

## 7. Stack candidates (idea-level)

### Already set up in this environment (2026-07-19)
- Circle CLI `@circle-fin/cli` + Cursor skills (`use-arc`, `use-agent-wallet`, `pay-via-agent-wallet`, …)
- Agent wallet logged in (mainnet + testnet)
- **Arc Testnet wallet:** `0x161102d980f44ad03fb532730d6cad8fb3857de5` (~20 USDC faucet)
- **Base mainnet agent wallet:** `0x6a4019bbc6f4a7a4834eb2bee4f950545d84b9df` (empty)
- Encode Arc programme context: https://www.encodeclub.com/my-programmes/arc-hackathon

### Likely building blocks
| Layer | Candidates |
|-------|------------|
| Voice / SMS | Twilio Voice + SMS (same as Text-to-Chain SMS path) |
| STT / TTS | Deepgram / Whisper / Twilio built-ins / ElevenLabs |
| Agent brain | Cursor-shaped agent OR Claude/OpenAI Agents SDK + Circle skills/CLI |
| Settlement | Arc + USDC + Circle Agent Wallets + Gateway / x402 |
| Identity | ArcNS and/or HotlineNS |
| Orchestration | Single webhook service (TS or Rust) — voice + SMS share one agent |

### Explicit non-goals (v0)
- Uniswap / custom token / Sepolia home chain
- Multi-chain bridge UI
- Full banking rails / KYC product (demo with testnet USDC)

---

## 8. Contrast matrix

| Dimension | Text-to-Chain | hotline.guru (ours) |
|-----------|---------------|---------------------|
| Primary UI | SMS commands | **Voice** + SMS (natural language) |
| Home chain | Sepolia → cashout to Arc | **Arc-first** |
| Money | TXTC + ETH + USDC path | **USDC only** |
| DEX | Uniswap V3 core | **None** |
| Agent | Implied / commands | **Conversational agent that acts** |
| Identity | ENS `*.ttcip.eth` | ArcNS / HotlineNS + contacts |
| Economy | DeFi ops over SMS | **Agentic pay + send** (marketplace / x402) |
| Custody | Server EOA keys | Prefer **Circle agent wallets + policies** |

---

## 9. Hackathon narrative hooks (Encode × Arc / Circle)

- **Inclusion:** feature phone → real USDC economy (same spirit as Text-to-Chain).
- **Agent Stack:** Agent Wallets, CLI/skills, Marketplace, Nanopayments / Gateway.
- **Arc:** USDC-as-gas, sub-second finality, predictable fees — ideal for voice-triggered micro-actions.
- **Differentiator vs Text-to-Chain:** voice hotline + agent that *does things*, not a DeFi command menu; no DEX tax.

Possible demo script:
1. Call hotline → join → get name.
2. Fund (faucet / peer send).
3. Voice: send USDC to another name.
4. Voice: pay an x402 service; hear the answer.
5. Show policy rejecting over-limit spend.

---

## 10. Open questions

1. Voice provider + cost per minute for demo vs Africa-scale later?
2. DTMF PIN vs spoken PIN vs SMS OTP for confirmations?
3. One shared hotline number (IVR: “enter your PIN”) vs personal numbers?
4. How do users get first USDC without a bank? (faucet for demo; peer P2P / airtime / voucher later)
5. Integrate ArcNS vs ship HotlineNS for judging “we built identity”?
6. How much of Circle Agent Stack CLI can the voice agent shell out to vs SDK?
7. Legal / Twilio / telephony compliance for the regions we demo?

---

## 11. References

### Source inspiration
- https://github.com/minrawsjar/Text-to-Chain
- Local mirror notes: Encode/ETHGlobal style docs in their `docs/` (vision, technical overview, Circle Arc track)

### Circle / Arc
- Agent Stack: https://developers.circle.com/agent-stack
- Agent Stack starter kits: https://github.com/circlefin/agent-stack-starter-kits
- Circle Skills: https://github.com/circlefin/skills
- Arc Testnet: chain `5042002`, RPC `https://rpc.testnet.arc.network`, explorer https://testnet.arcscan.app
- Faucet: https://faucet.circle.com

### Identity
- ArcNS: https://arcname.services / https://github.com/khenzarr/arcns

### Programme
- Encode Arc: https://www.encodeclub.com/my-programmes/arc-hackathon
- Encode events: https://luma.com/encode-club

### Peer projects (see §13)
- https://github.com/505labs/cesta-agent
- https://github.com/max-andrew/manila
- https://github.com/orbbit-tech/openpop
- https://github.com/0xETHtastic/frontend
- https://github.com/narasim-teja/sidekick
- https://github.com/0xaaiden/ANyasset
- https://github.com/LegendaryPenguin/EthGlobal26
- https://github.com/carluzh/canary
- https://github.com/notveiker/EG-Arc-Cumulant

---

## 12. Status

| Item | Status |
|------|--------|
| Idea capture (`kb.md`) | **Done** |
| Peer / competitor scan (this section) | **Done** |
| Circle CLI + Cursor skills | Done |
| Arc wallet funded (testnet) | Done (~20 USDC) |
| Product build | Not started |
| Voice/SMS prototype | Not started |
| Name service decision | Open |

Next when we leave idea stage: pick one demo journey (probably **voice send + x402 pay**), freeze custody model (Circle agent wallet + deterministic policy gate), and stub a Twilio voice webhook → agent → `circle` actions.

---

## 13. Peer projects — edges that improve our formula

Scan of ETHGlobal / Arc-adjacent builds (2026). Goal: steal *mechanisms*, not become another DeFi dashboard.

### Snapshot

| Project | One-liner | Steal for hotline.guru? |
|---------|-----------|-------------------------|
| [cesta-agent](https://github.com/505labs/cesta-agent) | Voice co-pilot; shared USDC treasury; x402 spends | **High** — closest cousin |
| [manila](https://github.com/max-andrew/manila) | Agent payroll; deterministic policy; private nanopay | **High** — security model |
| [openpop](https://github.com/orbbit-tech/openpop) | Verifiable CRE receipts → escrow release | **Medium** — trust for counterparties |
| [Ethastic frontend](https://github.com/0xETHtastic/frontend) | Meshtastic LoRa mesh → EVVM payments | **High** — true offline path |
| [sidekick](https://github.com/narasim-teja/sidekick) | Agent-native perps + Gateway margin calls | Low for v0; MCP/SDK patterns |
| [ANyasset](https://github.com/0xaaiden/ANyasset) | ENS checkout links → USDC settlement | Medium — name as payee UX |
| [Vouch / EthGlobal26](https://github.com/LegendaryPenguin/EthGlobal26) | World ID + private underwriting + Arc loans | Medium later — personhood |
| [canary](https://github.com/carluzh/canary) | Parametric depeg insurance risk curve | Low — different product |
| [Cumulant](https://github.com/notveiker/EG-Arc-Cumulant) | Structured prediction products on Arc | Low — different product |

---

### [cesta-agent](https://github.com/505labs/cesta-agent) — RoadTrip Co-Pilot (“give your car a wallet”)

**Edge**
- **Voice-first agent that spends** — Whisper STT → Claude → Kokoro TTS; same intent loop we want on a phone call.
- **Shared GroupTreasury** on Arc: per-tx caps, daily limits, **category budgets**, 2-of-N voting over auto-limit.
- **Autonomous nanopay** for tiny spends (tolls) vs confirm for big (hotels).
- **x402 mock APIs** as a clean demo surface (pay-per-query weather/hotels).
- **ERC-8004 agent identity** + reputation on Arc.
- **TEE → Stripe virtual card** bridge (crypto → real-world merchant) — optional stretch for “no bank but still pay IRL”.

**Takeaways for us**
1. Split **auto-nanopay** vs **confirm-with-PIN** by amount/category (voice: DTMF for PIN).
2. Demo script pattern: fund → voice book/pay → budget check aloud.
3. MCP tools around treasury/x402 mirror Circle CLI skills — keep agent tool surface small and explicit.
4. Don’t copy the car/trip framing; steal the **policy + voice + x402** loop.

---

### [manila](https://github.com/max-andrew/manila) — sealed daily payroll agent

**Edge**
- Plain-English agent **drafts**; **deterministic policy engine** decides pass / review / reject — LLM **cannot** talk past caps.
- Maker-checker: soft over-cap → second signature; hard ceiling / off-allowlist → **refuse even with approval**.
- Agent holds **no keys** — Dynamic MPC server wallet signs; Circle Gateway batches gas-free USDC.
- **Privacy**: Unlink seals amounts/counterparties; employer gets exportable audit CSV (“open the envelope”).
- Cron / Durable Object path for **hands-off daily runs** once policy is trusted.

**Takeaways for us**
1. **Never let the LLM authorize money.** Parse intent → structured intent → policy gate → execute.
2. Three verdicts: pass / need human (PIN or second factor) / hard reject — teach this in the voice script (“I can’t send that — over your limit”).
3. Agent wallet + Gateway nanopay as the settle path (already our stack).
4. SMS receipt / “open the envelope” style audit for every spend (tx hash + spoken summary).
5. Privacy sealing is optional stretch; inclusion markets may *want* transparency — decide later.

---

### [openpop](https://github.com/orbbit-tech/openpop) — verifiable agent workflows

**Edge**
- Chainlink CRE + signed receipt → **ProofGatedEscrow** releases USDC only if proof verifies.
- MCP `get_proof` so a **downstream agent** verifies without trusting the operator.
- Fixes ERC-8004’s weak “self-reported validation” with hardware/BFT receipts.
- Framing: OpenClaw routes work *in*; OpenPop proves work *out*.

**Takeaways for us**
1. For high-stakes voice actions (“release escrow to vendor”), attach a **verifiable receipt** not just an SMS.
2. Optional: investor/family “watcher agent” that verifies spends before acknowledging.
3. Don’t rebuild CRE for v0 — note as trust upgrade path after PIN + policy.

---

### [0xETHtastic/frontend](https://github.com/0xETHtastic/frontend) — Ethastic (Meshtastic + EVVM)

**Edge**
- **Meshtastic / LoRa mesh** via Web Serial — messages over radio when there’s **no cellular data / no internet**.
- Parses mesh text into payment actions (sendToEvvm / CCTP-style fields) with wallet signing.
- Complements Text-to-Chain’s SMS story: SMS needs a tower; **mesh needs neighbors**.

**Takeaways for us**
1. Our “without internet” claim gets stronger as a **ladder**: voice/SMS (cellular) → optional Meshtastic gateway (disaster / rural mesh).
2. Same agent backend: ingress adapter (Twilio | Meshtastic serial bridge) → shared intent + policy + USDC on Arc.
3. Hackathon stretch only if we already nail voice; otherwise cite as roadmap for Encode story.

---

### [sidekick](https://github.com/narasim-teja/sidekick) — agent-native perps

**Edge**
- Designed for agents that act every ~2s block (continuous funding, no cliff liquidations).
- Margin calls **are** Circle Gateway nanopayments (`@circle-fin/x402-batching`).
- **Self-describing venue** (`GET /venue`) + **MCP tools** + Circle developer-controlled MPC wallets.
- ERC-8004 identity composed with accounts.

**Takeaways for us**
1. Don’t build perps — but **expose hotline as MCP tools** (`hotline_send`, `hotline_balance`, `hotline_pay_service`) so any agent can call the same backend Cursor uses.
2. Self-describing `/venue`-style endpoint for the hotline number, limits, supported intents.
3. Circle MPC wallets over home-rolled EOA key DB (upgrade from Text-to-Chain trust model).

---

### [ANyasset](https://github.com/0xaaiden/ANyasset) — AnyAsset Checkout

**Edge**
- Merchant **ENS-branded invoices** + checkout links; settlement rail selectable (Base live / Arc experimental).
- ENS text records as product metadata (`anyasset:checkout`, `anyasset:settlement`).
- Dynamic Flow for “any token in → USDC out” (nice on-ramp UX, not our v0 core).

**Takeaways for us**
1. **Name = payee**: voice “pay coffee.hotline” resolves like ENS/ArcNS → invoice or direct transfer.
2. Optional: agent creates a one-time **voice invoice** (“ask Bob to pay you $5”) → SMS link for smartphone users, dial-to-confirm for feature phones.
3. Store settlement preference on the name record (Arc USDC only for us).

---

### [Vouch / EthGlobal26](https://github.com/LegendaryPenguin/EthGlobal26) — credit passport

**Edge**
- **World ID** personhood as anti-Sybil collateral; **TEE private underwriting**; loans in USDC on Arc.
- ERC-8004 passport; defaulter can’t respawn with a new wallet.
- On-chain = verdict only; raw income never leaves privacy boundary.

**Takeaways for us**
1. Optional: bind hotline account to World ID so one human ↔ one agent wallet (blocks SIM-swap farms).
2. Credit/lending is out of scope for hotline v0 — keep as “reputation passport” idea later.
3. Reminder of Arc decimals trap (already in our notes): native 18 vs USDC ERC-20 6.

---

### [canary](https://github.com/carluzh/canary) — parametric insurance / risk curve

**Edge**
- Machine-verifiable disasters (depeg) → auto settle from Chainlink history; CRE watchtower.
- USDC markets on Arc; idle collateral → USYC yield.

**Takeaways for us**
- Little direct product overlap. Possible later: voice “insure my remittance for 1 day” as an x402-purchased cover — not v0.

---

### [Cumulant](https://github.com/notveiker/EG-Arc-Cumulant) — structured prediction products

**Edge**
- Baskets / tranches / protected notes on USDC; non-custodial wallet-signed trades.
- Honest about **demo rails** vs user-signed trades (faucet/resolver keys separate).

**Takeaways for us**
1. Be explicit in demos: what the **agent signs**, what the **user confirms**, what is **test faucet**.
2. Prediction markets aren’t our formula — skip.

---

## 14. Upgraded formula (after peer scan)

**Before:** Call/text your agent → it spends USDC on Arc securely.

**Sharper formula:**

> **Telephony (voice/SMS) is the UI. A policy engine is the brain’s leash. Circle Agent Wallet + Gateway is the wallet. Arc USDC is the money. x402 is how the agent buys the world. Names are how humans address each other.**

### Must-have in v0 (steal now)
1. **Deterministic policy gate** (Manila) — LLM proposes, code disposes.
2. **Voice confirm + DTMF PIN** for over-limit (Cesta + Manila maker-checker).
3. **x402 / nanopay** for tiny autonomous actions; transfer for P2P (Cesta + our Agent Stack).
4. **Circle-managed wallets**, not server-stored EOAs (Sidekick / Agent Stack vs Text-to-Chain).
5. **Human-readable payees** via ArcNS / contacts / ENS-style records (ANyasset + ArcNS).

### Nice-to-have (demo polish)
6. Spoken budget / receipt + SMS tx-hash receipt (Cesta + Manila audit).
7. MCP surface so Cursor and the phone agent share tools (Sidekick / OpenPop pattern).
8. ERC-8004 agent identity for the hotline itself (Cesta / Sidekick).

### Roadmap (story, not build yet)
9. Meshtastic ingress for true offline (Ethastic).
10. CRE/OpenPop proofs for escrow-grade actions.
11. World ID personhood binding (Vouch).
12. TEE card bridge for IRL merchants (Cesta stretch).

### Still explicitly out of scope
- Uniswap / custom tokens / perps venues / prediction markets / insurance curves as core product.

---

## 15. What already exists — integrate vs build

Two Circle surfaces. Don’t confuse them:

| Surface | What it is | URL / access |
|---------|------------|--------------|
| **Skills** (dev/agent playbooks) | How *our* agent uses Circle (wallet, pay, policy, Arc) | Installed locally + [circlefin/skills](https://github.com/circlefin/skills) + [agents.circle.com skills index](https://agents.circle.com/.well-known/agent-skills/index.json) |
| **Marketplace** (paid APIs) | Third-party x402 services our agent can *buy* with USDC | [agents.circle.com/services](https://agents.circle.com/services) via `circle services search/inspect/pay` |

Catalog is large (~470+ endpoints across categories). Payments mostly on **Base / Polygon / Solana** Gateway or vanilla x402 — **not primarily Arc-native service listing** (Arc is still the settlement home for *our* wallets/transfers).

---

### A. Skills we already have (don’t rebuild)

| Skill | Use for hotline |
|-------|-----------------|
| `use-circle-cli` | Master routing |
| `use-agent-wallet` / `wallet-login` | Auth + wallets |
| `fund-agent-wallet` | Faucet / fund / Gateway deposit |
| `pay-via-agent-wallet` / `wallet-pay` | Pay any x402 service |
| `agent-wallet-policy` | Circle-native spend caps (OTP to *set*; agent can *read*) |
| `use-gateway` / `unify-balance` | Nanopayment balance |
| `use-arc` | Arc chain config |
| `use-usdc` | Transfers / balances |
| `bridge-stablecoin` | CCTP if needed |
| `accept-agent-payments` | If *we* sell a hotline API as x402 |
| `use-developer-controlled-wallets` | Multi-user custodial wallets per phone |
| `discover-services` | Runtime service search |

**CLI verbs that replace custom code:** `circle wallet *`, `circle gateway *`, `circle services search|inspect|pay`, `circle bridge *`.

---

### B. Marketplace — integrate (don’t rebuild these capabilities)

Categories (approx counts from CLI, 2026-07-19):

| Category | ~N | Examples useful to hotline |
|----------|----|----------------------------|
| FINANCIAL_ANALYSIS | 278 | Prices (Allium, AIsa/CoinGecko), Alchemy RPC, Otto research |
| SOCIAL_INTELLIGENCE | 58 | Twitter/X via AIsa |
| INFRASTRUCTURE | 53 | **Phone numbers, voice outbound, sandboxes, domains** |
| WEB_SEARCH_RESEARCH | 42 | Perplexity Sonar, maps (StableEnrich), scholar |
| PREDICTION_MARKETS | 26 | Polymarket / Kalshi data |
| CREATIVE | 13 | Image/audio/LLM chat (BlockRun) |

#### Telephony already on marketplace (big deal for us)

| Provider | Endpoint | Price | What it does |
|----------|----------|-------|--------------|
| **[StablePhone](https://stablephone.dev)** | `POST /api/call` | ~$0.54 | Outbound AI phone call (task + number) |
| StablePhone | `POST /api/number` | ~$20 | Buy outbound caller-ID number |
| StablePhone | `POST /api/lookup` | ~$0.05 | iMessage/FaceTime check |
| **[BlockRun.AI](https://blockrun.ai)** | `/phone/numbers/buy` | ~$5 / 30d | Provision Twilio number (wallet-bound) |
| BlockRun | `/phone/numbers/list|renew|release` | — | Manage numbers |
| BlockRun | `/phone/lookup` + `/fraud` | ~$0.05 | Carrier + **SIM-swap / call-forward fraud** signals |
| BlockRun | `/voice/call` | — | Outbound Bland.ai conversation (needs owned `from` number) |
| **StableEmail** | send / inbox / subdomain | $0.005–$5 | Email without Twilio |
| **StableDomains** | check/register-ish | — | Domains |
| **StableEnrich** | Google Maps nearby/details | — | Places (Cesta hotel search without Google key) |
| **AIsa / Perplexity** | sonar* | — | “What’s the price of X / research Y” over voice |

#### Other integrate-worthy
- **Web search / deep research** — don’t build RAG for demo answers; pay Sonar.
- **Maps / places** — pay StableEnrich instead of Google API keys.
- **Market prices** — pay Allium/AIsa instead of building price oracles.
- **Email receipts** — StableEmail SMS alternative for smartphone users.

---

### C. Critical gap — what marketplace does **not** give us

Marketplace telephony today is mostly **outbound** (agent calls a human) + number provisioning.

**Our product is inbound:** human dials hotline → *their* agent answers → acts on *their* wallet.

Missing / must build (or wire ourselves):

| Need | Exists? | Action |
|------|---------|--------|
| Inbound voice webhook (user calls us) | Not as turnkey x402 “hosted inbound IVR” | Build thin Twilio/Vonage (or see if BlockRun number can webhook to us) |
| STT/TTS + dialog loop bound to *caller identity* | Partial (outbound AI call APIs) | Build orchestrator; optionally buy LLM via BlockRun chat x402 |
| Phone → Circle wallet binding + PIN | No | **Build** |
| Manila-style deterministic policy over intents | Circle policy = money caps only | **Build** intent policy on top |
| P2P USDC send by name/voice | CLI/`use-usdc` yes; UX no | **Integrate** transfer + ArcNS/contacts |
| ArcNS / HotlineNS naming | Not in marketplace | Integrate ArcNS or thin contacts DB |
| Meshtastic / true offline radio | Not in marketplace | Roadmap (Ethastic) |
| Verifiable CRE receipts | Not Marketplace; OpenPop pattern | Optional later |

---

### D. Recommended build boundary for hotline.guru

```
┌─────────────────────────────────────────────────────────┐
│ BUILD (thin product)                                    │
│  • Inbound call/SMS webhook + session (caller ID)       │
│  • Intent parse → policy gate → confirm/PIN             │
│  • Phone↔wallet map + contacts / ArcNS resolve          │
│  • Orchestrator that shells to circle CLI / SDKs        │
└───────────────────────────┬─────────────────────────────┘
                            │ integrates
┌───────────────────────────▼─────────────────────────────┐
│ CIRCLE SKILLS / CLI (money layer)                       │
│  wallet · gateway · policy · pay · transfer · arc       │
└───────────────────────────┬─────────────────────────────┘
                            │ pays
┌───────────────────────────▼─────────────────────────────┐
│ MARKETPLACE (capabilities we won’t rebuild)             │
│  BlockRun numbers + fraud lookup                        │
│  StablePhone outbound (agent calls Bob to confirm?)     │
│  StableEmail receipts · maps · prices · web research    │
└─────────────────────────────────────────────────────────┘
```

**Demo-smart integrations:**
1. On join: optional `phone/lookup/fraud` before binding wallet (SIM-swap check).
2. Provision demo number via BlockRun *or* our own Twilio — don’t rebuild Twilio admin UI.
3. Voice: “What’s BTC?” → `circle services pay` CoinGecko/Allium → speak result.
4. Voice: “Email me the receipt” → StableEmail.
5. Stretch: agent **calls** the user’s backup number via StablePhone to confirm a large send (maker-checker without smartphone app).

**Do not build:** payment protocol, faucet UI, DEX, price APIs, Google Maps keys, email SMTP, outbound dialer infrastructure.

---

## 16. Implementation lock (2026-07-19)

Plan executed in-repo. Stack:

| Layer | Shipped |
|-------|---------|
| Voice | `telephony/asterisk` — Docker Asterisk + FastAGI `:4573` (PTCIP pattern, no Twilio) |
| SMS | Provider interface: mock / Telnyx / Africa’s Talking webhooks |
| Orchestrator | Hono `:8787` + CLI `npm run cli` |
| Policy | Deterministic pass/confirm/reject (`lib/policy.ts`) |
| Wallets | `WALLET_MODE=local` Arc EOAs (encrypted); Circle agent wallet for ops funding |
| Marketplace | Price via public fallback or `MARKETPLACE_LIVE=1` + `circle services pay` |

Verified live:
- Policy hard-reject on over-cap send
- Arc USDC transfer alice→bob on testnet (funded from operator agent wallet)
- `PRICE bitcoin` reply
- Asterisk container up; HTTP `/v1/message` + `/health`

See [README.md](README.md) and [DEMO.md](DEMO.md).
)