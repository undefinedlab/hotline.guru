# Clear demo: call → onboard → transfer (testnet)

**Goal:** Publish one **real phone number** that **anyone** can dial — at minimum verified from the **UK, India, and Germany** — then onboard by voice and send **Arc testnet USDC** under PIN + policy.

**Not the goal:** A German/UK/India *local* DID, mainnet, cash-in/out, or a polished operator UI. Reachability is international PSTN into one number, not one DID per country.

Related: [HANDOVER.md](./HANDOVER.md) · [DEMO.md](../DEMO.md) · [telephony/README.md](../telephony/README.md) · `scripts/setup-trunk.sh`

---

## 0. Acceptance: anyone can reach it

The demo number is a failure if only your softphone or one country’s SIMs work.

| Requirement | Pass criteria |
|-------------|----------------|
| **Public PSTN** | Any GSM/LTE mobile can dial the published E.164 number (caller pays intl rates) |
| **UK smoke** | Call from a UK mobile (`+44`) → ring → AGI welcome |
| **India smoke** | Call from an India mobile (`+91`) → ring → AGI welcome |
| **Germany smoke** | Call from a DE mobile (`+49`) → ring → AGI welcome |
| **Same product path** | Each country can complete onboard + transfer (or at least reach AGI; full money path once per rehearsal is enough) |

**Number choice rule:** use a **US geographic / local** DID (`+1` area code). Do **not** use US/UK/DE **toll-free** — those are often blocked or useless from abroad. Do **not** require callers to install an app.

Publish the number as international format only, e.g. `+1 555 010 0199`, and tell testers: dial with `+` or `00` prefix from their country.

---

## 1. Demo script (what must work)

| Beat | Caller experience | System |
|------|-------------------|--------|
| **0. Reach** | From UK / India / Germany (or any country): dial published `+1…` | PSTN connects; no geo-block on the DID |
| **1. Call** | Hear the agent (not busy / not dead air) | PSTN → Telnyx/Zadarma → Asterisk → FastAGI `:4573` |
| **2. Onboard** | Welcome → say name → set PIN (DTMF) | Wallet on caller MSISDN (Circle testnet or local Arc) |
| **3. Transfer** | `send 0.1 usdt to +1…` → confirm PIN | Policy → **Arc testnet** USDC (or pending-claim if payee unknown) |
| **4. Refuse** | `send 100…` | Hard ceiling — no PIN dance |

Optional extras (nice, not required for “clear”): dial `flash` / `rate`, spoken policy freeze.

**Safe claim after this works:** “Anyone can call this number (verified UK / India / Germany); settlement path proven on Arc **testnet** via voice.”  
**Do not claim:** mainnet USDC, local numbers in every country, telco SIM identity.

---

## 2. Number providers (options)

Prefer a **US local** DID so **UK, India, Germany, and anyone else** dial the same `+1…`. Avoid country-local DIDs that need heavy KYC (DE) or only work in-country (many toll-free).

| Provider | Number KYC | Fits this repo | Reachable from UK / IN / DE | Notes |
|----------|------------|----------------|-----------------------------|-------|
| **Telnyx** (recommended) | US/CA: **none** for the number | `npm run trunk` (SIP_TRUNK_HOST=sip.telnyx.com) + SMS webhooks | Yes on US local | Account may need payment / verification to order US from EU |
| **Zadarma** | US: passport + address | `npm run trunk` (SIP_TRUNK_HOST=pbx.zadarma.com) | Yes on US local | Skip DE numbers; reuse existing trunk if still live |
| **Twilio** Elastic SIP | Trial can get US number fast | Not pre-wired | Yes on US local | Fine alternative; more Asterisk work |
| **German / UK local DID** | Heavy / local-address docs | Same SIP once approved | Local callers only (others still intl) | **Wrong for speed**; does not improve “anyone can call” |

### Recommendation

1. **Telnyx US local** if starting fresh — one number, worldwide dial-in.  
2. **Zadarma US** if that SIP account already works.  
3. Softphone (`hotline` / `hotline-lab`) = **lab only** — does **not** satisfy UK/IN/DE reachability.

