/**
 * 自实现的 Tooltip（Tips）：基于 dsh 自带 `@deepseek-ai/dsh-client-ui-primitives/Tooltip` 的轻量修改版，
 * 并已合并原 `FollowTooltip` 的鼠标跟随能力（通过 `follow` 参数控制）。
 *
 * 原版仅支持 `label: string | (() => string)` 的纯文本气泡；本实现保留其全部定位、
 * 视口自适应、hover/focus 双触发、delay、disabled、maxWidth、ref 转发等行为，
 * 仅扩展内容形态以支持插槽传入任意组件排版，并通过 `follow` 合并跟随变体：
 *
 * - 新增 `content?: ReactNode | (() => ReactNode)` 插槽，传入时优先于 `label` 渲染；
 * - 兼容扩展 `label` 亦可为 `ReactNode | (() => ReactNode)`，便于平滑迁移（原有 `label="文字"` 仍可工作）；
 * - 新增 `follow?: boolean`（默认 `false`）：为 `true` 时水平位置跟随鼠标（原 `FollowTooltip` 行为），
 *   垂直仍锚定到元素边缘，键盘聚焦时居中显示；为 `false` 时为普通锚点居中/右侧定位；
 * - 气泡容器由 `span` 改为 `div`，使块级富内容（flex / grid 排版）合法；
 * - 当内容为富组件时，外层包裹 `.rich` 以重置 `white-space` 为 `normal`，避免 `pre-line` 干扰布局；
 * - 其它视觉与交互完全复刻原版（fixed 定位、transform 按 side、水平溢出内收、垂直翻转、maxWidth 覆盖等）。
 *
 * 用法：
 * ```tsx
 * // 纯文本（原有写法不变）
 * <Tooltip label="缓存 12,345" side="top"><span>...</span></Tooltip>
 * // 富排版（新增插槽）
 * <Tooltip content={<div><b>今日</b><span>12,345 tokens</span></div>} side="top"><span>...</span></Tooltip>
 * // 函数式惰性求值（仅在气泡可见时执行，避免大开销）
 * <Tooltip content={() => <MyPanel />}><span>...</span></Tooltip>
 * // 跟随鼠标（原 FollowTooltip 已移除，统一使用 follow）
 * <Tooltip follow content={barContent} side="top"><span className={css.barRow} /></Tooltip>
 * ```
 *
 * 独立成文件（一个组件一个文件），样式见 `./Tooltip.module.css`。
 */

import { cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FocusEventHandler, MouseEventHandler, MutableRefObject, ReactElement, ReactNode, Ref } from 'react'
import css from './Tooltip.module.css'

/** 气泡相对锚点的方位。 */
export type TooltipSide = 'right' | 'bottom' | 'top'

/** Tooltip 向锚点子元素注入的受控属性；子元素原有回调会在其前链式调用。 */
interface AnchorProps {
  ref?: Ref<HTMLElement> | undefined
  onMouseEnter?: MouseEventHandler | undefined
  onMouseMove?: MouseEventHandler | undefined
  onMouseLeave?: MouseEventHandler | undefined
  onFocus?: FocusEventHandler | undefined
  onBlur?: FocusEventHandler | undefined
}

/** 兼容原版的文本标签（字符串或惰性求值），本实现同时允许 ReactNode 以便直接传组件。 */
type TooltipLabel = string | ReactNode | (() => string | ReactNode)
/** 富内容插槽：任意 React 排版或惰性求值函数。 */
type TooltipContent = ReactNode | (() => ReactNode)

