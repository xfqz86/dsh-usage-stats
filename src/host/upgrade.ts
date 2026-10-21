/**
 * 插件升级：识别当前安装方式，并在 npm 安装下调用 dsh CLI 把 profile 依赖改到指定版本。
 *
 * 安装方式由 profile 的 package.json 依赖 spec 判定（npm 版本范围可直接升级；
 * link/file/git/路径安装是本地开发副本或不可写来源，只能回仓库更新）。升级通过
 * `process.execPath` 重新执行当前 dsh CLI 的 `plugin --profile <名> add` 子命令完成，
 * 成功后新版本已写入 profile 依赖，但运行中的进程仍加载旧模块，必须重启 DSH 才生效
 * （协议 restartRequired 恒为 true）。原始命令输出只写服务端日志，不回给浏览器端；
 * 失败按 timeout/network/failed 归因，不抛错；并发升级用模块级标志单飞。
 *
 * 为什么不用基座 ctx.pluginManager：本插件升级的是自身，profile 的 base bundle 已加载
 * hmr，installBundle 对已装包返回 already-installed、removeBundle 对运行中的插件返回
 * bundle-in-use/stop-profile，插件页更新也只对官方目录包先卸再装——自升级卸不掉也装不回。
 * 因此走基座支持的 CLI 路径（与 pluginManager 共享同一套 pnpm operations），重启后加载新版。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { UpdateInstallKind, UpgradeFailureReason, UpgradeResult } from '../types.ts';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-app-boot';

/** 本包名，与 package.json 的 name 一致，用于读 profile 依赖与拼安装 spec。 */
const PACKAGE_NAME = '@xfqz86/dsh-usage-stats';

/** 升级命令超时：pnpm 解析与下载通常数十秒，180 秒覆盖慢网且不至于永久占用单飞标志。 */
const UPGRADE_TIMEOUT_MS = 180_000;

/** 命令输出只用于日志归因，截断到 16 KiB 防止异常输出撑大内存。 */
const MAX_OUTPUT_LENGTH = 16 * 1024;

/** 精确版本形状：只接受可安装的单个版本（允许 v 前缀与预发布/构建后缀），不接受范围。 */
const EXACT_VERSION_PATTERN = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

/** 安装方式判定为本地副本的 spec 前缀：pnpm 的本地/工作区/git/URL 形式都不能从 registry 升级。 */
const LOCAL_SPEC_PREFIXES = ['link:', 'file:', 'portal:', 'workspace:', 'git+', 'github:', 'http://', 'https://'];

/** npm 版本范围的前缀操作符（长的在前，避免 >= 被 > 抢先匹配）。 */
const RANGE_OPERATOR_PATTERN = /^(?:>=|<=|\^|~|>|<|=)/;

/** npm 可接受的版本/范围主体：精确 semver、部分版本（0.5、1）与 latest、* 标签。 */
const NPM_RANGE_BODY_PATTERN = /^v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** 网络类失败标记：DNS、连接、TLS、超时与 pnpm fetch 失败，小写匹配命令输出与 spawn 错误码。 */
const NETWORK_FAILURE_MARKERS = [
  'econnrefused',
  'econnreset',
  'econnaborted',
  'enotfound',
  'eai_again',
  'etimedout',
  'enetunreach',
  'ehostunreach',
  'epipe',
  'getaddrinfo',
  'socket hang up',
  'network',
  'tls',
  'cert_',
  'err_pnpm_meta_fetch_fail',
  'err_pnpm_fetch_',
];

/** 同一时刻只允许一条升级命令，避免两次 add 并发写同一个 profile 依赖。 */
let upgrading = false;

/** spawn 结果：退出码、截断输出、超时与启动失败分开归因。 */
interface UpgradeCommandOutcome {
  code: number | null
  output: string
  timedOut: boolean
  spawnError: NodeJS.ErrnoException | null
}

/** 构造失败结果：restartRequired 恒为 false，reason 由浏览器端本地化。 */
function errorResult(version: string, reason: UpgradeFailureReason): UpgradeResult {
  return { status: 'error', version, restartRequired: false, reason };
}

