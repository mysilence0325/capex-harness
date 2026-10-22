export type ConvertEngine = 'auto' | 'wps' | 'libreoffice'
export type ConvertTarget = 'pdf' | 'docx' | 'xlsx' | 'pptx'

export interface ConvertArguments {
  readonly help: boolean
  readonly input?: string
  readonly output?: string
  readonly engine: ConvertEngine
}

export interface ConvertOptions {
  readonly input: string
  readonly output: string
  readonly engine?: ConvertEngine
}

export function parseConvertArguments(argv: readonly string[]): ConvertArguments
export function wpsBinaryFor(input: string, environment: NodeJS.ProcessEnv): string | undefined
export function helpAdvertisesConversion(help: string): boolean
export function validateConvertedFile(path: string, target: ConvertTarget): void
export function convertOfficeFile(options: ConvertOptions): { readonly engine: 'wps' | 'libreoffice'; readonly output: string }
