import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  adjacentTabStopIndex,
  initialMenuIndex,
  menuOwnerAllowsInteraction,
  moveMenuIndex,
  orderedTabStopIndexes,
  type MenuMove,
  type MenuOpenFocus,
  type TabDirection,
} from './menu-navigation.ts'
import styles from './AccessibleAppMenu.module.css'

export interface AccessibleAppMenuItem {
  id: string
  label: string
}

export interface AccessibleAppMenuProps {
  items: readonly AccessibleAppMenuItem[]
  selectedId: string
  triggerLabel: string
  triggerClassName: string
  triggerIcon: ReactNode
  onOpening(): void
  onSelect(id: string): void
}

interface MenuPosition {
  left: number
  top: number
  visible: boolean
}

const VIEWPORT_MARGIN = 12
const MENU_GAP = 4
const INSTANCE_VIEW_SELECTOR = '.instance-view'
const TAB_STOP_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'iframe',
  'object',
  'embed',
  'summary',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
].join(',')

function elementIsRendered(element: HTMLElement): boolean {
  try {
    if (typeof element.checkVisibility === 'function') {
      return element.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true })
    }

    const view = element.ownerDocument.defaultView
    if (view === null) return false
    for (let current: HTMLElement | null = element; current !== null; current = current.parentElement) {
      const style = view.getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
        return false
      }
    }
    return true
  } catch {
    // DOM visibility is an execution guard here, not cosmetic metadata. Any
    // unexpected browser/realm failure therefore closes rather than guesses.
    return false
  }
}

function owningInstanceView(trigger: HTMLElement | null): HTMLElement | null {
  return trigger?.closest<HTMLElement>(INSTANCE_VIEW_SELECTOR) ?? null
}

function ownerAllowsInteraction(trigger: HTMLElement | null, owner: HTMLElement | null): boolean {
  if (trigger === null || owner === null) return false
  return menuOwnerAllowsInteraction({
    triggerConnected: trigger.isConnected,
    ownerConnected: owner.isConnected,
    ownerContainsTrigger: owner.contains(trigger),
    ownerIsInstanceView: owner.matches(INSTANCE_VIEW_SELECTOR),
    ownerHasInactiveClass:
      owner.classList.contains('instance-hidden') || owner.classList.contains('instance-pending'),
    ownerHidden: owner.hasAttribute('hidden'),
    ownerAriaHidden: owner.getAttribute('aria-hidden') === 'true',
    rendered: elementIsRendered(trigger) && elementIsRendered(owner),
  })
}

function isTabStop(element: HTMLElement, excludedTree: HTMLElement | null): boolean {
  if (excludedTree?.contains(element) === true) return false
  if (element.tabIndex < 0 || element.matches(':disabled')) return false
  if (element.closest('[inert], [hidden], [aria-hidden="true"]') !== null) return false
  return elementIsRendered(element)
}

/** The menu is portalled to body, so native Tab would continue from the
 * portal's body position. Resolve the adjacent focus stop around the trigger
 * in the original document order instead. */
function adjacentTabStop(
  trigger: HTMLElement,
  menu: HTMLElement | null,
  direction: TabDirection,
): HTMLElement | null {
  const candidates = Array.from(
    trigger.ownerDocument.querySelectorAll<HTMLElement>(TAB_STOP_SELECTOR),
  ).filter(element => isTabStop(element, menu))
  const triggerDocumentIndex = candidates.indexOf(trigger)
  if (triggerDocumentIndex < 0) return null
  const orderedIndexes = orderedTabStopIndexes(candidates.map(element => element.tabIndex))
  const targetDocumentIndex = adjacentTabStopIndex(orderedIndexes, triggerDocumentIndex, direction)
  return targetDocumentIndex < 0 ? null : candidates[targetDocumentIndex] ?? null
}

/** Watch only the trigger's ancestor chain while the portal is open. This
 * catches the owning InstanceView's active/hidden class transition and every
 * possible disconnect point without observing unrelated streaming DOM. */