/** 相对/绝对路径判定：覆盖 POSIX 与 Windows 盘符形式，供本地安装识别。 */
function isPathSpec(spec: string): boolean {
  return spec.startsWith('/')
    || spec.startsWith('./')
    || spec.startsWith('../')
    || spec === '.'
    || spec === '..'
    || /^[A-Za-z]:[\\/]/.test(spec);
}

/**
 * 识别一条依赖 spec 属于哪种安装方式。
 *
 * @param spec - profile package.json 里本包的依赖声明原文。
 * @returns npm（版本范围/标签，可升级）、local（本地副本或 git/URL，不能就地升级）或 unknown。
 */
export function classifyDependencySpec(spec: string | undefined): UpdateInstallKind {
  if (typeof spec !== 'string') return 'unknown';
  const value = spec.trim();
  if (value === '') return 'unknown';
  if (LOCAL_SPEC_PREFIXES.some(prefix => value.startsWith(prefix))) return 'local';
  if (isPathSpec(value)) return 'local';
  if (value === 'latest' || value === '*') return 'npm';
  const operator = RANGE_OPERATOR_PATTERN.exec(value);
  const body = operator === null ? value : value.slice(operator[0].length).trim();
  return NPM_RANGE_BODY_PATTERN.test(body) ? 'npm' : 'unknown';
}

/** 从 profile 的 package.json 内容里取本包依赖 spec，缺失或形状非法返回 null。 */
function dependencySpecOf(manifest: unknown): string | null {
  if (manifest === null || typeof manifest !== 'object') return null;
  const dependencies = (manifest as { dependencies?: unknown }).dependencies;
  if (dependencies === null || typeof dependencies !== 'object') return null;
  const spec = (dependencies as Record<string, unknown>)[PACKAGE_NAME];
  return typeof spec === 'string' ? spec : null;
}

/**
 * 读取 profile 的 package.json 依赖，判断本插件当前安装方式。
 *
 * 没有 profileContext（非 dsh 启动的嵌入运行）、文件缺失、JSON 损坏或依赖未声明时
 * 一律 unknown；关键点是不手写 profile 结构，类型来自 dsh-app-boot 的 Context 合并。
 *
 * @param ctx - 服务所在上下文。
 * @returns 安装方式，失败不抛错。
 */
export async function detectInstallKind(ctx: Context): Promise<UpdateInstallKind> {
  const profile = ctx.get('profileContext');
  if (profile === undefined) return 'unknown';
  try {
    const text = await readFile(join(profile.dir, 'package.json'), 'utf8');
    const manifest: unknown = JSON.parse(text);
    const spec = dependencySpecOf(manifest);
    return spec === null ? 'unknown' : classifyDependencySpec(spec);
  } catch {
    return 'unknown';
  }
}

/** 当前进程可用的 dsh CLI 入口：Electron 桌面端与没有脚本入口的嵌入运行返回 null。 */
function cliEntryPath(): string | null {
  if (typeof process.versions.electron === 'string') return null;
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) return null;
  return existsSync(entry) ? entry : null;
}

/**
 * 执行一次升级命令：spawn 当前 Node + CLI 入口，工作目录为 profile 目录，
 * 环境变量补 DSH_HOME 让 CLI 找到同一个 harness home。
 *
 * @param profile - 启动期 profile 事实（名称、目录、home）。
 * @param cliEntry - 已确认存在的 CLI 入口脚本。
 * @param version - 已校验的精确版本号。
 * @returns 退出码、截断后的输出、超时与 spawn 错误。
 */