export function Tooltip({
  label,
  content,
  side,
  delayMs = 0,
  disabled = false,
  maxWidth,
  follow = false,
  children,
}: {
  /** 文本标签（兼容原版）；传入 ReactNode 时等同 content，为存量代码保留。 */
  label?: TooltipLabel
  /** 富内容插槽（推荐）：任意组件排版，优先级高于 label。支持函数以惰性求值。 */
  content?: TooltipContent
  /** 相对锚点的方位，默认跟随时为 'bottom'，非跟随时为 'right'。 */
  side?: TooltipSide
  /** hover 延迟（毫秒），键盘聚焦仍立即显示。 */
  delayMs?: number
  /** 为 true 时抑制气泡；锚点仍原样渲染，避免切换时重挂导致过渡中断。 */
  disabled?: boolean
  /** 气泡宽度上限（像素），用于长文案超出默认 50vw 的场景。 */
  maxWidth?: number
  /** 为 true 时水平跟随鼠标（原 FollowTooltip 行为）；为 false 时为普通锚点定位。 */
  follow?: boolean
  /** 单个锚点元素；其原有 ref（回调或对象）会与 Tooltip 的 ref 一并转发。 */
  children: ReactElement<AnchorProps>
}) {
  const anchor = useRef<HTMLElement | null>(null)
  // React 18 的 ref 不在 props 中，显式转发以避免包裹锚点后静默切断宿主 ref。
  const childRef = (children as ReactElement<AnchorProps> & { ref?: Ref<HTMLElement> }).ref
  const mergedRef = useCallback((el: HTMLElement | null) => {
    anchor.current = el
    if (typeof childRef === 'function') childRef(el)
    else if (childRef != null) (childRef as MutableRefObject<HTMLElement | null>).current = el
  }, [childRef])

  // 实际方位：未显式传入时，跟随态默认 'bottom'，普通态默认 'right'，保持与合并前两组件一致。
  const effectiveSide: TooltipSide = side ?? (follow ? 'bottom' : 'right')

  // 锚点边缘而非最终坐标：垂直翻转需基于对侧边缘重算气泡 top。
  const [pos, setPos] = useState<{ x: number; top: number; bottom: number } | null>(null)
  // 气泡实际方位，默认按请求 side，视口放不下时翻转。
  const [placement, setPlacement] = useState<TooltipSide>(effectiveSide)
  const bubble = useRef<HTMLDivElement | null>(null)
  const lastClientX = useRef<number>(0)

  // 插槽解析：content 优先于 label；函数仅在气泡可见时求值，避免每次渲染开销。
  const raw: TooltipLabel | TooltipContent | undefined = content !== undefined ? content : label
  const resolved: ReactNode = pos === null
    ? null
    : raw === undefined
      ? null
      : typeof raw === 'function'
        ? (raw as () => ReactNode)()
        : raw

  const isEmpty = resolved === null || resolved === undefined || resolved === '' || (typeof resolved === 'string' && resolved.trim() === '')

  const y = pos === null
    ? 0
    : placement === 'right'
      ? pos.top + (pos.bottom - pos.top) / 2
      : placement === 'top' ? pos.top - 8 : pos.bottom + 8

  const EDGE_MARGIN = 12

  // 视口自适应：fixed 定位不感知边缘，靠近右边缘的气泡需水平内收，
  // 顶部/底部放不下时翻转到对侧（仅当对侧确实能放下时翻转，避免震荡）。
  // 每次先重置 base left，再度量，确保短文案或大视口能释放此前的偏移。
  useLayoutEffect(() => {
    if (pos === null) return
    const fit = () => {
      const el = bubble.current
      /* v8 ignore next -- pos 仅在气泡挂载时设置 */
      if (el === null) return
      el.style.left = `${pos.x}px`
      const r = el.getBoundingClientRect()
      let dx = 0
      if (r.right > window.innerWidth - EDGE_MARGIN) dx = window.innerWidth - EDGE_MARGIN - r.right
      if (r.left + dx < EDGE_MARGIN) dx = EDGE_MARGIN - r.left
      el.style.left = `${pos.x + dx}px`
      if (effectiveSide === 'right') return
      const fitsBelow = pos.bottom + 8 + r.height <= window.innerHeight - EDGE_MARGIN
      const fitsAbove = pos.top - 8 - r.height >= EDGE_MARGIN
      if (placement === 'bottom' && !fitsBelow && fitsAbove) setPlacement('top')
      if (placement === 'top' && !fitsAbove && fitsBelow) setPlacement('bottom')
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [effectiveSide, placement, pos, resolved])

  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // hover 与 focus 为独立触发：仅当两者皆清除时才隐藏气泡。
  const triggers = useRef({ hover: false, focus: false })

  const cancelShow = useCallback(() => {
    if (showTimer.current === null) return
    clearTimeout(showTimer.current)
    showTimer.current = null
  }, [])

  useEffect(() => {
    if (disabled) {
      cancelShow()
      triggers.current = { hover: false, focus: false }
      setPos(null)
    }
    return cancelShow
  }, [cancelShow, disabled])

  // 同步外部 side 变化到 placement（下次 show 时也会重置，此处保证受控更新及时）。
  useEffect(() => {
    setPlacement(effectiveSide)
  }, [effectiveSide])

  // 跟随时：用鼠标 X 作为气泡 left；非跟随时：用锚点几何居中/右侧。
  const computeFollowPos = useCallback((clientX: number) => {
    const el = anchor.current
    if (el === null) return null
    const r = el.getBoundingClientRect()
    return { x: clientX, top: r.top, bottom: r.bottom }
  }, [])

  const computeFixedPos = useCallback(() => {
    const el = anchor.current
    if (el === null) return null
    const r = el.getBoundingClientRect()
    return { x: effectiveSide === 'right' ? r.right + 10 : r.left + r.width / 2, top: r.top, bottom: r.bottom }
  }, [effectiveSide])

  const show = useCallback((clientX?: number) => {
    if (disabled) return
    if (follow) {
      const cx = clientX ?? lastClientX.current
      const p = computeFollowPos(cx)
      if (p === null) return
      setPlacement(effectiveSide)
      setPos(p)
      return
    }
    const p = computeFixedPos()
    if (p === null) return
    setPlacement(effectiveSide)
    setPos(p)
  }, [computeFixedPos, computeFollowPos, disabled, effectiveSide, follow])

  const showAfterHoverDelay = useCallback((clientX?: number) => {
    cancelShow()
    if (delayMs <= 0) {
      show(clientX)
      return
    }
    showTimer.current = setTimeout(() => {
      showTimer.current = null
      show(clientX)
    }, delayMs)
  }, [cancelShow, delayMs, show])

  const hide = useCallback(() => {
    cancelShow()
    if (!triggers.current.hover && !triggers.current.focus) setPos(null)
  }, [cancelShow])

  // 内容是否为纯字符串：字符串沿用 pre-line 以支持 \n，富组件则包裹 .rich 重置为空白 normal。
  const isStringContent = typeof resolved === 'string'

  return (
    <>
      {cloneElement(children, {
        ref: mergedRef,
        onMouseEnter: (e: Parameters<MouseEventHandler>[0]) => {
          ;(children.props.onMouseEnter as unknown as MouseEventHandler | undefined)?.(e as never)
          triggers.current.hover = true
          if (follow) {
            lastClientX.current = (e as unknown as { clientX: number }).clientX
            showAfterHoverDelay(lastClientX.current)
          } else {
            showAfterHoverDelay()
          }
        },
        onMouseMove: (e: Parameters<MouseEventHandler>[0]) => {
          ;(children.props.onMouseMove as unknown as MouseEventHandler | undefined)?.(e as never)
          if (!follow) return
          if (disabled) return
          const cx = (e as unknown as { clientX: number }).clientX
          lastClientX.current = cx
          if (pos !== null) {
            const p = computeFollowPos(cx)
            if (p !== null) setPos(p)
          }
        },
        onMouseLeave: (e: Parameters<MouseEventHandler>[0]) => {
          ;(children.props.onMouseLeave as unknown as MouseEventHandler | undefined)?.(e as never)
          triggers.current.hover = false
          cancelShow()
          if (!triggers.current.focus) setPos(null)
        },
        onFocus: (e: Parameters<FocusEventHandler>[0]) => {
          ;(children.props.onFocus as unknown as FocusEventHandler | undefined)?.(e as never)
          triggers.current.focus = true
          cancelShow()
          if (follow) {
            // 键盘聚焦：居中显示，不跟随鼠标
            const el = anchor.current
            if (el === null) return
            const r = el.getBoundingClientRect()
            setPlacement(effectiveSide)
            setPos({ x: r.left + r.width / 2, top: r.top, bottom: r.bottom })
            return
          }
          show()
        },
        onBlur: (e: Parameters<FocusEventHandler>[0]) => {
          ;(children.props.onBlur as unknown as FocusEventHandler | undefined)?.(e as never)
          triggers.current.focus = false
          hide()
        },
      })}
      {pos !== null && !isEmpty && (
        <div
          ref={bubble}
          className={css.bubble}
          data-side={placement}
          style={{ left: pos.x, top: y, ...(maxWidth === undefined ? {} : { maxWidth }) }}
          role="tooltip"
        >
          {isStringContent ? resolved : <div className={css.rich}>{resolved}</div>}
        </div>
      )}
    </>
  )
}

/** 别名：用户侧常称 Tips，本包同时导出 Tips 以兼容口语化导入。 */
export const Tips = Tooltip
export type TipsSide = TooltipSide
