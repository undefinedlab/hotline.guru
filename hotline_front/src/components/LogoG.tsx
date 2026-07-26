/** Geometric “g” — open bowl, inward spur, detached parallel tail. */
export function LogoG({ className = '', size = 28 }: { className?: string; size?: number }) {
  const h = Math.round(size * (74 / 64))
  return (
    <svg
      className={className}
      width={size}
      height={h}
      viewBox="0 0 64 74"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        fillRule="evenodd"
        d="M32 4A24 24 0 1 1 31.99 4ZM32 17.5A10.5 10.5 0 1 1 31.99 17.5ZM45.5 8.16A24 24 0 0 1 45.5 47.84ZM29 23H45.5V33H29Z"
      />
      <path d="M54.72 57.84A37.5 37.5 0 0 1 9.33 57.87L15.37 49.91A27.5 27.5 0 0 0 48.66 49.88Z" />
    </svg>
  )
}