function runUpgradeCommand(
  profile: Context['profileContext'],
  cliEntry: string,
  version: string,
): Promise<UpgradeCommandOutcome> {
  return new Promise<UpgradeCommandOutcome>(resolve => {
    const child = spawn(
      process.execPath,
      [cliEntry, 'plugin', '--profile', profile.name, 'add', `${PACKAGE_NAME}@${version}`],
      {
        cwd: profile.dir,
        env: { ...process.env, DSH_HOME: profile.home },
        windowsHide: true,
      },
    );
    let output = '';
    const collect = (chunk: Buffer): void => {
      if (output.length >= MAX_OUTPUT_LENGTH) return;
      output += chunk.toString('utf8');
      if (output.length > MAX_OUTPUT_LENGTH) output = output.slice(0, MAX_OUTPUT_LENGTH);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let timedOut = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, UPGRADE_TIMEOUT_MS);
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output, timedOut, spawnError });
    };
    child.on('error', error => {
      spawnError = error as NodeJS.ErrnoException;
      // spawn 失败时 close 仍会紧随其后触发；极端情况下没有 close，也在此收敛避免悬挂。
      finish(null);
    });
    child.on('close', code => finish(code));
  });
}

/** 命令输出或错误码是否指向网络/registry 不可达，而非依赖解析或脚本错误。 */
function isNetworkFailure(text: string): boolean {
  const lowered = text.toLowerCase();
  return NETWORK_FAILURE_MARKERS.some(marker => lowered.includes(marker));
}

/** 失败时把命令与截断输出写服务端日志，客户端只拿归因后的 reason。 */
function warnUpgradeFailure(version: string, reason: UpgradeFailureReason, outcome: UpgradeCommandOutcome): void {
  const errorText = outcome.spawnError === null ? '' : ` ${outcome.spawnError.code ?? ''} ${outcome.spawnError.message}`;
  console.warn(`[usage-stats] 升级到 ${version} 失败（${reason}，退出码 ${String(outcome.code)}）${errorText}\n${outcome.output}`);
}

/**
 * 把 profile 里的本插件依赖升级到指定版本。
 *
 * 前置条件：版本合法、没有并发升级、非桌面/嵌入运行、依赖为 npm 安装。
 * 失败按 timeout/network/failed 归因且不抛错；成功表示依赖已写入 profile，
 * 运行中的 DSH 仍需重启才加载新版本。
 *
 * @param ctx - 服务所在上下文（读取 profileContext 与 profile 文件）。
 * @param version - checkUpdate 返回的 latest 版本号。
 * @returns 升级结果，失败以 status 表达。
 */
export async function runPluginUpgrade(ctx: Context, version: string): Promise<UpgradeResult> {
  const requested = version.trim();
  const matched = EXACT_VERSION_PATTERN.exec(requested);
  if (matched === null) return errorResult(requested, 'failed');
  const target = matched[1];
  if (upgrading) return errorResult(target, 'busy');
  const profile = ctx.get('profileContext');
  const cliEntry = cliEntryPath();
  if (profile === undefined || cliEntry === null) return errorResult(target, 'unsupported');
  upgrading = true;
  try {
    const install = await detectInstallKind(ctx);
    if (install === 'local') return errorResult(target, 'link-install');
    if (install !== 'npm') return errorResult(target, 'unsupported');
    let outcome: UpgradeCommandOutcome;
    try {
      outcome = await runUpgradeCommand(profile, cliEntry, target);
    } catch (error) {
      // spawn 参数异常等同步抛错也按 failed 收敛，保证升级接口不向客户端抛错。
      console.warn(`[usage-stats] 无法启动升级命令：${error instanceof Error ? error.message : String(error)}`);
      return errorResult(target, 'failed');
    }
    if (outcome.timedOut) {
      warnUpgradeFailure(target, 'timeout', outcome);
      return errorResult(target, 'timeout');
    }
    if (outcome.code === 0) {
      return { status: 'ok', version: target, restartRequired: true, reason: null };
    }
    const failureText = outcome.spawnError === null
      ? outcome.output
      : `${outcome.spawnError.code ?? ''} ${outcome.spawnError.message}\n${outcome.output}`;
    const reason: UpgradeFailureReason = isNetworkFailure(failureText) ? 'network' : 'failed';
    warnUpgradeFailure(target, reason, outcome);
    return errorResult(target, reason);
  } finally {
    upgrading = false;
  }
}
