/**
 * 额度轮询共享 hook 工厂（浏览器端）。
 *
 * Go/DeepSeek/Z.ai 同一写法，调用方只配端点、夹取与 error 占位：
 *   - enabled 为 false 时清空已拉数据、不发起任何请求；
 *   - 轮询体与手动强制刷新共享递增序号，旧响应丢弃；
 *   - 失败时首屏置 error 占位保组件可见，已有数据则保留等下次轮询；
 *   - 手动刷新带 force 绕过服务端 TTL，不重置轮询定时器。
 * 传入的 endpoint/clampMinutes/makeError 须为模块级稳定引用，
 * 否则 effect 会反复重建导致刷爆接口。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { API_HEADERS } from './api.ts';

/** 额度轮询：返回 [数据, 手动刷新]，未启用/失败未加载时为 null。 */
export function useQuota<T>(options: {
  enabled: boolean
  intervalMinutes: number
  endpoint: string
  clampMinutes: (v: number) => number
  makeError: () => T
}): [T | null, () => void] {
  const { enabled, intervalMinutes, endpoint, clampMinutes, makeError } = options;
  const [data, setData] = useState<T | null>(null);
  // 乱序守卫：轮询与手动强制刷新共享同一递增序号，最后发起者胜出。
  const seqRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      // 未启用额度抓取：清空已拉数据、不发起任何请求。
      setData(null);
      return;
    }
    // 防御性夹取：偏好已夹到下限，这里再兜底一次防止误用。
    const minutes = clampMinutes(intervalMinutes);
    let live = true;
    const load = async (force: boolean) => {
      const mine = ++seqRef.current;
      let parsed: { ok?: boolean; value?: T } = {};
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: API_HEADERS,
          body: JSON.stringify(force ? { intervalMinutes: minutes, force: true } : { intervalMinutes: minutes }),
        });
        parsed = await response.json().catch(() => ({})) as { ok?: boolean; value?: T };
      } catch {
        parsed = {};
      }
      if (!live || mine !== seqRef.current) return;
      if (parsed.ok === true && parsed.value) {
        setData(parsed.value);
      } else {
        setData((prev) => prev ?? makeError());
      }
    };
    void load(false);
    const timerId = window.setInterval(() => { void load(false); }, minutes * 60 * 1000);
    return () => { live = false; window.clearInterval(timerId); };
    // intervalMinutes 参与夹取，effect 依赖用原始值以感知变化。
  }, [enabled, intervalMinutes, endpoint, clampMinutes, makeError]);

  /** 手动触发一次立即刷新，未启用时忽略，直接带 force 抓取。 */
  const refresh = useCallback(() => {
    if (!enabled) return;
    const minutes = clampMinutes(intervalMinutes);
    const mine = ++seqRef.current;
    void (async () => {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: API_HEADERS,
          body: JSON.stringify({ intervalMinutes: minutes, force: true }),
        });
        const parsed = await response.json().catch(() => ({})) as { ok?: boolean; value?: T };
        if (mine !== seqRef.current) return;
        if (parsed.ok === true && parsed.value) {
          setData(parsed.value);
        } else {
          setData((prev) => prev ?? makeError());
        }
      } catch {
        setData((prev) => prev ?? makeError());
      }
    })();
  }, [enabled, intervalMinutes, endpoint, clampMinutes, makeError]);

  return [data, refresh];
}
