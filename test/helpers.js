/**
 * Shared test helpers.
 *
 * Every test file runs in its own process, so pointing `DSH_HOME` at a fresh
 * temporary directory here keeps the credential store away from the real
 * `~/.dsh` without any cross-file coordination.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Redirect the credential store into a throwaway directory.
 * @returns the temporary home directory.
 */
export function useTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-public-access-test-'))
  process.env.DSH_HOME = home
  delete process.env.DSH_AUTH_FILE
  return home
}
