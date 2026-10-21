/**
 * 更新检查：查询 npm registry 上本插件的最新版本号，再取对应 GitHub Release 的更新说明，
 * 供「关于」页与更新说明弹窗提示升级。
 *
 * 版本端点固定为 `GET https://registry.npmjs.org/@xfqz86%2Fdsh-usage-stats/latest`，
 * 只读取响应体的 `version` 字段并校验版本形状；Release 端点固定为
 * `GET https://api.github.com/repos/xfqz86/dsh-usage-stats/releases/tags/v<版本>`，
 * 读取 body/published_at/html_url。Release 查询失败不算整体失败：notes 与 publishedAt
 * 置 null，url 回退到 tag 页。6 小时内存缓存只存放成功结果（含安装方式，安装方式变化
 * 即绕过），force=true 为用户手动检查，绕过缓存并将新的成功结果写回。两个请求各自
 * 8 秒超时；超时、网络、非 2xx、JSON 或版本号非法一律返回 error，不抛错。不新增依赖、
 * 不写账本，纯只读查询，协议见 src/types.ts 的 UpdateCheckResult。
 */
import type { UpdateCheckResult, UpdateInstallKind } from '../types.ts';

/** npm registry 上本插件 latest dist-tag 的端点，固定域名。 */
const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/@xfqz86%2Fdsh-usage-stats/latest';

/** 检查失败时的兜底更新说明页：releases 列表。 */
const RELEASES_URL = 'https://github.com/xfqz86/dsh-usage-stats/releases';

/** 单个版本的更新说明页前缀，拼上 `v` + 版本号即对应 GitHub Release tag。 */
const RELEASE_TAG_URL = 'https://github.com/xfqz86/dsh-usage-stats/releases/tag/v';

/** 对应 tag 的 GitHub Release API 前缀，拼上 `v` + 版本号取正文与发布时间。 */
const RELEASE_API_URL = 'https://api.github.com/repos/xfqz86/dsh-usage-stats/releases/tags/v';

/** 单个请求超时：github/npm 正常数百毫秒返回，8 秒足够且不拖住「关于」页。 */
const REQUEST_TIMEOUT_MS = 8000;

/** 成功结果的内存缓存时长：6 小时，自动检查与手动检查共用。 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** 版本号形状：`1.2.3`，允许 `-pre`/`+build` 后缀与可选的 v 前缀，捕获去前缀后的版本。 */
const VERSION_PATTERN = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

/** 一条成功检查结果，缓存原样保存安装方式：安装方式变化时旧缓存不可复用。 */
interface CachedUpdateCheck {
  at: number
  latest: string
  url: string
  notes: string | null
  publishedAt: number | null
  install: UpdateInstallKind
}

/** 从 Release API 响应体读出的更新说明字段，缺失时都为 null。 */
interface ReleaseNotes {
  notes: string | null
  publishedAt: number | null
  url: string | null
}

/** Release 查询失败时的空说明：整体仍按成功返回，url 由调用方回退到 tag 页。 */
const EMPTY_RELEASE_NOTES: ReleaseNotes = { notes: null, publishedAt: null, url: null };

/** 最近一次成功查询；只缓存成功结果，失败不覆盖已有缓存。 */
let cache: CachedUpdateCheck | null = null;

/** 构造失败结果：latest 恒为 null，url 退回 releases 列表，安装方式照常带回。 */
function errorResult(install: UpdateInstallKind): UpdateCheckResult {
  return { status: 'error', latest: null, url: RELEASES_URL, notes: null, publishedAt: null, install };
}

/** 从 registry 响应体取 `version` 字段，缺失、非字符串或形状非法返回 null。 */
function parseLatestVersion(data: unknown): string | null {
  if (data === null || typeof data !== 'object') return null;
  const raw = (data as { version?: unknown }).version;
  if (typeof raw !== 'string') return null;
  const matched = VERSION_PATTERN.exec(raw.trim());
  return matched === null ? null : matched[1];
}

/** 从 Release API 响应体读正文、发布时间与 html_url，任一字段缺失或非法即为 null。 */
function parseReleaseNotes(data: unknown): ReleaseNotes {
  if (data === null || typeof data !== 'object') return EMPTY_RELEASE_NOTES;
  const release = data as { body?: unknown; published_at?: unknown; html_url?: unknown };
  const notes = typeof release.body === 'string' && release.body.trim().length > 0 ? release.body : null;
  const published = typeof release.published_at === 'string' ? Date.parse(release.published_at) : Number.NaN;
  const url = typeof release.html_url === 'string' && release.html_url.trim().length > 0 ? release.html_url : null;
  return { notes, publishedAt: Number.isFinite(published) ? published : null, url };
}

/** 实时查询 npm registry 的最新版本，无缓存；任何失败都返回 null，不抛错。 */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const response = await fetch(REGISTRY_LATEST_URL, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    return parseLatestVersion(data);
  } catch {
    // 超时、网络与 JSON 解析失败同属「拿不到有效版本」，由调用方归一为 error 结果。
    return null;
  }
}

/**
 * 查询对应版本的 GitHub Release 更新说明，无缓存。
 *
 * 任何失败（超时、非 2xx、坏 JSON）都返回空说明而不是抛错：版本检查本身已成功，
 * 说明缺失只影响弹窗正文，不应把整体结果降级为 error。
 *
 * @param version - npm latest 的版本号（不带 v 前缀）。
 * @returns 正文、发布时间与 html_url；缺失字段为 null。
 */
async function fetchReleaseNotes(version: string): Promise<ReleaseNotes> {
  try {
    const response = await fetch(RELEASE_API_URL + version, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-usage-stats',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return EMPTY_RELEASE_NOTES;
    const data: unknown = await response.json();
    return parseReleaseNotes(data);
  } catch {
    return EMPTY_RELEASE_NOTES;
  }
}

/** 缓存命中时原样返回成功结果（含说明与安装方式）。 */
function cachedResult(entry: CachedUpdateCheck): UpdateCheckResult {
  return {
    status: 'ok',
    latest: entry.latest,
    url: entry.url,
    notes: entry.notes,
    publishedAt: entry.publishedAt,
    install: entry.install,
  };
}

/**
 * 查询 npm registry 上的最新版本与 Release 说明，带 6 小时内存缓存。
 *
 * @param force - 为 true 时（用户手动检查）绕过缓存重新查询，成功后刷新缓存；
 *   查询失败不写入缓存，也不清掉已有的成功缓存。
 * @param install - 当前安装方式；与缓存记录不同则视为不可复用，重新查询。
 * @returns 更新检查结果，失败以 status 表达、不抛错。
 */
export async function queryUpdateCheck(force: boolean, install: UpdateInstallKind): Promise<UpdateCheckResult> {
  if (!force && cache !== null && cache.install === install && Date.now() - cache.at < CACHE_TTL_MS) {
    return cachedResult(cache);
  }
  const latest = await fetchLatestVersion();
  if (latest === null) return errorResult(install);
  const release = await fetchReleaseNotes(latest);
  const url = release.url ?? RELEASE_TAG_URL + latest;
  const result: UpdateCheckResult = {
    status: 'ok',
    latest,
    url,
    notes: release.notes,
    publishedAt: release.publishedAt,
    install,
  };
  cache = { at: Date.now(), latest, url, notes: release.notes, publishedAt: release.publishedAt, install };
  return result;
}
