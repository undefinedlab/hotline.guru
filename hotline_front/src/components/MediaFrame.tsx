import { motion } from 'motion/react'
import { EASE, viewport } from '../motion'
import './MediaFrame.css'

type Props = {
  src: string
  label?: string
  dark?: boolean
}

export function MediaFrame({ src, label, dark }: Props) {
  return (
    <motion.div
      className={`media ${dark ? 'media--dark' : ''}`}
      initial={{ opacity: 0, y: 18, scale: 0.98 }}
      whileInView={{ opacity: 1, y: 0, scale: 1 }}
      viewport={viewport}
      transition={{ duration: 0.85, ease: EASE }}
    >
      <div className="media__frame">
        <video
          className="media__video"
          src={src}
          autoPlay
          muted
          playsInline
          loop
        />
      </div>
      {label ? <p className="media__label">{label}</p> : null}
    </motion.div>
  )
}

export const VIDEOS = {
  nokia: 'https://videos.pexels.com/video-files/3878355/3878355-hd_1920_1080_30fps.mp4',
  retro: 'https://videos.pexels.com/video-files/8102793/8102793-hd_1920_1080_25fps.mp4',
  dial: 'https://videos.pexels.com/video-files/855574/855574-hd_1920_1080_25fps.mp4',
  hold: 'https://videos.pexels.com/video-files/853984/853984-hd_1920_1080_25fps.mp4',
  hands: 'https://videos.pexels.com/video-files/2795376/2795376-hd_1920_1080_25fps.mp4',
  city: 'https://videos.pexels.com/video-files/3250231/3250231-hd_1920_1080_25fps.mp4',
  call: 'https://videos.pexels.com/video-files/4053216/4053216-hd_1920_1080_25fps.mp4',
} as const
