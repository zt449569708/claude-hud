import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONFIG } from '../dist/config.js';
import {
  detectZhipuProvider,
  parseZhipuQuota,
  getUsageFromZhipu,
} from '../dist/zhipu-usage.js';

const ZHIPU_ENV = {
  baseUrl: 'https://open.bigmodel.cn/api/anthropic',
  authToken: 'test-token',
};

function makeConfig(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    display: {
      ...DEFAULT_CONFIG.display,
      showZhipuUsage: true,
      zhipuUsageFreshnessMs: 60_000,
      zhipuUsageFetchTimeoutMs: 1000,
      ...overrides,
    },
  };
}

async function withTempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'claude-hud-zhipu-'));
  return {
    dir,
    cachePath: path.join(dir, 'zhipu-usage.json'),
    cleanup: async () => rm(dir, { recursive: true, force: true }),
  };
}

// ---------- detectZhipuProvider ----------

test('detectZhipuProvider identifies bigmodel.cn as zhipu', () => {
  assert.equal(
    detectZhipuProvider({ baseUrl: 'https://open.bigmodel.cn/api/anthropic' }),
    'zhipu',
  );
  assert.equal(
    detectZhipuProvider({ baseUrl: 'https://dev.bigmodel.cn/api/anthropic' }),
    'zhipu',
  );
});

test('detectZhipuProvider identifies api.z.ai as zai', () => {
  assert.equal(
    detectZhipuProvider({ baseUrl: 'https://api.z.ai/api/anthropic' }),
    'zai',
  );
});

test('detectZhipuProvider falls back to glm- model id as zhipu', () => {
  assert.equal(detectZhipuProvider({}, 'glm-4.6'), 'zhipu');
  assert.equal(detectZhipuProvider({}, 'GLM-5.1'), 'zhipu');
});

test('detectZhipuProvider returns null for unknown providers', () => {
  assert.equal(detectZhipuProvider({ baseUrl: 'https://api.anthropic.com' }), null);
  assert.equal(detectZhipuProvider({}, 'claude-opus-4'), null);
  assert.equal(detectZhipuProvider({}, undefined), null);
});

// ---------- parseZhipuQuota ----------

test('parseZhipuQuota maps TOKENS_LIMIT and TIME_LIMIT from data envelope', () => {
  const usage = parseZhipuQuota({
    data: {
      limits: [
        { type: 'TOKENS_LIMIT', percentage: 42.4, nextResetTime: 1781530420302 },
        { type: 'TIME_LIMIT', percentage: 65.6, nextResetTime: 1783299674964 },
      ],
    },
  });
  assert.deepEqual(usage, {
    fiveHour: 42,
    sevenDay: 66,
    fiveHourResetAt: new Date(1781530420302),
    sevenDayResetAt: new Date(1783299674964),
  });
});

test('parseZhipuQuota accepts a bare limits array', () => {
  const usage = parseZhipuQuota({
    limits: [{ type: 'TOKENS_LIMIT', percentage: 10 }],
  });
  assert.equal(usage.fiveHour, 10);
  assert.equal(usage.sevenDay, null);
  assert.equal(usage.fiveHourResetAt, null);
});

test('parseZhipuQuota clamps percentages to 0-100', () => {
  const usage = parseZhipuQuota({
    limits: [
      { type: 'TOKENS_LIMIT', percentage: 150 },
      { type: 'TIME_LIMIT', percentage: -5 },
    ],
  });
  assert.equal(usage.fiveHour, 100);
  assert.equal(usage.sevenDay, 0);
});

test('parseZhipuQuota returns null when no usable limits', () => {
  assert.equal(parseZhipuQuota({ data: { limits: [] } }), null);
  assert.equal(parseZhipuQuota({ limits: [{ type: 'OTHER', percentage: 50 }] }), null);
  assert.equal(parseZhipuQuota(null), null);
  assert.equal(parseZhipuQuota('not-an-object'), null);
});

// ---------- getUsageFromZhipu ----------

test('getUsageFromZhipu returns null without an auth token', async () => {
  const usage = await getUsageFromZhipu(makeConfig(), {
    env: { baseUrl: ZHIPU_ENV.baseUrl, authToken: '' },
  });
  assert.equal(usage, null);
});

