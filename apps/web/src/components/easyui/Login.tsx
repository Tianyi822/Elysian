/**
 * EasyUI source component, adapted for Elysian.
 * Copyright (c) 2026 Suraj Maurya. MIT, see ./LICENSE.
 * Upstream: src/components/ui/Login.tsx
 * Revision: f2287ce01ae6b6e7be28ca8d6a803dff91a20c96
 * Adaptations are recorded in ./upstream.json.
 */
import type { ReactNode } from 'react'
import './login.css'

interface LoginProps {
  title: string
  logo: ReactNode
  children: ReactNode
}

/** Visual shell only: the caller owns the form, inputs and session behavior. */
export function Login({ title, logo, children }: LoginProps) {
  return (
    <section className="easyui-login relative mx-auto w-full max-w-md rounded-3xl border border-login-line bg-login-card p-6 text-login-fg shadow-[0_20px_50px_var(--t-panel-shadow)] sm:p-8">
      <header className="mb-6 flex flex-col items-center text-center">
        <div aria-hidden className="mb-3.5 grid size-10 place-items-center rounded-full border border-login-line bg-login-field">
          {logo}
        </div>
        <h1 className="text-2xl font-semibold">{title}</h1>
      </header>
      {children}
    </section>
  )
}
