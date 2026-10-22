/** Capex desktop-open copy. */
export const zh = {
  openFailed: '无法打开“{name}”：{message}',
  invalidRequest: '桌面启动器没有提供有效的文件路径',
} satisfies Record<string, string>

/** Message keys for desktop-launched document failures. */
export type DesktopOpenKey = keyof typeof zh

/** English desktop-open messages. */
export const en = {
  openFailed: 'Could not open "{name}": {message}',
  invalidRequest: 'The desktop launcher did not provide a valid file path',
} satisfies Record<DesktopOpenKey, string>
