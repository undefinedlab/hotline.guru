import { motion, useReducedMotion } from 'motion/react'
import {
  Phone,
  Shield,
  Mic,
  ShoppingBag,
  Radio,
  Lock,
  Repeat,
  Bot,
  ArrowRight,
  type LucideIcon,
} from 'lucide-react'
import { EASE, stagger, fadeUp, viewport } from '../motion'
import { LogoG } from './LogoG'
import { MediaFrame, VIDEOS } from './MediaFrame'
import './Sections.css'

function SectionHead({
  eyebrow,
  title,
  lede,
}: {
  eyebrow: string
  title: string
  lede: string
}) {
  return (
    <motion.div
      className="section__head"
      variants={stagger}
      initial="hidden"
      whileInView="show"
      viewport={viewport}
    >
      <div>
        <motion.div className="section__eyebrow" variants={fadeUp}>
          <span className="section__dot" aria-hidden />
          <span className="section__eyebrow-text">{eyebrow}</span>
        </motion.div>
        <motion.h2 className="section__title" variants={fadeUp}>
          {title}
        </motion.h2>
      </div>
      <motion.p className="section__lede" variants={fadeUp}>
        {lede}
      </motion.p>
    </motion.div>
  )
}

const MODULES: {
  i: string
  title: string
  meta: string
}[] = [
  { i: '01', title: 'Ingress', meta: 'Voice · SMS · WhatsApp · Telegram' },
  { i: '02', title: 'Orchestrator', meta: 'Intent · HotlineNS · spoken policy' },
  { i: '03', title: 'Custody', meta: 'Circle DCW · Arc USDC · pending claims' },
  { i: '04', title: 'Marketplace', meta: 'x402 · StablePhone · Shop · research' },
]

const FEATURES: {
  icon: LucideIcon
  title: string
  body: string
}[] = [
  {
    icon: Phone,
    title: 'Phone is the account',
    body: 'Onboard by calling. No app store. Feature-phone ready.',
  },
  {
    icon: Shield,
    title: 'Spoken policy',
    body: '“Never send more than ten to someone new.” Compiles, you confirm, code freezes it.',
  },
  {
    icon: Mic,
    title: 'Voice memo on send',
    body: 'Remittance is a relationship — attach a short note that rides with the payment.',
  },
  {
    icon: Radio,
    title: 'Flash for balance',
    body: 'Missed-call / flash the hotline — balance by SMS. Zero cost to the user.',
  },
  {
    icon: Repeat,
    title: 'Standing orders',
    body: '“Send fifty to mom every month.” School fees and rent on a schedule.',
  },
  {
    icon: Lock,
    title: 'Savings lock',
    body: 'Lock dollars until a date — inflation hedge without a bank product.',
  },
  {
    icon: Bot,
    title: 'Agent x402 last mile',
    body: 'Other agents pay to call, ask, deliver USDC, or buy marketplace APIs through guru.',
  },
  {
    icon: ShoppingBag,
    title: 'Shop online',
    body: 'SHOP tee → BUY 1 → cart link. Human approves payment. Shop.app skill for the wide catalog.',
  },
]

