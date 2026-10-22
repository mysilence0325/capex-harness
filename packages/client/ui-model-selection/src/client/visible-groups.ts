/** The provider groups both model pickers render. */

import { isHiddenModelProvider } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Drop the routes the product hides, keeping the catalog's own order.
 * @param groups - provider groups in catalog order.
 * @returns those groups without the hidden providers.
 */
export function visibleModelGroups<T extends { readonly id: string }>(groups: readonly T[]): T[] {
  return groups.filter(group => !isHiddenModelProvider(group.id))
}
