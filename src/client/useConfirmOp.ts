/**
 * 二次确认操作 hook（浏览器端）。
 *
 * 重建/清零账本同一写法：busy 锁、成功 done 后 1.5s 回 idle、失败回 idle；
 * 确认弹窗显隐与「我已了解」复选一体管理。执行体由调用方传入
 * （如 `() => postLedgerApi('rebuild', onRefresh)`）。
 * locked 为外部占用条件（如扫描进行中）：为 true 时不开弹窗、不执行，
 * 已打开的弹窗随之关闭（可能在确认前被占用），按钮侧同时置灰，
 * 避免进入注定被服务端拒绝的确认流程。
 */
import { useEffect, useState } from 'react';

/** 确认操作状态。 */
export type ConfirmOpState = 'idle' | 'busy' | 'done';

/** 确认操作手柄：arm 开弹窗、confirm 关弹窗并执行、dismiss 直接关弹窗。 */
export function useConfirmOp(run: () => Promise<void>, locked = false): {
  state: ConfirmOpState
  confirmOpen: boolean
  acknowledged: boolean
  setAcknowledged: (v: boolean) => void
  arm: () => void
  confirm: () => void
  dismiss: () => void
} {
  const [state, setState] = useState<ConfirmOpState>('idle');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  // 占用条件在确认前变为真（如扫描开始）：关掉已打开的弹窗，避免确认后静默失败。
  useEffect(() => {
    if (!locked) return;
    setConfirmOpen(false);
    setAcknowledged(false);
  }, [locked]);
  const arm = () => {
    if (state === 'busy' || locked) return;
    setAcknowledged(false);
    setConfirmOpen(true);
  };
  const dismiss = () => {
    setConfirmOpen(false);
    setAcknowledged(false);
  };
  const confirm = () => {
    dismiss();
    if (state === 'busy' || locked) return;
    setState('busy');
    void run().then(() => {
      setState('done');
      window.setTimeout(() => setState('idle'), 1500);
    }).catch(() => {
      setState('idle');
    });
  };
  return { state, confirmOpen, acknowledged, setAcknowledged, arm, confirm, dismiss };
}
