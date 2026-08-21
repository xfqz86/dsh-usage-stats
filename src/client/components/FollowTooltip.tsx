/**
 * 鼠标跟随的 Tooltip：用于三色比例条等宽条形锚点。
 * 复用 Tooltip 的视觉（dark plate、white text），但水平位置跟随鼠标，
 * 垂直位置仍锚定到条的边缘，避免 tooltip 远离鼠标。
 * 独立成文件（一个组件一个文件）。
 */

import { cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FocusEvent, FocusEventHandler, MouseEvent, MouseEventHandler, MutableRefObject, ReactElement, Ref } from 'react'
import css from './FollowTooltip.module.css'

type Side = 'top' | 'bottom' | 'right'

interface AnchorProps {
  ref?: Ref<HTMLElement> | undefined
  onMouseEnter?: MouseEventHandler | undefined
  onMouseMove?: MouseEventHandler | undefined
  onMouseLeave?: MouseEventHandler | undefined
  onFocus?: FocusEventHandler | undefined
  onBlur?: FocusEventHandler | undefined
}

export function FollowTooltip({
  label,
  side = 'bottom',
  delayMs = 0,
  disabled = false,
  children,
}: {
  label: string
  side?: Side
  delayMs?: number
  disabled?: boolean
  children: ReactElement<AnchorProps>
}) {
  const anchor = useRef<HTMLElement | null>(null)
  const childRef = (children as ReactElement<AnchorProps> & { ref?: Ref<HTMLElement> }).ref
  const mergedRef = useCallback((el: HTMLElement | null) => {
    anchor.current = el
    if (typeof childRef === 'function') childRef(el)
    else if (childRef != null) (childRef as MutableRefObject<HTMLElement | null>).current = el
  }, [childRef])

  const [pos, setPos] = useState<{ x: number; top: number; bottom: number } | null>(null)
  const [placement, setPlacement] = useState<Side>(side)
  const bubble = useRef<HTMLSpanElement | null>(null)
  const lastClientX = useRef<number>(0)
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const EDGE_MARGIN = 12

  // 根据侧边与锚点矩形计算纵坐标
  const y = pos === null
    ? 0
    : placement === 'right'
      ? pos.top + (pos.bottom - pos.top) / 2
      : placement === 'top' ? pos.top - 8 : pos.bottom + 8

  useLayoutEffect(() => {
    if (pos === null) return
    const fit = () => {
      const el = bubble.current
      if (el === null) return
      el.style.left = `${pos.x}px`
      const r = el.getBoundingClientRect()
      let dx = 0
      if (r.right > window.innerWidth - EDGE_MARGIN) dx = window.innerWidth - EDGE_MARGIN - r.right
      if (r.left + dx < EDGE_MARGIN) dx = EDGE_MARGIN - r.left
      el.style.left = `${pos.x + dx}px`
      if (side === 'right') return
      const fitsBelow = pos.bottom + 8 + r.height <= window.innerHeight - EDGE_MARGIN
      const fitsAbove = pos.top - 8 - r.height >= EDGE_MARGIN
      if (placement === 'bottom' && !fitsBelow && fitsAbove) setPlacement('top')
      if (placement === 'top' && !fitsAbove && fitsBelow) setPlacement('bottom')
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [placement, pos, side, label])

  const cancelShow = useCallback(() => {
    if (showTimer.current === null) return
    clearTimeout(showTimer.current)
    showTimer.current = null
  }, [])

  useEffect(() => {
    if (disabled) {
      cancelShow()
      setPos(null)
    }
    return cancelShow
  }, [cancelShow, disabled])

  // 同步 side 变化
  useEffect(() => {
    setPlacement(side)
  }, [side])

  const computePos = (clientX: number) => {
    const el = anchor.current
    if (el === null) return null
    const r = el.getBoundingClientRect()
    return { x: clientX, top: r.top, bottom: r.bottom }
  }

  const show = (clientX: number) => {
    if (disabled) return
    const p = computePos(clientX)
    if (p === null) return
    setPlacement(side)
    setPos(p)
  }

  const showAfterDelay = (clientX: number) => {
    cancelShow()
    if (delayMs <= 0) {
      show(clientX)
      return
    }
    showTimer.current = setTimeout(() => {
      showTimer.current = null
      show(clientX)
    }, delayMs)
  }

  return (
    <>
      {cloneElement(children, {
        ref: mergedRef,
        onMouseEnter: (e: MouseEvent<HTMLElement>) => {
          ;(children.props.onMouseEnter as unknown as MouseEventHandler | undefined)?.(e as never)
          if (disabled) return
          lastClientX.current = e.clientX
          showAfterDelay(lastClientX.current)
        },
        onMouseMove: (e: MouseEvent<HTMLElement>) => {
          ;(children.props.onMouseMove as unknown as MouseEventHandler | undefined)?.(e as never)
          if (disabled) return
          const cx = e.clientX
          lastClientX.current = cx
          // 已显示则跟随
          if (pos !== null) {
            const p = computePos(cx)
            if (p !== null) setPos(p)
          }
        },
        onMouseLeave: (e: MouseEvent<HTMLElement>) => {
          ;(children.props.onMouseLeave as unknown as MouseEventHandler | undefined)?.(e as never)
          cancelShow()
          setPos(null)
        },
        onFocus: (e: FocusEvent<HTMLElement>) => {
          ;(children.props.onFocus as unknown as FocusEventHandler | undefined)?.(e as never)
          if (disabled) return
          cancelShow()
          // 键盘聚焦：居中显示
          const el = anchor.current
          if (el === null) return
          const r = el.getBoundingClientRect()
          setPlacement(side)
          setPos({ x: r.left + r.width / 2, top: r.top, bottom: r.bottom })
        },
        onBlur: (e: FocusEvent<HTMLElement>) => {
          ;(children.props.onBlur as unknown as FocusEventHandler | undefined)?.(e as never)
          setPos(null)
        },
      })}
      {pos !== null && label !== '' && (
        <span
          ref={bubble}
          className={css.bubble}
          data-side={placement}
          style={{ left: pos.x, top: y }}
          role="tooltip"
        >
          {label}
        </span>
      )}
    </>
  )
}
