/**
 * 用量统计浏览器端（Client）的快照轮询。
 *
 * 服务端（Host）提供 POST /usage-stats/api/snapshot（回环围栏 + CSRF 围栏：
 * 所有 /usage-stats/api/* POST 必须携带 x-dsh-usage-stats 请求头，否则 403）。
 * 本 hook 维持一个 4s 轮询，底部角标与模态窗共用同一份数据。
 * UsageAgg / SeriesPoint 协议类型定义在 types.ts（与 host 端 Agg /
 * SeriesPoint 统一，避免两端镜像漂移）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { API_HEADERS } from './api.ts';

import type { UsageSnapshot } from '../types.ts';

/** 快照协议类型单一定义在 types.ts（host snapshot() 构建共用），此处 re-export 保持对外引用面。 */
export type { UsageAgg, SeriesPoint, ModelStat, SessionStat, UsageSnapshot } from '../types.ts';

/** 每 `intervalMs` 轮询一次服务端快照；返回 [快照, 是否出错, 手动刷新]。 */
export function useSnapshot(intervalMs = 4000): [UsageSnapshot | null, boolean, () => void] {
  const [data, setData] = useState<UsageSnapshot | null>(null);
  const [err, setErr] = useState(false);
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
      try {
        const response = await fetch('/usage-stats/api/snapshot', {
          method: 'POST',
          headers: API_HEADERS,
          body: JSON.stringify({ sessionId: null, limit: 500 }),
        });
        parsed = await response.json().catch(() => ({})) as { ok?: boolean; value?: UsageSnapshot };
      } catch {
        parsed = {};
      }
      if (!live || mine !== seqRef.current) return;
      if (parsed.ok === true && parsed.value) {
        setData(parsed.value);
        setErr(false);
      } else {
        setErr(true);
        // 保留旧数据，仅标记错误，避免 4s 轮询抖动导致界面闪烁
      }
    };
    void load();
    const timerId = window.setInterval(() => { void load(); }, intervalMs);
    return () => { live = false; window.clearInterval(timerId); };
  }, [intervalMs, tick]);

  /** 手动触发一次立即刷新（设置页"手动刷新"按钮用）。 */
  const refresh = useCallback(() => setTick(v => v + 1), []);

  return [data, err, refresh];
}
