# hotline.guru — demo

## The demo

**Onboard** → welcome → name → Arc wallet on this number → PIN → thanks  
**Send** → `send 0.1 usdt to +1555…` → keypad PIN → USDC held for **their** number (escrow pending claim)  
**New number?** → no wallet until they call in; then escrow releases (or refunds sender after expiry)  
**Push limit** → `send 100…` → hard ceiling **refuses**  
**PIN lockout** → wrong PIN repeats → temporary lock (`PIN_MAX_FAILS`)

## Money loop (don’t burn the faucet)

```
faucet / treasury → fund caller
caller --PIN--> escrow (pending claim for destination MSISDN)
receiver onboard (name + PIN) → wallet minted → escrow releases
unclaimed after N days → refund sender
```

```bash
npm run funds
npm run demo    # onboard → fund → send-to-phone → receiver onboard → refuse
```

## Voice

```bash
npm run telephony && npm run start
# first call: name + keypad PIN
# next call: "send 5 usdt to +1…" → keypad PIN
# optional: ASYNC_SETTLE=1 → "sending now, I'll text you" (no silent hold on the call)
```

`DEMO_SIMPLE=0` (default). Set `DEMO_SIMPLE=1` only for one-shot lab skips.

## Settlement claim (investor-safe)

Settlement path proven on **Arc testnet** (Circle DCW / local EOAs).  
**Arc has no public mainnet yet** — testnet is the only network there is. Mainnet is out of scope until Arc ships one; do not claim live mainnet USDC.

## Demo beats (investor / hackathon)

1. **Spoken leash:** “Never send more than ten dollars to someone I haven't paid before.” → readback → PIN → frozen.  
2. **Flash balance:** missed call / dial `flash` → SMS balance (zero user cost).  
3. **Dial-a-rate:** dial `rate` → hear USDC reference, hang up — no account.  
4. **Voice note:** send → optional memo → payee SMS carries the relationship.  
5. **Standing / lock:** “send 50 to mom every month” · “lock 5 until December.”  
5b. **Swap (Arc):** `swap 5 usdc to euro` · `swap 1 euro to usdc` · `swap 0.001 bitcoin to usdc` — PIN → Circle Swap Kit (USDC / EURC / cirBTC). Needs `KIT_KEY`.  
6. **B2A:** `POST /v1/x402/ask` or `/call` with `X-Payment: lab` → SMS / StablePhone outbound.  
7. **Marketplace:** `POST /v1/x402/discover` · `/price` · `/research` · `/proxy`  
8. **Shop online:** `SHOP tee` / `POST /v1/x402/shop` → `BUY 1` cart link (human pays). Full multi-store: [shop.app/SKILL.md](https://shop.app/SKILL.md) · Circle merch [shop.circle.com/agents.md](https://shop.circle.com/agents.md)

