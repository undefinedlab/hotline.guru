export const EASE = [0.16, 1, 0.3, 1] as const

export const stagger = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.08, delayChildren: 0.06 },
  },
}

export const fadeUp = {
  hidden: { y: 28, opacity: 0 },
  show: {
    y: 0,
    opacity: 1,
    transition: { duration: 0.7, ease: EASE },
  },
}

export const fadeIn = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { duration: 0.6, ease: EASE },
  },
}

export const scaleIn = {
  hidden: { opacity: 0, scale: 0.96 },
  show: {
    opacity: 1,
    scale: 1,
    transition: { duration: 0.7, ease: EASE },
  },
}

export const slideX = (from: number) => ({
  hidden: { x: from, opacity: 0 },
  show: {
    x: 0,
    opacity: 1,
    transition: { duration: 0.75, ease: EASE },
  },
})

export const viewport = { once: true, amount: 0.22 } as const
