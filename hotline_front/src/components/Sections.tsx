import { motion, useReducedMotion } from 'motion/react'
import { ArrowRight } from 'lucide-react'
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
                {[
                  { i: '01', title: 'Ingress', meta: 'Voice · SMS · Asterisk · Telnyx' },
                  { i: '02', title: 'Orchestrator', meta: 'Intent · contacts · policy' },
                  { i: '03', title: 'Custody', meta: 'Circle · Arc USDC' },
                  { i: '04', title: 'Marketplace', meta: 'x402 nanopay' },
                ].map((row) => (
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
            lede="Your number is the account. Names resolve — not hex. Soft caps confirm. Hard ceilings refuse."
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
                  body: 'Call or text guru. Phone binds to an Arc wallet.',
                },
                {
                  n: '02',
                  title: 'Speak',
                  body: '“Send five to Bob.” Contacts and numbers resolve.',
                },
                {
                  n: '03',
                  title: 'Policy',
                  body: 'Limits and ceilings. Code authorizes — or refuses.',
                },
                {
                  n: '04',
                  title: 'Settle',
                  body: 'USDC on Arc. Or nanopay an x402 API for an answer.',
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

      <section id="demo" className="section section--soft">
        <div className="shell">
          <SectionHead
            eyebrow="Demo path"
            title="The proof isn’t the send. It’s the refuse."
            lede="One call walks Encode × Circle Arc end-to-end: onboard, settle, hit a hard ceiling, then buy a capability with x402."
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
                  { k: 'Call', t: 'Join', d: 'Agent greets you by name.' },
                  { k: 'Speak', t: 'Send', d: 'Tiny Arc USDC settles under policy.' },
                  { k: 'Push', t: 'Refuse', d: 'Hard ceiling holds.' },
                  { k: 'Ask', t: 'Nanopay', d: 'Agent buys the answer via x402.' },
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
            title="Policy before personality."
            lede="We demo an agent that cannot overspend. Thin core, fat partners: Circle for money, marketplace for capabilities, guru for inbound identity."
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
                  body: 'Soft caps, daily budgets, hard ceilings — enforced in code.',
                },
                {
                  n: 'Moat',
                  title: 'Own the inbound',
                  body: 'Phone ↔ wallet binding, voice confirm, SMS receipts.',
                },
                {
                  n: 'Expand',
                  title: 'Buy the world',
                  body: 'x402 turns every call into a purchasing agent.',
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
                  <li>USDC only on Circle Arc</li>
                  <li>Voice primary, SMS parity</li>
                  <li>Hard policy over soft vibes</li>
                  <li>Names, phones, contacts as payees</li>
                  <li>x402 marketplace nanopay</li>
                </ul>
              </motion.div>
              <motion.div className="split__col split__col--no" variants={fadeUp}>
                <h3>We refuse</h3>
                <ul>
                  <li>DEX / custom token theater</li>
                  <li>Multi-chain bridge UIs</li>
                  <li>Perps & prediction scope creep</li>
                  <li>LLM-authorized spending</li>
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
            lede="Arc, x402, and cheap telephony just converged. Same core — more doors."
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
                  how: 'Voice + SMS, Arc USDC, policy gate, x402 nanopay.',
                },
                {
                  when: 'Next',
                  what: 'Identity & custody',
                  how: 'GuruNS, Agent Wallets, DTMF PIN, maker-checker.',
                },
                {
                  when: 'Scale',
                  what: 'Distribution',
                  how: 'WhatsApp, USSD, MCP, guru as an x402 API.',
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
                  Short codes and voice trunks where remittance already lives.
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
                    document.getElementById('demo')?.scrollIntoView({ behavior: 'smooth' })
                  }
                >
                  See the demo path
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
