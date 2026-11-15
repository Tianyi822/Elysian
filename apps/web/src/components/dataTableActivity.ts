import { createContext } from 'react'

/** Hidden or retargeted tables stop undispatched work and dismiss old dialogs. */
export const DataTableActivityContext = createContext({ active: true, scope: '' })
