import { useId } from 'react'
import type { IconProps } from './icons/props.ts'

/** Native viewBox of {@link CAPEX_LOGO_SHELL_PATH} (width and height in user units). */
export const CAPEX_LOGO_VIEWBOX = 512

/** Body of the Capex symbol: a five-sector turbine shell. */
export const CAPEX_LOGO_SHELL_PATH = 'M256 54c44 0 81 24 102 60 40-3 78 19 96 54 18 36 11 78-16 107 17 39 5 85-29 111-34 27-80 28-115 6-32 28-80 34-118 12-38-22-58-64-51-106-38-17-64-54-61-96 3-42 35-77 75-88 20-37 64-61 105-57 4-2 8-3 12-3Z'

/** Shell cut-outs that carve the ring's opening and the aircraft's silhouette out of it. */
export const CAPEX_LOGO_CUT_PATHS = [
  'M258 143c-63 0-114 51-114 114 0 62 50 113 113 113 41 0 78-22 98-55l-68-24c-9 11-22 18-37 18-28 0-51-23-51-51 0-29 23-52 51-52 18 0 34 9 43 23l43-66c-22-13-49-20-78-20Z',
  'm277 208 215-143-99 211 100 98-221-66 45-52Z',
] as const

/** Upper wing of the ascending aircraft. */
export const CAPEX_LOGO_UPPER_WING_PATH = 'm168 263 284-181-157 191-52 11-36 70-17-68-22-23Z'

/** Lower wing of the ascending aircraft. */
export const CAPEX_LOGO_LOWER_WING_PATH = 'M242 307 452 82 309 329l-46-3-21-19Z'

/**
 * Render the Capex symbol.
 *
 * The default `current` tone draws the whole symbol in the inherited text color,
 * which is how a monochrome mark sits beside a wordmark; the `brand` tone keeps
 * the supplied artwork's gradients. Both sides of the sidebar render the mark at
 * once, so gradient and mask identifiers are derived from the component instance.
 * @param props.size - Square edge in px (default 24).
 * @param props.className - Extra class for layout placement.
 * @param props.tone - `current` follows the text color; `brand` uses the artwork gradients.
 * @returns the brand svg (aria-hidden; pair with the brand name for accessibility).
 */
export function CapexLogo({ size = 24, className, tone = 'current' }: IconProps & { readonly tone?: 'current' | 'brand' }) {
  const instance = useId().replace(/[^A-Za-z0-9_-]/gu, '')
  if (tone === 'current') {
    const cut = `capex-cut-${instance}`
    return (
      <svg
        width={size}
        height={size}
        className={className}
        viewBox={`0 0 ${CAPEX_LOGO_VIEWBOX} ${CAPEX_LOGO_VIEWBOX}`}
        fill="none"
        aria-hidden="true"
      >
        <defs>
          <mask id={cut}>
            <rect width={CAPEX_LOGO_VIEWBOX} height={CAPEX_LOGO_VIEWBOX} fill="#000" />
            <path fill="#fff" d={CAPEX_LOGO_SHELL_PATH} />
            {CAPEX_LOGO_CUT_PATHS.map(path => <path key={path} fill="#000" d={path} />)}
          </mask>
        </defs>
        <path fill="currentColor" mask={`url(#${cut})`} d={CAPEX_LOGO_SHELL_PATH} />
        <path fill="currentColor" d={CAPEX_LOGO_UPPER_WING_PATH} />
        <path fill="currentColor" d={CAPEX_LOGO_LOWER_WING_PATH} />
      </svg>
    )
  }
  const shell = `capex-shell-${instance}`
  const upperWing = `capex-upper-wing-${instance}`
  const lowerWing = `capex-lower-wing-${instance}`
  const cut = `capex-cut-${instance}`
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox={`0 0 ${CAPEX_LOGO_VIEWBOX} ${CAPEX_LOGO_VIEWBOX}`}
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={shell} x1="82" y1="420" x2="420" y2="72" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#00AFFF" />
          <stop offset="0.5" stopColor="#087CF4" />
          <stop offset="1" stopColor="#174FEA" />
        </linearGradient>
        <linearGradient id={upperWing} x1="168" y1="284" x2="452" y2="82" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFE600" />
          <stop offset="0.58" stopColor="#FFAA00" />
          <stop offset="1" stopColor="#FF3154" />
        </linearGradient>
        <linearGradient id={lowerWing} x1="242" y1="329" x2="452" y2="82" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FF9F00" />
          <stop offset="0.55" stopColor="#FF5538" />
          <stop offset="1" stopColor="#FF3154" />
        </linearGradient>
        <mask id={cut}>
          <rect width={CAPEX_LOGO_VIEWBOX} height={CAPEX_LOGO_VIEWBOX} fill="#000" />
          <path fill="#fff" d={CAPEX_LOGO_SHELL_PATH} />
          {CAPEX_LOGO_CUT_PATHS.map(path => <path key={path} fill="#000" d={path} />)}
        </mask>
      </defs>
      <path fill={`url(#${shell})`} mask={`url(#${cut})`} d={CAPEX_LOGO_SHELL_PATH} />
      <path fill={`url(#${upperWing})`} d={CAPEX_LOGO_UPPER_WING_PATH} />
      <path fill={`url(#${lowerWing})`} d={CAPEX_LOGO_LOWER_WING_PATH} />
    </svg>
  )
}
