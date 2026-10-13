/**
 * 单日明细的浏览器端取数：日期页点某行的「明细」链接时，按该行的本地日零点查一次
 * usageStats/dateDetail；没有打开的日期时不发请求。
 *
 * 明细连同它的入参日一起存（key 取 String(day)），换一行或换范围时不会把上一天的
 * 数字错配到新日期下；响应按递增序号丢弃后发先至的旧请求（STYLE §9）。
 * 失败清空本次明细并留下错误信息，由界面给出重试，不把上一天的明细留成假数据。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { errorMessage } from '../utils.ts';

import { usageStatsRemote } from './remote.ts';

import type { DateDetail, DateDetailRequest } from '../types.ts';

/** 单日明细取数结果：明细、加载中、失败信息与手动重试。 */
export interface DateDetailState {
  detail: DateDetail | null
  loading: boolean
  error: string | null
  reload: () => void
}

/**
 * 取某一天的明细。
 * @param day - 弹窗当前打开日期的本地日零点（与日期表行的 t 同值）；null 表示没有打开的行，不发请求。
 * @returns 明细与加载/错误状态、重试函数。
 */
export function useDateDetail(day: number | null): DateDetailState {
  const [loaded, setLoaded] = useState<{ key: string | null; detail: DateDetail | null }>({ key: null, detail: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // 乱序守卫：每次发起请求取递增序号，响应回来时若已有更新的请求发出即丢弃。
  const seqRef = useRef(0);
  const loadKey = day === null ? null : String(day);
  const detail = loaded.key === loadKey ? loaded.detail : null;

  useEffect(() => {
    if (day === null || loadKey === null) {
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
        const request: DateDetailRequest = { day };
        const result = await remote.dateDetail(request);
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        if (!live || mine !== seqRef.current) return;
        setLoaded({ key: loadKey, detail: result.value });
        setError(null);
      } catch (e) {
        if (!live || mine !== seqRef.current) return;
        setLoaded({ key: loadKey, detail: null });
        setError(errorMessage(e));
      } finally {
        if (live && mine === seqRef.current) setLoading(false);
      }
    };
    void load();
    return () => { live = false; };
  }, [day, loadKey, tick]);

  /** 重试：序号自增触发同一份入参重取。 */
  const reload = useCallback(() => setTick((v) => v + 1), []);

  return { detail, loading, error, reload };
}
