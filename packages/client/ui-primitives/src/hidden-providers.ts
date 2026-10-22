/**
 * Model provider routes the client hides from every selection surface.
 *
 * The offline product ships no DeepSeek account and no built-in DeepSeek route
 * in the settings page or the composer, so both the provider list and the
 * model catalog drop these ids before rendering. The Host keeps registering
 * them: the default model and web search still name `deepseek-official`.
 */
export const HIDDEN_MODEL_PROVIDERS: readonly string[] = ['deepseek-official', 'deepseek-account']

/**
 * Whether a provider route stays out of the client's provider surfaces.
 * @param provider - route id reported by the Host.
 * @returns true when the product hides that route.
 */
export function isHiddenModelProvider(provider: string): boolean {
  return HIDDEN_MODEL_PROVIDERS.includes(provider)
}
