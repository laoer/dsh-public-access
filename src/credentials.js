/**
 * Administrator credential store.
 *
 * The plugin used to read `DSH_AUTH_USER` / `DSH_AUTH_PASS` and fall back to
 * `admin` / `admin`. A default password that "just works" plus a wildcard bind
 * is the single worst combination this plugin can ship, and an environment
 * variable is a poor password store anyway (visible in `ps e`, in
 * `/proc/<pid>/environ`, and in plain text unit files).
 *
 * New model:
 *
 * - The file `$DSH_HOME/dsh-public-access.json` is the source of truth. It is
 *   written `0600` in a `0700` directory and holds the scrypt hash, a random
 *   32-byte session signing secret, and the administrator name.
 * - First activation without that file seeds it: from `DSH_AUTH_PASS` when the
 *   operator still sets it (one-time migration), otherwise from a freshly
 *   generated random password that is printed to the console **and** written
 *   to `$DSH_HOME/dsh-public-access.initial-password` (also `0600`) so it can
 *   be recovered from another terminal. That file is removed as soon as the
 *   password is changed through the panel or `auth-reset`.
 * - Once the file exists the environment is ignored for authentication. A
 *   stale `DSH_AUTH_PASS` in a unit file must not silently undo a password the
 *   administrator set in the UI, so it is only reported as ignored.
 *
 * Passwords are stored as `scrypt$N$r$p$salt$hash` so the cost parameters can
 * be raised later without a format break. All comparisons are constant-time.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/** Minimum accepted password length, in characters. */
export const MIN_PASSWORD_LENGTH = 8;
/** scrypt cost parameters. `N` is the CPU/memory cost, `r` the block size. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
/** Node's default `maxmem` (32 MiB) is below what N=16384/r=8 needs. */
const SCRYPT_MAXMEM = 128 * 1024 * 1024;
/** Length of a generated first-run password. */
const GENERATED_PASSWORD_LENGTH = 20;
/** Unambiguous alphabet: no 0/O, 1/l/I. */
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
/**
 * The dsh data directory (`$DSH_HOME`, else `~/.dsh`), mirroring the harness's
 * own resolution so a custom home or a second instance never shares one
 * administrator account with the real `~/.dsh`.
 * @returns the harness home directory.
 */
function dshHomeDir() {
    const fromEnv = process.env.DSH_HOME;
    return fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh');
}
/**
 * Path of the credential file. `DSH_AUTH_FILE` overrides it wholesale, which
 * is what the test suite uses.
 * @returns absolute path of the credential file.
 */
export function credentialFilePath() {
    const override = process.env.DSH_AUTH_FILE;
    if (override !== undefined && override.trim().length > 0)
        return override;
    return join(dshHomeDir(), 'dsh-public-access.json');
}
/**
 * Path of the one-time plaintext file holding a generated first-run password.
 * It sits beside the credential file and is removed on the first password
 * change.
 * @returns absolute path of the initial-password file.
 */
export function initialPasswordFilePath() {
    const file = credentialFilePath();
    // `dsh-public-access.json` -> `dsh-public-access.initial-password`, so the
    // documented name holds while a custom `DSH_AUTH_FILE` stays unambiguous.
    return file.endsWith('.json') ? `${file.slice(0, -5)}.initial-password` : `${file}.initial-password`;
}
/** Ensure the directory holding the credential file exists, owner-only. */
function ensureDir(file) {
    const dir = dirname(file);
    if (dir !== '' && !existsSync(dir))
        mkdirSync(dir, { recursive: true, mode: 0o700 });
}
/**
 * Hash a password with scrypt and a fresh 16-byte salt.
 * @param password plaintext password.
 * @returns `scrypt$N$r$p$salt$hash`.
 */
function hashPassword(password) {
    const salt = randomBytes(16);
    const derived = scryptSync(password, salt, SCRYPT_KEYLEN, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: SCRYPT_MAXMEM
    });
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}
/**
 * Verify a password against a stored `scrypt$...` hash.
 *
 * Unknown or malformed encodings are rejected rather than guessed at, so a
 * corrupted file can never authenticate anybody.
 * @param password submitted plaintext password.
 * @param stored stored hash string.
 * @returns true only when the password matches.
 */
function verifyPasswordHash(password, stored) {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt')
        return false;
    const [, n, r, p, saltHex, hashHex] = parts;
    const cost = { N: Number(n), r: Number(r), p: Number(p) };
    if (!Number.isSafeInteger(cost.N) || !Number.isSafeInteger(cost.r) || !Number.isSafeInteger(cost.p)) {
        return false;
    }
    let expected;
    try {
        expected = Buffer.from(hashHex, 'hex');
    }
    catch {
        return false;
    }
    if (expected.length === 0)
        return false;
    let actual;
    try {
        actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
            ...cost,
            maxmem: SCRYPT_MAXMEM
        });
    }
    catch {
        return false;
    }
    return actual.length === expected.length && timingSafeEqual(expected, actual);
}
/**
 * Generate a random first-run password.
 * @returns {@link GENERATED_PASSWORD_LENGTH} characters from an unambiguous alphabet.
 */