test('getUsageFromZhipu returns null when provider is undetectable', async () => {
  const usage = await getUsageFromZhipu(makeConfig(), {
    env: { baseUrl: 'https://api.anthropic.com', authToken: 'tok' },
  });
  assert.equal(usage, null);
});

test('getUsageFromZhipu returns null when disabled', async () => {
  let calls = 0;
  const usage = await getUsageFromZhipu(makeConfig({ showZhipuUsage: false }), {
    env: ZHIPU_ENV,
    fetcher: async () => { calls += 1; return {}; },
  });
  assert.equal(usage, null);
  assert.equal(calls, 0);
});

test('getUsageFromZhipu returns fresh cache without fetching', async () => {
  const { cachePath, cleanup } = await withTempDir();
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);
  await writeFile(
    cachePath,
    JSON.stringify({
      updated_at: new Date(now).toISOString(),
      five_hour: { used_percentage: 30, resets_at: '2026-06-15T15:00:00.000Z' },
      seven_day: { used_percentage: 70, resets_at: null },
    }),
    'utf8',
  );

  try {
    let calls = 0;
    const usage = await getUsageFromZhipu(
      makeConfig({ zhipuUsageCachePath: cachePath }),
      {
        env: ZHIPU_ENV,
        now: () => now + 10_000,
        fetcher: async () => { calls += 1; return {}; },
      },
    );
    assert.equal(usage.fiveHour, 30);
    assert.equal(usage.sevenDay, 70);
    assert.deepEqual(usage.fiveHourResetAt, new Date('2026-06-15T15:00:00.000Z'));
    assert.equal(calls, 0);
  } finally {
    await cleanup();
  }
});

test('getUsageFromZhipu fetches and persists on cache miss', async () => {
  const { cachePath, cleanup } = await withTempDir();
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);

  try {
    const usage = await getUsageFromZhipu(
      makeConfig({ zhipuUsageCachePath: cachePath }),
      {
        env: ZHIPU_ENV,
        now: () => now,
        fetcher: async () => ({
          data: {
            limits: [
              { type: 'TOKENS_LIMIT', percentage: 45, nextResetTime: 1781530420302 },
              { type: 'TIME_LIMIT', percentage: 12, nextResetTime: 1783299674964 },
            ],
          },
        }),
      },
    );
    assert.equal(usage.fiveHour, 45);
    assert.equal(usage.sevenDay, 12);
    assert.deepEqual(usage.fiveHourResetAt, new Date(1781530420302));

    const written = JSON.parse(await readFile(cachePath, 'utf8'));
    assert.equal(written.five_hour.used_percentage, 45);
    assert.equal(written.five_hour.resets_at, new Date(1781530420302).toISOString());
    assert.equal(written.seven_day.used_percentage, 12);
    assert.equal(typeof written.updated_at, 'string');
  } finally {
    await cleanup();
  }
});

test('getUsageFromZhipu falls back to stale cache on fetch failure', async () => {
  const { cachePath, cleanup } = await withTempDir();
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);
  await writeFile(
    cachePath,
    JSON.stringify({
      updated_at: new Date(now - 120_000).toISOString(),
      five_hour: { used_percentage: 55, resets_at: '2026-06-15T15:00:00.000Z' },
      seven_day: { used_percentage: null, resets_at: null },
    }),
    'utf8',
  );

  try {
    const usage = await getUsageFromZhipu(
      makeConfig({ zhipuUsageCachePath: cachePath, zhipuUsageFreshnessMs: 1000 }),
      {
        env: ZHIPU_ENV,
        now: () => now,
        fetcher: async () => { throw new Error('HTTP 500'); },
      },
    );
    assert.equal(usage.fiveHour, 55);
    assert.equal(usage.sevenDay, null);
    assert.deepEqual(usage.fiveHourResetAt, new Date('2026-06-15T15:00:00.000Z'));
  } finally {
    await cleanup();
  }
});

test('getUsageFromZhipu returns null when fetch fails and no cache exists', async () => {
  const { cachePath, cleanup } = await withTempDir();
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);

  try {
    const usage = await getUsageFromZhipu(
      makeConfig({ zhipuUsageCachePath: cachePath }),
      {
        env: ZHIPU_ENV,
        now: () => now,
        fetcher: async () => { throw new Error('timeout'); },
      },
    );
    assert.equal(usage, null);
  } finally {
    await cleanup();
  }
});
