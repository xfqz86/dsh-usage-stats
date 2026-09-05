/**
 * 二次确认操作 hook（浏览器端）。
 *
 * 重建/清零账本同一写法：busy 锁、成功 done 后 1.5s 回 idle、失败回 idle；
 * 确认弹窗显隐与「我已了解」复选一体管理。执行体由调用方传入
 * （如 `() => postLedgerApi('rebuild', onRefresh)`）。
 */
import { useState } from 'react';

/** 确认操作状态。 */
export type ConfirmOpState = 'idle' | 'busy' | 'done';

/** 确认操作手柄：arm 开弹窗、confirm 关弹窗并执行、dismiss 直接关弹窗。 */
export function useConfirmOp(run: () => Promise<void>): {
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
  const arm = () => {
    if (state === 'busy') return;
    setAcknowledged(false);
    setConfirmOpen(true);
  };
  const dismiss = () => {
    setConfirmOpen(false);
    setAcknowledged(false);
  };
  const confirm = () => {
    dismiss();
    if (state === 'busy') return;
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