export function generatePassword() {
    const bytes = randomBytes(GENERATED_PASSWORD_LENGTH);
    let out = '';
    for (let i = 0; i < GENERATED_PASSWORD_LENGTH; i += 1) {
        out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
    }
    return out;
}
/** A random session-signing secret (32 bytes hex). */
function generateSecret() {
    return randomBytes(32).toString('hex');
}
/**
 * Parsed credential file, keyed by `mtimeMs:size`.
 *
 * Session validation runs on every request, so re-reading and re-parsing the
 * file each time would put a synchronous read in the hot path. The stat is
 * kept (a few microseconds) instead of trusting a pure in-memory cache, so an
 * `auth-reset` from another process is picked up without a restart.
 */
let credentialCache;
/**
 * Read and parse the credential file.
 * @returns the stored credentials, or undefined when absent or unreadable.
 */
export function readCredentials() {
    const file = credentialFilePath();
    let key;
    try {
        const stat = statSync(file);
        key = `${stat.mtimeMs}:${stat.size}`;
    }
    catch {
        credentialCache = undefined;
        return undefined;
    }
    if (credentialCache?.key === key)
        return credentialCache.data;
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (parsed === null ||
            typeof parsed !== 'object' ||
            typeof parsed.username !== 'string' ||
            typeof parsed.passwordHash !== 'string' ||
            typeof parsed.secret !== 'string' ||
            parsed.secret.length < 16) {
            return undefined;
        }
        credentialCache = { key, data: parsed };
        return parsed;
    }
    catch {
        return undefined;
    }
}
/**
 * Write the credential file owner-only.
 * @param data the credentials to persist.
 */
function writeCredentials(data) {
    const file = credentialFilePath();
    ensureDir(file);
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
        const stat = statSync(file);
        credentialCache = { key: `${stat.mtimeMs}:${stat.size}`, data };
    }
    catch {
        credentialCache = undefined;
    }
    // `mode` only applies when the file is created; an existing file keeps its
    // old bits, so tighten explicitly.
    try {
        chmodSync(file, 0o600);
    }
    catch {
        // Non-POSIX filesystem: nothing to tighten.
    }
}
/**
 * Persist a plaintext first-run password next to the credential file.
 * @param password the generated password.
 * @returns the path written.
 */
function writeInitialPassword(password) {
    const file = initialPasswordFilePath();
    ensureDir(file);
    writeFileSync(file, [
        '# dsh-public-access: generated administrator password (first start)',
        '',
        `username: ${readCredentials()?.username ?? 'admin'}`,
        `password: ${password}`,
        '',
        'Log in, then change it under Settings -> Auth (or run `dsh --profile web auth-reset`).',
        'This file is deleted automatically once the password is changed.',
        ''
    ].join('\n'), { encoding: 'utf8', mode: 0o600 });
    try {
        chmodSync(file, 0o600);
    }
    catch {
        // Non-POSIX filesystem.
    }
    return file;
}
/**
 * Remove the generated-password file, if any. Called after a successful
 * password change so a plaintext secret does not outlive its usefulness.
 */
export function clearInitialPassword() {
    try {
        rmSync(initialPasswordFilePath(), { force: true });
    }
    catch {
        // Best effort: a leftover 0600 file is not a disclosure by itself.
    }
}
/**
 * Repair permissions left by another version or umask.
 *
 * No-op unless the file exists; failures are ignored because a filesystem
 * without POSIX modes cannot be tightened.
 */
export function hardenCredentialPermissions() {
    for (const file of [credentialFilePath(), initialPasswordFilePath()]) {
        if (!existsSync(file))
            continue;
        try {
            chmodSync(file, 0o600);
        }
        catch {
            // Non-POSIX filesystem.
        }
    }
}
/**
 * Bootstrap the credential file (idempotent).
 *
 * Order of authority:
 * 1. an existing credential file wins — the environment cannot override a
 *    password the administrator set through the panel or `auth-reset`;
 * 2. otherwise `DSH_AUTH_PASS` seeds the file once (migration for existing
 *    deployments);
 * 3. otherwise a random password is generated, printed, and written to the
 *    initial-password file.
 * @param now creation timestamp (tests pass a fixed value).
 * @returns how the credentials were obtained, plus the generated password.
 */