---

## 3. Architecture for the clear demo

```text
Mobile anywhere (must smoke-test: UK +44, India +91, Germany +49)
    │  PSTN  dial published +1 DID
    ▼
Telnyx / Zadarma
    │  SIP UDP 5060 + RTP 10000–10099
    ▼
Public host (VPS) — Asterisk
    │  FastAGI
    ▼
Orchestrator :4573 / :8787
    │  policy + PIN
    ▼
Arc testnet USDC  (Circle DCW  or  WALLET_MODE=local)
    │
    └── ArcScan link for the transfer
```

Code already routes trunk + softphone into the same AGI (`telephony/asterisk/extensions.conf` → `from-trunk` / `hotline`).

---

## 4. What we already have vs what we miss

### Already in the product (lab-proven)

| Piece | Status |
|-------|--------|
| Onboard → PIN → wallet on phone | WORKS |
| Send + PIN confirm + hard ceiling | WORKS |
| Pending-claim escrow for unknown payee | WORKS (expiry cron not scheduled) |
| FastAGI + softphone + STT pack | WORKS |
| Asterisk dialplan for inbound trunk | WORKS (`from-trunk`) |
| Telnyx / Zadarma SIP config | WORKS — `npm run trunk` generates it from `.env` (gitignored) |
| Arc **testnet** defaults in `.env.example` | WORKS |
| Circle DCW path / local EOA path | WORKS when configured |
| Unit tests (52) for pipeline/policy | PASS |

### Missing for the clear **live** demo

| Gap | Why it blocks | What to do |
|-----|---------------|------------|
| **Public host** for Asterisk | SIP/RTP must reach the internet | VPS (or home with public IP + port forward). Open **UDP 5060** + **UDP 10000–10099** |
| **Buy + activate US DID** | No public number yet | Telnyx Mission Control → Voice → buy US local → attach to SIP connection |
| **Wire SIP credentials** | `.env` has no `SIP_*` yet | Set `SIP_USER` / `SIP_PASSWORD` / `SIP_TRUNK_HOST` / `PUBLIC_IP` → `npm run trunk`. Generated `pjsip.conf` is gitignored — **secrets never enter git** |
| **Set `INBOUND_DID`** | Ops awareness / channel status | `.env`: `INBOUND_DID=+1…` |
| **Funded sender wallet** | Transfer fails if empty | Circle: `npm run circle:smoke` + fund testnet USDC **or** `WALLET_MODE=local` + `npm run funds` / `fund-user` |
| **Orchestrator reachable from Asterisk** | AGI host | Compose pack **or** `PHONE_AGI_HOST` pointing at orchestrator |
| **STT healthy** (voice name) | Else keypad fallback only | `npm run telephony` / pack; `curl :8090/health` |
| **Optional: live SMS** | Flash / confirm texts stay mock | `SMS_PROVIDER=telnyx` + `TELNYX_*` + webhook URL — **not required** for call→onboard→PIN transfer |

### Explicitly **not** required for this demo

- German number  
- Mainnet / production Circle  
- WhatsApp / Telegram live  
- Standing-order cron / claim expiry worker  
- CALLBACK / RECOVER outbound stubs  
- Operator dashboard  

---

## 5. Checklist — go from zero to clear demo

### A. Host + stack

- [ ] VPS with public IPv4  
- [ ] Clone repo, `cp .env.example .env`  
- [ ] Choose money mode:  
  - **Circle testnet (preferred for investor):** fill `CIRCLE_*`, `WALLET_MODE=circle`, `CIRCLE_BLOCKCHAIN=ARC-TESTNET`  
  - **Local lab EOAs (faster):** `WALLET_MODE=local`, then fund with scripts  
- [ ] `npm install` · `npm test` · `npm run pack` **or** `npm run telephony` + `npm run start`  
- [ ] Softphone smoke first: dial `hotline` → onboard works on host  

### B. Number (Telnyx path)

