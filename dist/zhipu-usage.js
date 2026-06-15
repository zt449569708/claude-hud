import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getHudPluginDir } from './claude-config-dir.js';
/**
 * GLM Coding Plan (智谱 / Z.ai) usage provider.
 *
 * Claude Code talks to GLM Coding Plan through an Anthropic-compatible endpoint
 * (`ANTHROPIC_BASE_URL` pointing at bigmodel.cn or api.z.ai). Those endpoints do
 * not inject `rate_limits` into the statusline stdin payload the way an
 * Anthropic subscriber session does, so we fetch usage from Z.ai/ZHIPU's own
 * monitor API and coerce it into the standard `UsageData` shape that the
 * existing renderer already understands.
 *
 * Window mapping (matches GLM Coding Plan's quota model):
 *   - `TOKENS_LIMIT`  → 5-hour rolling window  → `UsageData.fiveHour`
 *   - `TIME_LIMIT`    → monthly quota           → `UsageData.sevenDay`
 *
 * Auth uses the same `ANTHROPIC_AUTH_TOKEN` the user already configured for
 * Claude Code (passed verbatim as the `Authorization` header, matching the
 * official glm-plan-usage plugin).
 */
const DEFAULT_FETCH_TIMEOUT_MS = 1000;
const DEFAULT_FRESHNESS_MS = 60_000;
const WRITE_THROTTLE_MS = 30_000;
const QUOTA_LIMIT_PATH = '/api/monitor/usage/quota/limit';
const DEFAULT_CACHE_FILENAME = 'zhipu-usage.json';
const fsDeps = {
    chmodSync: fs.chmodSync,
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    readFileSync: fs.readFileSync,
    renameSync: fs.renameSync,
    rmSync: fs.rmSync,
    statSync: fs.statSync,
    writeFileSync: fs.writeFileSync,
};
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
export function detectZhipuProvider(env, modelId) {
    const { baseUrl } = env ? env : { baseUrl: process.env.ANTHROPIC_BASE_URL };
    const url = (baseUrl ?? '').trim();
    if (url.includes('open.bigmodel.cn') || url.includes('dev.bigmodel.cn')) {
        return 'zhipu';
    }
    if (url.includes('api.z.ai')) {
        return 'zai';
    }
    if (typeof modelId === 'string' && modelId.toLowerCase().startsWith('glm-')) {
        return 'zhipu';
    }
    return null;
}
function clampPercent(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }
    return Math.round(Math.min(100, Math.max(0, value)));
}
/** Coerce an epoch-ms timestamp (API) or ISO string (cache) into a Date. */
function toResetDate(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof value === 'string') {
        const ms = Date.parse(value);
        return Number.isFinite(ms) ? new Date(ms) : null;
    }
    return null;
}
/**
 * Coerce a raw `quota/limit` response into `UsageData`.
 *
 * Accepts both `{ data: { limits: [...] } }` and a bare `{ limits: [...] }`
 * envelope. `TOKENS_LIMIT` maps to the 5h window and `TIME_LIMIT` to the
 * monthly quota. Returns null when neither limit carries a usable percentage.
 */
