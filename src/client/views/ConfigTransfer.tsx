/**
 * 配置迁移区（ConfigTransfer）：设置 Tab 的专属子视图，一个组件一个文件。
 *
 * 偏好设置在服务端 profile 配置文档里，跨设备迁移只能靠一串文本，故本区把整份偏好
 * 编成配置串导出、或从配置串导回，编辑与写入实现见 ../configTransfer.ts 与 ../settings.ts。
 * 两块内容各一行说明加一列操作：
 *   - 导出：生成配置串 → 只读文本域（等宽、限高滚动、聚焦全选）→ 复制，复制结果内联反馈；
 *   - 导入：粘贴配置串 → 解析，错误按 ../configTransfer.ts 的错误码给对应文案；
 *     解析成功先预览「将覆盖几项、其中几项与当前不同」，确认后才整份写入，
 *     不可写（profile 配置不可写）或与当前取值完全一致时不给确认。
 * 写入链路：本组件只调 props.onReplace，落到哪份存储由设置 Tab 经
 * UsageStatsPanel、UsageStatsFooter 一路传入（即 settings.ts 的 replaceUsageSettings）。
 */

import { IconCheckOutlineRegular, IconCopyOutlineRegular, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives';
import { useEffect, useRef, useState } from 'react';

import { HintCard } from '../components/HintCard.tsx';
import shared from '../components/UsageStatsCommon.module.css';
import { changedSettingFields, decodeConfigTransfer, encodeConfigTransfer } from '../configTransfer.ts';

import css from './ConfigTransfer.module.css';

import type { UsageSettings } from '../../types.ts';
import type { ConfigTransferError } from '../configTransfer.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

/** 复制与导入成功反馈的展示时长，与 SessionIdBadge 的「已复制」保持一致。 */
const FEEDBACK_DURATION_MS = 1600;

/** 解析错误码 → 文案键；错误码集合由 ../configTransfer.ts 定义，这里是唯一的界面映射。 */
const ERROR_KEYS: Record<ConfigTransferError, 'settings.configErrorEmpty' | 'settings.configErrorBase64' | 'settings.configErrorPayload' | 'settings.configErrorFormat' | 'settings.configErrorVersion'> = {
  empty: 'settings.configErrorEmpty',
  'invalid-base64': 'settings.configErrorBase64',
  'invalid-payload': 'settings.configErrorPayload',
  'unknown-format': 'settings.configErrorFormat',
  'unsupported-version': 'settings.configErrorVersion',
};

/** 配置串待确认的导入：解析结果 + 确认时给用户的差异条数，避免确认时才知会覆盖什么。 */
interface ImportPreview {
  /** 待写入的整份偏好。 */
  settings: UsageSettings
  /** 原配置串的导出时间，缺失时界面隐藏该行。 */
  exportedAt: string | undefined
  /** 与当前偏好不同的字段数。 */
  changed: number
}

/** 配置迁移区：导出配置串与从配置串导入，写入经 props.onReplace 上传到设置 Tab。 */
export function ConfigTransfer({
  settings, onReplace, writable, t,
}: {
  /** 当前生效的偏好，导出内容与差异比对都以它为准。 */
  settings: UsageSettings
  /** 整份写入偏好：导入确认后调用。 */
  onReplace: (next: UsageSettings) => void
  /** profile 配置文档当前是否可写；只读时禁止导入，导出不受影响。 */
  writable: boolean
  t: PropsLocale<'dsh-usage-stats'>['t']
}) {
  // 折叠态由设置 Tab 持有（与账本操作折叠同排），本组件只负责折叠内的内容。
  const [exported, setExported] = useState('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<ConfigTransferError | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  // 两块的内联反馈各留一份，跟随触发它的按钮显示；同一时刻只会有一条
  const [exportFeedback, setExportFeedback] = useState('');
  const [importFeedback, setImportFeedback] = useState('');
  const [copied, setCopied] = useState(false);
  const feedbackTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (feedbackTimer.current !== undefined) window.clearTimeout(feedbackTimer.current);
  }, []);

  // 服务端偏好变化（本组件的导入、其他分组的开关都会触发）即作废待确认的预览：
  // 「与当前不同几项」按当时的取值算，留着会显示与实际不符的条数。
  useEffect(() => {
    setPreview(null);
    setError(null);
  }, [settings]);

  /** 内联反馈：覆盖上一次的反馈并收起对勾，到时清空。 */
  const flash = (set: (text: string) => void, text: string): void => {
    if (feedbackTimer.current !== undefined) window.clearTimeout(feedbackTimer.current);
    set(text);
    feedbackTimer.current = window.setTimeout(() => {
      set('');
      setCopied(false);
    }, FEEDBACK_DURATION_MS);
  };

  const flashExport = (text: string): void => flash(setExportFeedback, text);
  const flashImport = (text: string): void => flash(setImportFeedback, text);

  const onGenerate = (): void => {
    setExported(encodeConfigTransfer(settings));
    setExportFeedback('');
    setCopied(false);
  };

  /** 复制结果只影响图标与反馈文字：失败保持复制图标，反馈行同时说明「请手动复制」。 */
  const onCopy = (): void => {
    void writeClipboard(exported).then((accepted) => {
      setCopied(accepted);
      flashExport(accepted ? t('settings.configCopied') : t('settings.configCopyFailed'));
    });
  };

  /** 解析粘贴的配置串：错误落在错误码上，成功则算出差异条数待确认。 */
  const onParse = (): void => {
    const result = decodeConfigTransfer(draft);
    setImportFeedback('');
    if (!result.ok) {
      setError(result.error);
      setPreview(null);
      return;
    }
    setError(null);
    setPreview({
      settings: result.settings,
      // 解析器用 null 表示串里没有导出时间（旧串或字段被剔除），界面按「没有」处理
      exportedAt: result.exportedAt ?? undefined,
      changed: changedSettingFields(settings, result.settings).length,
    });
  };

  /** 确认导入：整份写入后清空输入框，反馈走内联文案而非弹窗（模态窗内层级不合适）。 */
  const onConfirm = (): void => {
    if (preview === null) return;
    onReplace(preview.settings);
    setPreview(null);
    setDraft('');
    flashImport(t('settings.configImported'));
  };

  const onCancel = (): void => {
    setPreview(null);
    setError(null);
  };

  // 预览与确认按钮同屏出现：changed 为 0 时按钮禁用，此时文案已说明与当前一致。
  // 导入是整份覆盖，故覆盖项数取整份偏好的字段数，与「其中几项与当前不同」分开报。
  const previewHint = (() => {
    if (preview === null) return '';
    if (preview.changed === 0) return t('settings.configPreviewSame');
    return t('settings.configPreview', { count: Object.keys(settings).length, fields: preview.changed });
  })();

  return (
    <div className={css.content}>
      {/* 导出：说明 + 生成，生成后才出现文本域与复制按钮 */}
      <div className={css.block}>
        <div className={css.blockHead}>
          <span className={css.blockTitle}>{t('settings.configExport')}</span>
        </div>
        <span className={shared.goHint}>{t('settings.configExportHint')}</span>
        <button type="button" className={css.actionBtn} onClick={onGenerate}>
          {t('settings.configGenerate')}
        </button>
        {exported !== '' && (
          <>
            <textarea
              className={`${css.stringBox} ${css.stringMono}`}
              readOnly
              value={exported}
              aria-label={t('settings.configStringExport')}
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className={css.actions}>
              <button type="button" className={css.actionBtn} onClick={onCopy}>
                {copied ? <IconCheckOutlineRegular size={14} /> : <IconCopyOutlineRegular size={14} />}
                <span>{t('settings.configCopy')}</span>
              </button>
            </div>
          </>
        )}
        {/* 复制结果紧跟生成结果：成功「已复制」，失败给出手动复制的退路 */}
        {exportFeedback !== '' && (
          <span className={css.feedback} role="status">{exportFeedback}</span>
        )}
      </div>

      {/* 导入：粘贴 + 解析，解析成功后先预览差异再确认，确认才整份写入 */}
      <div className={css.block}>
        <div className={css.blockHead}>
          <span className={css.blockTitle}>{t('settings.configImport')}</span>
        </div>
        <span className={shared.goHint}>{t('settings.configImportHint')}</span>
        <textarea
          className={css.pasteBox}
          value={draft}
          placeholder={t('settings.configPastePlaceholder')}
          aria-label={t('settings.configStringImport')}
          disabled={!writable}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className={css.actions}>
          <button type="button" className={css.actionBtn} onClick={onParse} disabled={!writable}>
            {t('settings.configParse')}
          </button>
        </div>
        {/* 只读说明：与按钮 disabled 同步出现，避免点了没反应；导出不受只读影响 */}
        {!writable && <span className={shared.goHint}>{t('settings.configReadonlyHint')}</span>}
        {error !== null && (
          <HintCard variant="error" role="alert" title={t(ERROR_KEYS[error])} />
        )}
        {preview !== null && (
          <div className={css.preview}>
            <span className={css.previewText}>{previewHint}</span>
            {preview.exportedAt !== undefined && (
              <span className={css.previewMeta}>{t('settings.configExportedAt', { time: new Date(preview.exportedAt).toLocaleString() })}</span>
            )}
            <div className={css.actions}>
              <button
                type="button"
                className={css.actionBtn}
                onClick={onConfirm}
                disabled={!writable || preview.changed === 0}
              >
                {t('settings.configConfirm')}
              </button>
              <button type="button" className={css.actionBtn} onClick={onCancel}>
                {t('settings.configCancel')}
              </button>
            </div>
          </div>
        )}
        {/* 导入结果提示：写入完成（服务端取值随后回流，预览随之收起） */}
        {importFeedback !== '' && (
          <span className={css.feedback} role="status">{importFeedback}</span>
        )}
      </div>
    </div>
  );
}
