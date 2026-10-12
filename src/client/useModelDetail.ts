/**
 * 模型明细的浏览器端取数：点某行的「明细」链接时按「目标 + 归并来源」各查一次
 * usageStats/modelDetail，用 mergeModelDetails 合成一行；没有打开的行时不发请求。
 *
 * 依赖三处变化即重取——keys 签名、时间下界 since、手动 reload，并按递增序号
 * 丢弃后发先至的旧响应（STYLE §9）。失败清空本次明细并留下错误信息，
 * 由界面给出重试，不把上一行的数据错配到当前行。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { errorMessage, splitModelKey } from '../utils.ts';

import { usageStatsRemote } from './remote.ts';
import { mergeModelDetails } from './stats.ts';

import type { ModelDetail, ModelDetailRequest } from '../types.ts';

/** 模型明细取数结果：明细、加载中、失败信息与手动重试。 */
export interface ModelDetailState {
  detail: ModelDetail | null
  loading: boolean
  error: string | null
  reload: () => void
}

/**
 * 按模型键（`provider\0model`，首个为目标行、其余为归并来源）取明细。
 * @param keys - 弹窗当前打开行的模型键集合；null 表示没有打开的行，不发请求。
 * @param since - 时间下界（本地日零点），null 为全部历史。
 * @returns 合并后的明细与加载/错误状态、重试函数。
 */
export function useModelDetail(keys: readonly string[] | null, since: number | null): ModelDetailState {
  // 明细连同它的入参键一起存：键对不上即视为「没有数据」，换行或换范围时不会把
  // 上一行的数字短暂显示在新行下（查询是本地毫秒级，但错配的数字比空态更糟）。
  const [loaded, setLoaded] = useState<{ key: string | null; detail: ModelDetail | null }>({ key: null, detail: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // 乱序守卫：每次发起请求取递增序号，响应回来时若已有更新的请求发出即丢弃。
  const seqRef = useRef(0);
  // keys 是每次渲染新建的数组，取签名当依赖，内容不变就不重取；首键即目标行。
  const signature = keys === null || keys.length === 0 ? null : keys.join('|');
  const firstKey = signature === null ? null : signature.split('|')[0];
  const loadKey = signature === null ? null : `${signature}|${since ?? 'all'}`;
  const detail = loaded.key === loadKey ? loaded.detail : null;

  useEffect(() => {
    if (signature === null || firstKey === null || loadKey === null) {
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
        const details = await Promise.all(signature.split('|').map(async (key) => {
          const { provider, model } = splitModelKey(key);
          const request: ModelDetailRequest = since === null ? { provider, model } : { provider, model, since };
          const result = await remote.modelDetail(request);
          if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
          return result.value;
        }));
        if (!live || mine !== seqRef.current) return;
        setLoaded({ key: loadKey, detail: mergeModelDetails(details, splitModelKey(firstKey)) });
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
  }, [signature, firstKey, loadKey, since, tick]);

  /** 重试：序号自增触发同一份入参重取。 */
  const reload = useCallback(() => setTick((v) => v + 1), []);

  return { detail, loading, error, reload };
}
