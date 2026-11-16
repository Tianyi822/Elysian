/**
 * EasyUI source component, adapted for Elysian.
 * Copyright (c) 2026 Suraj Maurya — MIT, see ./LICENSE.
 * Upstream: src/components/ui/sidebar.tsx
 * Revision: a64cd82c1adc0b44ec4f495e45b3b4d76f1f0143
 * Adaptations are recorded in ./upstream.json.
 */
"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import { AnimatePresence, motion, useDragControls, useIsPresent, useReducedMotion, type PanInfo } from "framer-motion";
import { ChevronRight, PanelLeft } from "lucide-react";
import { Button, type ButtonProps } from "../Button";
import { observeElementSize } from "../../utils/observeElementSize";
import { cn } from "./utils";

const spring = { type: "spring", stiffness: 420, damping: 36, mass: 0.8 } as const;
const EXPANDED = 248;
const COLLAPSED = 56;

export type SidebarChild = { id: string; label: string; badge?: string | number };
export type SidebarItem = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  badge?: string | number;
  children?: SidebarChild[];
};
export type SidebarSection = { title?: string; items: SidebarItem[] };

const SidebarContext = React.createContext({ collapsed: false });
export const useSidebar = () => React.useContext(SidebarContext);

/** Desktop shell extracted so the host keeps its route and drawer ownership. */
export function Sidebar({ collapsed, children }: { collapsed: boolean; children: React.ReactNode }) {
  const reduced = useReducedMotion();
  return <motion.aside aria-label="桌面主导航" data-easyui="sidebar" data-collapsed={collapsed || undefined}
    initial={false} animate={{ width: collapsed ? COLLAPSED : EXPANDED }}
    transition={reduced ? { duration: 0 } : spring}
    className="desktop-navigation hidden h-full shrink-0 overflow-hidden border-r border-sidebar-line bg-sidebar md:block">
    {children}
  </motion.aside>;
}

/** The host's non-nested Radix root owns focus trapping, Escape and restoration. */
export function SidebarDrawer({ open, onClose, onCloseAutoFocus, children }: {
  open: boolean; onClose(): void; onCloseAutoFocus(event: Event): void; children: React.ReactNode;
}) {
  return <AnimatePresence>{open && <Drawer key="navigation" onClose={onClose} onCloseAutoFocus={onCloseAutoFocus}>{children}</Drawer>}</AnimatePresence>;
}

function Drawer({ children, onClose, onCloseAutoFocus }: {
  children: React.ReactNode; onClose(): void; onCloseAutoFocus(event: Event): void;
}) {
  const reduced = useReducedMotion();
  const present = useIsPresent();
  const controls = useDragControls();
  return <Dialog.Portal forceMount>
    <Dialog.Overlay forceMount asChild><motion.div aria-hidden="true"
      className="fixed inset-0 z-40 bg-[var(--t-sidebar-overlay)] backdrop-blur-[2px] md:hidden"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={reduced ? { duration: 0 } : { duration: 0.2 }} />
    </Dialog.Overlay>
    <Dialog.Content forceMount asChild aria-describedby={undefined} onCloseAutoFocus={onCloseAutoFocus}>
      <motion.aside aria-hidden={!present || undefined} inert={!present}
        data-easyui="sidebar-drawer"
        className="fixed inset-y-0 left-0 z-50 w-[17rem] max-w-[85vw] overflow-hidden border-r border-sidebar-line bg-sidebar shadow-2xl outline-none md:hidden"
        initial={{ x: reduced ? 0 : "-100%" }} animate={{ x: 0 }} exit={{ x: reduced ? 0 : "-100%" }}
        transition={reduced ? { duration: 0 } : spring}
        drag="x" dragControls={controls} dragListener={false}
        dragConstraints={{ left: 0, right: 0 }} dragElastic={{ left: 0.5, right: 0 }} dragMomentum={false}
        style={{ touchAction: 'pan-y' }}
        onPointerDown={event => {
          if (!event.defaultPrevented && !(event.target as Element).closest('button,input,textarea,[data-sidebar-reorder]')) controls.start(event);
        }}
        onDragEnd={(_, info: PanInfo) => { if (info.offset.x < -80 || info.velocity.x < -400) onClose(); }}>
        <Dialog.Title className="sr-only">主导航</Dialog.Title>
        {children}
      </motion.aside>
    </Dialog.Content>
  </Dialog.Portal>;
}

/** Keep one trigger node through route changes, with the official icon geometry. */
export const SidebarTrigger = React.forwardRef<HTMLButtonElement, ButtonProps>(function SidebarTrigger({ className, ...props }, ref) {
  return <Button unstyled ref={ref} type="button" aria-label="打开主导航"
    className={cn("grid size-9 place-items-center rounded-[8px] text-sidebar-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-fg focus-visible:ring-2 focus-visible:ring-focus md:hidden", className)} {...props}>
    <PanelLeft aria-hidden className="size-[18px]" />
  </Button>;
});

