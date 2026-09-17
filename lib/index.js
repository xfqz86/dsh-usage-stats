import { Service } from "@deepseek-ai/cordis";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { constants, zstdDecompressSync } from "node:zlib";
import Schema from "@deepseek-ai/schemastery";

//#region src/utils.ts
/** 时间戳对应的本地零点，避免 UTC 漂移，host 折叠与会话图共用同一套日划分。 */
function startOfDay(timeMs) {
	const d = new Date(timeMs);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}
/** 任意异常 → 可读消息字符串，Error 取 message，对象取 message 字段，其余原样字符串化。 */
function errorMessage(error) {
	if (error instanceof Error) return error.message;
	if (error !== null && typeof error === "object") {
		const message = error.message;
		if (typeof message === "string" && message.length > 0) return message;
	}
	return String(error);
}
/** 把 `provider\0model` 键拆回 provider 与 model，无分隔符时都记 unknown。 */
function splitModelKey(key) {
	const sep = key.indexOf("\0");
	if (sep === -1) return {
		provider: "unknown",
		model: "unknown"
	};
	return {
		provider: key.slice(0, sep),
		model: key.slice(sep + 1)
	};
}
/** 额度轮询 TTL 下限：仅约束自动轮询的有效 TTL（见 effectiveQuotaTtl），手动 force 刷新不受限。 */
const QUOTA_MIN_FETCH_MS = 18e4;
/** 额度结果缓存上限：默认 5 分钟；客户端可按抓取间隔调短有效缓存。 */
const QUOTA_CACHE_TTL_MS = 3e5;
/**
* 额度有效 TTL：`min(上限, max(下限, 间隔))`，让实际打官方端点的频率与
* 设置一致且不短于下限；未提供间隔时用默认上限。三额度查询共用同一公式。
*/
function effectiveQuotaTtl(intervalMinutes) {
	if (typeof intervalMinutes === "number" && Number.isFinite(intervalMinutes)) return Math.min(QUOTA_CACHE_TTL_MS, Math.max(QUOTA_MIN_FETCH_MS, Math.round(intervalMinutes * 60 * 1e3)));
	return QUOTA_CACHE_TTL_MS;
}
/** 设置命名空间名，服务端 ctx.settings 注册键，即 settings.yaml 里的一级键。 */
const USAGE_SETTINGS_NAMESPACE = "usage-stats";
/** OpenCode Go 额度抓取间隔默认值，单位分钟。 */
const GO_FETCH_DEFAULT_MINUTES = 5;
/** DeepSeek 余额抓取间隔默认值，单位分钟。 */
const DEEPSEEK_FETCH_DEFAULT_MINUTES = 5;
/** Z.ai 额度抓取间隔默认值，单位分钟。 */
const ZAI_FETCH_DEFAULT_MINUTES = 5;
/** 偏好默认值：设置命名空间未覆盖的字段、取值尚未到达浏览器时都用它。 */
const USAGE_SETTINGS_DEFAULTS = {
	goEnabled: true,
	showGoInSidebar: true,
	goFetchMinutes: 5,
	deepseekEnabled: true,
	showDeepSeekInSidebar: true,
	deepseekFetchMinutes: 5,
	zaiEnabled: true,
	showZaiInSidebar: true,
	zaiFetchMinutes: 5,
	modelRedirects: []
};

//#endregion
//#region src/host/quota.ts
/**
* 额度查询共享基元（服务端）：浏览器 UA、key 回退解析、TTL 缓存单飞工厂。
*
* Go/DeepSeek/Z.ai 同一写法：官方端点固定域名 + 浏览器 UA 防前置拦截；
* key 仅走 DSH 凭据中心、按名回退；结果带 TTL 缓存与单飞（并发只打一次官方端点）；
* 未配 key / 401 / 403 一律结构化返回、不抛错，由客户端按 status 本地化。
*/
/** 浏览器 UA：三额度官方端点共用，避免被前置 Cloudflare 拦截。 */
const QUOTA_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
/** 按名回退解析 key：首个成功者胜出（去空格），全部失败回 null。 */
async function resolveFirstKey(credentials, names) {
	if (credentials && typeof credentials.resolve === "function") for (const name of names) try {
		const resolved = await credentials.resolve(credentialRef(name));
		if (resolved && typeof resolved.value === "string" && resolved.value.trim().length > 0) return resolved.value.trim();
	} catch {}
	return null;
}
/**
* 带 TTL 缓存与单飞的查询工厂：每个调用处实例独立缓存。
* 常规调用在 TTL 内直接回缓存；force 为用户手动刷新，完全绕过 TTL 与下限、
* 立即重拉官方端点，仅经单飞合并并发请求，返回后缓存窗口重新起算
* （失败的结构化结果同样写入缓存，失败窗口内不重复打官方端点）。
*/
function createQuotaQuery(fetch) {
	let cache = null;
	let inflight = null;
	return async (intervalMinutes, force = false, credentials) => {
		const effectiveTtlMs = effectiveQuotaTtl(intervalMinutes);
		if (!force && cache !== null && Date.now() - cache.at < effectiveTtlMs) return cache.value;
		if (inflight === null) inflight = fetch(credentials).then((value) => {
			cache = {
				at: Date.now(),
				value
			};
			return value;
		}).finally(() => {
			inflight = null;
		});
		return inflight;
	};
}

//#endregion
//#region src/host/deepseekBalance.ts
/**
* DeepSeek 余额查询：通过 `GET https://api.deepseek.com/user/balance` 获取当前余额。
*
* 机制要点：
*   - 官方固定域名端点，使用 Bearer key 与浏览器 UA，与 GoQuota 同款以防前置拦截。
*   - key 解析仅走 DSH 凭据中心，支持 `DEEPSEEK_API_KEY` 等，由 `ctx.credentials` 统一托管，不直接读 `process.env` 或配置文件。
*   - 结果带 TTL 缓存与单飞，TTL 默认 5 分钟，单飞即并发请求只打一次官方端点。
*   - is_available 归一化：仅当官方返回 boolean true 时为 true，其余按 false。
*   - 金额字段如 total_balance 等为字符串小数，归一化保留字符串避免浮点丢失。
*
* DeepSeekBalance / DeepSeekBalanceInfo 协议类型定义在 types.ts，与客户端 useDeepSeekBalance 统一。
* 纯数据模块：请求失败 / 未配置 key 都返回带 status 的结构化结果，由
* 客户端按 status 本地化文案，不在服务端拼用户文案。
* 本功能不写入 ledger，仅只读查询与内存缓存。
*/
/** DeepSeek 官方余额端点，固定域名。 */
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
/** 解析 DeepSeek API Key，仅走 DSH 凭据中心，支持 DEEPSEEK_API_KEY 等。 */
async function resolveDeepSeekKeyWithCredentials(credentials) {
	return resolveFirstKey(credentials, [
		"DEEPSEEK_API_KEY",
		"DEEPSEEK_APIKEY",
		"DEEPSEEK_API_TOKEN",
		"DEEPSEEK_TOKEN"
	]);
}
/** 归一化单条余额明细，字段缺失或非法返回 null，不使整批失败。 */
function normalizeBalanceInfo(raw) {
	if (raw === null || typeof raw !== "object") return null;
	const rec = raw;
	const currency = rec.currency;
	if (typeof currency !== "string" || currency.trim().length === 0) return null;
	const toAmount = (v) => {
		if (typeof v === "string") {
			const t = v.trim();
			return t.length > 0 ? t : "0.00";
		}
		if (typeof v === "number" && Number.isFinite(v)) return String(v);
		return "0.00";
	};
	return {
		currency: currency.trim(),
		totalBalance: toAmount(rec.total_balance),
		grantedBalance: toAmount(rec.granted_balance),
		toppedUpBalance: toAmount(rec.topped_up_balance)
	};
}
/** 实时查询 DeepSeek 余额，无缓存。 */
async function fetchDeepSeekBalance(credentials) {
	const key = await resolveDeepSeekKeyWithCredentials(credentials);
	if (key === null) return {
		status: "no-key",
		fetchedAt: Date.now(),
		isAvailable: false,
		balances: [],
		todayAmount: null,
		todayCurrency: null
	};
	try {
		const response = await fetch(DEEPSEEK_BALANCE_URL, {
			headers: {
				authorization: `Bearer ${key}`,
				"user-agent": QUOTA_UA
			},
			signal: AbortSignal.timeout(15e3)
		});
		if (response.status === 401 || response.status === 403) return {
			status: "no-key",
			fetchedAt: Date.now(),
			isAvailable: false,
			balances: [],
			todayAmount: null,
			todayCurrency: null
		};
		if (!response.ok) return {
			status: "error",
			fetchedAt: Date.now(),
			isAvailable: false,
			balances: [],
			todayAmount: null,
			todayCurrency: null
		};
		const data = await response.json();
		const isAvailable = data.is_available === true;
		const balances = (Array.isArray(data.balance_infos) ? data.balance_infos : []).map(normalizeBalanceInfo).filter((v) => v !== null);
		return {
			status: "ok",
			fetchedAt: Date.now(),
			isAvailable,
			balances,
			todayAmount: null,
			todayCurrency: null
		};
	} catch {
		return {
			status: "error",
			fetchedAt: Date.now(),
			isAvailable: false,
			balances: [],
			todayAmount: null,
			todayCurrency: null
		};
	}
}
/**
* 带 TTL 缓存与单飞的余额查询，路由每次调用都走这里。
*
* @param intervalMinutes 客户端抓取间隔，单位为分钟；有效 TTL 见共享公式，
*   未提供时用默认 5 分钟。
* @param force 为 true 时绕过 TTL 缓存强制重新抓取，供概览 DeepSeek 磁贴的立即
*   刷新按钮使用；仍走单飞，避免并发打官方端点。
*/
const queryDeepSeekBalance = createQuotaQuery((credentials) => fetchDeepSeekBalance(credentials));

//#endregion
//#region src/host/goquota.ts
/**
* OpenCode Go 订阅额度查询：滚动 5 小时 / 本周 / 本月三档用量百分比
* 与重置时间，端点为 `GET https://opencode.ai/zen/go/v1/usage`。
*
* 机制要点：
*   - 官方固定域名端点；Bearer key + 浏览器 UA，否则会被 opencode.ai 前置
*     Cloudflare 以 error 1010 拦截。
*   - key 解析：仅走 DSH 凭据中心 `OPENCODE_GO_API_KEY`，即 `ctx.credentials`，
*     由 `~/.dsh/.credentials.yaml` 等统一托管，不直接读 `process.env`。
*   - 语义：无 key → no-key；401/403 读响应体，`error.type` 为 EntitlementError
*     （已配置 Key 但未开通订阅，如 403 + "OpenCode Go subscription required."）
*     判 no-plan，其余 401/403（Key 无效等）仍判 no-key。
*   - 结果带 TTL 缓存 5 分钟与单飞机制，并发请求只打一次官方端点。
*
* GoWindow / GoQuota 协议类型定义在 types.ts，与客户端 useGoQuota 统一。
* 纯数据模块：请求失败 / 未配置 key / 未开通订阅都返回带 status 的结构化结果，
* 由客户端按 status 本地化文案，不在服务端拼用户文案。
*/
/** OpenCode Go 官方额度端点，固定域名。 */
const GO_QUOTA_URL = "https://opencode.ai/zen/go/v1/usage";
/** 解析 OpenCode Go API Key：仅走 DSH 凭据中心 OPENCODE_GO_API_KEY。 */
async function resolveGoKeyWithCredentials(credentials) {
	return resolveFirstKey(credentials, ["OPENCODE_GO_API_KEY"]);
}
/** 归一化单个额度窗口，包含 percent 和 resetsAt，字段缺失或非法返回 null。 */
function normalizeGoWindow(raw) {
	if (raw === null || typeof raw !== "object") return null;
	const { percent, resetsAt } = raw;
	const p = Number(percent);
	if (!Number.isFinite(p)) return null;
	return {
		percent: p,
		resetsAt: typeof resetsAt === "string" ? resetsAt : ""
	};
}
/** 实时查询 OpenCode Go 额度，无缓存。 */
async function fetchGoQuota(credentials) {
	const key = await resolveGoKeyWithCredentials(credentials);
	if (key === null) return {
		status: "no-key",
		fetchedAt: Date.now(),
		rolling: null,
		weekly: null,
		monthly: null
	};
	try {
		const response = await fetch(GO_QUOTA_URL, {
			headers: {
				authorization: `Bearer ${key}`,
				"user-agent": QUOTA_UA
			},
			signal: AbortSignal.timeout(15e3)
		});
		if (response.status === 401 || response.status === 403) {
			const body = await response.json().catch(() => null);
			const err = body !== null && typeof body === "object" && body.error !== null && typeof body.error === "object" ? body.error : null;
			if (err !== null && err.type === "EntitlementError") return {
				status: "no-plan",
				fetchedAt: Date.now(),
				rolling: null,
				weekly: null,
				monthly: null
			};
			return {
				status: "no-key",
				fetchedAt: Date.now(),
				rolling: null,
				weekly: null,
				monthly: null
			};
		}
		if (!response.ok) return {
			status: "error",
			fetchedAt: Date.now(),
			rolling: null,
			weekly: null,
			monthly: null
		};
		const usage = (await response.json())?.usage;
		if (usage === null || typeof usage !== "object") return {
			status: "error",
			fetchedAt: Date.now(),
			rolling: null,
			weekly: null,
			monthly: null
		};
		return {
			status: "ok",
			fetchedAt: Date.now(),
			rolling: normalizeGoWindow(usage.rolling),
			weekly: normalizeGoWindow(usage.weekly),
			monthly: normalizeGoWindow(usage.monthly)
		};
	} catch {
		return {
			status: "error",
			fetchedAt: Date.now(),
			rolling: null,
			weekly: null,
			monthly: null
		};
	}
}
/**
* 带 TTL 缓存与单飞的额度查询，路由每次调用都走这里。
*
* @param intervalMinutes 客户端抓取间隔，单位分钟；有效 TTL 见共享公式，
*   未提供时用默认 5 分钟。
* @param force 为 true 时绕过 TTL 缓存强制重新抓取，供概览 Go 磁贴的“立即
*   刷新”按钮使用；仍走单飞，避免并发打官方端点。
* @param credentials DSH 凭据中心，可选，缺席时返回 no-key，仅 OPENCODE_GO_API_KEY。
*/
const queryGoQuota = createQuotaQuery((credentials) => fetchGoQuota(credentials));

