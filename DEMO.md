# hotline.guru — demo

## The demo

**Onboard** → welcome → name → Arc wallet on this number → PIN → thanks  
**Send** → `send 0.1 usdt to +1555…` → keypad PIN → USDC to **their** phone wallet  
**New number?** → we create their Arc wallet now; when they call in, it's already theirs  
**Push limit** → `send 100…` → hard ceiling **refuses**

## Money loop (don’t burn the faucet)

```
faucet / treasury → fund caller
caller --PIN--> receiver phone wallet (created if needed)
receiver later onboard (name + PIN) → same wallet, balance waiting
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
```

`DEMO_SIMPLE=0` (default). Set `DEMO_SIMPLE=1` only for one-shot lab skips.

## Pitch

Call once to open your number. Send to any phone. Policy + PIN before money moves.