export function Sections() {
  const reduce = useReducedMotion()

  return (
    <>
      <section id="problem" className="section section--soft">
        <div className="shell">
          <SectionHead
            eyebrow="The problem"
            title="Crypto settled the rails. Not the last mile."
            lede="Everyone already knows how to dial. Almost no one will install a wallet, memorize a seed phrase, or trust an AI that “probably” won’t overspend."
          />

          <div className="split-media">
            <motion.div
              className="stats"
              variants={stagger}
              initial="hidden"
              whileInView="show"
              viewport={viewport}
            >
              {[
                { n: '2.5B+', l: 'People with a phone who will never open MetaMask' },
                { n: 'Dial', l: 'The only universal login on a $15 handset' },
                { n: 'Hard no', l: 'What institutions need before agents hold funds' },
              ].map((s) => (
                <motion.div
                  key={s.n}
                  className="stat"
                  variants={fadeUp}
                  whileHover={reduce ? undefined : { y: -3 }}
                >
                  <div className="stat__n">{s.n}</div>
                  <div className="stat__l">{s.l}</div>
                </motion.div>
              ))}
            </motion.div>
            <MediaFrame src={VIDEOS.nokia} label="Feature phone · last mile" />
          </div>
        </div>
      </section>

      <section id="product" className="section section--dark">
        <div className="shell">
          <SectionHead
            eyebrow="Product"
            title="A money agent you call — not another app."
            lede="guru is the inbound layer for agentic USDC: voice and SMS as UI, deterministic policy as the bank charter, Circle Arc as settlement, x402 as how the agent buys the world."
          />

          <div className="split-media split-media--flip">
            <MediaFrame src={VIDEOS.retro} label="Voice ingress" dark />
            <div>
              <motion.div
                className="pillars"
                variants={stagger}
                initial="hidden"
                whileInView="show"
                viewport={viewport}
              >
                {['Telephony = UI', 'Policy = leash', 'Arc USDC = money', 'x402 = world'].map(
                  (p) => (
                    <motion.span key={p} className="pillar" variants={fadeUp}>
                      {p}
                    </motion.span>
                  ),
                )}
              </motion.div>

              <motion.div
                className="stack"
                variants={stagger}
                initial="hidden"
                whileInView="show"
                viewport={viewport}
              >
                {MODULES.map((row) => (
                  <motion.div key={row.i} className="stack__row" variants={fadeUp}>
                    <span className="stack__idx">{row.i}</span>
                    <strong>{row.title}</strong>
                    <span>{row.meta}</span>
                  </motion.div>
                ))}
              </motion.div>
            </div>
          </div>
        </div>
      </section>

      <section id="flow" className="section">
        <div className="shell">
          <SectionHead
            eyebrow="How it works"
            title="Sixty seconds from ringtone to receipt."
            lede="Your number is the account. Names resolve — not hex. Soft caps confirm. Hard ceilings refuse. Settlement proven on Arc testnet."
          />

          <div className="split-media">
            <motion.div
              className="flow"
              variants={stagger}
              initial="hidden"
              whileInView="show"
              viewport={viewport}
            >
              {[
                {
                  n: '01',
                  title: 'Dial',
                  body: 'Call or text guru. Name + PIN open the number.',
                },
                {
                  n: '02',
                  title: 'Speak',
                  body: '“Send five to Bob.” Phones and .hotline names resolve.',
                },
                {
                  n: '03',
                  title: 'Policy',
                  body: 'Your frozen rules + hard ceilings. Code authorizes — or refuses.',
                },
                {
                  n: '04',
                  title: 'Settle',
                  body: 'USDC on Arc — or nanopay x402 / shop a cart you still approve.',
                },
              ].map((step) => (
                <motion.article key={step.n} className="flow__step" variants={fadeUp}>
                  <div className="flow__n">{step.n}</div>
                  <h3 className="flow__title">{step.title}</h3>
                  <p className="flow__body">{step.body}</p>
                </motion.article>
              ))}
            </motion.div>
            <MediaFrame src={VIDEOS.dial} label="Dial · speak · settle" />
          </div>
        </div>
      </section>

      <section id="features" className="section section--soft">
        <div className="shell">
          <SectionHead
            eyebrow="Features"
            title="Built for corridors that flash, remittance, and agents."
            lede="Not a dashboard of toggles — the things people actually say on a call, plus the agent surface that reaches them."
          />

          <motion.div
            className="features"
            variants={stagger}
            initial="hidden"
            whileInView="show"
            viewport={viewport}
          >
            {FEATURES.map((f) => {
              const Icon = f.icon
              return (
                <motion.article key={f.title} className="feature" variants={fadeUp}>
                  <div className="feature__icon" aria-hidden>
                    <Icon size={18} strokeWidth={1.75} />
                  </div>
                  <h3 className="feature__title">{f.title}</h3>
                  <p className="feature__body">{f.body}</p>
                </motion.article>
              )
            })}
          </motion.div>
        </div>
      </section>

      <section id="demo" className="section">
        <div className="shell">
          <SectionHead
            eyebrow="Demo path"
            title="The proof isn’t the send. It’s the refuse."
            lede="One call walks the rail: onboard, settle under policy, hit a hard ceiling, freeze a spoken rule, then buy a capability with x402."
          />

          <div className="split-media split-media--flip">
            <MediaFrame src={VIDEOS.hold} label="Live path" />
            <div className="demo">
              <div className="demo__rail" aria-hidden>
                <motion.span
                  initial={reduce ? false : { scaleY: 0 }}
                  whileInView={{ scaleY: 1 }}
                  viewport={viewport}
                  transition={{ duration: 1.2, ease: EASE }}
                />
              </div>
              <motion.div
                variants={stagger}
                initial="hidden"
                whileInView="show"
                viewport={viewport}
              >
                {[
                  { k: 'Call', t: 'Onboard', d: 'Name + keypad PIN. Wallet on this number.' },
                  { k: 'Speak', t: 'Send', d: 'Pending-claim escrow if they’ve never joined.' },
                  { k: 'Push', t: 'Refuse', d: 'Hard ceiling — no PIN dance.' },
                  { k: 'Rule', t: 'Freeze', d: 'Spoken policy compiles; PIN locks it.' },
                  { k: 'Ask', t: 'Nanopay', d: 'Agent buys price, research, or a shop cart link.' },
                ].map((row) => (
                  <motion.div key={row.k} className="demo__step" variants={fadeUp}>
                    <div className="demo__node">{row.k}</div>
                    <div>
                      <strong>{row.t}</strong>
                      <p>{row.d}</p>
                    </div>
                  </motion.div>
                ))}
              </motion.div>
            </div>
          </div>
        </div>
      </section>

      <section id="trust" className="section section--dark">
        <div className="shell">
          <SectionHead
            eyebrow="Trust"
            title="LLM proposes. Code disposes."
            lede="We demo an agent that cannot overspend — and cannot loosen a rule you froze. Thin core, fat partners: Circle for money, marketplace for capabilities, guru for inbound identity."
          />

          <div className="split-media">
            <motion.div
              className="bento"
              variants={stagger}
              initial="hidden"
              whileInView="show"
              viewport={viewport}
            >
              {[
                {
                  n: 'Gate',
                  title: 'Deterministic leash',
                  body: 'Soft caps, daily budgets, hard ceilings, spoken rules — enforced in code.',
                },
                {
                  n: 'Moat',
                  title: 'Own the inbound',
                  body: 'Phone ↔ wallet, PIN lockout & recovery, flash balance, voice confirm.',
                },
                {
                  n: 'Expand',
                  title: 'Buy the world',
                  body: 'x402 last mile: call humans, research, fraud check, shop — still under policy.',
                },
              ].map((card) => (
                <motion.article key={card.n} className="card" variants={fadeUp}>
                  <div className="card__n">{card.n}</div>
                  <h3 className="card__title">{card.title}</h3>
                  <p className="card__body">{card.body}</p>
                </motion.article>
              ))}
            </motion.div>
            <MediaFrame src={VIDEOS.hands} label="Policy · custody" dark />
          </div>
        </div>
      </section>

      <section id="scope" className="section">
        <div className="shell">
          <SectionHead
            eyebrow="Scope"
            title="Narrow on purpose."
            lede="USDC-only on Arc. Voice-first. Human-readable payees. No DeFi theme park — and no LLM with a blank check."
          />

          <div className="split-media">
            <motion.div
              className="split"
              variants={stagger}
              initial="hidden"
              whileInView="show"
              viewport={viewport}
            >
              <motion.div className="split__col" variants={fadeUp}>
                <h3>We ship</h3>
                <ul>
                  <li>USDC on Circle Arc (testnet proven)</li>
                  <li>Voice primary, SMS / chat parity</li>
                  <li>Spoken policy + hard ceilings</li>
                  <li>Pending-claim escrow, not ghost wallets</li>
                  <li>x402 agent surface + Shop cart links</li>
                </ul>
              </motion.div>
              <motion.div className="split__col split__col--no" variants={fadeUp}>
                <h3>We refuse</h3>
                <ul>
                  <li>DEX / custom token theater</li>
                  <li>Silent custody downgrades</li>
                  <li>LLM-authorized spending</li>
                  <li>Auto-complete shop checkout</li>
                  <li>App-store dependency for users</li>
                </ul>
              </motion.div>
            </motion.div>
            <MediaFrame src={VIDEOS.call} label="Ship · refuse" />
          </div>
        </div>
      </section>

      <section id="roadmap" className="section section--soft">
        <div className="shell">
          <SectionHead
            eyebrow="Roadmap"
            title="Ship the rail. Widen the surface."
            lede="Mainnet proof, then corridor liquidity. Airtime-out is spend — not the unlock."
          />

          <div className="split-media split-media--flip">
            <MediaFrame src={VIDEOS.city} label="Now → horizon" />
            <motion.div
              className="roadmap"
              variants={stagger}
              initial="hidden"
              whileInView="show"
              viewport={viewport}
            >
              {[
                {
                  when: 'Now',
                  what: 'Foundation',
                  how: 'Voice + SMS, Arc testnet USDC, spoken policy, pending claims, flash, shop, x402 B2A.',
                },
                {
                  when: 'Next',
                  what: 'Production money',
                  how: 'One mainnet transfer, telco SIM signals, live callback, corridor escrow with a partner.',
                },
                {
                  when: 'Scale',
                  what: 'Distribution',
                  how: 'WhatsApp · USSD · sell the hotline as production x402.',
                },
                {
                  when: 'Horizon',
                  what: 'Offline & IRL',
                  how: 'Mesh, World ID, TEE → merchant card.',
                },
              ].map((item) => (
                <motion.div key={item.when} className="roadmap__item" variants={fadeUp}>
                  <div className="roadmap__when">{item.when}</div>
                  <div className="roadmap__what">{item.what}</div>
                  <div className="roadmap__how">{item.how}</div>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </div>
      </section>

      <section id="ask" className="section section--dark">
        <div className="shell">
          <SectionHead
            eyebrow="Contact"
            title="Build the dial tone of agentic money."
            lede="Partners who treat the phone line as infrastructure — Circle, telcos, capital for category creation."
          />

          <div className="split-media split-media--flip">
            <MediaFrame src={VIDEOS.nokia} label="Let’s talk" dark />
            <div>
              <motion.ul
                className="ask-list"
                variants={stagger}
                initial="hidden"
                whileInView="show"
                viewport={viewport}
              >
                <motion.li variants={fadeUp}>
                  <strong>Circle</strong>
                  Agent Wallets, Gateway, marketplace as the settlement plane.
                </motion.li>
                <motion.li variants={fadeUp}>
                  <strong>Telco / SMS</strong>
                  Short codes, voice trunks, SIM-change signals where remittance lives.
                </motion.li>
                <motion.li variants={fadeUp}>
                  <strong>Capital</strong>
                  Fund the OS layer — identity, policy, inbound.
                </motion.li>
              </motion.ul>

              <motion.div
                className="ask-box"
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={viewport}
                transition={{ duration: 0.7, ease: EASE, delay: 0.1 }}
              >
                <a className="btn btn--primary" href="mailto:hello@hotline.guru">
                  Contact us
                  <ArrowRight size={14} strokeWidth={2.2} />
                </a>
                <button
                  type="button"
                  className="btn btn--ghost-light"
                  onClick={() =>
                    document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' })
                  }
                >
                  See features
                </button>
              </motion.div>
            </div>
          </div>
        </div>
      </section>

      <div className="site-end">
        <div className="shell site-end__inner">
          <span className="site-end__brand">
            <span className="site-end__logo">
              <LogoG size={20} />
            </span>
            <strong>guru</strong>
          </span>
          <span>no bank · no app · no uniswap</span>
        </div>
      </div>
    </>
  )
}
