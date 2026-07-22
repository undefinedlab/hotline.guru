# hotline.guru — demo

## The demo

**First call** → name → **Hey Ben, what can I do for you?**  
**Send** → `send 0.1 usdt to <treasury>` (we control the sink; funds recycle)

Spoken → faster-whisper → policy → Arc USDC.

## Money loop (don’t burn the faucet)

```
Circle faucet → operator (optional)
            ↘
         lab treasury EOA  ←── caller sends 0.1 USDC back here
            ↘
         fund caller 0.5
```

Treasury address is in `data/lab-wallets.json` (auto-created).

```bash
# One-time: put CIRCLE_API_KEY in .env  OR  faucet the treasury once:
#   https://faucet.circle.com → Arc Testnet → (address printed by npm run funds)

npm run funds          # auto faucet if key set; ensure treasury funded
npm run demo           # onboard → fund 0.5 → send 0.1 → policy refuse
```

## Voice

```bash
npm run telephony && npm run start
# dial hotline, speak
```

## Pitch

Call the hotline. It remembers you. Say who to pay. Tiny Arc USDC moves under policy — recycled through a wallet we control.