//#endregion
//#region src/host/agg.ts
/** 新建空计数，所有字段归零。 */
function newAgg() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		total: 0,
		calls: 0
	};
}
/** 把一次用量折进聚合，调用次数加一。 */
function ink(agg, u) {
	const input = u.inputTokens || 0;
	const output = u.outputTokens || 0;
	const cacheRead = u.cacheReadTokens || 0;
	const cacheWrite = u.cacheWriteTokens || 0;
	const reasoning = u.reasoningTokens || 0;
	agg.input += input;
	agg.output += output;
	agg.cacheRead += cacheRead;
	agg.cacheWrite += cacheWrite;
	agg.reasoning += reasoning;
	agg.total += input + output + cacheRead + cacheWrite;
	agg.calls += 1;
}
/**
* 计量事件的类型名单。assistant/attempt 不列入：其用量是流式中间态，
* 会在同一 turn/step 的 assistant/message 上再次出现，收进来即双计。
*/
const METERED_TYPES = ["assistant/message", "compaction/summary"];
/** 类型守卫：携带 usage 候选的计量事件（零用量也为 true，是否折叠由后续判断）。 */
function usable(event) {
	const usage = event?.data?.usage;
	return METERED_TYPES.includes(event.type) && usage != null && typeof usage === "object";
}
/**
* 计量事件的模型身份：provider 与 model 以 \0 分隔，缺失记 unknown。
* 对话消息取 data.message.source，压缩摘要取 data 顶层的 provider/model。
*/
function modelKeyOf(event) {
	const data = event.data;
	const source = event.type === "assistant/message" ? data?.message?.source : data;
	const pick = (value) => typeof value === "string" && value ? value : "unknown";
	return pick(source?.provider) + "\0" + pick(source?.model);
}

//#endregion
//#region src/host/rawlog.ts
/**
* 会话原始日志的物理代次识别与多帧 zstd 解码：扫描拼接 zstd 帧边界后逐帧解压为
* NDJSON 文本，供扫描链路在 harness 读取失败时兜底读取旧代次会话。
*
* 背景：harness 的 JSONL 会话日志是 append-only 的多帧 zstd 拼接（首帧独立承载会话头），
* Node 的 zstdDecompressSync/createZstdDecompress 只解第一帧，因此必须自行扫描帧边界；
* 帧结构（magic 0xFD2FB528、frame header descriptor、window descriptor、dict id、
* frame content size、3 字节 block header 循环至 last block、可选 4 字节 checksum）在本模块
* 自实现，不 import harness 内部包（@deepseek-ai/dsh-session-persistence-jsonl）。
*
* 本模块是纯函数模块：只接收内存字节、不做文件 I/O，单测不读取 ~/.dsh。
*/
/** zstd 帧魔数：小端 0xFD2FB528。 */
const ZSTD_MAGIC = 4247762216;
/** 规范会话日志文件名：`session.jsonl`（v0）、`session.vN.jsonl`（N ≥ 1），可选 `.zstd` 压缩后缀。 */
const SESSION_LOG_NAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/;
/**
* 解析会话日志文件名，返回物理代次与物理编码，非规范名返回 null。
* 规范与 harness 一致：v0 沿用 `session.jsonl`，vN（N ≥ 1）为 `session.vN.jsonl`；
* 大写、前导零、`.v0`、临时后缀等非规范名一律不识别（含 `session.lock`）。
*/
function parseSessionLogName(name) {
	const match = SESSION_LOG_NAME.exec(name);
	if (!match) return null;
	const generation = match[1] === void 0 ? 0 : Number(match[1]);
	if (!Number.isSafeInteger(generation)) return null;
	return {
		generation,
		compression: match[2] === void 0 ? "none" : "zstd"
	};
}
/**
* 结构扫描拼接 zstd 流，只定位帧边界、不解压 block：
* EOF 落在末帧内部时返回其起点 tornStart；结构非法（坏 magic、保留 header 位、保留 block 类型）抛错。
* @param buffer - 会话日志文件的完整字节。
* @param maxFrames - 可选的完整帧数上限，仅供只看元数据的读取方提前返回。
* @returns 完整帧区间序列与可选的不完整尾帧起点。
*/
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) return {
			frames,
			tornStart: start
		};
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
		offset += 4;
		if (offset === buffer.length) return {
			frames,
			tornStart: start
		};
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		let contentSizeBytes = 0;
		if (contentSizeFlag === 0) contentSizeBytes = singleSegment ? 1 : 0;
		else contentSizeBytes = 1 << contentSizeFlag;
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remainingHeaderBytes) return {
			frames,
			tornStart: start
		};
		offset += remainingHeaderBytes;
		for (;;) {
			if (buffer.length - offset < 3) return {
				frames,
				tornStart: start
			};
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = blockHeader >>> 1 & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
			const payloadBytes = blockType === 1 ? 1 : blockSize;
			if (buffer.length - offset < payloadBytes) return {
				frames,
				tornStart: start
			};
			offset += payloadBytes;
			if (lastBlock) break;
		}
		if (checksum) {
			if (buffer.length - offset < 4) return {
				frames,
				tornStart: start
			};
			offset += 4;
		}
		frames.push({
			start,
			end: offset
		});
		if (frames.length === maxFrames) return { frames };
	}
	return { frames };
}
/**
* 解码一个会话日志为 NDJSON 文本：
* - `none`：按 UTF-8 原样返回；
* - `zstd`：逐帧解压后拼接；不完整尾帧按 harness 语义恢复可用前缀并截断到最后一个换行，
*   无法恢复（坏帧、无完整行）则丢弃该尾帧。
* 结构非法与完整帧校验失败抛出错误，由调用方计入失败会话；空文件返回空串。
*/
function decodeSessionLog(buffer, compression) {
	if (compression === "none") return buffer.toString("utf8");
	const { frames, tornStart } = scanZstdFrames(buffer);
	const parts = [];
	for (const { start, end } of frames) try {
		parts.push(zstdDecompressSync(buffer.subarray(start, end)).toString("utf8"));
	} catch (e) {
		throw new Error(`corrupt Zstandard session log: frame at byte ${start} failed validation: ${errorMessage(e)}`);
	}
	if (tornStart !== void 0) {
		const recovered = recoverTornFrame(buffer.subarray(tornStart));
		if (recovered) parts.push(recovered);
	}
	return parts.join("");
}
/**
* 恢复不完整尾帧的可用明文：以 ZSTD_e_flush 抑制帧结束标记与校验，只保留最后一个换行
* 之前的完整记录（与 harness 迁移读取一致）；无法恢复返回空串。
*/
function recoverTornFrame(bytes) {
	let recovered;
	try {
		recovered = zstdDecompressSync(bytes, { finishFlush: constants.ZSTD_e_flush });
	} catch {
		return "";
	}
	const text = recovered.toString("utf8");
	const newline = text.lastIndexOf("\n");
	return newline === -1 ? "" : text.slice(0, newline + 1);
}

//#endregion
//#region src/host/logs.ts
/**
* 会话日志的目录发现与 NDJSON 解析。会话事件读取优先走 harness 服务
* （sessionQuery.readSession / persistence.open+read，见 scan.ts），读取失败或
* 返回空事件时由扫描链路用本模块定位到的原始文件经 rawlog 兜底解码；
* 本模块只负责定位每个会话目录下的最高代次日志、解析文本行。
*/
/** 读取当前 DSH 数据主目录（每次调用重新读取环境变量，避免模块加载时环境未就绪导致路径陈旧）。 */
function getDshHome() {
	return process.env.DSH_HOME || join(process.env.HOME || "", ".dsh");
}
/** 动态获取会话根目录（基于 getDshHome，不固化模块级路径）。 */
function getSessionsRoot() {
	return join(getDshHome(), "sessions");
}
/** 解析一行 NDJSON：会话事件、会话种子记录，或空行/坏行返回 null。 */
function parseLine(line) {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed);
		if (parsed && typeof parsed === "object" && typeof parsed.type === "string") return parsed;
		return null;
	} catch {
		return null;
	}
}
/** 解析 NDJSON 日志体为记录数组（跳过坏行）。 */
function parseLogLines(text) {
	const records = [];
	for (const line of text.split("\n")) {
		const record = parseLine(line);
		if (record) records.push(record);
	}
	return records;
}
/** 递归发现会话根目录下的全部会话日志（深度 ≤3）：sessionId -> 最高代次日志。
*  sessionId 取会话目录名（实测与 harness header.id 一致，含旧目录名 session-<uuid>）；
*  同一目录覆盖 v0（session.jsonl[.zstd]）、vN（session.vN.jsonl[.zstd]）与未压缩明文，
*  只保留物理代次最高的文件——低代次是高代次的迁移前缀，重复折叠会重复计数；
*  同代次（v0 的压缩/明文两种写法）优先 zstd。非规范名（含 session.lock）一律忽略。 */
function findSessionLogs(root, depth, out) {
	if (depth > 3) return;
	let entries;
	try {
		entries = readdirSync(root);
	} catch {
		return;
	}
	const id = basename(root) || "";
	for (const entry of entries) {
		const p = join(root, entry);
		let st;
		try {
			st = statSync(p);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			findSessionLogs(p, depth + 1, out);
			continue;
		}
		const parsed = parseSessionLogName(entry);
		if (!parsed || !id) continue;
		const prev = out.get(id);
		if (prev && (prev.generation > parsed.generation || prev.generation === parsed.generation && prev.compression === "zstd")) continue;
		out.set(id, {
			path: p,
			generation: parsed.generation,
			compression: parsed.compression
		});
	}
}

