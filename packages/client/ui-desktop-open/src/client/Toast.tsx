/** One transient desktop-open failure notice. */
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsHooks, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Injected failure state and dismissal. */
export interface DesktopOpenToastInjected {
  readonly hooks: { readonly message: HostObservable<string | null> }
  readonly dismiss: () => void
}

/** Props for the shell overlay notice. */
export type DesktopOpenToastProps = PropsRuntime<'shell.overlay'>
  & PropsLocale<'desktopOpen'>
  & InjectFace<DesktopOpenToastInjected>
  & PropsHooks<DesktopOpenToastInjected['hooks']>

/**
 * Render the latest open failure, or nothing while no failure is pending.
 * @param props - overlay runtime, localizer, and pending message.
 * @returns one Toast or null.
 */
export function DesktopOpenToast({ useMessage, dismiss }: DesktopOpenToastProps) {
  const message = useMessage(value => value)
  return message === null ? null : <Toast text={message} onDone={dismiss} />
}
