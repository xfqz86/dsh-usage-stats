/**
 * 会话明细的浏览器端取数：会话页点主会话行的「明细」链接时，按该行的折叠会话集合
 * （主会话 + 展平的全部子代理）查一次 usageStats/sessionDetail；没有打开的行时不发请求。
 *
 * 集合在点击那一刻由 `sessionGroupIds` 取一次并随弹窗冻结，打开期间不随快照轮询重算
 * （服务端明细是「打开时刻」的按需查询，重开或重试才对齐当前数据）。明细连同入参签名
 * 一起存：签名对不上即视为「没有数据」，换行时不会把上一行的数字短暂显示在新行下。
 * 响应按递增序号丢弃后发先至的旧请求（STYLE §9）；失败清空本次明细并留下错误信息，
 * 由界面给出重试，不把上一行的明细留成假数据。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { errorMessage } from '../utils.ts';

import { usageStatsRemote } from './remote.ts';

import type { SessionDetail, SessionDetailRequest } from '../types.ts';

/** 会话明细取数结果：明细、加载中、失败信息与手动重试。 */
export interface SessionDetailState {
  detail: SessionDetail | null
  loading: boolean
  error: string | null
  reload: () => void
}

/**
 * 取一条会话明细。
 * @param ids - 弹窗打开行的折叠会话 id 集合；null 或空数组表示没有打开的行，不发请求。
 * @returns 明细与加载/错误状态、重试函数。
 */
export function useSessionDetail(ids: readonly string[] | null): SessionDetailState {
  const [loaded, setLoaded] = useState<{ key: string | null; detail: SessionDetail | null }>({ key: null, detail: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // 乱序守卫：每次发起请求取递增序号，响应回来时若已有更新的请求发出即丢弃。
  const seqRef = useRef(0);
  // 集合签名取排序后的 id 列表：服务端对集合顺序不敏感（docs/API.md §2.3），
  // 内容不变就不重取；明细连同它的入参签名一起存，签名对不上即视为「没有数据」。
  const signature = ids === null || ids.length === 0 ? null : [...ids].sort().join('|');
  const detail = loaded.key === signature ? loaded.detail : null;

  useEffect(() => {
    if (signature === null) {
      setLoaded({ key: null, detail: null });
      setError(null);
      setLoading(false);
      return;
    }
    const mine = ++seqRef.current;
    let live = true;
    setLoading(true);
    setError(null);
    const load = async (): Promise<void> => {
      try {
        const remote = usageStatsRemote();
        const request: SessionDetailRequest = { sessionIds: signature.split('|') };
        const result = await remote.sessionDetail(request);
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        if (!live || mine !== seqRef.current) return;
        setLoaded({ key: signature, detail: result.value });
        setError(null);
      } catch (e) {
        if (!live || mine !== seqRef.current) return;
        setLoaded({ key: signature, detail: null });
        setError(errorMessage(e));
      } finally {
        if (live && mine === seqRef.current) setLoading(false);
      }
    };
    void load();
    return () => { live = false; };
  }, [signature, tick]);

  /** 重试：序号自增触发同一份入参重取。 */
  const reload = useCallback(() => setTick((v) => v + 1), []);

  return { detail, loading, error, reload };
}