//#endregion
//#region src/host/ledger.ts
/**
* 原始事件流账本 Ledger：用量事件的唯一事实来源 —— 自管理 SQLite。
*
* 不依赖 harness 的 storage 家族：直接用 node:sqlite 的同步 API
* DatabaseSync，Node ≥22 内置，运行时仅打印一条 experimental 警告。
* 数据落在 `$DSH_HOME/storages/dsh-usage-stats/ledger.sqlite`：
*
*   - `events` 表：一行一条用量事件，PRIMARY KEY 为 t、session_id、seq 天然
*     幂等，同一条事件重复写入收敛，重开账本时每行只折一次，seq=-1 的未知
*     序事件再按毫秒时间戳区分。结构化列主键，列顺序为 t、session_id、seq。
*     无 time 的畸形事件以"当天内确定性毫秒偏移"入账：同日重放幂等，
*     跨日重放理论上可能重复——防御路径罕见可接受。
*   - `session_meta` 表：key = session_id，value = title/cwd/createdAt/lastActive/parentSession/origin/delegationDepth，初始化扫描抄录、实时 session/title 事件更新。
*   - `agg_*` 预统计表（agg_total/agg_daily/agg_model/agg_model_daily/agg_session/agg_session_daily/agg_checkpoint 共 7 张）：派生聚合的物化视图，见 §5 预统计；与 events 同库但各自提交，
*     命中时直接加载即可，无需重放全量事件。
*   - `PRAGMA user_version` = LEDGER_VERSION：结构不兼容时清空重建
*     ，事件表为空后下次启动全量重扫 —— 账本结构升级的安全网。
*
* 所有读写同步：append / setMeta 即写即持久，自动提交，崩溃后重启从 sqlite 恢复；会话元数据在内存缓存一份供快照读取。
* 预统计表与事件表同库但独立提交，崩溃窗口的缺口由启动对账或 rebuild 修复。
*/
/**
* 账本 schema 版本，PRAGMA user_version，不匹配时清库重建并全量重扫。
* 统计口径变化同样要递增：历史事件只在重扫时补录，旧库不会自愈。
*/
const LEDGER_VERSION = 6;
/** 归属目录名，位于 storages 下，与插件同名。 */
const LEDGER_DIR_NAME = "dsh-usage-stats";
/** 账本 sqlite 文件名。 */
const DB_FILE_NAME = "ledger.sqlite";
/** 账本数据库文件绝对路径，默认位于 $DSH_HOME/storages/dsh-usage-stats/。 */
function ledgerDatabasePath() {
	return join(getDshHome(), "storages", LEDGER_DIR_NAME, DB_FILE_NAME);
}
/** events 表 DDL，列名 snake_case，读回时映射回 camelCase。 */
const EVENT_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS events (
  t           INTEGER NOT NULL,
  session_id  TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  provider    TEXT    NOT NULL,
  model       TEXT    NOT NULL,
  input       INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  reasoning   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (t, session_id, seq)
)`;
/** session_meta 表 DDL。 */
const META_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS session_meta (
  session_id       TEXT    PRIMARY KEY,
  title            TEXT    NOT NULL DEFAULT '',
  cwd              TEXT    NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL DEFAULT 0,
  last_active      INTEGER NOT NULL DEFAULT 0,
  parent_session   TEXT    NOT NULL DEFAULT '',
  origin           TEXT    NOT NULL DEFAULT '',
  delegation_depth INTEGER NOT NULL DEFAULT 0
)`;
/** 预统计：全量总表，单行，id=0。 */
const AGG_TOTAL_DDL = `
CREATE TABLE IF NOT EXISTS agg_total (
  id            INTEGER PRIMARY KEY CHECK (id = 0),
  input         INTEGER NOT NULL DEFAULT 0,
  output        INTEGER NOT NULL DEFAULT 0,
  cache_read    INTEGER NOT NULL DEFAULT 0,
  cache_write   INTEGER NOT NULL DEFAULT 0,
  reasoning     INTEGER NOT NULL DEFAULT 0,
  total         INTEGER NOT NULL DEFAULT 0,
  calls         INTEGER NOT NULL DEFAULT 0,
  folded_events INTEGER NOT NULL DEFAULT 0
)`;
/** 预统计：按日全量。 */
const AGG_DAILY_DDL = `
CREATE TABLE IF NOT EXISTS agg_daily (
  day         INTEGER PRIMARY KEY,
  input       INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  reasoning   INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  calls       INTEGER NOT NULL DEFAULT 0
)`;
/** 预统计：按模型。 */
const AGG_MODEL_DDL = `
CREATE TABLE IF NOT EXISTS agg_model (
  provider    TEXT    NOT NULL,
  model       TEXT    NOT NULL,
  input       INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  reasoning   INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  calls       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, model)
)`;
/** 预统计：按模型×日。 */
const AGG_MODEL_DAILY_DDL = `
CREATE TABLE IF NOT EXISTS agg_model_daily (
  provider    TEXT    NOT NULL,
  model       TEXT    NOT NULL,
  day         INTEGER NOT NULL,
  input       INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  reasoning   INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  calls       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, model, day)
)`;
/** 预统计：按会话。 */
const AGG_SESSION_DDL = `
CREATE TABLE IF NOT EXISTS agg_session (
  session_id  TEXT    PRIMARY KEY,
  input       INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  reasoning   INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  calls       INTEGER NOT NULL DEFAULT 0,
  max_seq     INTEGER NOT NULL DEFAULT -1,
  last_active INTEGER NOT NULL DEFAULT 0
)`;
/** 预统计：按会话×日。 */
const AGG_SESSION_DAILY_DDL = `
CREATE TABLE IF NOT EXISTS agg_session_daily (
  session_id  TEXT    NOT NULL,
  day         INTEGER NOT NULL,
  input       INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  reasoning   INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  calls       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, day)
)`;
/** 预统计：水位/检查点，可选，记录已密封的边界。 */
const AGG_CHECKPOINT_DDL = `
CREATE TABLE IF NOT EXISTS agg_checkpoint (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
)`;
/** 新建空会话元数据，字段可增量补齐。 */
function emptySessionMeta() {
	return {
		title: "",
		cwd: "",
		createdAt: 0,
		lastActive: 0,
		parentSession: "",
		origin: "",
		delegationDepth: 0
	};
}
/**
* 清洗写入 sqlite TEXT 列的字符串：node:sqlite 不允许文本包含 U+0000，
* 异常元数据如标题、cwd、会话 id 等原样写入会让 upsertMeta 抛错，
* 实时路径因此丢事件、扫描路径记 failed。统一把 NUL 替换为替换符
* U+FFFD，保留字符占位、可人工识别；清洗确定性一致，重复写同一输入
* 结果相同，不破坏 upsert 幂等。仅作用于入列前的边界，内存其余路径不受影响。
*/
function sanitizeSqlText(value) {
	return value.includes("\0") ? value.replaceAll("\0", "�") : value;
}
/**
* 会话事件转换为账本事件，usage 缺失或非对象时返回 null；零用量由调用方丢弃。
* 接受全部计量事件（对话消息与压缩摘要调用），模型身份由 modelKeyOf 分派。
*/
function toLedgerEvent(sessionId, event) {
	const usage = event.data?.usage;
	if (usage === null || typeof usage !== "object") return null;
	const u = usage;
	const num = (v) => {
		const n = Number(v);
		return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
	};
	const { provider, model } = splitModelKey(modelKeyOf(event));
	const sessionIdText = sanitizeSqlText(sessionId);
	const providerText = sanitizeSqlText(provider);
	const modelText = sanitizeSqlText(model);
	const rawT = event.time;
	let t;
	if (typeof rawT === "number" && Number.isFinite(rawT) && rawT > 0) t = rawT;
	else {
		let hashStr = "";
		try {
			hashStr = JSON.stringify(event.data ?? "");
		} catch {
			hashStr = String(event.data);
		}
		let h = 0;
		for (let i = 0; i < hashStr.length; i += 1) h = h * 31 + hashStr.charCodeAt(i) >>> 0;
		t = startOfDay(Date.now()) + 1e3 + h % 83998999;
	}
	return {
		t,
		sessionId: sessionIdText,
		provider: providerText,
		model: modelText,
		seq: typeof event.seq === "number" ? event.seq : -1,
		input: num(u.inputTokens),
		output: num(u.outputTokens),
		cacheRead: num(u.cacheReadTokens),
		cacheWrite: num(u.cacheWriteTokens),
		reasoning: num(u.reasoningTokens)
	};
}
/**
* 自管理 SQLite 账本：events / session_meta / agg_* 共 9 表；读走内存缓存 + 按需
* SELECT，写同步即持久，自动提交。测试注入 DSH_HOME 即可隔离介质。
* 新增 agg_* 预统计表：对不会再变动的历史数据做物化聚合，启动时优先
* 加载预统计，仅重放少量未密封账本，显著降低冷启动时间。
*/
var Ledger = class {
	db;
	stmts;
	metaCache = /* @__PURE__ */ new Map();
	closed = false;
	aggSuspended = false;
	inTransaction = false;
	path;
	constructor(path = ledgerDatabasePath()) {
		this.path = path;
	}
	/** 打开账本：建目录、建表、迁移，user_version 不匹配则清库，再载入 meta 缓存。 */
	open() {
		mkdirSync(dirname(this.path), { recursive: true });
		this.db = new DatabaseSync(this.path);
		this.db.exec(EVENT_TABLE_DDL);
		this.db.exec(META_TABLE_DDL);
		this.db.exec(AGG_TOTAL_DDL);
		this.db.exec(AGG_DAILY_DDL);
		this.db.exec(AGG_MODEL_DDL);
		this.db.exec(AGG_MODEL_DAILY_DDL);
		this.db.exec(AGG_SESSION_DDL);
		this.db.exec(AGG_SESSION_DAILY_DDL);
		this.db.exec(AGG_CHECKPOINT_DDL);
		const resetAllTables = () => {
			this.db.exec("DROP TABLE IF EXISTS events");
			this.db.exec("DROP TABLE IF EXISTS session_meta");
			this.db.exec("DROP TABLE IF EXISTS agg_total");
			this.db.exec("DROP TABLE IF EXISTS agg_daily");
			this.db.exec("DROP TABLE IF EXISTS agg_model");
			this.db.exec("DROP TABLE IF EXISTS agg_model_daily");
			this.db.exec("DROP TABLE IF EXISTS agg_session");
			this.db.exec("DROP TABLE IF EXISTS agg_session_daily");
			this.db.exec("DROP TABLE IF EXISTS agg_checkpoint");
			this.db.exec(EVENT_TABLE_DDL);
			this.db.exec(META_TABLE_DDL);
			this.db.exec(AGG_TOTAL_DDL);
			this.db.exec(AGG_DAILY_DDL);
			this.db.exec(AGG_MODEL_DDL);
			this.db.exec(AGG_MODEL_DAILY_DDL);
			this.db.exec(AGG_SESSION_DDL);
			this.db.exec(AGG_SESSION_DAILY_DDL);
			this.db.exec(AGG_CHECKPOINT_DDL);
		};
		const row = this.db.prepare("PRAGMA user_version").get();
		const version = typeof row?.user_version === "number" ? row.user_version : 0;
		if (version !== 6) {
			if (version === 3 || version === 2) {
				try {
					this.db.exec("ALTER TABLE session_meta ADD COLUMN parent_session TEXT NOT NULL DEFAULT ''");
				} catch {}
				try {
					this.db.exec("ALTER TABLE session_meta ADD COLUMN origin TEXT NOT NULL DEFAULT ''");
				} catch {}
				try {
					this.db.exec("ALTER TABLE session_meta ADD COLUMN delegation_depth INTEGER NOT NULL DEFAULT 0");
				} catch {}
				console.warn(`[usage-stats] 账本 schema 升级 ${String(version)} -> ${String(6)}，保留历史事件`);
				this.db.exec(`PRAGMA user_version = ${6}`);
			} else if (version === 0) {
				if ((() => {
					try {
						return this.db.prepare("SELECT 1 FROM events LIMIT 1").get() !== void 0;
					} catch {
						return false;
					}
				})()) {
					console.warn(`[usage-stats] 账本 schema 版本 ${String(version)} 与 ${String(6)} 不一致，重建空账本`);
					resetAllTables();
				}
				this.db.exec(`PRAGMA user_version = ${6}`);
			} else {
				console.warn(`[usage-stats] 账本 schema 版本 ${String(version)} 与 ${String(6)} 不一致，重建空账本`);
				resetAllTables();
				this.db.exec(`PRAGMA user_version = ${6}`);
			}
		}
		const hasEvent = this.db.prepare("SELECT 1 AS x FROM events LIMIT 1");
		const hasEventByPK = this.db.prepare("SELECT 1 AS x FROM events WHERE t = ? AND session_id = ? AND seq = ? LIMIT 1");
		const insertEvent = this.db.prepare(`INSERT INTO events (t, session_id, seq, provider, model, input, output, cache_read, cache_write, reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(t, session_id, seq) DO UPDATE SET
         provider = excluded.provider, model = excluded.model,
         input = excluded.input, output = excluded.output,
         cache_read = excluded.cache_read, cache_write = excluded.cache_write,
         reasoning = excluded.reasoning`);
		const allEvents = this.db.prepare("SELECT t, session_id, seq, provider, model, input, output, cache_read, cache_write, reasoning FROM events");
		const upsertMeta = this.db.prepare(`INSERT INTO session_meta (session_id, title, cwd, created_at, last_active, parent_session, origin, delegation_depth)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         title = excluded.title, cwd = excluded.cwd,
         created_at = excluded.created_at, last_active = excluded.last_active,
         parent_session = excluded.parent_session, origin = excluded.origin, delegation_depth = excluded.delegation_depth`);
		const allMeta = this.db.prepare("SELECT session_id, title, cwd, created_at, last_active, parent_session, origin, delegation_depth FROM session_meta");
		const hasAgg = this.db.prepare("SELECT 1 AS x FROM agg_total LIMIT 1");
		const getAggTotal = this.db.prepare("SELECT input, output, cache_read, cache_write, reasoning, total, calls, folded_events FROM agg_total WHERE id = 0");
		const allAggDaily = this.db.prepare("SELECT day, input, output, cache_read, cache_write, reasoning, total, calls FROM agg_daily");
		const allAggModel = this.db.prepare("SELECT provider, model, input, output, cache_read, cache_write, reasoning, total, calls FROM agg_model");
		const allAggModelDaily = this.db.prepare("SELECT provider, model, day, input, output, cache_read, cache_write, reasoning, total, calls FROM agg_model_daily");
		const allAggSession = this.db.prepare("SELECT session_id, input, output, cache_read, cache_write, reasoning, total, calls, max_seq, last_active FROM agg_session");
		const allAggSessionDaily = this.db.prepare("SELECT session_id, day, input, output, cache_read, cache_write, reasoning, total, calls FROM agg_session_daily");
		const incAggTotal = this.db.prepare(`INSERT INTO agg_total(id, input, output, cache_read, cache_write, reasoning, total, calls, folded_events)
       VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         input = agg_total.input + excluded.input,
         output = agg_total.output + excluded.output,
         cache_read = agg_total.cache_read + excluded.cache_read,
         cache_write = agg_total.cache_write + excluded.cache_write,
         reasoning = agg_total.reasoning + excluded.reasoning,
         total = agg_total.total + excluded.total,
         calls = agg_total.calls + excluded.calls,
         folded_events = agg_total.folded_events + excluded.folded_events`);
		const incAggDaily = this.db.prepare(`INSERT INTO agg_daily(day, input, output, cache_read, cache_write, reasoning, total, calls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         input = agg_daily.input + excluded.input,
         output = agg_daily.output + excluded.output,
         cache_read = agg_daily.cache_read + excluded.cache_read,
         cache_write = agg_daily.cache_write + excluded.cache_write,
         reasoning = agg_daily.reasoning + excluded.reasoning,
         total = agg_daily.total + excluded.total,
         calls = agg_daily.calls + excluded.calls`);
		const incAggModel = this.db.prepare(`INSERT INTO agg_model(provider, model, input, output, cache_read, cache_write, reasoning, total, calls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, model) DO UPDATE SET
         input = agg_model.input + excluded.input,
         output = agg_model.output + excluded.output,
         cache_read = agg_model.cache_read + excluded.cache_read,
         cache_write = agg_model.cache_write + excluded.cache_write,
         reasoning = agg_model.reasoning + excluded.reasoning,
         total = agg_model.total + excluded.total,
         calls = agg_model.calls + excluded.calls`);
		const incAggModelDaily = this.db.prepare(`INSERT INTO agg_model_daily(provider, model, day, input, output, cache_read, cache_write, reasoning, total, calls)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, model, day) DO UPDATE SET
          input = agg_model_daily.input + excluded.input,
          output = agg_model_daily.output + excluded.output,
          cache_read = agg_model_daily.cache_read + excluded.cache_read,
          cache_write = agg_model_daily.cache_write + excluded.cache_write,
          reasoning = agg_model_daily.reasoning + excluded.reasoning,
          total = agg_model_daily.total + excluded.total,
          calls = agg_model_daily.calls + excluded.calls`);
		const incAggSession = this.db.prepare(`INSERT INTO agg_session(session_id, input, output, cache_read, cache_write, reasoning, total, calls, max_seq, last_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         input = agg_session.input + excluded.input,
         output = agg_session.output + excluded.output,
         cache_read = agg_session.cache_read + excluded.cache_read,
         cache_write = agg_session.cache_write + excluded.cache_write,
         reasoning = agg_session.reasoning + excluded.reasoning,
         total = agg_session.total + excluded.total,
         calls = agg_session.calls + excluded.calls,
         max_seq = CASE WHEN excluded.max_seq > agg_session.max_seq THEN excluded.max_seq ELSE agg_session.max_seq END,
         last_active = CASE WHEN excluded.last_active > agg_session.last_active THEN excluded.last_active ELSE agg_session.last_active END`);
		const incAggSessionDaily = this.db.prepare(`INSERT INTO agg_session_daily(session_id, day, input, output, cache_read, cache_write, reasoning, total, calls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, day) DO UPDATE SET
         input = agg_session_daily.input + excluded.input,
         output = agg_session_daily.output + excluded.output,
         cache_read = agg_session_daily.cache_read + excluded.cache_read,
         cache_write = agg_session_daily.cache_write + excluded.cache_write,
         reasoning = agg_session_daily.reasoning + excluded.reasoning,
         total = agg_session_daily.total + excluded.total,
         calls = agg_session_daily.calls + excluded.calls`);
		const insertAggTotalBulk = this.db.prepare(`INSERT INTO agg_total(id, input, output, cache_read, cache_write, reasoning, total, calls, folded_events)
       VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?)`);
		const insertAggDailyBulk = this.db.prepare(`INSERT INTO agg_daily(day, input, output, cache_read, cache_write, reasoning, total, calls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
		const insertAggModelBulk = this.db.prepare(`INSERT INTO agg_model(provider, model, input, output, cache_read, cache_write, reasoning, total, calls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
		const insertAggModelDailyBulk = this.db.prepare(`INSERT INTO agg_model_daily(provider, model, day, input, output, cache_read, cache_write, reasoning, total, calls)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
		const insertAggSessionBulk = this.db.prepare(`INSERT INTO agg_session(session_id, input, output, cache_read, cache_write, reasoning, total, calls, max_seq, last_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
		const insertAggSessionDailyBulk = this.db.prepare(`INSERT INTO agg_session_daily(session_id, day, input, output, cache_read, cache_write, reasoning, total, calls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
		const getCheckpoint = this.db.prepare("SELECT value FROM agg_checkpoint WHERE key = ?");
		const upsertCheckpoint = this.db.prepare(`INSERT INTO agg_checkpoint(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
		const allEventsSince = this.db.prepare("SELECT t, session_id, seq, provider, model, input, output, cache_read, cache_write, reasoning FROM events WHERE t >= ?");
		this.stmts = {
			hasEvent,
			hasEventByPK,
			insertEvent,
			allEvents,
			upsertMeta,
			allMeta,
			hasAgg,
			getAggTotal,
			allAggDaily,
			allAggModel,
			allAggModelDaily,
			allAggSession,
			allAggSessionDaily,
			incAggTotal,
			incAggDaily,
			incAggModel,
			incAggModelDaily,
			incAggSession,
			incAggSessionDaily,
			insertAggTotalBulk,
			insertAggDailyBulk,
			insertAggModelBulk,
			insertAggModelDailyBulk,
			insertAggSessionBulk,
			insertAggSessionDailyBulk,
			getCheckpoint,
			upsertCheckpoint,
			allEventsSince
		};
		for (const row of allMeta.all()) {
			const id = String(row.session_id);
			this.metaCache.set(id, {
				title: String(row.title ?? ""),
				cwd: String(row.cwd ?? ""),
				createdAt: Number(row.created_at) || 0,
				lastActive: Number(row.last_active) || 0,
				parentSession: String(row.parent_session ?? ""),
				origin: String(row.origin ?? ""),
				delegationDepth: Number(row.delegation_depth) || 0
			});
		}
	}
	/** 事件流是否已有内容，决定首启扫描或直接重建。 */
	hasEvents() {
		this.assertOpen();
		return this.stmts.hasEvent.get() !== void 0;
	}
	/** 指定主键的事件是否已存在，用于 seq=-1 等无法通过水位去重的幂等校验。
	*  键与 append 同样经 NUL 清洗，保证读写对称命中。 */
	hasEventAt(t, sessionId, seq) {
		this.assertOpen();
		return this.stmts.hasEventByPK.get(t, sanitizeSqlText(sessionId), seq) !== void 0;
	}
	/** 追加一条事件，幂等，同 t+session+seq 收敛为 upsert，返回是否为新插入。 */
	append(ev) {
		this.assertOpen();
		const existed = this.hasEventAt(ev.t, ev.sessionId, ev.seq);
		this.stmts.insertEvent.run(ev.t, ev.sessionId, ev.seq, ev.provider, ev.model, ev.input, ev.output, ev.cacheRead, ev.cacheWrite, ev.reasoning);
		return !existed;
	}
	/** 更新会话元数据，增量合并，内存缓存与同步写回，全部字符串经 NUL 清洗后入列。 */
	setMeta(id, patch) {
		this.assertOpen();
		const key = sanitizeSqlText(id);
		const current = this.metaCache.get(key) ?? emptySessionMeta();
		const next = {
			title: typeof patch.title === "string" ? sanitizeSqlText(patch.title) : current.title,
			cwd: typeof patch.cwd === "string" ? sanitizeSqlText(patch.cwd) : current.cwd,
			createdAt: typeof patch.createdAt === "number" && Number.isFinite(patch.createdAt) && patch.createdAt > 0 ? patch.createdAt : current.createdAt,
			lastActive: typeof patch.lastActive === "number" && Number.isFinite(patch.lastActive) && patch.lastActive > 0 ? Math.max(current.lastActive, patch.lastActive) : current.lastActive,
			parentSession: typeof patch.parentSession === "string" ? sanitizeSqlText(patch.parentSession) : current.parentSession,
			origin: typeof patch.origin === "string" ? sanitizeSqlText(patch.origin) : current.origin,
			delegationDepth: typeof patch.delegationDepth === "number" && Number.isFinite(patch.delegationDepth) && patch.delegationDepth >= 0 ? patch.delegationDepth : current.delegationDepth
		};
		this.metaCache.set(key, next);
		this.stmts.upsertMeta.run(key, next.title, next.cwd, next.createdAt, next.lastActive, next.parentSession, next.origin, next.delegationDepth);
	}
	/** 取会话元数据，无则返回 null，键与 setMeta 同样清洗，保证读写对称命中。 */
	getMeta(id) {
		this.assertOpen();
		return this.metaCache.get(sanitizeSqlText(id)) ?? null;
	}
	/** 全部账本事件，冷启动或重建时逐条折叠进聚合缓存。 */
	allEvents() {
		this.assertOpen();
		return this.stmts.allEvents.all().map((r) => ({
			t: Number(r.t) || 0,
			sessionId: String(r.session_id),
			provider: String(r.provider),
			model: String(r.model),
			seq: Number(r.seq) || 0,
			input: Number(r.input) || 0,
			output: Number(r.output) || 0,
			cacheRead: Number(r.cache_read) || 0,
			cacheWrite: Number(r.cache_write) || 0,
			reasoning: Number(r.reasoning) || 0
		}));
	}
	/** 查询指定时间戳之后的事件，增量加载，预统计加速。 */
	allEventsSince(since) {
		this.assertOpen();
		return this.stmts.allEventsSince.all(since).map((r) => ({
			t: Number(r.t) || 0,
			sessionId: String(r.session_id),
			provider: String(r.provider),
			model: String(r.model),
			seq: Number(r.seq) || 0,
			input: Number(r.input) || 0,
			output: Number(r.output) || 0,
			cacheRead: Number(r.cache_read) || 0,
			cacheWrite: Number(r.cache_write) || 0,
			reasoning: Number(r.reasoning) || 0
		}));
	}
	/** 清空全部 9 表事件流、元数据与预统计，重建账本用，保留表结构。 */
	clear() {
		this.assertOpen();
		this.db.exec("DELETE FROM events");
		this.db.exec("DELETE FROM session_meta");
		this.metaCache.clear();
		this.clearAggregates();
	}
	/** 关闭数据库连接，插件卸载时调用，幂等。 */
	close() {
		if (this.closed) return;
		this.closed = true;
		this.db.close();
	}
	assertOpen() {
		if (this.closed) throw new Error("ledger is closed");
	}
	/** 是否已暂停预统计增量，批量导入期间挂起，避免每行多次写。 */
	isAggSuspended() {
		return this.aggSuspended;
	}
	/** 设置预统计增量挂起，批量扫描时调用。 */
	setAggSuspended(v) {
		this.aggSuspended = v;
	}
	/** 在事务中执行，支持嵌套，已在事务内则直接执行。 */
	transaction(fn) {
		this.assertOpen();
		if (this.inTransaction) return fn();
		this.inTransaction = true;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (e) {
			try {
				this.db.exec("ROLLBACK");
			} catch {}
			throw e;
		} finally {
			this.inTransaction = false;
		}
	}
	/** 预统计是否已有内容，即是否有物化聚合。 */
	hasAggregates() {
		this.assertOpen();
		return this.stmts.hasAgg.get() !== void 0;
	}
	/** 增量更新预统计，单条事件，对应一次用量调用。 */
	incrementAgg(ev) {
		this.assertOpen();
		if (this.aggSuspended) return;
		if (ev.input + ev.output + ev.cacheRead + ev.cacheWrite + ev.reasoning <= 0) return;
		const day = startOfDay(ev.t);
		const total = ev.input + ev.output + ev.cacheRead + ev.cacheWrite;
		const runInTx = () => {
			this.stmts.incAggTotal.run(ev.input, ev.output, ev.cacheRead, ev.cacheWrite, ev.reasoning, total, 1, 1);
			this.stmts.incAggDaily.run(day, ev.input, ev.output, ev.cacheRead, ev.cacheWrite, ev.reasoning, total, 1);
			this.stmts.incAggModel.run(ev.provider, ev.model, ev.input, ev.output, ev.cacheRead, ev.cacheWrite, ev.reasoning, total, 1);
			this.stmts.incAggModelDaily.run(ev.provider, ev.model, day, ev.input, ev.output, ev.cacheRead, ev.cacheWrite, ev.reasoning, total, 1);
			this.stmts.incAggSession.run(ev.sessionId, ev.input, ev.output, ev.cacheRead, ev.cacheWrite, ev.reasoning, total, 1, ev.seq, ev.t);
			this.stmts.incAggSessionDaily.run(ev.sessionId, day, ev.input, ev.output, ev.cacheRead, ev.cacheWrite, ev.reasoning, total, 1);
		};
		if (this.inTransaction) runInTx();
		else this.transaction(runInTx);
	}
	/** 批量物化当前内存聚合到 DB，覆盖式，全量预统计。 */
	persistAggregates(store) {
		this.assertOpen();
		this.transaction(() => {
			this.db.exec("DELETE FROM agg_total");
			this.db.exec("DELETE FROM agg_daily");
			this.db.exec("DELETE FROM agg_model");
			this.db.exec("DELETE FROM agg_model_daily");
			this.db.exec("DELETE FROM agg_session");
			this.db.exec("DELETE FROM agg_session_daily");
			const a = store.allAgg;
			this.stmts.insertAggTotalBulk.run(a.input, a.output, a.cacheRead, a.cacheWrite, a.reasoning, a.total, a.calls, store.foldedEvents);
			for (const [day, agg] of store.allDaily) this.stmts.insertAggDailyBulk.run(day, agg.input, agg.output, agg.cacheRead, agg.cacheWrite, agg.reasoning, agg.total, agg.calls);
			for (const [key, agg] of store.models) {
				const { provider, model } = splitModelKey(key);
				this.stmts.insertAggModelBulk.run(provider, model, agg.input, agg.output, agg.cacheRead, agg.cacheWrite, agg.reasoning, agg.total, agg.calls);
			}
			for (const [key, dailyMap] of store.modelDaily) {
				const { provider, model } = splitModelKey(key);
				for (const [day, agg] of dailyMap) this.stmts.insertAggModelDailyBulk.run(provider, model, day, agg.input, agg.output, agg.cacheRead, agg.cacheWrite, agg.reasoning, agg.total, agg.calls);
			}
			for (const [sid, info] of store.sessions) {
				const ag = info.allAgg;
				this.stmts.insertAggSessionBulk.run(sid, ag.input, ag.output, ag.cacheRead, ag.cacheWrite, ag.reasoning, ag.total, ag.calls, info.maxSeq, info.lastActive);
				for (const [day, dAgg] of info.daily) this.stmts.insertAggSessionDailyBulk.run(sid, day, dAgg.input, dAgg.output, dAgg.cacheRead, dAgg.cacheWrite, dAgg.reasoning, dAgg.total, dAgg.calls);
			}
		});
	}
	/** 从预统计加载内存聚合，快速启动路径；modelDaily 缺失时回放 events 重建并回写，返回是否命中。 */
	loadAggregates(store) {
		this.assertOpen();
		const totalRow = this.stmts.getAggTotal.get();
		if (totalRow === void 0) return false;
		store.allAgg.input = Number(totalRow.input) || 0;
		store.allAgg.output = Number(totalRow.output) || 0;
		store.allAgg.cacheRead = Number(totalRow.cache_read) || 0;
		store.allAgg.cacheWrite = Number(totalRow.cache_write) || 0;
		store.allAgg.reasoning = Number(totalRow.reasoning) || 0;
		store.allAgg.total = Number(totalRow.total) || 0;
		store.allAgg.calls = Number(totalRow.calls) || 0;
		store.foldedEvents = Number(totalRow.folded_events) || store.allAgg.calls;
		store.allDaily.clear();
		store.models.clear();
		store.modelDaily.clear();
		store.sessions.clear();
		for (const r of this.stmts.allAggDaily.all()) {
			const day = Number(r.day) || 0;
			store.allDaily.set(day, {
				input: Number(r.input) || 0,
				output: Number(r.output) || 0,
				cacheRead: Number(r.cache_read) || 0,
				cacheWrite: Number(r.cache_write) || 0,
				reasoning: Number(r.reasoning) || 0,
				total: Number(r.total) || 0,
				calls: Number(r.calls) || 0
			});
		}
		for (const r of this.stmts.allAggModel.all()) {
			const key = String(r.provider) + "\0" + String(r.model);
			store.models.set(key, {
				input: Number(r.input) || 0,
				output: Number(r.output) || 0,
				cacheRead: Number(r.cache_read) || 0,
				cacheWrite: Number(r.cache_write) || 0,
				reasoning: Number(r.reasoning) || 0,
				total: Number(r.total) || 0,
				calls: Number(r.calls) || 0
			});
		}
		for (const r of this.stmts.allAggModelDaily.all()) {
			const key = String(r.provider) + "\0" + String(r.model);
			const day = Number(r.day) || 0;
			let daily = store.modelDaily.get(key);
			if (!daily) {
				daily = /* @__PURE__ */ new Map();
				store.modelDaily.set(key, daily);
			}
			daily.set(day, {
				input: Number(r.input) || 0,
				output: Number(r.output) || 0,
				cacheRead: Number(r.cache_read) || 0,
				cacheWrite: Number(r.cache_write) || 0,
				reasoning: Number(r.reasoning) || 0,
				total: Number(r.total) || 0,
				calls: Number(r.calls) || 0
			});
		}
		if (store.modelDaily.size === 0 && store.models.size > 0) try {
			const events = this.allEvents();
			for (const ev of events) {
				const day = startOfDay(ev.t);
				const key = ev.provider + "\0" + ev.model;
				let daily = store.modelDaily.get(key);
				if (!daily) {
					daily = /* @__PURE__ */ new Map();
					store.modelDaily.set(key, daily);
				}
				let agg = daily.get(day);
				if (!agg) {
					agg = {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						reasoning: 0,
						total: 0,
						calls: 0
					};
					daily.set(day, agg);
				}
				agg.input += ev.input;
				agg.output += ev.output;
				agg.cacheRead += ev.cacheRead;
				agg.cacheWrite += ev.cacheWrite;
				agg.reasoning += ev.reasoning;
				agg.total += ev.input + ev.output + ev.cacheRead + ev.cacheWrite;
				agg.calls += 1;
			}
			if (store.modelDaily.size > 0) this.transaction(() => {
				this.db.exec("DELETE FROM agg_model_daily");
				for (const [key, dailyMap] of store.modelDaily) {
					const { provider, model } = splitModelKey(key);
					for (const [day, agg] of dailyMap) this.stmts.insertAggModelDailyBulk.run(provider, model, day, agg.input, agg.output, agg.cacheRead, agg.cacheWrite, agg.reasoning, agg.total, agg.calls);
				}
			});
		} catch (e) {
			console.error("[usage-stats] modelDaily 重建失败", e);
		}
		for (const r of this.stmts.allAggSession.all()) {
			const sid = String(r.session_id);
			store.sessions.set(sid, {
				daily: /* @__PURE__ */ new Map(),
				allAgg: {
					input: Number(r.input) || 0,
					output: Number(r.output) || 0,
					cacheRead: Number(r.cache_read) || 0,
					cacheWrite: Number(r.cache_write) || 0,
					reasoning: Number(r.reasoning) || 0,
					total: Number(r.total) || 0,
					calls: Number(r.calls) || 0
				},
				maxSeq: typeof r.max_seq === "number" ? r.max_seq : -1,
				lastActive: Number(r.last_active) || 0
			});
		}
		for (const r of this.stmts.allAggSessionDaily.all()) {
			const sid = String(r.session_id);
			const day = Number(r.day) || 0;
			let info = store.sessions.get(sid);
			if (!info) {
				info = {
					daily: /* @__PURE__ */ new Map(),
					allAgg: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						reasoning: 0,
						total: 0,
						calls: 0
					},
					maxSeq: -1,
					lastActive: 0
				};
				store.sessions.set(sid, info);
			}
			info.daily.set(day, {
				input: Number(r.input) || 0,
				output: Number(r.output) || 0,
				cacheRead: Number(r.cache_read) || 0,
				cacheWrite: Number(r.cache_write) || 0,
				reasoning: Number(r.reasoning) || 0,
				total: Number(r.total) || 0,
				calls: Number(r.calls) || 0
			});
		}
		return true;
	}
	/** 清空预统计，重建或清零时调用。 */
	clearAggregates() {
		this.assertOpen();
		this.db.exec("DELETE FROM agg_total");
		this.db.exec("DELETE FROM agg_daily");
		this.db.exec("DELETE FROM agg_model");
		this.db.exec("DELETE FROM agg_model_daily");
		this.db.exec("DELETE FROM agg_session");
		this.db.exec("DELETE FROM agg_session_daily");
		this.db.exec("DELETE FROM agg_checkpoint");
	}
	/** 读检查点。 */
	getCheckpoint(key) {
		this.assertOpen();
		const row = this.stmts.getCheckpoint.get(key);
		if (!row) return null;
		const v = Number(row.value);
		return Number.isFinite(v) ? v : null;
	}
	/** 写检查点。 */
	setCheckpoint(key, value) {
		this.assertOpen();
		this.stmts.upsertCheckpoint.run(key, value);
	}
	/** 记录密封边界（仅写 checkpoint，不物化；物化由 persistAggregates 完成）。 */
	sealUntil(dayStart) {
		this.assertOpen();
		this.setCheckpoint("sealed_until", dayStart);
	}
	/** 获取已密封边界，默认为 0。 */
	getSealedUntil() {
		return this.getCheckpoint("sealed_until") ?? 0;
	}
	/**
	* 清零墓碑：清零后落标记，重启 bootstrap 空库且有标记时跳过首启全量扫描，
	* 否则空库会被当作首启、把磁盘日志里的历史统计原样扫回来。
	* 复用 agg_checkpoint（与 sealed_until 同款键值用法，无结构变更）；
	* 必须在 clear 之后写——clear 经 clearAggregates 整表清空 checkpoint。
	*/
	markCleared() {
		this.setCheckpoint("cleared_at", Date.now());
	}
	/** 清零墓碑时间；从未清零返回 null。 */
	getClearedAt() {
		return this.getCheckpoint("cleared_at");
	}
};

//#endregion
//#region src/host/store.ts
/**
* 内存聚合缓存：由账本事件流折叠而来的派生统计，按天、会话、模型、模型×日、全量维度组织。
*
* 边界：账本即 ledger.ts 的 Ledger，持有 sqlite 事件流与会话元数据；本模块
* 只做折叠与聚合，是快照 API 的读取面。折叠路径：
*   - 启动/重建：从账本事件全量折叠，经由 scan.ts 的 rebuildFromEvents；
*   - 实时：session/event 监听逐条折叠，共用 foldRecord 与账本追加路径。
* 账本写入同步落盘，sqlite 自动提交、即写即持久。
* 预统计：对不会再变动的历史数据做物化聚合，启动时优先从 agg_* 表加载，
* 仅少量未密封事件需重放，显著降低冷启动时间；实时路径增量更新预统计。
* 所有操作以 store 为首参的纯函数或接受 ledger 参数的折叠助手，可独立测试。
*/
/** 新建空聚合缓存。 */
function createStore() {
	return {
		sessions: /* @__PURE__ */ new Map(),
		models: /* @__PURE__ */ new Map(),
		modelDaily: /* @__PURE__ */ new Map(),
		allAgg: newAgg(),
		allDaily: /* @__PURE__ */ new Map(),
		foldedEvents: 0,
		dedupSkipped: 0,
		scanning: false,
		running: false,
		scans: 0,
		failed: 0,
		rawSessions: 0,
		harnessSessions: 0,
		lastError: null,
		scanError: null,
		lastScanAt: 0
	};
}
/** 取某日分桶计数，不存在则新建。 */
function dayAgg(map, day) {
	let a = map.get(day);
	if (!a) {
		a = newAgg();
		map.set(day, a);
	}
	return a;
}
/** 取会话级状态，不存在则新建。 */
function ensureSession(store, id) {
	let info = store.sessions.get(id);
	if (!info) {
		info = {
			daily: /* @__PURE__ */ new Map(),
			allAgg: newAgg(),
			maxSeq: -1,
			lastActive: 0
		};
		store.sessions.set(id, info);
	}
	return info;
}
/** 取某模型分桶计数，不存在则新建，key 为 provider 与 model 以 \0 拼接。 */
function ensureModel(store, key) {
	let agg = store.models.get(key);
	if (!agg) {
		agg = newAgg();
		store.models.set(key, agg);
	}
	return agg;
}
/** 取某模型的按日分桶 Map，不存在则新建。 */
function ensureModelDaily(store, key) {
	let m = store.modelDaily.get(key);
	if (!m) {
		m = /* @__PURE__ */ new Map();
		store.modelDaily.set(key, m);
	}
	return m;
}
/** 把一次真实用量折进会话日桶 / 会话总桶 / 全量日桶 / 全量总桶。 */
function foldUsage(store, info, timeMs, u) {
	const day = startOfDay(timeMs);
	ink(dayAgg(info.daily, day), u);
	ink(info.allAgg, u);
	ink(dayAgg(store.allDaily, day), u);
	ink(store.allAgg, u);
	if (timeMs > info.lastActive) info.lastActive = timeMs;
}
/**
* 从原始记录求 fork 继承前缀长度：最后一个 `session/end-seed`（`data.inherited === true`）
* 之后偏移一位，即该会话从父会话复制来的事件数，与 harness 的 `inheritedEventCount` 同义。
* 无标记返回 0。原始日志路径拿不到 harness 元数据，用标记事件兜底。
*/
function inheritedPrefixOf(records) {
	let cut = -1;
	for (const record of records) {
		if (typeof record !== "object" || record === null) continue;
		const r = record;
		if (r.type !== "session/end-seed" || r.data?.inherited !== true) continue;
		const seq = r.seq;
		if (typeof seq === "number" && Number.isFinite(seq) && seq > cut) cut = seq;
	}
	return cut + 1;
}
/**
* 归一 harness 元数据里的 fork 继承前缀长度（`SessionLogSnapshot.inheritedEventCount`
* 与 `SessionHandle.inheritedEventCount`）：非有限、负数与缺省一律按 0，即无继承。
*/
function inheritedCountOf(value) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
/**
* 只保留本会话自有事件，丢掉 fork 继承前缀，避免把父会话的用量在子会话下重复计入。
* 继承前缀是日志的物理前缀（seq 从 0 起共 inherited 条），因此按 seq 判定；
* 无 seq 的记录（会话种子 header）不属于事件序列，原样保留供 meta 抄录。
*/
function liveEventsOf(events, inherited) {
	if (!(inherited > 0)) return events;
	return events.filter((event) => {
		const seq = event.seq;
		return typeof seq !== "number" || seq >= inherited;
	});
}
/**
* 折叠一条账本事件进聚合缓存，调用方保证事件唯一（PK 为 t、session_id、seq），
* 本函数除零用量守卫外恒折叠，直接重调会翻倍。返回是否真正折叠，
* 事件无用量时返回 false。seq>=0 时推进该会话的 maxSeq 水位，使重启恢复后
* 实时路径同样能去重历史事件。
* 若提供 ledger，则同步增量更新预统计物化表，挂起时跳过，由批量 persist 覆盖。
*/
function foldLedgerEvent(store, ev, ledger) {
	if (ev.input + ev.output + ev.cacheRead + ev.cacheWrite + ev.reasoning <= 0) return false;
	const usage = {
		inputTokens: ev.input,
		outputTokens: ev.output,
		cacheReadTokens: ev.cacheRead,
		cacheWriteTokens: ev.cacheWrite,
		reasoningTokens: ev.reasoning
	};
	const info = ensureSession(store, ev.sessionId);
	if (ev.seq >= 0 && ev.seq > info.maxSeq) info.maxSeq = ev.seq;
	foldUsage(store, info, ev.t, usage);
	const modelKey = ev.provider + "\0" + ev.model;
	ink(ensureModel(store, modelKey), usage);
	ink(dayAgg(ensureModelDaily(store, modelKey), startOfDay(ev.t)), usage);
	store.foldedEvents += 1;
	if (ledger) try {
		ledger.incrementAgg(ev);
	} catch (e) {
		console.error("[usage-stats] 预统计增量写入失败", e);
		store.lastError = errorMessage(e);
	}
	return true;
}
/**
* 处理一条原始记录，涵盖会话种子、session/title、计量事件（usable，含对话与压缩调用）三类：
* 元数据写账本 meta；usable 事件经 seq 水位、seq=-1 主键、append 返回值三层去重后追加进账本
* 并折叠进聚合缓存。初始化扫描与实时监听共用此路径，保证账本内事件唯一。
* 全部同步，sqlite 即写即持久，无需等待落盘。
* 预统计增量在此路径自动完成，挂起时跳过。
*/
function foldRecord(store, ledger, id, record) {
	if (record.type === "session") {
		const rec = record;
		const createdAt = typeof rec.createdAt === "number" ? rec.createdAt : void 0;
		const parentSession = typeof rec.parentSession === "string" ? rec.parentSession : void 0;
		const origin = typeof rec.origin === "string" ? rec.origin : void 0;
		const delegationDepth = typeof rec.delegationDepth === "number" && Number.isFinite(rec.delegationDepth) ? rec.delegationDepth : void 0;
		ledger.setMeta(id, {
			cwd: typeof rec.cwd === "string" ? rec.cwd : void 0,
			createdAt,
			lastActive: createdAt,
			parentSession,
			origin,
			delegationDepth
		});
		return;
	}
	if (record.type === "session/title") {
		const title = record.data?.title;
		ledger.setMeta(id, { title: typeof title === "string" ? title : void 0 });
		return;
	}
	const event = record;
	if (!usable(event)) return;
	let ev;
	try {
		ev = toLedgerEvent(id, event);
	} catch {
		return;
	}
	if (ev === null) return;
	if (ev.input + ev.output + ev.cacheRead + ev.cacheWrite + ev.reasoning <= 0) return;
	const sid = ev.sessionId;
	const info = ensureSession(store, sid);
	if (typeof ev.seq === "number" && ev.seq >= 0 && ev.seq <= info.maxSeq) {
		store.dedupSkipped += 1;
		return;
	}
	if (ev.seq < 0 && ledger.hasEventAt(ev.t, sid, ev.seq)) {
		store.dedupSkipped += 1;
		return;
	}
	if (!ledger.append(ev)) {
		store.dedupSkipped += 1;
		return;
	}
	ledger.setMeta(sid, { lastActive: ev.t });
	foldLedgerEvent(store, ev, ledger);
}
/** 取会话 meta，缺省用空元数据，避免 snapshot 层判空。 */
function metaOf(ledger, id) {
	return ledger.getMeta(id) ?? {
		title: "",
		cwd: "",
		createdAt: 0,
		lastActive: 0,
		parentSession: "",
		origin: "",
		delegationDepth: 0
	};
}

//#endregion
//#region src/host/scan.ts
/**
* 会话扫描编排，账本导入：把磁盘原始日志 ∪ harness 会话清单的会话 id
* 全集逐会话读取，经 foldRecord 写入账本（events、session_meta 共 9 表，
* 含 agg_* 预统计）并折叠聚合缓存。harness 读取经 sessionQuery.readSession、
* persistence.open+read 实现；两路都被拒绝（如旧代次会话的
* SessionFormatUnsupportedError）或返回空事件时，回退用 rawlog 自读磁盘最高
* 代次日志兜底，使被迁移拒绝的旧会话仍纳入统计；4 路 worker 并行。
*
* 语义：只在账本需要初始化，首启无事件或显式重建时运行；平时数据来自
* 实时 session/event 监听，每次写入同步落盘，无需周期性对账。
* 预统计：批量导入期间挂起逐条物化，完成后一次 bulk 物化 agg_* 表，
* 后续启动可直接从预统计加载，仅重放少量未密封事件，显著加速冷启动。
* 扫描报告，rawSessions（raw 兜底命中）、harnessSessions（harness 命中）、
* failed 记录最近一次导入结果。
*/
/** 扫描并发 worker 数：IO 等待为主，4 路并行兼顾吞吐与 sqlite 写竞争。 */
const SCAN_WORKERS = 4;
/** 复位聚合缓存，重建账本前调用：清空会话/模型/全量/日桶与去重水位与计数。 */
function resetStore(store) {
	store.sessions.clear();
	store.models.clear();
	store.modelDaily.clear();
	store.allAgg = newAgg();
	store.allDaily.clear();
	store.foldedEvents = 0;
	store.dedupSkipped = 0;
	store.rawSessions = 0;
	store.harnessSessions = 0;
	store.failed = 0;
	store.lastError = null;
	store.scanError = null;
}
/** 会话 id 截断展示，取前 12 字符。 */
const shortOf = (id) => typeof id === "string" && id.length > 12 ? id.slice(0, 12) + "…" : String(id);
/**
* 尝试从预统计物化表加载聚合，属于快速启动路径。
* 成功返回 true，已填充 store，无预统计返回 false，调用方需回退到事件重放或扫描。
*/
function tryLoadAggregates(store, ledger) {
	if (!ledger.hasAggregates()) return false;
	const ok = ledger.loadAggregates(store);
	if (ok) store.dedupSkipped = 0;
	return ok;
}
/**
* 密封历史预统计：将当前内存聚合全量物化至 DB，并将密封边界推进至今日零点。
* 供显式 seal 调用；scanOnce 仅在有扫描且有折叠事件时调用。
*/
function sealAggregates(store, ledger) {
	try {
		ledger.persistAggregates(store);
	} catch (e) {
		console.error("[usage-stats] 物化预统计失败", e);
		return;
	}
	try {
		ledger.sealUntil(startOfDay(Date.now()));
	} catch {}
}
/** 扫描一轮全部会话并将其写入账本，初始与重建共用，防重入由 store.running 保证（force 持锁重入除外）。
*  整轮无失败会话时清除历史错误标记，自愈，日志可读性恢复后自动消失。
*  批量导入期间挂起逐条物化，完成后一次 bulk 物化，兼顾写入吞吐与启动加速。 */
async function scanOnce(ctx, store, ledger, options) {
	const initial = !!options?.initial;
	const force = !!options?.force;
	if (store.running && !force) return;
	if (initial) store.scanning = true;
	store.running = true;
	store.scans += 1;
	store.lastScanAt = Date.now();
	store.failed = 0;
	store.rawSessions = 0;
	store.harnessSessions = 0;
	const prevSuspend = ledger.isAggSuspended();
	ledger.setAggSuspended(true);
	let didScan = false;
	try {
		const query = ctx.sessionQuery;
		const persist = ctx.sessionPersistence;
		const logPaths = /* @__PURE__ */ new Map();
		findSessionLogs(getSessionsRoot(), 0, logPaths);
		const ids = new Set(logPaths.keys());
		const headerMap = /* @__PURE__ */ new Map();
		if (query) try {
			const listed = await query.listSessions();
			if (Array.isArray(listed)) {
				for (const rec of listed) if (rec.header && typeof rec.header.id === "string") {
					ids.add(rec.header.id);
					const h = rec.header;
					if (typeof h.cwd === "string" || typeof h.createdAt === "number" || typeof h.parentSession === "string" || typeof h.origin === "string" || typeof h.delegationDepth === "number") headerMap.set(rec.header.id, {
						cwd: typeof h.cwd === "string" ? h.cwd : void 0,
						createdAt: typeof h.createdAt === "number" ? h.createdAt : void 0,
						parentSession: typeof h.parentSession === "string" ? h.parentSession : void 0,
						origin: typeof h.origin === "string" ? h.origin : void 0,
						delegationDepth: typeof h.delegationDepth === "number" ? h.delegationDepth : void 0
					});
				}
			}
		} catch (e) {
			store.scanError = "listSessions: " + errorMessage(e);
		}
		if (persist) try {
			const snapshots = await persist.list();
			if (Array.isArray(snapshots)) for (const snap of snapshots) {
				const header = snap.header ?? snap;
				if (header && typeof header.id === "string") {
					const hid = header.id;
					ids.add(hid);
					const h = header;
					if (typeof h.cwd === "string" || typeof h.createdAt === "number" || typeof h.parentSession === "string" || typeof h.origin === "string" || typeof h.delegationDepth === "number") {
						if (!headerMap.has(hid)) headerMap.set(hid, {
							cwd: typeof h.cwd === "string" ? h.cwd : void 0,
							createdAt: typeof h.createdAt === "number" ? h.createdAt : void 0,
							parentSession: typeof h.parentSession === "string" ? h.parentSession : void 0,
							origin: typeof h.origin === "string" ? h.origin : void 0,
							delegationDepth: typeof h.delegationDepth === "number" ? h.delegationDepth : void 0
						});
					}
				}
			}
		} catch (e) {
			store.scanError = "persistence.list: " + errorMessage(e);
		}
		const idList = [...ids];
		let i = 0;
		async function worker() {
			while (i < idList.length) {
				const id = idList[i];
				i += 1;
				try {
					const hdr = headerMap.get(id);
					if (hdr && (hdr.cwd !== void 0 || hdr.createdAt !== void 0 || hdr.parentSession !== void 0 || hdr.origin !== void 0 || hdr.delegationDepth !== void 0)) ledger.setMeta(id, {
						cwd: hdr.cwd,
						createdAt: hdr.createdAt,
						lastActive: hdr.createdAt,
						parentSession: hdr.parentSession,
						origin: hdr.origin,
						delegationDepth: hdr.delegationDepth
					});
					let events = null;
					if (query) try {
						const snap = await query.readSession(id);
						if (snap && Array.isArray(snap.events)) events = liveEventsOf(snap.events, inheritedCountOf(snap.inheritedEventCount));
					} catch (e) {
						store.lastError = "readSession " + shortOf(id) + ": " + errorMessage(e);
						events = null;
					}
					if (events === null && persist) {
						let handle = null;
						try {
							handle = await persist.open(id, "read");
							const r = await handle.read(0);
							events = r && Array.isArray(r.events) ? liveEventsOf(r.events, inheritedCountOf(handle.inheritedEventCount)) : [];
						} catch (e) {
							store.lastError = "persistence.read " + shortOf(id) + ": " + errorMessage(e);
							events = null;
						} finally {
							if (handle) try {
								await handle.close();
							} catch {}
						}
					}
					let folded = false;
					if (events && events.length) {
						for (const event of events) try {
							foldRecord(store, ledger, id, event);
						} catch (e) {
							store.lastError = "record " + shortOf(id) + ": " + errorMessage(e);
						}
						store.harnessSessions += 1;
						didScan = true;
						folded = true;
					}
					if (!folded) {
						const log = logPaths.get(id);
						if (log) try {
							const records = parseLogLines(decodeSessionLog(readFileSync(log.path), log.compression));
							const live = liveEventsOf(records, inheritedPrefixOf(records));
							if (live.length > 0) {
								for (const record of live) try {
									foldRecord(store, ledger, id, record);
								} catch (e) {
									store.lastError = "record " + shortOf(id) + ": " + errorMessage(e);
								}
								store.rawSessions += 1;
								didScan = true;
								folded = true;
							}
						} catch (e) {
							store.lastError = "raw " + shortOf(id) + ": " + errorMessage(e);
						}
					}
					if (!folded && events === null) store.failed += 1;
				} catch (e) {
					store.lastError = "session " + shortOf(id) + ": " + errorMessage(e);
					store.failed += 1;
				}
			}
		}
		const n = Math.max(1, Math.min(SCAN_WORKERS, idList.length || 1));
		const workers = [];
		for (let k = 0; k < n; k += 1) workers.push(worker());
		await Promise.all(workers.map((w) => w.catch((e) => {
			store.lastError = "worker: " + errorMessage(e);
			store.failed += 1;
		})));
		didScan = didScan || idList.length > 0;
	} finally {
		if (didScan && store.foldedEvents > 0) try {
			sealAggregates(store, ledger);
		} catch {}
		ledger.setAggSuspended(prevSuspend);
		if (store.failed === 0) {
			store.lastError = null;
			store.scanError = null;
		}
		if (initial) store.scanning = false;
		store.running = false;
	}
}
/** 从账本事件流重建聚合缓存，启动加载账本已有事件时用，元数据已在 ledger。
*  清空现有聚合后按事件流全量重折；seq>=0 的 maxSeq 水位在 foldLedgerEvent 内重建，seq=-1 靠主键与 lastActive，
*  实时路径随后可对历史事件去重。
*  批量重建期间挂起逐条预统计，结束后统一物化以加速后续启动。 */
function rebuildFromEvents(store, ledger) {
	const prev = ledger.isAggSuspended();
	ledger.setAggSuspended(true);
	try {
		store.sessions.clear();
		store.models.clear();
		store.modelDaily.clear();
		store.allAgg = newAgg();
		store.allDaily.clear();
		store.foldedEvents = 0;
		store.dedupSkipped = 0;
		for (const ev of ledger.allEvents()) foldLedgerEvent(store, ev);
		if (store.foldedEvents > 0) try {
			sealAggregates(store, ledger);
		} catch {}
	} finally {
		ledger.setAggSuspended(prev);
	}
}
/**
* 增量重建：优先从预统计加载聚合，sealedUntil>0 时对边界之后的账本事件按
* 会话水位比对补齐（调用方过滤，fold 本身不去重），补齐后推进密封边界。
*
* 对账必须无条件执行，不设跨日前置条件：实时路径 ledger.append 与
* incrementAgg 是两个独立提交，中间崩溃会在 events 表留下「已入账但聚合
* 缺失」的事件。启动时始终
* 重放 sealedUntil 之后的窗口，即上次密封以来的增量，量级约为当日事件数，
* 水位之下的事件一律跳过 —— 重复调用不翻倍，rebuildFromEvents 路径不受影响。
* 不变量与已知限制：密封边界之前维持「events 存在 ⇒ 聚合已收」；若进程恰在
* 同会话 append 与 incrementAgg 两条同步语句之间崩溃、且该会话水位已被后续
* 事件推进，水位补齐无法覆盖该事件，需 rebuild 全量重折修复，窗口极窄，
* 实际可忽略。
*/
function rebuildWithDelta(store, ledger) {
	if (tryLoadAggregates(store, ledger)) {
		const sealedUntil = ledger.getSealedUntil();
		if (sealedUntil > 0) {
			const delta = ledger.allEventsSince(sealedUntil);
			if (delta.length > 0) {
				const missing = [];
				for (const ev of delta) {
					const info = store.sessions.get(ev.sessionId);
					if (!info) {
						missing.push(ev);
						continue;
					}
					if (ev.seq >= 0) {
						if (ev.seq > info.maxSeq) missing.push(ev);
					} else if (ev.t > info.lastActive) missing.push(ev);
				}
				for (const ev of missing) foldLedgerEvent(store, ev, ledger);
			}
			try {
				ledger.sealUntil(Math.max(sealedUntil, startOfDay(Date.now())));
			} catch {}
		}
		return true;
	}
	return false;
}

//#endregion
//#region src/host/settings.ts
/**
* 服务端（Host）的插件偏好设置：把 `usage-stats` 命名空间注册进 harness 的
* 用户设置体系（ctx.settings，由 dsh-settings-file 落到 `$DSH_HOME/settings.yaml`），
* 偏好因此属于部署而不是某一个浏览器。
*
* 注册遵循官方范式（ui-theme 等）：schema 提供每个字段的默认值，设置服务按
* 「schema 默认值 → 组合 base → 用户文档」顺序解析；用户文档只存显式改过的
* 字段（浏览器端 settingsScope 走路径写入），未写过的字段继续跟随默认值。
* 同一个 schema 随 describe 下发浏览器，settingsScope 用它校验收到的取值。
*
* `settings` 服务是可选依赖：不进 UsageStatsService.inject，缺席时（无设置
* 后端的部署）不注册命名空间，浏览器端 settingsScope 报 unavailable，偏好
* 退化为仅当前页面生效。
*/
/**
* 偏好设置 schema：字段默认值与 USAGE_SETTINGS_DEFAULTS 同源（utils.ts），
* 数值字段只约束类型，不在 schema 里设 min——手改 settings.yaml 写出越界间隔
* 时，整段失效回退默认值远不如夹到下限友好，夹取统一由浏览器端归一化负责
* （clampGoFetchMinutes 等，下限 3 分钟）。
*
* modelRedirects 是模型统计重定向规则表：每条规则四个字符串字段各自带空串
* 默认值，手写文档漏字段时按空串解析而不是让整段命名空间判非法；规则内容
* 不在 schema 里设 min/长度约束，条数上限与空白清洗由浏览器端的
* normalizeModelRedirects 负责（与服务端解析值同源，见 utils.ts）。
*/
const UsageSettingsSchema = Schema.object({
	goEnabled: Schema.boolean().default(USAGE_SETTINGS_DEFAULTS.goEnabled),
	showGoInSidebar: Schema.boolean().default(USAGE_SETTINGS_DEFAULTS.showGoInSidebar),
	goFetchMinutes: Schema.number().default(5),
	deepseekEnabled: Schema.boolean().default(USAGE_SETTINGS_DEFAULTS.deepseekEnabled),
	showDeepSeekInSidebar: Schema.boolean().default(USAGE_SETTINGS_DEFAULTS.showDeepSeekInSidebar),
	deepseekFetchMinutes: Schema.number().default(5),
	zaiEnabled: Schema.boolean().default(USAGE_SETTINGS_DEFAULTS.zaiEnabled),
	showZaiInSidebar: Schema.boolean().default(USAGE_SETTINGS_DEFAULTS.showZaiInSidebar),
	zaiFetchMinutes: Schema.number().default(5),
	modelRedirects: Schema.array(Schema.object({
		fromProvider: Schema.string().default(""),
		fromModel: Schema.string().default(""),
		toProvider: Schema.string().default(""),
		toModel: Schema.string().default("")
	})).default([])
});
/**
* 把 `usage-stats` 命名空间注册到设置服务；服务缺席时静默跳过。
* 注册是插件 fiber 上的 effect，插件卸载即注销命名空间。
*
* 注册失败（命名空间被别的插件占用、schema 被服务拒绝）只降级偏好：浏览器端
* settingsScope 随即报 unavailable，设置页如实提示改动不会保存。统计是插件的
* 主职责，不能因为偏好这一附加能力注册失败就整个插件连同账本一起挂掉。
* @param ctx - 服务端插件上下文。
*/
function registerUsageSettings(ctx) {
	ctx.inject(["settings"], (settingsCtx) => {
		try {
			settingsCtx.settings.register(USAGE_SETTINGS_NAMESPACE, UsageSettingsSchema);
		} catch (error) {
			console.warn("[usage-stats] 偏好设置命名空间注册失败，偏好退化为仅当前页面生效", error);
		}
	});
}

//#endregion
//#region src/host/snapshot.ts
/**
* 快照构建：把聚合缓存 UsageStore 与账本会话元数据整理成
* usageStats/snapshot 的结果 value，不触碰传输层与 ctx。
* 快照协议类型 UsageSnapshot、ModelStat、SessionStat、SeriesPoint、
* UsageAgg 单一定义在 types.ts，host 构建与 client 消费共用同一类型面，
* 避免两端镜像漂移；splitModelKey 来自 utils.ts，host 与 client 共用。
*/
/** 把逐日聚合转成按时间升序的序列，用于会话、全量与模型×日。 */
function buildSeries(dailyMap) {
	const out = [];
	for (const [day, agg] of dailyMap) out.push({
		t: day,
		input: agg.input,
		output: agg.output,
		cacheRead: agg.cacheRead,
		cacheWrite: agg.cacheWrite,
		reasoning: agg.reasoning,
		calls: agg.calls
	});
	out.sort((a, b) => a.t - b.t);
	return out;
}
/** 聚合转为对外 usage 形状，直接透传聚合内预计算的 total，调用数已分离。 */
function usageOf(agg) {
	return {
		input: agg.input,
		output: agg.output,
		cacheRead: agg.cacheRead,
		cacheWrite: agg.cacheWrite,
		reasoning: agg.reasoning,
		total: agg.total
	};
}
/** 无用量会话的占位 usage。 */
const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	reasoning: 0,
	total: 0
};
/** 截断已排序序列至共享上限（`SERIES_MAX_DAYS`，与客户端 `all` 范围对齐），避免长历史下每 4s 全量序列化开销。 */
function truncateSeries(series) {
	return series.length > 366 ? series.slice(series.length - 366) : series;
}
/** 构建快照 value：汇总 + 模型拆分 + 会话明细 + 按日序列；sessionId 可选过滤当前会话。会话明细默认 200、上限 1000；all 与 models 序列截断至 366 天，current 序列不截断；sessions 为有量会话数。 */
function snapshot(store, ledger, sessionId, opts) {
	let sessionsWithUsage = 0;
	const sessionsList = [];
	for (const [id, info] of store.sessions) {
		if (info.allAgg.calls > 0) sessionsWithUsage += 1;
		const meta = metaOf(ledger, id);
		sessionsList.push({
			id,
			title: meta.title,
			cwd: meta.cwd,
			createdAt: meta.createdAt,
			lastActive: Math.max(meta.lastActive, info.lastActive),
			parentSession: meta.parentSession || null,
			origin: meta.origin || null,
			delegationDepth: meta.delegationDepth || 0,
			calls: info.allAgg.calls,
			usage: usageOf(info.allAgg)
		});
	}
	sessionsList.sort((a, b) => b.lastActive - a.lastActive);
	const rawLimit = opts?.limit;
	const limit = typeof rawLimit === "number" && Number.isFinite(rawLimit) ? Math.max(1, Math.min(1e3, Math.floor(rawLimit))) : 200;
	const truncatedList = sessionsList.length > limit ? sessionsList.slice(0, limit) : sessionsList;
	const models = [];
	for (const [key, agg] of store.models) {
		const { provider, model } = splitModelKey(key);
		const dailyMap = store.modelDaily.get(key);
		const series = dailyMap ? truncateSeries(buildSeries(dailyMap)) : [];
		models.push({
			provider,
			model,
			calls: agg.calls,
			usage: usageOf(agg),
			series
		});
	}
	models.sort((a, b) => b.usage.total - a.usage.total);
	const allAgg = store.allAgg;
	const allSeries = truncateSeries(buildSeries(store.allDaily));
	let current = null;
	let currentSeries = [];
	if (sessionId) {
		const info = store.sessions.get(sessionId);
		if (info) {
			current = {
				id: sessionId,
				calls: info.allAgg.calls,
				usage: usageOf(info.allAgg)
			};
			currentSeries = buildSeries(info.daily);
		} else {
			current = {
				id: sessionId,
				calls: 0,
				usage: { ...zeroUsage }
			};
			currentSeries = [];
		}
	}
	return {
		scanning: store.scanning,
		scans: store.scans,
		failed: store.failed,
		rawSessions: store.rawSessions,
		harnessSessions: store.harnessSessions,
		foldedEvents: store.foldedEvents,
		dedupSkipped: store.dedupSkipped,
		lastError: store.lastError,
		scanError: store.scanError,
		lastScanAt: store.lastScanAt,
		time: Date.now(),
		sessions: sessionsWithUsage,
		current,
		all: {
			calls: allAgg.calls,
			usage: usageOf(allAgg)
		},
		series: {
			all: allSeries,
			current: currentSeries
		},
		models,
		sessionsList: truncatedList
	};
}

//#endregion
//#region src/host/zaiQuota.ts
/**
* Z.ai 智谱额度查询：滚动 5 小时、每周 7 天百分比与每月 Web 搜索次数，端点为 GET https://api.z.ai/api/monitor/usage/quota/limit。
*
* 机制要点：
*   - 官方固定域名端点，Bearer key 与浏览器 UA 与 GoQuota、DeepSeek 同款以防前置拦截。
*   - key 解析：仅走 DSH 凭据中心 `ZAI_CODING_CN_API_KEY` 到 `ZAI_API_KEY`，经 `ctx.credentials`
*     由 `~/.dsh/.credentials.yaml` 等统一托管，不直接读 `process.env`，亦不使用 `GLM_API_KEY`。
*   - 结果带 TTL 缓存 5 分钟与单飞机制，并发请求仅打一次官方端点。
*   - 语义：无 key / 401/403 判为 no-key；合法 key 但无 GLM Coding Plan，success 为 false 且
*     msg 含 "coding plan" 时判为 no-plan；非 2xx、超时或结构非法判为 error；成功判为 ok。
*   - quota 端点响应：{ code:200, success:true, data:{ level?, limits:[{type, unit, number,
*     percentage?, nextResetTime?, usage?, currentValue?}] } }；CREDIT_LIMIT /
*     TOKENS_LIMIT 为百分比窗口，按 unit 归类为 session 与 weekly，TIME_LIMIT 为月度 Web 搜索计数。
*
* ZaiQuota / ZaiWindow / ZaiWebSearchQuota 协议类型定义在 types.ts，与客户端 useZaiQuota 统一。
* 纯数据模块：请求失败 / 未配置 key 都返回带 status 的结构化结果，由
* 客户端按 status 本地化文案，不在服务端拼用户文案。
* 本功能不写入 ledger，仅只读查询与内存缓存。
*/
/** Z.ai 官方额度端点，固定域名，参考 openusage ZAIUsageClient.quotaURL。 */
const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
/** 解析 Z.ai API Key：仅走 DSH 凭据中心，经 ZAI_CODING_CN_API_KEY 到 ZAI_API_KEY。 */
async function resolveZaiKeyWithCredentials(credentials) {
	return resolveFirstKey(credentials, ["ZAI_CODING_CN_API_KEY", "ZAI_API_KEY"]);
}
/** 把 number/数字字符串归一为非负有限数，其余返回 null。 */
function parseNonNegNumber(raw) {
	if (typeof raw === "number" && Number.isFinite(raw)) return raw >= 0 ? raw : null;
	if (typeof raw === "string") {
		const n = Number(raw);
		if (Number.isFinite(n) && n >= 0) return n;
	}
	return null;
}
/** 归一化单个百分比额度窗口，非法返回 null。 */
function normalizeZaiWindow(raw) {
	if (raw === null || typeof raw !== "object") return null;
	const rec = raw;
	const percent = parseNonNegNumber(rec.percentage);
	if (percent === null) return null;
	let resetsAt = "";
	const rt = rec.nextResetTime;
	if (typeof rt === "number" && Number.isFinite(rt) && rt > 0) resetsAt = new Date(rt).toISOString();
	else if (typeof rt === "string" && rt.trim().length > 0) {
		const n = Number(rt);
		if (Number.isFinite(n) && n > 0) resetsAt = new Date(n).toISOString();
		else resetsAt = rt;
	} else if (typeof rec.resetsAt === "string" && rec.resetsAt.length > 0) resetsAt = rec.resetsAt;
	const used = parseNonNegNumber(rec.currentValue ?? rec.used);
	const limit = parseNonNegNumber(rec.usage ?? rec.limit);
	return {
		percent,
		resetsAt,
		used,
		limit
	};
}
/** 归一化 Web 搜索次数额度，非法返回 null。 */
function normalizeZaiWebSearch(raw) {
	if (raw === null || typeof raw !== "object") return null;
	const rec = raw;
	const used = parseNonNegNumber(rec.currentValue ?? rec.used);
	const limit = parseNonNegNumber(rec.usage ?? rec.limit);
	if (used === null || limit === null) return null;
	const percent = limit > 0 ? used / limit * 100 : 0;
	let resetsAt = "";
	const rt = rec.nextResetTime;
	if (typeof rt === "number" && Number.isFinite(rt) && rt > 0) resetsAt = new Date(rt).toISOString();
	else if (typeof rt === "string" && rt.trim().length > 0) {
		const n = Number(rt);
		if (Number.isFinite(n) && n > 0) resetsAt = new Date(n).toISOString();
		else resetsAt = rt;
	}
	return {
		used,
		limit,
		percent,
		resetsAt
	};
}
/** 按 unit 归类百分比窗口：子日为 session，多日为 weekly，与 ZAIUsageMapper.classifyTokenWindow 一致。 */
function classifyTokenWindow(entry) {
	const unitRaw = entry.unit;
	const numberRaw = entry.number;
	const unit = typeof unitRaw === "number" && Number.isFinite(unitRaw) ? unitRaw : null;
	const number = typeof numberRaw === "number" && Number.isFinite(numberRaw) ? numberRaw : null;
	if (unit === null || number === null || number <= 0) return null;
	let unitMs = null;
	switch (unit) {
		case 3:
			unitMs = 36e5;
			break;
		case 4:
			unitMs = 864e5;
			break;
		case 6:
			unitMs = 6048e5;
			break;
		case 5:
			unitMs = 2592e6;
			break;
		default: return null;
	}
	if (unitMs * number < 864e5) return "session";
	return "weekly";
}
/** 从 limits 数组中解析出各窗口。 */
function parseLimits(limits) {
	let session = null;
	let weekly = null;
	let webSearches = null;
	let sawRecognized = false;
	const percentEntries = [];
	let timeEntry = null;
	for (const raw of limits) {
		if (raw === null || typeof raw !== "object") continue;
		const rec = raw;
		let type = "";
		if (typeof rec.type === "string") type = rec.type;
		else if (typeof rec.name === "string") type = rec.name;
		const effective = (typeof rec.rawType === "string" ? rec.rawType : null) ?? type;
		if (effective === "CREDIT_LIMIT" || effective === "TOKENS_LIMIT") percentEntries.push(rec);
		else if (type === "TIME_LIMIT" || effective === "TIME_LIMIT") {
			if (timeEntry === null) timeEntry = rec;
		} else if (type === "CREDIT_LIMIT" || type === "TOKENS_LIMIT") percentEntries.push(rec);
	}
	for (const entry of percentEntries) {
		const win = classifyTokenWindow(entry);
		if (win === null) continue;
		sawRecognized = true;
		const norm = normalizeZaiWindow(entry);
		if (norm === null) continue;
		if (win === "session" && session === null) session = norm;
		else if (win === "weekly" && weekly === null) weekly = norm;
	}
	if (timeEntry !== null) {
		const norm = normalizeZaiWebSearch(timeEntry);
		if (norm !== null) {
			sawRecognized = true;
			webSearches = norm;
		} else sawRecognized = true;
	}
	return {
		session,
		weekly,
		webSearches,
		sawRecognized
	};
}
/** 实时查询 Z.ai 额度，无缓存。 */
async function fetchZaiQuota(credentials) {
	const key = await resolveZaiKeyWithCredentials(credentials);
	if (key === null) return {
		status: "no-key",
		fetchedAt: Date.now(),
		plan: null,
		session: null,
		weekly: null,
		webSearches: null
	};
	try {
		const response = await fetch(ZAI_QUOTA_URL, {
			method: "GET",
			headers: {
				authorization: `Bearer ${key}`,
				accept: "application/json",
				"user-agent": QUOTA_UA
			},
			signal: AbortSignal.timeout(15e3)
		});
		if (response.status === 401 || response.status === 403) return {
			status: "no-key",
			fetchedAt: Date.now(),
			plan: null,
			session: null,
			weekly: null,
			webSearches: null
		};
		if (!response.ok) return {
			status: "error",
			fetchedAt: Date.now(),
			plan: null,
			session: null,
			weekly: null,
			webSearches: null
		};
		const body = await response.json();
		const success = body.success;
		let msg = "";
		if (typeof body.msg === "string") msg = body.msg;
		else if (typeof body.message === "string") msg = body.message;
		if (success === false && msg.toLowerCase().includes("coding plan")) return {
			status: "no-plan",
			fetchedAt: Date.now(),
			plan: null,
			session: null,
			weekly: null,
			webSearches: null
		};
		const code = body.code;
		if (code !== void 0 && Number(code) !== 200 && success !== true) return {
			status: "error",
			fetchedAt: Date.now(),
			plan: null,
			session: null,
			weekly: null,
			webSearches: null
		};
		const dataRaw = body.data;
		let dataObj = null;
		if (dataRaw !== null && typeof dataRaw === "object" && !Array.isArray(dataRaw)) dataObj = dataRaw;
		else if (Array.isArray(dataRaw)) return {
			status: "error",
			fetchedAt: Date.now(),
			plan: null,
			session: null,
			weekly: null,
			webSearches: null
		};
		const container = dataObj ?? body;
		const limitsRaw = container.limits;
		if (limitsRaw === void 0 || limitsRaw === null) return {
			status: "error",
			fetchedAt: Date.now(),
			plan: null,
			session: null,
			weekly: null,
			webSearches: null
		};
		if (!Array.isArray(limitsRaw)) return {
			status: "error",
			fetchedAt: Date.now(),
			plan: null,
			session: null,
			weekly: null,
			webSearches: null
		};
		if (limitsRaw.length === 0) {
			let plan = null;
			const level = typeof container.level === "string" ? container.level.trim() : "";
			if (level.length > 0) plan = "Z.ai " + level;
			return {
				status: "ok",
				fetchedAt: Date.now(),
				plan,
				session: null,
				weekly: null,
				webSearches: null
			};
		}
		let plan = null;
		const levelRaw = container.level;
		if (typeof levelRaw === "string" && levelRaw.trim().length > 0) plan = "Z.ai " + levelRaw.trim();
		const parsed = parseLimits(limitsRaw);
		if (!(parsed.session !== null || parsed.weekly !== null || parsed.webSearches !== null) && parsed.sawRecognized) return {
			status: "error",
			fetchedAt: Date.now(),
			plan: null,
			session: null,
			weekly: null,
			webSearches: null
		};
		return {
			status: "ok",
			fetchedAt: Date.now(),
			plan,
			session: parsed.session,
			weekly: parsed.weekly,
			webSearches: parsed.webSearches
		};
	} catch {
		return {
			status: "error",
			fetchedAt: Date.now(),
			plan: null,
			session: null,
			weekly: null,
			webSearches: null
		};
	}
}
/**
* 带 TTL 缓存与单飞的额度查询，路由每次调用都走这里。
*
* @param intervalMinutes 客户端抓取间隔，单位分钟；有效 TTL 见共享公式，
*   未提供时用默认 5 分钟。
* @param force 为 true 时绕过 TTL 缓存强制重新抓取，概览 Z.ai 磁贴的立即刷新按钮用，仍走单飞，避免并发打官方端点。
*/
const queryZaiQuota = createQuotaQuery((credentials) => fetchZaiQuota(credentials));

//#endregion
//#region src/host/service.ts
/**
* 用量统计的服务端 Host 服务：账本模式装配，自管理 sqlite 介质，对外暴露
* usageStats 命名空间的 7 个一元 Remote 方法。
*
* 数据流（账本为唯一事实来源、聚合为派生缓存）与原 apply 函数版一致：
* 注册偏好设置命名空间 → openLedger → 先挂 session/event 实时监听 →
* bootstrap（预统计快加载、事件重放、首启全量扫描三档回退）。信任与认证由
* 网关载体统一处理，本服务只做业务：快照、重建、清零、密封、三路额度。
*
* 方法签名遵守严格 Remote 约定：公开非静态实例方法、非泛型、
* 参数为具名必填简单标识符（无 lookup、无 signal），请求与结果均为
* Client-safe 纯 JSON 类型（见 src/types.ts）。
*/
var __runInitializers = void 0 && (void 0).__runInitializers || function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = void 0 && (void 0).__esDecorate || function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) {
			if (kind === "field") initializers.unshift(_);
			else descriptor[key] = _;
		}
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/**
* 取可选的凭据中心：不进 inject，直接 ctx.get 判空（官方可选服务写法）。
* @param ctx - 服务所在上下文。
* @returns 可用的凭据服务，缺席时为 undefined。
*/
function credentialsOf(ctx) {
	const credentials = ctx.get("credentials");
	return typeof credentials?.resolve === "function" ? credentials : void 0;
}
/** 打开/创建账本：版本不兼容或损坏时自动清库重建，保存与连接由 Ledger 负责。 */
function openLedger() {
	const ledger = new Ledger();
	ledger.open();
	return ledger;
}
let UsageStatsService = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _snapshot_decorators;
	let _rebuild_decorators;
	let _clear_decorators;
	let _seal_decorators;
	let _goQuota_decorators;
	let _deepseekBalance_decorators;
	let _zaiQuota_decorators;
	return class UsageStatsService extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_snapshot_decorators = [Remote("snapshot")];
			_rebuild_decorators = [Remote("rebuild")];
			_clear_decorators = [Remote("clear")];
			_seal_decorators = [Remote("seal")];
			_goQuota_decorators = [Remote("goQuota")];
			_deepseekBalance_decorators = [Remote("deepseekBalance")];
			_zaiQuota_decorators = [Remote("zaiQuota")];
			__esDecorate(this, null, _snapshot_decorators, {
				kind: "method",
				name: "snapshot",
				static: false,
				private: false,
				access: {
					has: (obj) => "snapshot" in obj,
					get: (obj) => obj.snapshot
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _rebuild_decorators, {
				kind: "method",
				name: "rebuild",
				static: false,
				private: false,
				access: {
					has: (obj) => "rebuild" in obj,
					get: (obj) => obj.rebuild
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _clear_decorators, {
				kind: "method",
				name: "clear",
				static: false,
				private: false,
				access: {
					has: (obj) => "clear" in obj,
					get: (obj) => obj.clear
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _seal_decorators, {
				kind: "method",
				name: "seal",
				static: false,
				private: false,
				access: {
					has: (obj) => "seal" in obj,
					get: (obj) => obj.seal
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _goQuota_decorators, {
				kind: "method",
				name: "goQuota",
				static: false,
				private: false,
				access: {
					has: (obj) => "goQuota" in obj,
					get: (obj) => obj.goQuota
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _deepseekBalance_decorators, {
				kind: "method",
				name: "deepseekBalance",
				static: false,
				private: false,
				access: {
					has: (obj) => "deepseekBalance" in obj,
					get: (obj) => obj.deepseekBalance
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _zaiQuota_decorators, {
				kind: "method",
				name: "zaiQuota",
				static: false,
				private: false,
				access: {
					has: (obj) => "zaiQuota" in obj,
					get: (obj) => obj.zaiQuota
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		/**
		* 挂载前必需的服务（数组即全必需）。credentials 为可选：
		* 不进 inject，调用处经 ctx.get 判空，缺席时额度查询直接返回 no-key，
		* 仅走 DSH 凭据中心，不读 env 与文件。
		*/
		static inject = ["sessionQuery", "sessionPersistence"];
		store = (__runInitializers(this, _instanceExtraInitializers), createStore());
		ledger = openLedger();
		constructor(ctx) {
			super(ctx, "usageStats", { namespace: "usageStats" });
		}
		[Service.init]() {
			const ctx = this.ctx;
			const store = this.store;
			const ledger = this.ledger;
			registerUsageSettings(ctx);
			ctx.effect(() => () => ledger.close(), "dsh-usage-stats: 关闭账本数据库连接");
			ctx.on("session/event", (session, event) => {
				const id = session && typeof session.id === "string" ? session.id : void 0;
				if (!id) return;
				try {
					const hdr = session.header;
					if (hdr) {
						const patch = {};
						if (typeof hdr.parentSession === "string") patch.parentSession = hdr.parentSession;
						if (hdr.origin === "subagent") patch.origin = hdr.origin;
						if (typeof hdr.delegationDepth === "number" && Number.isFinite(hdr.delegationDepth)) patch.delegationDepth = hdr.delegationDepth;
						if (typeof hdr.cwd === "string") patch.cwd = hdr.cwd;
						if (typeof hdr.createdAt === "number" && Number.isFinite(hdr.createdAt)) patch.createdAt = hdr.createdAt;
						if (Object.keys(patch).length > 0) try {
							ledger.setMeta(id, patch);
						} catch (e) {
							console.warn("[usage-stats] 会话元数据补齐失败，跳过", id, e);
						}
					}
					if (typeof event.seq === "number" && event.seq < inheritedCountOf(session.inheritedEventCount)) return;
					foldRecord(store, ledger, id, event);
				} catch (e) {
					console.error("[usage-stats] 实时事件入账失败", e);
				}
			});
			const bootstrap = async () => {
				if (ledger.hasAggregates()) {
					if (rebuildWithDelta(store, ledger)) {
						store.scans += 1;
						store.lastScanAt = Date.now();
						return;
					}
				}
				if (ledger.hasEvents()) {
					rebuildFromEvents(store, ledger);
					store.scans += 1;
					store.lastScanAt = Date.now();
					return;
				}
				if (ledger.getClearedAt() !== null) {
					console.info("[usage-stats] 清零墓碑生效，跳过首启全量扫描（重建可重新统计历史）");
					return;
				}
				await scanOnce(ctx, store, ledger, { initial: true });
			};
			bootstrap().catch((e) => console.error("[usage-stats] 初始化失败", e));
		}
		/**
		* usageStats/snapshot：聚合快照，带会话过滤返回对应会话的 current。
		* @param request - 会话过滤与明细分页上限。
		* @returns 快照 value（传输信封由网关负责）。
		*/
		snapshot(request) {
			const raw = request.sessionId;
			const sessionId = typeof raw === "string" && raw.length > 0 ? raw : null;
			const limit = typeof request.limit === "number" && Number.isFinite(request.limit) ? request.limit : void 0;
			return snapshot(this.store, this.ledger, sessionId, limit !== void 0 ? { limit } : void 0);
		}
		/**
		* usageStats/rebuild：清空账本（顺带清掉清零墓碑）→ 复位聚合缓存 → 全量重扫日志导入。
		* @returns 重建确认与折叠事件数；进行中返回 usageStats/busy。
		*/
		async rebuild() {
			const store = this.store;
			if (store.running) throw new RemoteError("usageStats/busy", "rebuild already in progress", { operation: "rebuild" });
			store.running = true;
			try {
				this.ledger.clear();
				resetStore(store);
				await scanOnce(this.ctx, store, this.ledger, {
					initial: true,
					force: true
				});
			} finally {
				store.running = false;
				store.scanning = false;
			}
			return {
				rebuilt: true,
				foldedEvents: store.foldedEvents
			};
		}
		/**
		* usageStats/clear：清空账本 → 复位聚合缓存 → 落清零墓碑，不重扫，统计直接归零；
		* 重启后 bootstrap 据墓碑跳过首启全量扫描，历史统计不复活（rebuild 是恢复出口）。
		* @returns 清零确认与折叠事件数；进行中返回 usageStats/busy。
		*/
		async clear() {
			const store = this.store;
			if (store.running) throw new RemoteError("usageStats/busy", "clear already in progress", { operation: "clear" });
			store.running = true;
			try {
				this.ledger.clear();
				resetStore(store);
				this.ledger.markCleared();
			} finally {
				store.running = false;
			}
			return {
				cleared: true,
				foldedEvents: store.foldedEvents
			};
		}
		/**
		* usageStats/seal：手动物化当前聚合至预统计，密封不会再变动的历史数据。
		* @returns 密封确认、密封边界与折叠事件数；进行中返回 usageStats/busy。
		*/
		seal() {
			const store = this.store;
			if (store.running) throw new RemoteError("usageStats/busy", "seal already in progress", { operation: "seal" });
			sealAggregates(store, this.ledger);
			return {
				sealed: true,
				sealedUntil: this.ledger.getSealedUntil(),
				foldedEvents: store.foldedEvents
			};
		}
		/**
		* usageStats/goQuota：OpenCode Go 订阅额度，TTL 缓存 + 单飞。
		* @param request - 客户端抓取间隔与强制刷新。
		* @returns 额度 value（无 key 时为 no-key，不抛错）。
		*/
		async goQuota(request) {
			const intervalMinutes = typeof request.intervalMinutes === "number" && Number.isFinite(request.intervalMinutes) ? request.intervalMinutes : void 0;
			const force = request.force === true;
			return queryGoQuota(intervalMinutes, force, credentialsOf(this.ctx));
		}
		/**
		* usageStats/deepseekBalance：DeepSeek 余额，TTL 缓存 + 单飞。
		* @param request - 客户端抓取间隔与强制刷新。
		* @returns 余额 value（无 key 时为 no-key，不抛错）。
		*/
		async deepseekBalance(request) {
			const intervalMinutes = typeof request.intervalMinutes === "number" && Number.isFinite(request.intervalMinutes) ? request.intervalMinutes : void 0;
			const force = request.force === true;
			return queryDeepSeekBalance(intervalMinutes, force, credentialsOf(this.ctx));
		}
		/**
		* usageStats/zaiQuota：Z.ai 智谱额度，TTL 缓存 + 单飞。
		* @param request - 客户端抓取间隔与强制刷新。
		* @returns 额度 value（无 key 时为 no-key，不抛错）。
		*/
		async zaiQuota(request) {
			const intervalMinutes = typeof request.intervalMinutes === "number" && Number.isFinite(request.intervalMinutes) ? request.intervalMinutes : void 0;
			const force = request.force === true;
			return queryZaiQuota(intervalMinutes, force, credentialsOf(this.ctx));
		}
	};
})();

//#endregion
export { UsageStatsService, UsageStatsService as default };