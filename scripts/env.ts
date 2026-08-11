/**
 * Load `.env` for the CLI scripts. Next.js does this on its own; `tsx` does not.
 * Import this first in any script that talks to a model.
 */

export function loadEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env is fine — the caller reports a clearer error if the key is needed.
  }
}
