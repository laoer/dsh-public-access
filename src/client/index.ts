/**
 * Settings-panel client half: the "认证 / Auth" section.
 *
 * This file is not an ES module. It is the browser artifact the harness's
 * module loader materializes, so it wraps itself in the
 * `window.__ModuleLoader__.load({ id, factory })` envelope (id must equal the
 * package name) exactly like the harness's own client bundles. `require` is
 * answered by the loader's seed table, which is where React comes from; the
 * plugin never bundles its own copy.
 *
 * What it renders: the signed-in administrator name plus a change-password
 * form. All copy arrives from `GET /_auth/password` so there is one source of
 * truth for translations (the server already localizes the login page), and
 * the form posts the same origin-relative endpoint as JSON — the session
 * cookie rides along, and the custom content type is what makes the request
 * un-forgeable from another site.
 *
 * Styling uses only `--dsw-alias-*` theme tokens so light/dark switching and
 * future renames cannot break the panel.
 */

declare const window: any
declare const document: any

/** The narrow slice of React this panel uses. */
interface ReactLike {
  createElement: (type: any, props?: any, ...children: any[]) => any
  useState: <T>(initial: T) => [T, (next: T | ((previous: T) => T)) => void]
  useEffect: (effect: () => void, deps: unknown[]) => void
  useCallback: <T extends (...args: any[]) => any>(fn: T, deps: unknown[]) => T
}

/** Panel copy served by the host half. */
interface PanelMessages {
  label: string
  heading: string
  intro: string
  usernameLabel: string
  oldPasswordLabel: string
  newPasswordLabel: string
  confirmPasswordLabel: string
  submitLabel: string
  workingLabel: string
  mismatch: string
  changed: string
  signOutLabel: string
  footnote: string
}

/** One `GET /_auth/password` answer. */
interface PanelState {
  username?: string
  messages?: PanelMessages
}

/** Fallbacks used only when the state request fails; the server normally wins. */
const FALLBACK_COPY: PanelMessages = {
  label: 'Auth',
  heading: 'Administrator sign-in',
  intro: 'Change the password used to sign in to this Web UI.',
  usernameLabel: 'Signed in as',
  oldPasswordLabel: 'Current password',
  newPasswordLabel: 'New password',
  confirmPasswordLabel: 'Confirm new password',
  submitLabel: 'Change password',
  workingLabel: 'Saving…',
  mismatch: 'The two new passwords do not match',
  changed: 'Password updated.',
  signOutLabel: 'Sign out',
  footnote: 'Forgot it? Run `dsh --profile web auth-reset` on the server.'
}

/** The endpoint served by `src/reverse-proxy-fix.ts`. */
const PASSWORD_PATH = '/_auth/password'

/** Small helper: token-backed style values with a safe fallback. */
function themeToken(name: string, fallback: string): string {
  return `var(${name}, ${fallback})`
}

const PANEL_STYLES = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
    padding: '4px 0',
    maxWidth: '560px',
    color: themeToken('--dsw-alias-label-primary', '#e6e6e6'),
    fontSize: '13px',
    lineHeight: 1.5
  },
  intro: { color: themeToken('--dsw-alias-label-secondary', '#9a9a9a'), margin: 0 },
  identity: { margin: 0, fontVariantNumeric: 'tabular-nums' },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  label: { color: themeToken('--dsw-alias-label-secondary', '#9a9a9a'), fontSize: '12px' },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 10px',
    borderRadius: '8px',
    border: `1px solid ${themeToken('--dsw-alias-border-l1', '#333')}`,
    background: themeToken('--dsw-alias-bg-layer-2', '#141414'),
    color: themeToken('--dsw-alias-label-primary', '#e6e6e6'),
    fontSize: '13px',
    outline: 'none'
  },
  actions: { display: 'flex', alignItems: 'center', gap: '12px' },
  primary: {
    padding: '8px 16px',
    borderRadius: '8px',
    border: 'none',
    background: themeToken('--dsw-alias-brand-primary', '#4a9eff'),
    color: '#fff',
    fontSize: '13px',
    fontWeight: 500,
    cursor: 'pointer'
  },
  primaryDisabled: {
    padding: '8px 16px',
    borderRadius: '8px',
    border: 'none',
    background: themeToken('--dsw-alias-state-idle-primary', '#4a4a4a'),
    color: '#fff',
    fontSize: '13px',
    cursor: 'default'
  },
  secondary: {
    padding: '8px 16px',
    borderRadius: '8px',
    border: `1px solid ${themeToken('--dsw-alias-border-l1', '#333')}`,
    background: 'transparent',
    color: themeToken('--dsw-alias-label-primary', '#e6e6e6'),
    fontSize: '13px',
    cursor: 'pointer'
  },
  footnote: { color: themeToken('--dsw-alias-label-secondary', '#9a9a9a'), fontSize: '12px', margin: 0 },
  error: { color: themeToken('--dsw-alias-state-error-primary', '#ff6b6b'), margin: 0 },
  success: { color: themeToken('--dsw-alias-state-success-primary', '#4cc38a'), margin: 0 }
} as const

/**
 * Register the section into the settings panel.
 *
 * `slots.inject` waits for the owning `settings.section` declaration, so the
 * settings shell may load before or after this bundle without a race.
 * @param ctx the client plugin context.
 * @param React the loader-provided React.
 */
function registerAuthSection(ctx: any, React: ReactLike): void {
  const slots = ctx?.slots
  slots?.inject('settings.section', () =>
    slots.register(
      { name: 'settings.section', id: 'auth', order: 100, label: authNavLabel },
      createAuthSection(React)
    )
  )
}

