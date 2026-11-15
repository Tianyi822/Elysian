import { forwardRef, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { PressButton, type PressButtonProps, type PressButtonVariant } from './easyui/PressButton'
import { cn } from './easyui/utils'

export type ButtonVariant = PressButtonVariant | 'default' | 'destructive' | 'warning' | 'success' | 'link' | 'gradient'
export type ButtonSize = 'compact' | 'sm' | 'md' | 'lg' | 'icon'

export interface ButtonProps extends Omit<PressButtonProps, 'variant' | 'size'> {
  variant?: ButtonVariant
  size?: ButtonSize
  isLoading?: boolean
  loadingText?: string
  leftIcon?: ReactNode
  rightIcon?: ReactNode
}

const tones = {
  primary: 'border-transparent bg-fg text-surface hover:bg-fg hover:text-surface hover:opacity-90',
  secondary: 'border-control-line bg-surface text-fg hover:border-control-line hover:bg-surface-raised hover:text-fg',
  outline: 'border-control-line bg-transparent text-fg hover:border-control-line hover:bg-surface hover:text-fg',
  ghost: 'border-transparent bg-transparent text-fg-muted hover:border-transparent hover:bg-surface hover:text-fg',
  destructive: 'border-danger/40 bg-danger/10 text-danger hover:border-danger/40 hover:bg-danger/20 hover:text-danger',
  warning: 'border-warning/40 bg-warning/10 text-warning hover:border-warning/40 hover:bg-warning/20 hover:text-warning',
  success: 'border-success/40 bg-success/10 text-success hover:border-success/40 hover:bg-success/20 hover:text-success',
  link: 'h-auto border-0 bg-transparent p-0 text-accent-fg underline-offset-4 hover:bg-transparent hover:text-accent-fg hover:underline',
} as const

// Retained class constants are still used by links and other legacy controls.
// Their old CSS shell must not override PressButton's shape or press transform.
const legacyShells = new Set(['ctl', 'ctl-default', 'ctl-quiet', 'ctl-danger', 'ctl-sm', 'action-button'])

/** All panel actions share EasyUI PressButton. Compound controls opt out of its
 * visual shell to retain their own switch/tab/menu geometry and direct children. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = 'primary', size = 'compact', isLoading = false, loadingText,
  leftIcon, rightIcon, disabled, className, children, unstyled = false, ...props
}, ref) {
  const tone = variant === 'default' ? 'primary' : variant === 'gradient' ? 'secondary' : variant
  const pressVariant = !['destructive', 'warning', 'success', 'link'].includes(tone)
    ? tone as PressButtonVariant : 'outline'
  const classes = unstyled ? className : className?.split(/\s+/).filter(name => !legacyShells.has(name)).join(' ')

  return <PressButton
    ref={ref}
    nativePress
    variant={pressVariant}
    size={size === 'compact' ? 'md' : size}
    unstyled={unstyled}
    disabled={disabled || isLoading}
    aria-busy={isLoading || undefined}
    className={cn(
      !unstyled && size === 'compact' && 'h-[var(--ctl-height,2rem)] gap-1.5 px-3.5 text-sm',
      classes,
      !unstyled && 'py-0',
      !unstyled && tones[tone],
      // EasyUI's explicit radii take priority over old local button classes.
      !unstyled && (classes?.split(/\s+/).includes('rounded-full') ? 'rounded-full' : size === 'sm' ? 'rounded-[10px]' : 'rounded-[14px]'),
    )}
    {...props}
  >
    {isLoading ? <Loader2 aria-hidden className={cn('shrink-0 animate-spin motion-reduce:animate-none', size === 'sm' || size === 'compact' ? 'size-3' : 'size-4')} /> : leftIcon}
    {isLoading && loadingText ? loadingText : children}
    {!isLoading && rightIcon}
  </PressButton>
})