export function parseZhipuQuota(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }
    const resp = raw;
    const limits = resp.data?.limits ?? resp.limits;
    if (!Array.isArray(limits)) {
        return null;
    }
    let fiveHour = null;
    let sevenDay = null;
    let fiveHourResetAt = null;
    let sevenDayResetAt = null;
    for (const item of limits) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const type = String(item.type ?? '').toUpperCase();
        const resetAt = toResetDate(item.nextResetTime);
        if (type === 'TOKENS_LIMIT') {
            fiveHour = clampPercent(item.percentage);
            fiveHourResetAt = resetAt;
        }
        else if (type === 'TIME_LIMIT') {
            sevenDay = clampPercent(item.percentage);
            sevenDayResetAt = resetAt;
        }
    }
    if (fiveHour === null && sevenDay === null) {
        return null;
    }
    return {
        fiveHour,
        sevenDay,
        fiveHourResetAt,
        sevenDayResetAt,
    };
}
function readCache(cachePath, now, freshnessMs, deps) {
    try {
        if (!deps.existsSync(cachePath)) {
            return null;
        }
        const raw = deps.readFileSync(cachePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
        const file = parsed;
        const updatedAt = Date.parse(file.updated_at ?? '');
        if (!Number.isFinite(updatedAt)) {
            return null;
        }
        if (now - updatedAt > freshnessMs) {
            return null;
        }
        const fiveHour = clampPercent(file.five_hour?.used_percentage);
        const sevenDay = clampPercent(file.seven_day?.used_percentage);
        if (fiveHour === null && sevenDay === null) {
            return null;
        }
        return {
            fiveHour,
            sevenDay,
            fiveHourResetAt: toResetDate(file.five_hour?.resets_at),
            sevenDayResetAt: toResetDate(file.seven_day?.resets_at),
        };
    }
    catch {
        return null;
    }
}
function shouldWrite(cachePath, now, deps) {
    try {
        if (!deps.existsSync(cachePath)) {
            return true;
        }
        const stats = deps.statSync(cachePath);
        return now - stats.mtimeMs > WRITE_THROTTLE_MS;
    }
    catch {
        return true;
    }
}
function writeCache(cachePath, usage, now, deps) {
    const snapshot = {
        updated_at: new Date(now).toISOString(),
        five_hour: {
            used_percentage: usage.fiveHour,
            resets_at: usage.fiveHourResetAt instanceof Date ? usage.fiveHourResetAt.toISOString() : null,
        },
        seven_day: {
            used_percentage: usage.sevenDay,
            resets_at: usage.sevenDayResetAt instanceof Date ? usage.sevenDayResetAt.toISOString() : null,
        },
    };
    const dir = path.dirname(cachePath);
    const base = path.basename(cachePath);
    const tmpPath = path.join(dir, `.${base}.${process.pid}.${now}.tmp`);
    try {
        if (deps.existsSync(dir)) {
            if (!deps.statSync(dir).isDirectory()) {
                return;
            }
        }
        else {
            deps.mkdirSync(dir, { recursive: true });
        }
        if (!shouldWrite(cachePath, now, deps)) {
            return;
        }
        deps.writeFileSync(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
            flag: 'wx',
        });
        deps.renameSync(tmpPath, cachePath);
        deps.chmodSync(cachePath, 0o600);
    }
    catch {
        try {
            deps.rmSync(tmpPath, { force: true });
        }
        catch {
            // Cache write failures must never break rendering.
        }
    }
}
function resolveBaseDomain(baseUrl) {
    try {
        const parsed = new URL(baseUrl);
        if (!parsed.protocol || !parsed.host) {
            return null;
        }
        return `${parsed.protocol}//${parsed.host}`;
    }
    catch {
        return null;
    }
}
const defaultFetcher = async (url, authToken, timeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                Authorization: authToken,
                'Accept-Language': 'en-US,en',
                'Content-Type': 'application/json',
            },
            signal: controller.signal,
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        return await res.json();
    }
    finally {
        clearTimeout(timer);
    }
};
/** Fetch the quota endpoint, parse, and persist to cache. Returns null on any failure. */
async function fetchAndCache(url, authToken, timeoutMs, cachePath, now, deps) {
    try {
        const raw = await deps.fetcher(url, authToken, timeoutMs);
        const usage = parseZhipuQuota(raw);
        if (usage) {
            writeCache(cachePath, usage, now, deps.fs);
            return usage;
        }
    }
    catch {
        // fetch/parse/write failure is non-fatal
    }
    return null;
}
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
export async function getUsageFromZhipu(config, deps = {}) {
    const env = deps.env ?? {
        baseUrl: process.env.ANTHROPIC_BASE_URL,
        authToken: process.env.ANTHROPIC_AUTH_TOKEN,
    };
    const provider = detectZhipuProvider(env);
    if (!provider || !env.authToken) {
        return null;
    }
    const baseDomain = resolveBaseDomain(env.baseUrl ?? '');
    if (!baseDomain) {
        return null;
    }
    const fs = deps.fs ?? fsDeps;
    const fetcher = deps.fetcher ?? defaultFetcher;
    const nowFn = deps.now ?? (() => Date.now());
    const now = nowFn();
    const enabled = config.display?.showZhipuUsage !== false;
    if (!enabled) {
        return null;
    }
    const cachePath = (config.display?.zhipuUsageCachePath ?? '').trim()
        || path.join(getHudPluginDir(os.homedir()), DEFAULT_CACHE_FILENAME);
    const freshnessMs = config.display?.zhipuUsageFreshnessMs ?? DEFAULT_FRESHNESS_MS;
    const fetchTimeoutMs = config.display?.zhipuUsageFetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const cached = readCache(cachePath, now, freshnessMs, fs);
    if (cached) {
        return cached;
    }
    // Fresh cache miss — look for stale data to display while refreshing.
    const stale = readCache(cachePath, nowFn(), Number.POSITIVE_INFINITY, fs);
    const url = `${baseDomain}${QUOTA_LIMIT_PATH}`;
    if (stale && deps.spawnRefresh) {
        // Background refresh: return stale data immediately and spawn a detached
        // child to fetch + persist so the next statusline tick reads fresh values
        // with zero blocking on this invocation.
        deps.spawnRefresh();
        return stale;
    }
    // First run (no stale data) or no spawn capability — sync fetch so an
    // initial value appears without waiting a full refresh cycle.
    return (await fetchAndCache(url, env.authToken, fetchTimeoutMs, cachePath, nowFn(), { fetcher, fs })) ?? stale;
}
/**
 * Spawn a detached background process that refreshes the cache file. The child
 * inherits the parent environment (including ANTHROPIC_AUTH_TOKEN) and runs
 * `node index.js --zhipu-refresh`. Failures are silent — the next statusline
 * tick simply retries.
 */
export function spawnDetachedRefresh() {
    try {
        const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
        const child = spawn(process.execPath, [entry, '--zhipu-refresh'], {
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
    }
    catch {
        // spawn failure is non-fatal — next statusline tick will retry
    }
}
/**
 * Standalone cache refresh for the detached `--zhipu-refresh` child process.
 * Reads env + config, fetches the quota, and writes the cache. Silently exits
 * on any failure so a broken background refresh never surfaces to the user.
 */
export async function refreshZhipuCacheStandalone() {
    const env = {
        baseUrl: process.env.ANTHROPIC_BASE_URL,
        authToken: process.env.ANTHROPIC_AUTH_TOKEN,
    };
    if (!detectZhipuProvider(env) || !env.authToken) {
        return;
    }
    const baseDomain = resolveBaseDomain(env.baseUrl ?? '');
    if (!baseDomain) {
        return;
    }
    const { loadConfig } = await import('./config.js');
    const config = await loadConfig();
    const cachePath = (config.display?.zhipuUsageCachePath ?? '').trim()
        || path.join(getHudPluginDir(os.homedir()), DEFAULT_CACHE_FILENAME);
    const timeoutMs = config.display?.zhipuUsageFetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    await fetchAndCache(`${baseDomain}${QUOTA_LIMIT_PATH}`, env.authToken, timeoutMs, cachePath, Date.now(), { fetcher: defaultFetcher, fs: fsDeps });
}
//# sourceMappingURL=zhipu-usage.js.map