- [ ] Telnyx account + payment method  
- [ ] Buy **US local** voice number (not toll-free)  
- [ ] Create SIP connection / credentials → note user/pass  
- [ ] Point DID → that connection; origination toward your Asterisk public IP:5060  
- [ ] `SIP_*` + `PUBLIC_IP` in `.env` → `npm run trunk` (writes external signaling/media = public IP)  
- [ ] Restart Asterisk; confirm registration in Telnyx portal / Asterisk logs  
- [ ] Set `INBOUND_DID=+1…` in `.env`  

### C. Money on testnet

- [ ] Caller number will onboard on first call → note deposit address from reply (or fund after PIN)  
- [ ] Fund **caller** with testnet USDC (Circle faucet/ops wallet or `scripts/fund-user.sh` in local mode)  
- [ ] Prepare a **second** phone (or known lab MSISDN) as payee — or accept pending-claim flow  

### D. Rehearse the script (multi-country reach)

- [ ] Publish the number as `+1…` (share in chat/deck — anyone can dial)  
- [ ] **UK** mobile: dial → welcome audio  
- [ ] **India** mobile: dial → welcome audio  
- [ ] **Germany** mobile: dial → welcome audio  
- [ ] From at least one of those: onboard (name + PIN)  
- [ ] `send 0.1 usdt to <payee>` → PIN → ArcScan (testnet)  
- [ ] Over-ceiling send → refuse  
- [ ] If one country fails: try another US local DID (rare carrier VoIP blocks) — do not ship as “public” until UK+IN+DE all ring

---

## 6. Env cheat sheet (demo)

```bash
# Voice / DID
INBOUND_DID=+1XXXXXXXXXX
SIP_TRUNK_HOST=sip.telnyx.com   # or pbx.zadarma.com
SIP_USER=
SIP_PASSWORD=
PUBLIC_IP=                      # public IPv4 of the Asterisk host
# then: npm run trunk   (writes gitignored telephony/asterisk/pjsip.conf)

# Money — Arc testnet (default URLs already correct)
ARC_RPC_URL=https://rpc.testnet.arc.network
ARC_CHAIN_ID=5042002
ARC_EXPLORER=https://testnet.arcscan.app
CIRCLE_BLOCKCHAIN=ARC-TESTNET

# Either:
WALLET_MODE=circle
CIRCLE_API_KEY=…
CIRCLE_ENTITY_SECRET=…
CIRCLE_WALLET_SET_ID=…

# Or lab without Circle console:
# WALLET_MODE=local

DEMO_SIMPLE=0
ASYNC_SETTLE=1          # optional — ack on call, settle in background
SMS_PROVIDER=mock       # OK for voice PIN demo; switch to telnyx for real SMS
```

---

## 7. Failure map (quick debug)

| Symptom | Likely cause |
|---------|----------------|
| Number rings then silence / no AGI | Asterisk ↔ orchestrator (`PHONE_AGI_HOST`, port 4573) |
| One-way / no audio | RTP ports closed or `external_media_address` wrong |
| SIP not registering | Creds / firewall 5060 / wrong `sip.telnyx.com` |
| Onboard OK, send fails | Unfunded wallet / Circle misconfig |
| “Creates wallet for unknown payee” | Old mental model — expect **pending claim** until they onboard |
| Call from India fails, UK/DE work | Rare carrier block on that DID — buy another US local; retest all three |
| Only softphone works | Not a public demo — PSTN DID + open SIP/RTP still missing |
| Toll-free number from abroad | Expected fail — switch to US **local** geographic |

---

## 8. After the clear demo (next, not blocking)

1. Cron: pending-claim expiry + standing orders  
2. Live SMS on same Telnyx number (flash balance texts)  
3. Real CALLBACK / RECOVER originate  
4. Mainnet only with production Circle credentials + one green transfer  

---

## 9. One-line summary

**Buy Telnyx US local → SIP into public Asterisk → prove dial-in from UK, India, and Germany → same AGI onboard/send on Arc testnet.**  
Anyone else dials the same `+1…`; those three countries are the minimum reachability test before you call the demo clear.
