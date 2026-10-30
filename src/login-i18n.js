/**
 * Login-page localization.
 *
 * The login page is rendered by this plugin, outside dsh's SPA, so it cannot
 * reuse the harness locale service. The vocabulary is deliberately tiny: one
 * page, two languages, a handful of strings.
 *
 * Resolution order (first match wins):
 *   1. `?lang=` on the login URL — an explicit pick from the page's switcher,
 *      which the route also persists in the `dsh_lang` cookie;
 *   2. the `dsh_lang` cookie — the remembered pick;
 *   3. `DSH_AUTH_LANG` — the deployment default (`zh-CN` or `en`);
 *   4. `Accept-Language` — the browser's preference order;
 *   5. `DEFAULT_LOCALE`.
 */
export const DEFAULT_LOCALE = 'zh-CN';
export const LOCALES = ['zh-CN', 'en'];
/** Preference cookie written only when the visitor picks a language explicitly. */
export const LANGUAGE_COOKIE = 'dsh_lang';
/** Display names are intentionally not translated: each language names itself. */
export const LANGUAGE_NAMES = {
    'zh-CN': '中文',
    en: 'English'
};
const MESSAGES = {
    'zh-CN': {
        tag: 'zh-CN',
        docTitle: 'DeepSeek Harness - 登录',
        subtitle: '请登录以继续',
        usernameLabel: '用户名',
        passwordLabel: '密码',
        submitLabel: '登 录',
        wrongCredentials: '用户名或密码错误',
        untrustedHost: (host) => `当前 Host（${host}）未被信任，请为该地址添加 --trusted-host 后重试`,
        lockedOut: (seconds) => `尝试次数过多，请 ${seconds} 秒后再试`,
        sessionRequired: '登录已失效，请重新登录',
        wrongPassword: '当前密码错误',
        passwordRequired: '请填写当前密码和新密码',
        passwordTooShort: (min) => `新密码至少 ${min} 个字符`,
        requestRejected: '请求不被接受',
        panel: {
            label: '认证',
            heading: '管理员认证',
            intro: '修改登录本机 Web UI 的管理员密码。修改成功后，其他已登录的浏览器会被登出。',
            usernameLabel: '当前用户名',
            oldPasswordLabel: '当前密码',
            newPasswordLabel: '新密码',
            confirmPasswordLabel: '确认新密码',
            submitLabel: '修改密码',
            workingLabel: '正在提交…',
            mismatch: '两次输入的新密码不一致',
            changed: '密码已更新，其他浏览器已登出',
            signOutLabel: '退出登录',
            footnote: '忘记密码：在服务器上运行 `dsh --profile web auth-reset`。'
        }
    },
    en: {
        tag: 'en',
        docTitle: 'DeepSeek Harness - Sign in',
        subtitle: 'Sign in to continue',
        usernameLabel: 'Username',
        passwordLabel: 'Password',
        submitLabel: 'Sign in',
        wrongCredentials: 'Incorrect username or password',
        untrustedHost: (host) => `Host ${host} is not trusted. Add --trusted-host for this address and retry.`,
        lockedOut: (seconds) => `Too many attempts. Try again in ${seconds} seconds.`,
        sessionRequired: 'Your session has expired. Sign in again.',
        wrongPassword: 'Current password is incorrect',
        passwordRequired: 'Enter your current and new password',
        passwordTooShort: (min) => `Password must be at least ${min} characters`,
        requestRejected: 'Request rejected',
        panel: {
            label: 'Auth',
            heading: 'Administrator sign-in',
            intro: 'Change the password used to sign in to this Web UI. Changing it signs out every other browser.',
            usernameLabel: 'Signed in as',
            oldPasswordLabel: 'Current password',
            newPasswordLabel: 'New password',
            confirmPasswordLabel: 'Confirm new password',
            submitLabel: 'Change password',
            workingLabel: 'Saving…',
            mismatch: 'The two new passwords do not match',
            changed: 'Password updated. Other browsers are signed out.',
            signOutLabel: 'Sign out',
            footnote: 'Forgot it? Run `dsh --profile web auth-reset` on the server.'
        }
    }
};
/** Copy for one locale. */
export function loginMessages(locale) {
    return MESSAGES[locale];
}
/**
 * Map a tag such as `zh`, `zh-Hans`, `zh-CN`, `en-US` onto a supported locale.
 * Unknown tags return `undefined`, so callers can fall through.
 */
export function parseLocale(value) {
    if (typeof value !== 'string')
        return undefined;
    const tag = value.trim().toLowerCase();
    if (tag === '')
        return undefined;
    if (tag === 'zh' || tag.startsWith('zh-'))
        return 'zh-CN';
    if (tag === 'en' || tag.startsWith('en-'))
        return 'en';
    return undefined;
}
/** First supported locale in an `Accept-Language` header, honouring `q=0`. */
export function fromAcceptLanguage(header) {
    if (!header)
        return undefined;
    for (const part of header.split(',')) {
        const [tag, ...params] = part.split(';');
        const refused = params.some((param) => {
            const [key, value] = param.trim().split('=');
            return key === 'q' && Number(value) === 0;
        });
        if (refused)
            continue;
        const locale = parseLocale(tag);
        if (locale !== undefined)
            return locale;
    }
    return undefined;
}
/** Locale remembered in the `dsh_lang` cookie, if any. */
export function cookieLocale(cookieHeader) {
    if (!cookieHeader)
        return undefined;
    const match = cookieHeader.match(/(?:^|;\s*)dsh_lang=([^;]*)/);
    return match ? parseLocale(decodeURIComponent(match[1])) : undefined;
}
/**
 * The deployment default from `DSH_AUTH_LANG`. A present but unsupported value
 * throws instead of silently falling back, so a typo fails at startup.
 */
export function configuredLocale(value = process.env.DSH_AUTH_LANG) {
    if (value === undefined || value.trim() === '')
        return undefined;
    const locale = parseLocale(value);
    if (locale === undefined) {
        throw new Error(`@timgong/dsh-public-access: DSH_AUTH_LANG must be "zh-CN" or "en", got ${JSON.stringify(value)}`);
    }
    return locale;
}
/** Resolve the locale for one request. */
export function resolveLocale(input) {
    return (parseLocale(input.lang) ??
        cookieLocale(input.cookieHeader) ??
        configuredLocale() ??
        fromAcceptLanguage(input.acceptLanguage) ??
        DEFAULT_LOCALE);
}