/**
 * Nav label for the section row.
 *
 * It is a thunk on purpose: the shell re-reads it on every projection, so the
 * row follows the active language without re-registering. The dsh_lang cookie
 * is the plugin's own explicit pick; the document language covers the rest.
 * @returns `认证` for Chinese, `Auth` otherwise.
 */
function authNavLabel(): string {
  let tag = ''
  try {
    const match = /(?:^|;\s*)dsh_lang=([^;]*)/.exec(document?.cookie ?? '')
    tag = (match?.[1] ?? document?.documentElement?.lang ?? '').toLowerCase()
  } catch {
    tag = ''
  }
  return tag.startsWith('zh') ? '认证' : 'Auth'
}

/**
 * Build the section component.
 * @param React the loader-provided React.
 * @returns a component suitable for the `settings.section` slot.
 */
function createAuthSection(React: ReactLike): (props: any) => any {
  const h = React.createElement
  return function AuthSection(): any {
    const [state, setState] = React.useState<PanelState>({})
    const [oldPassword, setOldPassword] = React.useState('')
    const [newPassword, setNewPassword] = React.useState('')
    const [confirmPassword, setConfirmPassword] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState('')
    const [success, setSuccess] = React.useState('')

    const messages = state.messages ?? FALLBACK_COPY

    React.useEffect(() => {
      let cancelled = false
      fetch(PASSWORD_PATH, { credentials: 'same-origin', headers: { accept: 'application/json' } })
        .then((response: any) => (response.ok ? response.json() : undefined))
        .then((body: PanelState | undefined) => {
          if (!cancelled && body !== undefined) setState(body)
        })
        .catch(() => {})
      return () => {
        cancelled = true
      }
    }, [])

    const submit = React.useCallback(
      (event: any) => {
        event?.preventDefault?.()
        setError('')
        setSuccess('')
        if (newPassword !== confirmPassword) {
          setError(messages.mismatch)
          return
        }
        setBusy(true)
        fetch(PASSWORD_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-dsh-renew': '1' },
          body: JSON.stringify({ oldPassword, newPassword })
        })
          .then(async (response: any) => {
            let body: any
            try {
              body = await response.json()
            } catch {
              body = undefined
            }
            if (response.ok && body?.ok === true) {
              setOldPassword('')
              setNewPassword('')
              setConfirmPassword('')
              setSuccess(messages.changed)
              return
            }
            if (response.status === 401 && body?.code === 'session-required') {
              // The store rotated its secret and the refresh cookie did not
              // land: send the page back through the gate.
              window.location.reload()
              return
            }
            setError(typeof body?.error === 'string' ? body.error : messages.mismatch)
          })
          .catch(() => setError(messages.intro))
          .then(() => setBusy(false))
      },
      [oldPassword, newPassword, confirmPassword, messages]
    )

    const signOut = React.useCallback((event: any) => {
      event?.preventDefault?.()
      fetch('/_auth/logout', { method: 'POST', credentials: 'same-origin' })
        .catch(() => {})
        .then(() => window.location.reload())
    }, [])

    const field = (label: string, value: string, onChange: (next: string) => void, autoComplete: string) =>
      h(
        'div',
        { style: PANEL_STYLES.field, key: label },
        h('label', { style: PANEL_STYLES.label }, label),
        h('input', {
          type: 'password',
          value,
          style: PANEL_STYLES.input,
          autoComplete,
          onChange: (event: any) => onChange(event.target.value)
        })
      )

    return h(
      'div',
      { style: PANEL_STYLES.root },
      h('h3', { style: { margin: 0, fontSize: '15px', fontWeight: 600 } }, messages.heading),
      h('p', { style: PANEL_STYLES.intro }, messages.intro),
      h(
        'p',
        { style: PANEL_STYLES.identity },
        `${messages.usernameLabel}: ${state.username ?? '—'}`
      ),
      h(
        'form',
        { onSubmit: submit, style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
        field(messages.oldPasswordLabel, oldPassword, setOldPassword, 'current-password'),
        field(messages.newPasswordLabel, newPassword, setNewPassword, 'new-password'),
        field(messages.confirmPasswordLabel, confirmPassword, setConfirmPassword, 'new-password'),
        error !== '' ? h('p', { style: PANEL_STYLES.error, role: 'alert' }, error) : null,
        success !== '' ? h('p', { style: PANEL_STYLES.success, role: 'status' }, success) : null,
        h(
          'div',
          { style: PANEL_STYLES.actions },
          h(
            'button',
            { type: 'submit', style: busy ? PANEL_STYLES.primaryDisabled : PANEL_STYLES.primary, disabled: busy },
            busy ? messages.workingLabel : messages.submitLabel
          ),
          h('button', { type: 'button', style: PANEL_STYLES.secondary, onClick: signOut }, messages.signOutLabel)
        )
      ),
      h('p', { style: PANEL_STYLES.footnote }, messages.footnote)
    )
  }
}

// ── Bundle envelope ────────────────────────────────────────────────────────
// The loader calls `factory(require)` once, memoizes the exports, and expects
// `apply` (plus cordis `inject`) back. Nothing here touches the DOM until the
// settings section actually renders.
window.__ModuleLoader__?.load({
  id: '@timgong/dsh-public-access',
  factory(require: (id: string) => any) {
    const React = require('react') as ReactLike
    return {
      inject: ['slots'],
      apply: (ctx: any) => registerAuthSection(ctx, React)
    }
  }
})
