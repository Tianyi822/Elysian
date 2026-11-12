import type { JQueryTerminal } from 'jquery.terminal'

export type CommandTerminalInstance = JQueryTerminal
let library: Promise<JQueryStatic> | undefined

/** Only the REPL core is loaded; optional ANSI/Prism/RPC extensions stay outside the bundle. */
export function loadCommandTerminalLibrary(): Promise<JQueryStatic> {
  library ??= Promise.all([
    import('jquery'),
    import('jquery.terminal'),
    import('jquery.terminal/css/jquery.terminal.min.css'),
  ]).then(([jquery, terminal]) => {
    const $ = jquery.default
    if (!$.fn.terminal) terminal.default(window, $)
    return $
  }).catch((error: unknown) => { library = undefined; throw error })
  return library
}