export function ensureCredentials(now = Date.now()) {
    hardenCredentialPermissions();
    const existing = readCredentials();
    const envPassword = process.env.DSH_AUTH_PASS;
    const envUsername = process.env.DSH_AUTH_USER?.trim() || undefined;
    if (existing !== undefined) {
        return {
            status: 'existing',
            username: existing.username,
            envIgnored: envPassword !== undefined && envPassword !== ''
        };
    }
    const username = envUsername ?? 'admin';
    if (envPassword !== undefined && envPassword !== '') {
        writeCredentials({
            version: 1,
            username,
            passwordHash: hashPassword(envPassword),
            secret: generateSecret(),
            createdAt: now,
            updatedAt: now
        });
        return { status: 'seeded', username, envIgnored: false };
    }
    const generatedPassword = generatePassword();
    writeCredentials({
        version: 1,
        username,
        passwordHash: hashPassword(generatedPassword),
        secret: generateSecret(),
        createdAt: now,
        updatedAt: now
    });
    const file = writeInitialPassword(generatedPassword);
    return { status: 'generated', username, generatedPassword, initialPasswordFile: file, envIgnored: false };
}
/**
 * The configured administrator name.
 * @returns the username, or `admin` when the file is missing.
 */
export function getUsername() {
    return readCredentials()?.username ?? 'admin';
}
/**
 * The session-signing secret.
 *
 * Reading it from the file (instead of deriving it from the password) is what
 * lets sessions survive a restart while a password change still invalidates
 * every one of them.
 * @returns the stored secret.
 * @throws when the credential file has not been bootstrapped yet.
 */
export function getSessionSecret() {
    const creds = readCredentials();
    if (creds === undefined) {
        throw new Error('@timgong/dsh-public-access: credential file missing; activate the plugin before issuing sessions');
    }
    return creds.secret;
}
/**
 * Verify a username/password pair.
 *
 * The username is compared as fixed-length byte buffers and the password
 * through scrypt, so a mismatch leaks neither timing nor prefix length.
 * @param username submitted username.
 * @param password submitted plaintext password.
 * @returns true when both match the stored administrator.
 */
export function verifyCredentials(username, password) {
    const creds = readCredentials();
    if (creds === undefined)
        return false;
    const expectedUser = Buffer.from(creds.username, 'utf8');
    const actualUser = Buffer.from(username, 'utf8');
    const userOk = expectedUser.length === actualUser.length && timingSafeEqual(expectedUser, actualUser);
    // Always run the hash comparison, even for a wrong username, so the response
    // time does not reveal which field was wrong.
    const passOk = verifyPasswordHash(password, creds.passwordHash);
    return userOk && passOk;
}
/**
 * Change the administrator password.
 *
 * A successful change rotates the session secret, which invalidates every
 * existing session cookie, then re-issues one for the caller. The plaintext
 * first-run file is removed, and so is a stale `DSH_AUTH_PASS` (it would
 * otherwise reappear as "ignored" noise on every restart).
 * @param oldPassword current password (proves the caller may change it).
 * @param newPassword replacement password.
 * @param now update timestamp (tests pass a fixed value).
 * @returns the outcome; `ok: false` carries a machine-readable reason.
 */
export function changePassword(oldPassword, newPassword, now = Date.now()) {
    if (newPassword.trim().length < MIN_PASSWORD_LENGTH)
        return { ok: false, reason: 'too-short' };
    if (oldPassword === '')
        return { ok: false, reason: 'empty' };
    const creds = readCredentials();
    if (creds === undefined || !verifyPasswordHash(oldPassword, creds.passwordHash)) {
        return { ok: false, reason: 'wrong-password' };
    }
    writeCredentials({
        ...creds,
        passwordHash: hashPassword(newPassword),
        secret: generateSecret(),
        updatedAt: now
    });
    clearInitialPassword();
    return { ok: true, username: creds.username };
}
/**
 * Replace the administrator credentials from the command line (`auth-reset`).
 *
 * Always rotates the session secret, so every issued cookie dies. This is the
 * documented recovery path for a forgotten password and for a username the
 * operator wants to rename.
 * @param options replacement username and/or password.
 * @param now update timestamp.
 * @returns the updated username and what was changed.
 */
export function resetCredentials(options, now = Date.now()) {
    const creds = readCredentials();
    if (creds === undefined) {
        throw new Error('no administrator account yet; start the web profile once to create one');
    }
    const username = options.username ?? creds.username;
    if (username.trim() === '')
        throw new Error('username must not be empty');
    const passwordChanged = options.password !== undefined;
    if (passwordChanged && options.password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    writeCredentials({
        ...creds,
        username,
        ...(passwordChanged ? { passwordHash: hashPassword(options.password) } : {}),
        secret: generateSecret(),
        updatedAt: now
    });
    clearInitialPassword();
    return { username, passwordChanged, usernameChanged: username !== creds.username };
}
