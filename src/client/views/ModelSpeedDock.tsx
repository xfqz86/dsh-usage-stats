/**
 * 输入区状态行读数条目的入口：按设置门控，并在挂载期间维护一个会话速度存储。
 *
 * 存储随条目挂载而建、随卸载（切走会话、关闭开关、插件卸载）而解绑：会话在最后一个引用
 * 释放后会被回收，重新进入时拿到的是新的事件窗口，所以不跨挂载缓存 store，避免读到冻结的
 * 旧快照。`ctx.sessions.binding(sessionId)` 暂不可用时订阅会话列表，等绑定出现后再建并退订。
 */

import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from 'react';

import { ModelSpeedPill, type SpeedEntryProps, type SpeedInjected } from '../components/ModelSpeedPill.tsx';
import { useUsageSettingsView } from '../hooks/useUsageSettings.ts';
import { createSpeedStore, EMPTY_SPEED_SNAPSHOT, type SpeedSnapshot, type SpeedStore, type SpeedStoreHandle } from '../modelSpeed.ts';

import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
// 类型侧合并：session-controller 客户端声明 ctx.sessions。
import type {} from '@deepseek-ai/dsh-api-session-controller/client';

/** useSyncExternalStore 的稳定空实现：会话绑定尚未就绪时使用。 */
const NOOP_SUBSCRIBE = (): (() => void) => () => {};

/** 条目注入器：按会话交出稳定的 useSpeed。 */
export interface SpeedInjection {
  /** 插槽注册的 inject 钩子。 */
  inject: (sessionId: SessionId) => SpeedInjected
}

/**
 * 建一个条目注入器：钩子只在读数组件挂载期间持有会话事件订阅。
 * @param ctx - 浏览器端插件上下文（需要 ctx.sessions）。
 * @returns inject 钩子。
 */
export function createSpeedInjection(ctx: ClientContext): SpeedInjection {
  const inject = (sessionId: SessionId): SpeedInjected => {
    // 钩子在条目注册时建一次：组件只拿稳定的 useSpeed，不再碰 ctx。
    const useSpeed = (): SpeedSnapshot => {
      const [store, setStore] = useState<SpeedStore | null>(null);
      // 不在 render 期建 store（订阅是副作用）：布局阶段建；binding 暂不可用时订阅
      // sessions.list，等它出现后再建，避免整个会话永久停在 “—”。
      useLayoutEffect(() => {
        let handle: SpeedStoreHandle | null = null;
        let unsubscribe = (): void => {};
        const attempt = (): boolean => {
          const binding = ctx.sessions.binding(sessionId);
          if (binding === undefined) return false;
          handle = createSpeedStore(binding.eventSource, binding.session);
          setStore(handle.store);
          return true;
        };
        if (!attempt()) {
          unsubscribe = ctx.sessions.list.subscribe(() => {
            if (attempt()) unsubscribe();
          });
        }
        return () => {
          unsubscribe();
          handle?.dispose();
        };
      }, [sessionId]);
      // 按 store 身份缓存订阅函数与取快照函数：uSES 每次渲染都会比较引用，直接传方法
      // 引用会触发无意义的重订阅（也命中 unbound-method 规则）。
      const subscribe = useCallback((listener: () => void) => (store === null ? NOOP_SUBSCRIBE() : store.subscribe(listener)), [store]);
      const getSnapshot = useCallback(() => (store === null ? EMPTY_SPEED_SNAPSHOT : store.getSnapshot()), [store]);
      return useSyncExternalStore(subscribe, getSnapshot);
    };
    return { useSpeed };
  };
  return { inject };
}

/** 输入区状态行的模型速度读数；偏好未落定或关闭时不渲染（也不建会话订阅）。 */
export function ModelSpeedDock({ useSpeed, t }: SpeedEntryProps) {
  const { settings, status } = useUsageSettingsView();
  // 配置文档尚未落定时先不挂载：否则会按默认值（开）先建一次订阅，再被请求结果关掉。
  if (status === 'loading' || !settings.modelSpeedEnabled) return null;
  return <ModelSpeedPill useSpeed={useSpeed} t={t} />;
}
