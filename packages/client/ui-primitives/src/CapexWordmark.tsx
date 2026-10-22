/**
 * Native view box of {@link CAPEX_WORDMARK_PATH}: the outlined lettering plus
 * the padding its shared stroke needs to stay inside the SVG.
 */
export const CAPEX_WORDMARK_VIEWBOX = { x: 40, y: -716, width: 3063, height: 918 }

/**
 * Outlined `Capex` lettering, taken from the repository's Montserrat Medium
 * (SIL Open Font License; see `Montserrat-OFL.txt` in `dsh-client-ui-theme`)
 * with 12/1000 em of negative tracking. Outlining keeps the wordmark identical
 * in every client, independent of installed fonts.
 */
export const CAPEX_WORDMARK_PATH = 'M418.0 8Q338.0 8 270.5 -18.5Q203.0 -45 153.5 -93.5Q104.0 -142 76.0 -207.0Q48.0 -272 48.0 -350Q48.0 -428 76.0 -493.0Q104.0 -558 154.0 -606.5Q204.0 -655 271.5 -681.5Q339.0 -708 419.0 -708Q500.0 -708 568.5 -680.5Q637.0 -653 685.0 -599L620.0 -536Q580.0 -578 530.0 -598.5Q480.0 -619 423.0 -619Q364.0 -619 313.5 -599.0Q263.0 -579 226.0 -543.0Q189.0 -507 168.5 -457.5Q148.0 -408 148.0 -350Q148.0 -292 168.5 -242.5Q189.0 -193 226.0 -157.0Q263.0 -121 313.5 -101.0Q364.0 -81 423.0 -81Q480.0 -81 530.0 -101.5Q580.0 -122 620.0 -165L685.0 -102Q637.0 -48 568.5 -20.0Q500.0 8 418.0 8Z M1121.0 0V-112L1116.0 -133V-324Q1116.0 -385 1080.5 -418.5Q1045.0 -452 974.0 -452Q927.0 -452 882.0 -436.5Q837.0 -421 806.0 -395L766.0 -467Q807.0 -500 864.5 -517.5Q922.0 -535 985.0 -535Q1094.0 -535 1153.0 -482.0Q1212.0 -429 1212.0 -320V0ZM947.0 6Q888.0 6 843.5 -14.0Q799.0 -34 775.0 -69.5Q751.0 -105 751.0 -150Q751.0 -193 771.5 -228.0Q792.0 -263 838.5 -284.0Q885.0 -305 964.0 -305H1132.0V-236H968.0Q896.0 -236 871.0 -212.0Q846.0 -188 846.0 -154Q846.0 -115 877.0 -91.5Q908.0 -68 963.0 -68Q1017.0 -68 1057.5 -92.0Q1098.0 -116 1116.0 -162L1135.0 -96Q1116.0 -49 1068.0 -21.5Q1020.0 6 947.0 6Z M1659.0 6Q1593.0 6 1538.5 -24.5Q1484.0 -55 1451.5 -115.0Q1419.0 -175 1419.0 -265Q1419.0 -355 1450.5 -415.0Q1482.0 -475 1536.5 -505.0Q1591.0 -535 1659.0 -535Q1737.0 -535 1797.0 -501.0Q1857.0 -467 1892.0 -406.5Q1927.0 -346 1927.0 -265Q1927.0 -184 1892.0 -123.0Q1857.0 -62 1797.0 -28.0Q1737.0 6 1659.0 6ZM1378.0 194V-530H1470.0V-387L1464.0 -264L1474.0 -141V194ZM1651.0 -78Q1702.0 -78 1742.5 -101.0Q1783.0 -124 1806.5 -166.5Q1830.0 -209 1830.0 -265Q1830.0 -322 1806.5 -363.5Q1783.0 -405 1742.5 -428.0Q1702.0 -451 1651.0 -451Q1601.0 -451 1560.5 -428.0Q1520.0 -405 1496.5 -363.5Q1473.0 -322 1473.0 -265Q1473.0 -209 1496.5 -166.5Q1520.0 -124 1560.5 -101.0Q1601.0 -78 1651.0 -78Z M2284.0 6Q2199.0 6 2134.5 -29.0Q2070.0 -64 2034.5 -125.0Q1999.0 -186 1999.0 -265Q1999.0 -344 2033.5 -405.0Q2068.0 -466 2128.5 -500.5Q2189.0 -535 2265.0 -535Q2342.0 -535 2401.0 -501.0Q2460.0 -467 2493.5 -405.5Q2527.0 -344 2527.0 -262Q2527.0 -256 2526.5 -248.0Q2526.0 -240 2525.0 -233H2074.0V-302H2475.0L2436.0 -278Q2437.0 -329 2415.0 -369.0Q2393.0 -409 2354.5 -431.5Q2316.0 -454 2265.0 -454Q2215.0 -454 2176.0 -431.5Q2137.0 -409 2115.0 -368.5Q2093.0 -328 2093.0 -276V-260Q2093.0 -207 2117.5 -165.5Q2142.0 -124 2186.0 -101.0Q2230.0 -78 2287.0 -78Q2334.0 -78 2372.5 -94.0Q2411.0 -110 2440.0 -142L2493.0 -80Q2457.0 -38 2403.5 -16.0Q2350.0 6 2284.0 6Z M2571.0 0 2799.0 -296 2798.0 -247 2581.0 -530H2688.0L2854.0 -312H2813.0L2979.0 -530H3084.0L2864.0 -245L2865.0 -296L3095.0 0H2986.0L2811.0 -232L2850.0 -226L2678.0 0Z'

/**
 * Stroke the lettering carries on top of its fill.
 *
 * Montserrat Medium alone reads lighter than the badge beside it; a shared
 * stroke of the same color thickens every stem uniformly, which lands the
 * wordmark at a semi-bold weight without shipping a second font file.
 */
export const CAPEX_WORDMARK_STROKE = 16

/** Props of {@link CapexWordmark}. */
export interface CapexWordmarkProps {
  /** Rendered height in px, descender included; width keeps the aspect ratio. */
  readonly height?: number
  /** Extra class for layout placement. */
  readonly className?: string | undefined
}

/**
 * Render the Capex wordmark as outlined lettering.
 *
 * The lettering draws in the inherited text color so it stays legible in both
 * client themes. It carries no accessible name of its own: the surrounding
 * brand row supplies one.
 * @param props.height - Rendered height in px (default 17).
 * @param props.className - Extra class for layout placement.
 * @returns the wordmark svg (aria-hidden decorative brand art).
 */
export function CapexWordmark({ height = 17, className }: CapexWordmarkProps) {
  const { x, y, width, height: boxHeight } = CAPEX_WORDMARK_VIEWBOX
  return (
    <svg
      width={(height * width) / boxHeight}
      height={height}
      className={className}
      viewBox={`${x} ${y} ${width} ${boxHeight}`}
      fill="none"
      aria-hidden="true"
    >
      <path
        d={CAPEX_WORDMARK_PATH}
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={CAPEX_WORDMARK_STROKE}
        strokeLinejoin="round"
        paintOrder="stroke fill"
      />
    </svg>
  )
}
