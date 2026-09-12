/**
 * 模型统计重定向规则编辑器：设置 Tab 的专属子视图，一个组件一个文件。
 *
 * 一条规则四个字段：来源供应商 + 来源模型 → 目标供应商 + 目标模型；语义与归并
 * 实现见 ../stats.ts 的 redirectModels（来源的用量算到目标名下，只影响模型页）。
 * 输入用 `<input list>` + `<datalist>`：候选取自原始快照的「供应商 + 模型」
 * （服务端快照不归并，正是为了这里能列出真实来源），既可下拉选也可手打，
 * 候选为空（还没用量）时照常输入。
 *
 * 来源侧候选会排除其他行已经配过的「供应商 + 模型」组合：同一来源只有最上面
 * 一条生效，已配过的组合再选一次没有意义（模型用光的供应商也一并从候选里去掉，
 * 本行自己那份取值仍然保留在候选里，便于回改）。
 *
 * 写入走「本地草稿 + 失焦/回车提交」：每敲一键就写设置文档既没必要，也会放大
 * 并发写冲突；草稿在服务端取值变化时同步回来，于是界面显示的是归一化后的结果
 * （去首尾空白、丢弃全空行、截断到上限，见 utils.ts 的 normalizeModelRedirects）。
 * 四项没填齐的规则留在界面上并提示，不参与归并（isCompleteRedirect）；
 * 同一来源配了多条时只有最上面一条生效，重复行同样给提示。
 */

