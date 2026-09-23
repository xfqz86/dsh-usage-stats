/**
 * 会话 ID 徽标：会话标题右侧工具区的等宽 sessionId 展示与悬停复制。
 * 注册在 `conversation.session.header.utilities`（session 作用域，框架只在有
 * 会话时渲染、sessionId 经 PropsRuntime 确定传入）；`showSessionId` 偏好关闭
 * 时渲染空，由设置 Tab 的会话分组开关门控，默认开启。
 */

import { IconCheckOutlineRegular, IconCopyOutlineRegular, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives';
import { useEffect, useRef, useState } from 'react';


import { useUsageSettings } from '../useUsageSettings.ts';

import css from './SessionIdBadge.module.css';

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';

/** 会话 ID 徽标属性：运行时 sessionId 与本地化函数均由插槽系统注入。 */
export type SessionIdBadgeProps =
  PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<'dsh-usage-stats'>;

/** 「已复制」反馈的展示时长。 */
const COPIED_DURATION_MS = 1600;

/** 会话 ID 徽标与悬停复制：复制成功短暂切换为对勾，失败静默无反馈。 */
export function SessionIdBadge({ sessionId, t }: SessionIdBadgeProps) {
  const [settings] = useUsageSettings();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current);
  }, []);

  if (!settings.showSessionId) return null;

  const onCopy = (): void => {
    void writeClipboard(sessionId).then((accepted) => {
      if (!accepted) return;
      setCopied(true);
      if (copiedTimer.current !== undefined) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => { setCopied(false); }, COPIED_DURATION_MS);
    });
  };

  return (
    <div className={css.identity} role="group" aria-label={t('sessionId.badgeAria', { id: sessionId })}>
      <span className={css.badge} title={sessionId}>
        <span className={css.badgeText}>{sessionId}</span>
        <button
          type="button"
          className={`${css.iconButton} ${css.copyButton}${copied ? ` ${css.copyButtonVisible}` : ''}`}
          aria-label={copied ? t('sessionId.copied') : t('sessionId.copy')}
          title={copied ? t('sessionId.copied') : t('sessionId.copy')}
          onClick={onCopy}
        >
          {copied ? <IconCheckOutlineRegular size={14} /> : <IconCopyOutlineRegular size={14} />}
        </button>
      </span>
    </div>
  );
}
