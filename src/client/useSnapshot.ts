/**
 * 用量统计浏览器端（Client）的快照轮询。
 *
 * 服务端（Host）提供 usageStats/snapshot（网关统一信任与认证）。
 * 本 hook 按传入间隔轮询（默认 SNAPSHOT_INTERVAL_MS），底部角标与模态窗共用同一份数据。
 * UsageAgg / SeriesPoint 协议类型定义在 types.ts，host 构建与 client 消费共用，
 * host 内折叠用的 Agg 结构见 src/host/agg.ts。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { SNAPSHOT_INTERVAL_MS, SNAPSHOT_LIMIT } from './api.ts';
import { usageStatsRemote } from './remote.ts';

import type { UsageSnapshot } from '../types.ts';

/** 快照协议类型单一定义在 types.ts（host snapshot() 构建共用），此处 re-export 保持对外引用面。 */
export type { UsageAgg, SeriesPoint, ModelStat, SessionStat, UsageSnapshot } from '../types.ts';

/** 每 `intervalMs` 轮询一次服务端快照；返回 [快照, 是否出错, 手动刷新, 出错明细]。 */
export function useSnapshot(intervalMs = SNAPSHOT_INTERVAL_MS): [UsageSnapshot | null, boolean, () => void, string | null] {
  const [data, setData] = useState<UsageSnapshot | null>(null);
  const [err, setErr] = useState(false);
  // TODO(诊断后删除)：临时把调用失败的真实原因暴露给界面，定位生产环境问题用。
  const [errDetail, setErrDetail] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // 乱序守卫：每次发起请求取递增序号，响应返回时若已有更新的请求发出
  // （自身序号不再是最新），丢弃本次结果，防止旧响应覆盖新数据。
  const seqRef = useRef(0);

  useEffect(() => {
    let live = true;
    setErr(false);
    const load = async () => {
      const mine = ++seqRef.current;
      let parsed: { ok?: boolean; value?: UsageSnapshot } = {};
      // TODO(诊断后删除)：记录真实失败原因（抛错取 message，业务拒绝取 code+message）。
      let detail: string | null = null;
      try {
        const result = await usageStatsRemote().snapshot({ sessionId: null, limit: SNAPSHOT_LIMIT });
        if (result.ok) {
          parsed = { ok: true, value: result.value };
        } else {
          parsed = { ok: false };
          detail = `${result.error.code}: ${result.error.message}`;
        }
      } catch (e) {
        parsed = {};
        detail = e instanceof Error ? e.message : String(e);
      }
      if (!live || mine !== seqRef.current) return;
      if (parsed.ok === true && parsed.value) {
        setData(parsed.value);
        setErr(false);
        setErrDetail(null);
      } else {
        setErr(true);
        setErrDetail(detail);
        // 保留旧数据，仅标记错误，避免轮询抖动导致界面闪烁
      }
    };
    void load();
    const timerId = window.setInterval(() => { void load(); }, intervalMs);
    return () => { live = false; window.clearInterval(timerId); };
  }, [intervalMs, tick]);

  /** 手动触发一次立即刷新（设置页"手动刷新"按钮用）。 */
  const refresh = useCallback(() => setTick(v => v + 1), []);

  return [data, err, refresh, errDetail];
}
