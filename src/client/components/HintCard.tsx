/**
 * 额度状态提示卡：图标徽标配短文案，概览磁贴与侧边栏 tooltip 共用。
 * `brand` 变体为未开通订阅（星标），`error` 变体为查询失败（告警）；
 * `tile` 为磁贴浅底，`tip` 为深色 tooltip 底。
 */

import { IconSparkleRegular, IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';

import css from './HintCard.module.css';

/** 额度状态提示卡，图标加短文案，变体选图标与色调，色调按容器深浅切换。 */
export function HintCard({ text, tone = 'tile', variant = 'brand' }: {
  text: string
  tone?: 'tile' | 'tip'
  variant?: 'brand' | 'error'
}) {
  const toneCls = tone === 'tip' ? ` ${css.tip}` : '';
  const variantCls = variant === 'error' ? ` ${css.error}` : '';
  return (
    <div className={`${css.root}${toneCls}${variantCls}`}>
      <span className={css.icon} aria-hidden="true">
        {variant === 'error' ? <IconWarningOutlineRegular size={14} /> : <IconSparkleRegular size={14} />}
      </span>
      <span className={css.text}>{text}</span>
    </div>
  );
}
