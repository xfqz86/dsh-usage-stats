/**
 * /usage-stats/api/* 的浏览器端调用约定：全部 POST 必须携带的请求头。
 *
 * 服务端在回环围栏之后校验自定义头 x-dsh-usage-stats（缺失或不匹配返回
 * 403 forbidden，见 src/host/http.ts 的 USAGE_STATS_HEADER_NAME/VALUE）；
 * 浏览器跨站请求无法在不触发 CORS preflight 的前提下携带自定义头，
 * 以此阻断针对本地 API 的跨站 CSRF。本模块为客户端侧该约定的单一来源。
 */

/** 所有 /usage-stats/api/* POST 统一携带的完整请求头（含 JSON content-type）。 */
export const API_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  'x-dsh-usage-stats': 'dsh-usage-stats',
};

/** 快照轮询间隔：底部角标与模态窗共用同一份数据。 */
export const SNAPSHOT_INTERVAL_MS = 4000;
/** 快照会话明细请求上限：服务端截断至 1000，此值兼顾完整与序列化开销。 */
export const SNAPSHOT_LIMIT = 500;