function observeOwnerLifetime(
  trigger: HTMLElement,
  owner: HTMLElement,
  onLost: () => void,
): () => void {
  const Observer = trigger.ownerDocument.defaultView?.MutationObserver
  if (Observer === undefined) {
    onLost()
    return () => undefined
  }

  const watched = new Set<Node>()
  for (let current: Node | null = trigger; current !== null; current = current.parentNode) {
    watched.add(current)
  }

  const observer = new Observer((records) => {
    const ancestorAttributeChanged = records.some(record => record.type === 'attributes')
    const ownerChainRemoved = records.some(record =>
      Array.from(record.removedNodes).some(removed =>
        Array.from(watched).some(watchedNode => removed === watchedNode || removed.contains(watchedNode)),
      ),
    )
    if (ancestorAttributeChanged || ownerChainRemoved || !ownerAllowsInteraction(trigger, owner)) {
      onLost()
    }
  })

  for (const node of watched) {
    if (node.nodeType === 1) {
      observer.observe(node, {
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
        childList: true,
      })
    } else {
      observer.observe(node, { childList: true })
    }
  }
  return () => observer.disconnect()
}

/** Owned accessible menu: the pinned vendor Menu has no focus transfer or
 * roving keyboard navigation, so this small surface implements those semantics
 * locally while retaining the required body portal and design tokens. */