import { IconChevronRightOutline14, IconPlusOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { MODEL_REDIRECT_MAX_RULES, isCompleteRedirect, normalizeModelRedirects } from '../../utils.ts';
import shared from '../components/UsageStatsCommon.module.css';
import { modelCatalog, unusedRedirectSources } from '../stats.ts';

import css from './ModelRedirectEditor.module.css';

import type { ModelRedirect, ModelStat } from '../../types.ts';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';

/** 新增一行的初值：四项全空，归一化时丢弃，用户真填了字段才会落盘。 */
const EMPTY_RULE: ModelRedirect = { fromProvider: '', fromModel: '', toProvider: '', toModel: '' };

/** 规则数组逐字段比较：与当前设置文档一致时不再发起写入。 */
function sameRules(a: readonly ModelRedirect[], b: readonly ModelRedirect[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((rule, i) => {
    const other = b[i];
    return rule.fromProvider === other.fromProvider && rule.fromModel === other.fromModel
      && rule.toProvider === other.toProvider && rule.toModel === other.toModel;
  });
}

/** 字段名映射：来源侧/目标侧 × 供应商/模型 → 规则里的字段名。 */
function redirectFieldKey(side: 'from' | 'to', field: 'provider' | 'model'): keyof ModelRedirect {
  if (side === 'from') return field === 'provider' ? 'fromProvider' : 'fromModel';
  return field === 'provider' ? 'toProvider' : 'toModel';
}

/** 来源组合键：供应商 + 模型，与归并用的键同形（`\0` 分隔，文本里不会出现）。 */
function pairKey(provider: string, model: string): string {
  return provider + '\u0000' + model;
}

/** 空排除集：目标侧候选不排除任何组合。 */
const NO_EXCLUSION: ReadonlySet<string> = new Set();

/** 模型统计重定向规则编辑器：列表 + 增删，改动提交给设置页写回设置文档。 */
export function ModelRedirectEditor({
  rules, models, onChange, t,
}: {
  /** 当前生效的规则表（设置文档里的取值，已归一化）。 */
  rules: ModelRedirect[]
  /** 原始快照的模型行，仅用于生成输入候选。 */
  models: ModelStat[]
  /** 提交改动：整表写回偏好设置。 */
  onChange: (rules: ModelRedirect[]) => void
  t: PropsLocale<'dsh-usage-stats'>['t']
}) {
  const [draft, setDraft] = useState<ModelRedirect[]>(rules);
  const uid = useId();
  /** 上一次同步进草稿的服务端取值：内容没变就不覆盖草稿，避免归一化重建数组时打断输入。 */
  const synced = useRef(rules);

  // 服务端取值变化时同步草稿：本组件自己的提交也会回到这里，界面因此与设置文档一致
  useEffect(() => {
    if (sameRules(synced.current, rules)) return;
    synced.current = rules;
    setDraft(rules);
  }, [rules]);

  // 候选底表：账本里出现过的供应商 → 模型（原始快照，服务端不归并）
  const catalog = useMemo(() => modelCatalog(models), [models]);
  const providers = useMemo(() => [...catalog.keys()], [catalog]);
  const allModels = useMemo(() => [...new Set(models.map((m) => m.model))].sort(), [models]);

  /**
   * 每行的「其他行已用来源」：来源侧候选要排除它们，本行自己那份不算。
   * 同一来源只有最上面一条生效（stats.ts 的规则索引），已配过的组合再选一次没有意义，
   * 于是来源的自动完成里不再出现——自己行在编辑时仍能看到自己的取值。
   */
  const otherSourceKeys = useMemo(() => {
    const keys = draft.map((rule) => (rule.fromProvider !== '' && rule.fromModel !== ''
      ? pairKey(rule.fromProvider, rule.fromModel)
      : null));
    return keys.map((_, i) => new Set(keys.filter((key, j): key is string => key !== null && j !== i)));
  }, [draft]);

  /** 某供应商下的模型候选：账本里没见过的供应商给全部模型兜底，同样排掉其他行已占用的组合。 */
  const modelsFor = (provider: string, free: ReadonlyMap<string, string[]>, used: ReadonlySet<string>): string[] => {
    const name = provider.trim();
    const observed = free.get(name);
    if (observed !== undefined) return observed;
    return allModels.filter((model) => !used.has(pairKey(name, model)));
  };

  // 重复来源标记：同一来源只有最上面一条生效（stats.ts 的规则索引按列表顺序）
  const duplicates = useMemo(() => {
    const seen = new Set<string>();
    return draft.map((rule) => {
      const defined = rule.fromProvider !== '' && rule.fromModel !== '';
      const key = rule.fromProvider + '\u0000' + rule.fromModel;
      const duplicate = defined && seen.has(key);
      if (defined) seen.add(key);
      return duplicate;
    });
  }, [draft]);

  const providerListId = `${uid}-providers`;

  /** 提交整表：与当前取值一致时跳过，避免空写。 */
  const commit = (next: ModelRedirect[]): void => {
    if (sameRules(next, rules)) return;
    onChange(normalizeModelRedirects(next));
  };

  const patch = (index: number, field: keyof ModelRedirect, value: string): void => {
    setDraft((prev) => prev.map((rule, i) => (i === index ? { ...rule, [field]: value } : rule)));
  };

  const remove = (index: number): void => {
    const next = draft.filter((_, i) => i !== index);
    setDraft(next);
    commit(next);
  };

  const add = (): void => {
    if (draft.length >= MODEL_REDIRECT_MAX_RULES) return;
    // 空行先只进草稿：一项都没填就走人时不留垃圾行，填了字段在失焦提交时落盘
    setDraft([...draft, { ...EMPTY_RULE }]);
  };

  /** 单个输入：候选表按「来源侧 / 目标侧 + 该行已选的供应商」生成。 */
  const renderField = (index: number, side: 'from' | 'to', field: 'provider' | 'model', listId: string) => {
    const rule = draft[index];
    const sideKey = side === 'from' ? 'settings.redirectFrom' : 'settings.redirectTo';
    const fieldKey = field === 'provider' ? 'settings.redirectProvider' : 'settings.redirectModel';
    const key = redirectFieldKey(side, field);
    return (
      <input
        className={css.ruleInput}
        type="text"
        list={listId}
        value={rule[key]}
        placeholder={t('settings.redirectPick')}
        aria-label={`${t(sideKey)} ${t(fieldKey)}`}
        onChange={(e) => patch(index, key, e.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
    );
  };

  return (
    <div className={css.editor}>
      <span className={shared.goHint}>{t('settings.modelRedirectsHint')}</span>

      {/* 目标侧供应商候选共用一张表；来源侧与两侧模型候选按行生成 */}
      <datalist id={providerListId}>
        {providers.map((provider) => <option key={provider} value={provider} />)}
      </datalist>

      {draft.length === 0 && (
        <span className={css.empty}>{t('settings.modelRedirectsEmpty')}</span>
      )}

      {draft.map((rule, index) => {
        // 来源侧排除其他行已配过的组合：供应商与模型两级候选都不再出现它们
        const used = otherSourceKeys[index];
        const free = unusedRedirectSources(catalog, used);
        const fromProviders = [...free.keys()];
        const fromModels = modelsFor(rule.fromProvider, free, used);
        const toModels = modelsFor(rule.toProvider, catalog, NO_EXCLUSION);
        return (
          <div className={css.ruleBlock} key={index}>
            <div className={css.ruleRow}>
              <span className={css.ruleSide}>
                <span className={css.ruleTag}>{t('settings.redirectFrom')}</span>
                {renderField(index, 'from', 'provider', `${uid}-from-providers-${index}`)}
                <datalist id={`${uid}-from-providers-${index}`}>
                  {fromProviders.map((provider) => <option key={provider} value={provider} />)}
                </datalist>
                {renderField(index, 'from', 'model', `${uid}-from-models-${index}`)}
                <datalist id={`${uid}-from-models-${index}`}>
                  {fromModels.map((model) => <option key={model} value={model} />)}
                </datalist>
              </span>
              <IconChevronRightOutline14 className={css.ruleArrow} size={14} />
              <span className={css.ruleSide}>
                <span className={css.ruleTag}>{t('settings.redirectTo')}</span>
                {renderField(index, 'to', 'provider', providerListId)}
                {renderField(index, 'to', 'model', `${uid}-to-models-${index}`)}
                <datalist id={`${uid}-to-models-${index}`}>
                  {toModels.map((model) => <option key={model} value={model} />)}
                </datalist>
              </span>
              <button
                type="button"
                className={css.ruleRemove}
                onClick={() => remove(index)}
                aria-label={t('settings.redirectRemove')}
                title={t('settings.redirectRemove')}
              >
                <IconTrashOutline16 size={14} />
              </button>
            </div>
            {(duplicates[index] || !isCompleteRedirect(rule)) && (
              <span className={css.ruleHint}>
                {duplicates[index] ? t('settings.modelRedirectsDuplicate') : t('settings.modelRedirectsIncomplete')}
              </span>
            )}
          </div>
        );
      })}

      <div className={css.editorFoot}>
        <button
          type="button"
          className={css.addBtn}
          onClick={add}
          disabled={draft.length >= MODEL_REDIRECT_MAX_RULES}
        >
          <IconPlusOutline16 size={14} />
          <span>{t('settings.modelRedirectsAdd')}</span>
        </button>
        <span className={css.ruleHint}>{t('settings.modelRedirectsMax', { max: MODEL_REDIRECT_MAX_RULES })}</span>
      </div>
    </div>
  );
}
