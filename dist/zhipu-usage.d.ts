import * as fs from 'node:fs';
import type { HudConfig } from './config.js';
import type { UsageData } from './types.js';
export type ZhipuProvider = 'zhipu' | 'zai';
export interface ZhipuEnv {
    baseUrl?: string;
    authToken?: string;
}
/** Injectable HTTP fetcher so tests can stub network calls. */
export type ZhipuFetcher = (url: string, authToken: string, timeoutMs: number) => Promise<unknown>;
type FileSystemDeps = {
    chmodSync: typeof fs.chmodSync;
    existsSync: typeof fs.existsSync;
    mkdirSync: typeof fs.mkdirSync;
    readFileSync: typeof fs.readFileSync;
    renameSync: typeof fs.renameSync;
    rmSync: typeof fs.rmSync;
    statSync: typeof fs.statSync;
    writeFileSync: typeof fs.writeFileSync;
};
export interface ZhipuUsageDeps {
    fetcher?: ZhipuFetcher;
    fs?: FileSystemDeps;
    env?: ZhipuEnv;
    now?: () => number;
    /** When provided, a stale cache triggers a detached background refresh instead of a blocking fetch. */
    spawnRefresh?: () => void;
}
/**
 * Detect a GLM Coding Plan provider from the Claude Code environment.
 *
 * Detection order:
 *   1. `ANTHROPIC_BASE_URL` host — authoritative.
 *   2. model id prefix `glm-` — fallback when the base url env is unset
 *      (defaults to the domestic `zhipu` flavour since that is the more common
 *      deployment; the rendering difference between zhipu/zai is purely a
 *      label, so a misguess is cosmetic only).
 */
export declare function detectZhipuProvider(env?: ZhipuEnv, modelId?: string): ZhipuProvider | null;
/**
 * Coerce a raw `quota/limit` response into `UsageData`.
 *
 * Accepts both `{ data: { limits: [...] } }` and a bare `{ limits: [...] }`
 * envelope. `TOKENS_LIMIT` maps to the 5h window and `TIME_LIMIT` to the
 * monthly quota. Returns null when neither limit carries a usable percentage.
 */
export declare function parseZhipuQuota(raw: unknown): UsageData | null;
/**
 * Resolve GLM Coding Plan usage for the current statusline tick.
 *
 * Strategy:
 *   1. Return a fresh cache hit immediately when available (the common case).
 *   2. When the cache is stale but data exists, return it instantly and spawn
 *      a detached background refresh (if spawnRefresh is provided) so the next
 *      tick picks up fresh values with zero blocking.
 *   3. First run (no cache) or no spawn capability — fetch synchronously with
 *      a short timeout so an initial value appears without waiting.
 *   4. On any failure, return the last stale value so the HUD keeps showing
 *      the last known usage rather than going dark.
 *
 * Returns null when there is no token, no detectable provider, or no usable
 * data from any source — the renderer then hides the usage line.
 */
export declare function getUsageFromZhipu(config: HudConfig, deps?: ZhipuUsageDeps): Promise<UsageData | null>;
/**
 * Spawn a detached background process that refreshes the cache file. The child
 * inherits the parent environment (including ANTHROPIC_AUTH_TOKEN) and runs
 * `node index.js --zhipu-refresh`. Failures are silent — the next statusline
 * tick simply retries.
 */
export declare function spawnDetachedRefresh(): void;
/**
 * Standalone cache refresh for the detached `--zhipu-refresh` child process.
 * Reads env + config, fetches the quota, and writes the cache. Silently exits
 * on any failure so a broken background refresh never surfaces to the user.
 */
export declare function refreshZhipuCacheStandalone(): Promise<void>;
export {};
//# sourceMappingURL=zhipu-usage.d.ts.map