export interface SidebarPanelProps {
  sections: SidebarSection[];
  activeId: string;
  onActiveChange: (id: string) => void;
  header?: React.ReactNode;
  headerAction?: React.ReactNode;
  footer?: React.ReactNode;
  collapsed: boolean;
  onToggle?: () => void;
  onNavigate?: () => void;
  navRef?: React.Ref<HTMLElement>;
  dragging?: boolean;
  renderLink?: (item: SidebarItem, props: React.ComponentProps<'a'>) => React.ReactNode;
  itemAttributes?: (item: SidebarItem) => React.HTMLAttributes<HTMLDivElement>;
  itemAction?: (item: SidebarItem) => React.ReactNode;
}

/* ───────────────────────── internals ───────────────────────── */

export function SidebarPanel({
  sections, activeId, onActiveChange, header, headerAction, footer, collapsed, onToggle, onNavigate,
  navRef, dragging = false, renderLink, itemAttributes, itemAction,
}: SidebarPanelProps) {
  const reduced = useReducedMotion();
  const transition = reduced ? { duration: 0 } : spring;
  const listRef = React.useRef<HTMLElement>(null);
  const hoveredRef = React.useRef<HTMLElement | null>(null);
  const uid = React.useId();
  const [hoverBox, setHoverBox] = React.useState<{ y: number; h: number } | null>(null);
  const [hovering, setHovering] = React.useState(false);

  const [open, setOpen] = React.useState<Set<string>>(
    () =>
      new Set(
        sections
          .flatMap((s) => s.items)
          .filter((i) => i.children?.some((c) => c.id === activeId))
          .map((i) => i.id)
      )
  );

  const measureHover = React.useCallback(() => {
    const el = hoveredRef.current;
    const list = listRef.current;
    if (!el || !list || !el.isConnected) return;
    setHoverBox({ y: el.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop, h: el.offsetHeight });
  }, []);
  React.useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    measureHover();
    return observeElementSize([list], measureHover);
  }, [collapsed, sections, measureHover]);
  React.useEffect(() => { if (dragging) setHovering(false); }, [dragging]);

  const enter = (e: React.MouseEvent<HTMLElement> | React.FocusEvent<HTMLElement>) => {
    hoveredRef.current = e.currentTarget;
    measureHover();
    setHovering(true);
  };

  const renderItem = (item: SidebarItem) => {
    const hasChildren = !!item.children?.length;
    const isOpen = hasChildren && open.has(item.id) && !collapsed;
    const childActive = !!item.children?.some((c) => c.id === activeId);
    const isActive = !hasChildren && activeId === item.id;

    const onClick = () => {
      if (!hasChildren) {
        onActiveChange(item.id);
        onNavigate?.();
      } else if (collapsed) {
        onToggle?.();
        setOpen((p) => new Set(p).add(item.id));
      } else {
        setOpen((p) => {
          const n = new Set(p);
          if (n.has(item.id)) n.delete(item.id);
          else n.add(item.id);
          return n;
        });
      }
    };

    const action = !collapsed ? itemAction?.(item) : undefined;
    const children = (<>
          {isActive && (
            <motion.span
              aria-hidden data-sidebar-active layoutId={`${uid}-active`}
              transition={transition}
              className="absolute inset-0 rounded-[8px] bg-sidebar-active"
            />
          )}
          <span className="relative grid size-5 shrink-0 place-items-center [&>svg]:size-[18px]">{item.icon}</span>
          <motion.span
            initial={false}
            animate={{ opacity: collapsed ? 0 : 1 }}
            transition={{ duration: reduced ? 0 : 0.15 }}
            className="relative flex-1 truncate whitespace-nowrap text-left"
          >
            {item.label}
          </motion.span>
          {!collapsed && item.badge !== undefined && (
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="relative rounded-[6px] bg-sidebar-active px-1.5 text-[11px] tabular-nums text-sidebar-muted"
            >
              {item.badge}
            </motion.span>
          )}
          {!collapsed && hasChildren && (
            <ChevronRight
              className={cn(
                "relative size-3.5 shrink-0 text-sidebar-subtle transition-transform duration-200 motion-reduce:transition-none",
                isOpen && "rotate-90"
              )}
            />
          )}
        </>);
    const controlProps = {
      onClick,
      onMouseEnter: enter,
      onFocus: enter,
      'aria-label': collapsed ? item.label : undefined,
      'aria-expanded': hasChildren ? isOpen : undefined,
      'aria-current': isActive ? 'page' as const : undefined,
      className: cn('nav-link relative flex h-9 w-full items-center gap-3 rounded-[8px] px-2.5 text-sm no-underline outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus/50',
        isActive || childActive ? 'text-sidebar-fg' : 'text-sidebar-muted hover:text-sidebar-fg',
        Boolean(action) && 'pr-9'),
      children,
    };
    const control = !hasChildren && renderLink ? renderLink(item, controlProps) : <Button unstyled type="button" {...controlProps} />;
    return (
      <div key={item.id} {...itemAttributes?.(item)}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>{control}</Tooltip.Trigger>
          {collapsed && <Tooltip.Portal><Tooltip.Content side="right" sideOffset={10}
            className="z-[80] whitespace-nowrap rounded-[6px] bg-sidebar-fg px-2 py-1 text-xs font-medium text-sidebar shadow-lg motion-safe:data-[state=delayed-open]:animate-[sidebar-tip-in_120ms_ease-out] motion-safe:data-[state=instant-open]:animate-[sidebar-tip-in_120ms_ease-out]">{item.label}</Tooltip.Content></Tooltip.Portal>}
        </Tooltip.Root>
        {action}

        <AnimatePresence initial={false}>
          {isOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: reduced ? 0 : 0.22, ease: [0.32, 0.72, 0, 1] }}
              className="overflow-hidden"
            >
              <div className="ml-[19px] mt-0.5 space-y-0.5 border-l border-sidebar-line py-0.5 pl-3">
                {item.children!.map((c) => {
                  const active = c.id === activeId;
                  return (
                    <Button unstyled
                      key={c.id}
                      type="button"
                      onClick={() => {
                        onActiveChange(c.id);
                        onNavigate?.();
                      }}
                      onMouseEnter={() => setHovering(false)}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "relative flex h-8 w-full items-center gap-2 rounded-[6px] px-2 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus/50",
                        active
                          ? "text-sidebar-fg"
                          : "text-sidebar-muted hover:text-sidebar-fg"
                      )}
                    >
                      {active && (
                        <motion.span
                          layoutId={`${uid}-dot`}
                          transition={transition}
                          className="absolute -left-[15.5px] top-[13px] size-1.5 rounded-full bg-sidebar-fg"
                        />
                      )}
                      <span className="flex-1 truncate text-left">{c.label}</span>
                      {c.badge !== undefined && (
                        <span className="text-[11px] tabular-nums text-sidebar-subtle">{c.badge}</span>
                      )}
                    </Button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  };

  return (
    <SidebarContext.Provider value={{ collapsed }}>
      <div className="flex h-full flex-col">
        {header && (
          <div
            className={cn(
              "flex h-14 shrink-0 items-center justify-between overflow-hidden px-4",
              collapsed && "w-14 justify-center px-0"
            )}
          >
            <div data-sidebar-swipe className="min-w-0">{header}</div>
            {headerAction}
          </div>
        )}

        <nav
          aria-label="主导航"
          ref={node => { listRef.current = node; if (typeof navRef === 'function') navRef(node); else if (navRef) navRef.current = node; }}
          onMouseLeave={() => {
            setHovering(false);
          }}
          className="relative min-h-0 flex-1 space-y-1 overflow-y-auto overflow-x-hidden p-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {hoverBox && (
            <motion.span
              aria-hidden
              data-sidebar-hover
              initial={false}
              animate={{ y: hoverBox.y, height: hoverBox.h, opacity: hovering && !dragging ? 1 : 0 }}
              transition={reduced ? { duration: 0 } : { y: spring, height: spring, opacity: { duration: 0.15 } }}
              className="pointer-events-none absolute inset-x-2 top-0 rounded-[8px] bg-sidebar-hover"
            />
          )}

          {sections.map((section, i) => (
            <div key={i} className="space-y-0.5">
              {section.title &&
                (collapsed ? (
                  <div className="mx-2.5 my-2 h-px bg-sidebar-line" />
                ) : (
                  <p className="truncate px-2.5 pb-1 pt-4 text-xs text-sidebar-subtle">
                    {section.title}
                  </p>
                ))}
              {section.items.map(renderItem)}
            </div>
          ))}
        </nav>

        {(footer || onToggle) && (
          <div className="shrink-0 space-y-1 border-t border-sidebar-line p-2">
            {footer}
            {onToggle && (
              <Button unstyled
                type="button"
                onClick={onToggle}
                aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
                aria-expanded={!collapsed}
                aria-keyshortcuts="Meta+B Control+B"
                data-sidebar-toggle
                className="flex h-9 w-full items-center gap-3 rounded-[8px] px-2.5 text-sm text-sidebar-muted outline-none transition-colors hover:bg-sidebar-hover hover:text-sidebar-fg focus-visible:ring-2 focus-visible:ring-focus/50"
              >
                <span className="grid size-5 shrink-0 place-items-center">
                  <PanelLeft aria-hidden className="size-[18px]" />
                </span>
                <motion.span
                  initial={false}
                  animate={{ opacity: collapsed ? 0 : 1 }}
                  transition={{ duration: reduced ? 0 : 0.15 }}
                  className="flex-1 whitespace-nowrap text-left"
                >
                  收起侧边栏
                </motion.span>
                {!collapsed && (
                  <kbd className="rounded border border-sidebar-line px-1 font-sans text-[10px] text-sidebar-subtle">
                    ⌘B
                  </kbd>
                )}
              </Button>
            )}
          </div>
        )}
      </div>
    </SidebarContext.Provider>
  );
}
