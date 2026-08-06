import { motion, useReducedMotion } from 'motion/react'
import { Plus, ArrowRight } from 'lucide-react'
import { EASE, stagger, fadeUp } from '../motion'
import { LogoG } from './LogoG'
import './Hero.css'

/** Retro feature phone — same family as the prior hero clip */
const VIDEO_SRC =
  'https://videos.pexels.com/video-files/8102793/8102793-hd_1920_1080_25fps.mp4'

const NAV_LINKS = [
  { label: 'Product', href: '#product' },
  { label: 'Flow', href: '#flow' },
  { label: 'Features', href: '#features' },
  { label: 'Trust', href: '#trust' },
  { label: 'Roadmap', href: '#roadmap' },
] as const

const MARQUEE = [
  'Phone is the account',
  'Spoken policy',
  'Voice + SMS',
  'Arc USDC',
  'Flash for balance',
  'Pending-claim escrow',
  'Standing orders',
  'Savings lock',
  'x402 agent last mile',
  'Shop with human approve',
  'No app required',
  'Feature-phone ready',
] as const

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
}

export function Hero() {
  const reduce = useReducedMotion()

  return (
    <>
      <section className="hero">
        <div className="hero__video-wrap">
          <div className="hero__video-frame">
            <motion.div
              className="hero__video-motion"
              initial={reduce ? false : { opacity: 0, scale: 1.08 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 1.9, ease: EASE }}
            >
              <video
                className="hero__video"
                src={VIDEO_SRC}
                autoPlay
                muted
                playsInline
                loop
              />
            </motion.div>
          </div>
        </div>

        <motion.div
          className="nav"
          initial={reduce ? false : { y: -18, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.85, ease: EASE }}
        >
          <div className="shell">
            <div className="nav__bar">
              <a href="/" className="nav__brand" aria-label="guru home">
                <LogoG className="nav__mark" size={26} />
                <span className="nav__wordmark">guru</span>
              </a>

              <nav className="nav__links" aria-label="Primary">
                {NAV_LINKS.map((link) => (
                  <a key={link.href} className="nav__link" href={link.href}>
                    {link.label}
                  </a>
                ))}
              </nav>

              <button
                type="button"
                className="btn btn--primary nav__cta"
                onClick={() => scrollToId('ask')}
              >
                Contact us
              </button>

              <button
                type="button"
                className="nav__menu"
                aria-label="Open sections"
                onClick={() => scrollToId('product')}
              >
                <span className="nav__menu-circle">
                  <Plus size={12} strokeWidth={3} />
                </span>
                <span className="nav__menu-label">Menu</span>
              </button>
            </div>
          </div>
        </motion.div>

        <div className="hero__bottom">
          <div className="shell">
            <motion.div
              className="hero__copy"
              variants={stagger}
              initial={reduce ? false : 'hidden'}
              animate="show"
            >
              <motion.div className="hero__kicker" variants={fadeUp}>
                <span className="hero__dot" aria-hidden />
                <span className="hero__kicker-text">
                  hotline.guru — phone-native OS for agentic USDC
                </span>
              </motion.div>

              <motion.h1 className="hero__title" variants={fadeUp}>
                Your phone number
                <br />
                is the wallet.
              </motion.h1>

              <motion.p className="hero__lede" variants={fadeUp}>
                Dial guru. Speak naturally. Freeze your own rules out loud.
                Policy decides what can move — Arc settles in USDC.
              </motion.p>

              <motion.div className="hero__actions" variants={fadeUp}>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => scrollToId('flow')}
                >
                  See how it works
                  <ArrowRight size={14} strokeWidth={2.2} />
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => scrollToId('features')}
                >
                  Features
                </button>
              </motion.div>
            </motion.div>
          </div>
        </div>
      </section>

      <div className="marquee" aria-hidden>
        <div className="shell">
          <div className="marquee__clip">
            <div className="marquee__fade marquee__fade--left" />
            <div className="marquee__fade marquee__fade--right" />
            <div className="marquee__track">
              {[0, 1].map((copy) => (
                <div key={copy} className="marquee__group">
                  {MARQUEE.map((item) => (
                    <span key={`${copy}-${item}`} className="marquee__item">
                      <span className="marquee__dot" />
                      {item}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