export function AccessibleAppMenu({
  items,
  selectedId,
  triggerLabel,
  triggerClassName,
  triggerIcon,
  onOpening,
  onSelect,
}: AccessibleAppMenuProps) {
  const [open, setOpen] = useState(false)
  const [focusIndex, setFocusIndex] = useState(-1)
  const [position, setPosition] = useState<MenuPosition>({ left: 0, top: 0, visible: false })
  const openFocus = useRef<MenuOpenFocus>('selected')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const ownerRef = useRef<HTMLElement | null>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const triggerId = useId()
  const menuId = useId()
  const ids = items.map(item => item.id)

  const dismissForOwnerLoss = (): void => {
    const menu = menuRef.current
    // MutationObserver callbacks are outside React's event boundary. Make the
    // detached portal non-visible and non-interactive synchronously, then let
    // state removal perform the normal React cleanup.
    if (menu !== null) {
      menu.style.visibility = 'hidden'
      menu.setAttribute('inert', '')
    }
    const active = menu?.ownerDocument.activeElement
    if (active !== null && active !== undefined && menu?.contains(active) === true) {
      ;(active as HTMLElement).blur()
    }
    ownerRef.current = null
    setOpen(false)
  }

  const currentOwnerAllowsInteraction = (): boolean =>
    ownerAllowsInteraction(triggerRef.current, ownerRef.current)

  const place = (): void => {
    if (!currentOwnerAllowsInteraction()) {
      dismissForOwnerLoss()
      return
    }
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (trigger === null || menu === null) return
    const anchor = trigger.getBoundingClientRect()
    const width = menu.offsetWidth
    const height = menu.offsetHeight
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const left = Math.min(
      Math.max(anchor.right - width, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN),
    )
    const below = anchor.bottom + MENU_GAP
    const above = anchor.top - height - MENU_GAP
    const preferredTop = below + height <= viewportHeight - VIEWPORT_MARGIN ? below : above
    const top = Math.min(
      Math.max(preferredTop, VIEWPORT_MARGIN),
      Math.max(VIEWPORT_MARGIN, viewportHeight - height - VIEWPORT_MARGIN),
    )
    setPosition({ left, top, visible: true })
  }

  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    const owner = ownerRef.current
    if (trigger === null || owner === null || !ownerAllowsInteraction(trigger, owner)) {
      dismissForOwnerLoss()
      return
    }
    return observeOwnerLifetime(trigger, owner, dismissForOwnerLoss)
  }, [open])

  useLayoutEffect(() => {
    if (!open) {
      setPosition({ left: 0, top: 0, visible: false })
      return
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, items.length])

  useEffect(() => {
    if (!open) return
    if (!currentOwnerAllowsInteraction()) {
      dismissForOwnerLoss()
      return
    }
    const initial = initialMenuIndex(ids, selectedId, openFocus.current)
    setFocusIndex(initial)
    itemRefs.current[initial]?.focus()
  }, [open, selectedId, ids.join('\u0000')])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (triggerRef.current?.contains(event.target) === true) return
      if (menuRef.current?.contains(event.target) === true) return
      ownerRef.current = null
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const openMenu = (intent: MenuOpenFocus): void => {
    const trigger = triggerRef.current
    const owner = owningInstanceView(trigger)
    if (!ownerAllowsInteraction(trigger, owner)) return
    ownerRef.current = owner
    openFocus.current = intent
    onOpening()
    setOpen(true)
  }

  const closeToTrigger = (): void => {
    setOpen(false)
    const trigger = triggerRef.current
    const owner = ownerRef.current
    ownerRef.current = null
    if (ownerAllowsInteraction(trigger, owner)) trigger?.focus()
    else dismissForOwnerLoss()
  }

  const moveFocus = (move: MenuMove): void => {
    const next = moveMenuIndex(items.length, focusIndex, move)
    setFocusIndex(next)
    itemRefs.current[next]?.focus()
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!currentOwnerAllowsInteraction()) {
      event.preventDefault()
      event.stopPropagation()
      dismissForOwnerLoss()
      return
    }
    const moves: Partial<Record<string, MenuMove>> = {
      ArrowDown: 'next',
      ArrowUp: 'previous',
      Home: 'first',
      End: 'last',
    }
    const move = moves[event.key]
    if (move !== undefined) {
      event.preventDefault()
      moveFocus(move)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeToTrigger()
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      const trigger = triggerRef.current
      const target = trigger === null
        ? null
        : adjacentTabStop(trigger, menuRef.current, event.shiftKey ? 'backward' : 'forward')
      setOpen(false)
      ownerRef.current = null
      if (target !== null) target.focus()
      else trigger?.blur()
    }
  }

  const menu = open && typeof document !== 'undefined'
    ? createPortal(
      <div
        ref={menuRef}
        id={menuId}
        className={styles.menu}
        role="menu"
        aria-labelledby={triggerId}
        style={{ left: position.left, top: position.top, visibility: position.visible ? 'visible' : 'hidden' }}
        onKeyDown={onMenuKeyDown}
        onPointerDownCapture={(event) => {
          if (currentOwnerAllowsInteraction()) return
          event.preventDefault()
          event.stopPropagation()
          dismissForOwnerLoss()
        }}
        onClickCapture={(event) => {
          if (currentOwnerAllowsInteraction()) return
          event.preventDefault()
          event.stopPropagation()
          dismissForOwnerLoss()
        }}
        onFocusCapture={(event) => {
          if (currentOwnerAllowsInteraction()) return
          event.stopPropagation()
          dismissForOwnerLoss()
        }}
      >
        {items.map((item, index) => {
          const selected = item.id === selectedId
          return (
            <button
              key={item.id}
              ref={(node) => { itemRefs.current[index] = node }}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              className={styles.item}
              tabIndex={index === focusIndex ? 0 : -1}
              onFocus={() => {
                if (!currentOwnerAllowsInteraction()) {
                  dismissForOwnerLoss()
                  return
                }
                setFocusIndex(index)
              }}
              onClick={() => {
                const trigger = triggerRef.current
                const owner = ownerRef.current
                if (!ownerAllowsInteraction(trigger, owner)) {
                  dismissForOwnerLoss()
                  return
                }
                setOpen(false)
                ownerRef.current = null
                trigger?.focus()
                // A focus listener may synchronously switch InstanceView.
                // Recheck before dispatching the source-bound launch.
                if (!ownerAllowsInteraction(trigger, owner)) return
                onSelect(item.id)
              }}
            >
              <span className={styles.label}>{item.label}</span>
              {selected && (
                <svg className={styles.check} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path d="M2.2 8.2 6.3 12l7.5-8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          )
        })}
      </div>,
      document.body,
    )
    : null

  return (
    <span className={styles.root}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={triggerClassName}
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            openMenu(event.key === 'ArrowDown' ? 'first' : 'last')
          }
        }}
        onClick={() => {
          if (open) {
            setOpen(false)
            ownerRef.current = null
          } else {
            openMenu('selected')
          }
        }}
      >
        {triggerIcon}
      </button>
      {menu}
    </span>
  )
}
