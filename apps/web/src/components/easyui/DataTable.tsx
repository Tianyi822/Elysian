/* EasyUI — MIT. Upstream f7193ce6f96d38fb39734c0ed8be43567a7eee4a.
 * Adaptations: semantic colors, Chinese labels, controlled query, stable row IDs,
 * file interactions and selection lifecycle. See upstream.json and LICENSE. */
"use client";

import React, {
  type ReactNode,
  type ReactElement,
  type Ref,
  cloneElement,
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Button } from "../Button";
import { IconButton } from "../IconButton";
import { X } from "../icons";
import { SelectDropdown } from "../SelectDropdown";
import { useImeEnterGuard } from "../useImeEnterGuard";
import "./data-table.css";

/* -------------------------------------------------------------------------- */
/*  DataTable — the other half of every dashboard.                             */
/*                                                                             */
/*  • Sortable columns (click: asc → desc → off) · sticky header               */
/*  • Row selection with select-all, shift-click ranges and a bulk-action bar  */
/*  • <Sparkline /> and <DeltaPill /> ready to drop into any cell              */
/*  • Sorting makes rows glide to their new place instead of jumping           */
/*  • Under 640px the table becomes stacked cards (with a sort menu)           */
/*  • Search, scroll-driven row mounting, empty state, keyboard + a11y support  */
/*                                                                             */
/*  One file · deps: react 19, framer-motion, tailwindcss · light + dark.      */
/* -------------------------------------------------------------------------- */

/* ========================================================================== */
/*  Types                                                                     */
/* ========================================================================== */

type Primitive = string | number | boolean | Date | null | undefined;

export interface DataTableColumn<T> {
  /** Unique id. Also the default property read from the row */
  key: string;
  header: string;
  /** Value used for sorting + search (default: row[key]) */
  accessor?: (row: T) => Primitive;
  /** What to show in the cell (default: the accessor value as text) */
  cell?: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  /** Default true */
  sortable?: boolean;
  /** A CSS grid track: "120px", "1.4fr", "minmax(0, 2fr)" */
  width?: string;
  /** The card title on mobile. Usually your first column */
  primary?: boolean;
  hideOnMobile?: boolean;
  /** Label used on mobile cards (default: header) */
  mobileLabel?: string;
  /** On mobile cards, give this cell the whole row width (great for sparklines) */
  fullWidthOnMobile?: boolean;
}

export type SortState = { key: string; dir: "asc" | "desc" } | null;
export type Id = string | number;

export interface DataTableProps<T> {
  rows: readonly T[];
  columns: readonly DataTableColumn<T>[];
  /** Readable name for a row, used by checkboxes and screen readers */
  getRowLabel?: (row: T) => string;
  selectable?: boolean;
  /** Whether a row participates in individual, range and select-all operations. */
  isRowSelectable?: (row: T) => boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Extra text to match when searching */
  searchText?: (row: T) => string;
  defaultSort?: SortState;
  /** Controlled sort */
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  /** Controlled selection */
  selected?: Id[];
  onSelectionChange?: (ids: Id[]) => void;
  /** Buttons shown in the bar when rows are selected */
  bulkActions?: (selectedIds: Id[]) => ReactNode;
  /** Action next to the search field, shown only in the normal toolbar. */
  searchAction?: ReactNode;
  /** Right side of the toolbar, replacing the row count when provided */
  toolbar?: ReactNode;
  /** Show the default row count in the normal toolbar (default true). */
  showRowCount?: boolean;
  /** Persistent navigation, retained while selection replaces search/actions. */
  toolbarNavigation?: ReactNode;
  /** Rows mounted per batch; the rest mount as the body scrolls (default 20, Infinity = all) */
  pageSize?: number;
  /** Desktop scroll height in px, or the remaining main/window height (default "viewport"). */
  maxHeight?: number | "viewport";
  /** Optional card list scroll height in px. By default, cards scroll with the page. */
  maxCardHeight?: number;
  /** Minimum desktop table width in px; overflow scrolls inside the table. Cards stay fluid. */
  minWidth?: number;
  density?: "comfortable" | "compact";
  /** Width below which rows become cards (default 640) */
  cardBreakpoint?: number;
  onRowClick?: (row: T) => void;
  emptyState?: ReactNode;
  ariaLabel?: string;
  className?: string;
  getRowId?: (row: T) => Id;
  query?: string;
  onQueryChange?: (query: string) => void;
  filterMode?: "client" | "external";
  searchLabel?: string;
  selectionKey?: string;
  busy?: boolean;
  active?: boolean;
  onRowDoubleClick?: (row: T) => void;
  onRowActivate?: (row: T) => void;
  onRowFocus?: (row: T) => void;
  rowKeyboardNav?: boolean;
  highlighted?: (row: T) => boolean;
  rowTitle?: (row: T) => string | undefined;
  rowWrapper?: (row: T, element: ReactElement) => ReactNode;
}

/* ========================================================================== */
/*  Helpers                                                                   */
/* ========================================================================== */

const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");
const ring = "ring-1 ring-line ";
const hairline = "border-line ";
const muted = "text-fg-muted";
const focus =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus/70 ";

function useElementWidth<T extends HTMLElement>(initial: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.round(el.clientWidth) || initial);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [initial]);
  return [ref, width] as const;
}

/** Nulls last, numbers numerically, dates by time, strings naturally ("item 2" < "item 10") */
function compareValues(a: Primitive, b: Primitive): number {
  if (a instanceof Date) a = +a;
  if (b instanceof Date) b = +b;
  if (typeof a === "boolean") a = a ? 1 : 0;
  if (typeof b === "boolean") b = b ? 1 : 0;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

function sortRows<T>(rows: T[], get: (row: T) => Primitive, dir: "asc" | "desc"): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: get(row) }))
    .sort((p, q) => {
      const pn = p.v == null, qn = q.v == null;
      if (pn || qn) return pn && qn ? p.i - q.i : pn ? 1 : -1; // empty values always last
      return compareValues(p.v, q.v) * sign || p.i - q.i; // stable
    })
    .map((x) => x.row);
}

/* Official checkbox and sort controls. Unused demo chart cells are omitted. */

const WrappedTableRow = forwardRef<HTMLDivElement, { element: ReactElement; wrap: (element: ReactElement) => ReactNode }>(function WrappedTableRow({ element, wrap }, ref) {
  return wrap(cloneElement(element as ReactElement<{ ref?: Ref<HTMLDivElement> }>, { ref }));
});

function Checkbox({
  checked,
  indeterminate,
  onToggle,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onToggle: (e: React.MouseEvent) => void;
  label: string;
}) {
  const on = checked || !!indeterminate;
  return (
    <Button unstyled
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={label}
      onClick={onToggle}
      className={cx(
        "relative grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[6px] transition-[background-color,box-shadow] duration-150 [-webkit-tap-highlight-color:transparent]",
        "before:absolute before:-inset-3 before:content-['']", // generous touch target
        on ? "bg-fg " : "bg-transparent ring-1 ring-inset ring-control-line ",
        focus,
      )}
    >
      <svg viewBox="0 0 16 16" className="h-3 w-3 text-surface " fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <motion.path
          d={indeterminate ? "M4 8h8" : "M3.5 8.5l3 3 6-6.5"}
          initial={false}
          animate={{ pathLength: on ? 1 : 0, opacity: on ? 1 : 0 }}
          transition={{ duration: 0.18, ease: EASE_OUT }}
        />
      </svg>
    </Button>
  );
}

function SortIcon({ state }: { state: "asc" | "desc" | null }) {
  return (
    <svg viewBox="0 0 12 14" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 5.2 6 2.2l3 3" className={cx("transition-opacity duration-150", state === "asc" ? "opacity-100" : state === "desc" ? "opacity-20" : "opacity-40")} />
      <path d="M3 8.8l3 3 3-3" className={cx("transition-opacity duration-150", state === "desc" ? "opacity-100" : state === "asc" ? "opacity-20" : "opacity-40")} />
    </svg>
  );
}

const alignClass = { left: "justify-start text-left", right: "justify-end text-right", center: "justify-center text-center" } as const;

/* ========================================================================== */
/*  DataTable                                                                 */
/* ========================================================================== */

export function DataTable<T>({
  rows,
  columns,
  getRowId = (r) => (r as { id: Id }).id,
  getRowLabel = (r) => String(getRowId(r)),
  selectable = true,
  isRowSelectable,
  searchable = true,
  searchPlaceholder = "搜索…",
  searchText,
  defaultSort = null,
  sort: controlledSort,
  onSortChange,
  selected: controlledSelected,
  onSelectionChange,
  bulkActions,
  searchAction,
  toolbar,
  showRowCount = true,
  toolbarNavigation,
  pageSize = 20,
  maxHeight = "viewport",
  maxCardHeight,
  minWidth = 560,
  density = "comfortable",
  cardBreakpoint = 640,
  onRowClick,
  emptyState,
  ariaLabel = "数据表格",
  className = "",
  query: controlledQuery, onQueryChange, filterMode = "client", searchLabel,
  selectionKey, busy, active = true, onRowDoubleClick, onRowActivate, onRowFocus,
  rowKeyboardNav, highlighted, rowTitle, rowWrapper,
}: DataTableProps<T>) {
  const reduce = useReducedMotion();
  const [rootRef, width] = useElementWidth<HTMLDivElement>(960);
  const cards = width < cardBreakpoint;
  const bodyScrolls = !cards || maxCardHeight !== undefined;
  const bodyMaxHeight = cards ? maxCardHeight : maxHeight === "viewport" ? undefined : maxHeight;
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [viewportMaxHeight, setViewportMaxHeight] = useState<number>();
  const [toolbarHeight, setToolbarHeight] = useState(44);
  const toolbarObserver = useRef<ResizeObserver | null>(null);
  const measureToolbar = useCallback((node: HTMLDivElement | null) => {
    toolbarObserver.current?.disconnect();
    toolbarObserver.current = null;
    if (!node) return;
    const update = () => setToolbarHeight(Math.max(44, node.offsetHeight));
    update();
    toolbarObserver.current = new ResizeObserver(update);
    toolbarObserver.current.observe(node);
  }, []);

  const [innerQuery, setInnerQuery] = useState("");
  const query = controlledQuery ?? innerQuery;
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreSearchFocus = useRef(false);
  const { guardProps, isImeKey } = useImeEnterGuard();
  const setQuery = (value: string) => {
    if (controlledQuery === undefined) setInnerQuery(value);
    onQueryChange?.(value);
  };
  const [innerSort, setInnerSort] = useState<SortState>(defaultSort);
  const [innerSel, setInnerSel] = useState<Id[]>([]);
  const [limit, setLimit] = useState(pageSize);
  const [scrolled, setScrolled] = useState(false);
  const [announce, setAnnounce] = useState("");
  const lastClicked = useRef<Id | null>(null);

  const sort = controlledSort !== undefined ? controlledSort : innerSort;
  const rowIds = useMemo(() => new Set((isRowSelectable ? rows.filter(isRowSelectable) : rows).map(getRowId)), [rows, getRowId, isRowSelectable]);
  const rawSelected = controlledSelected ?? innerSel;
  const selectedIds = useMemo(() => rawSelected.filter(id => rowIds.has(id)), [rawSelected, rowIds]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  const setSort = (s: SortState) => {
    if (controlledSort === undefined) setInnerSort(s);
    onSortChange?.(s);
    const col = columns.find((c) => c.key === s?.key);
    setAnnounce(s && col ? `已按${col.header}${s.dir === "asc" ? "升序" : "降序"}排列` : "已恢复默认顺序");
    lastClicked.current = null;
  };
  const setSelected = (ids: Id[]) => {
    if (controlledSelected === undefined) setInnerSel(ids);
    onSelectionChange?.(ids);
  };

  const read = useCallback(
    (row: T, col: DataTableColumn<T>): Primitive => (col.accessor ? col.accessor(row) : ((row as Record<string, unknown>)[col.key] as Primitive)),
    [],
  );

  /* ----------------------------- filter + sort ----------------------------- */
  const processed = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = [...rows];
    if (q && filterMode === "client")
      list = rows.filter((r) => {
        if (searchText && searchText(r).toLowerCase().includes(q)) return true;
        return columns.some((c) => {
          const v = read(r, c);
          return v != null && String(v instanceof Date ? v.toISOString() : v).toLowerCase().includes(q);
        });
      });
    const col = sort ? columns.find((c) => c.key === sort.key) : undefined;
    return sort && col ? sortRows(list, (r) => read(r, col), sort.dir) : list;
  }, [rows, columns, query, sort, searchText, read, filterMode]);

  const selectionScope = useRef({ selectionKey, query });
  useEffect(() => {
    const changed = selectionScope.current.selectionKey !== selectionKey || selectionScope.current.query !== query;
    selectionScope.current = { selectionKey, query };
    if (changed || !active && rawSelected.length > 0) { setSelected([]); setLimit(pageSize); lastClicked.current = null; }
    else if (rawSelected.length !== selectedIds.length) setSelected(selectedIds);
  }, [selectionKey, query, rowIds, rawSelected, selectedIds, pageSize, active]);
  useEffect(() => setLimit(pageSize), [pageSize]);
  const visible = processed.slice(0, limit);
  const hasMore = processed.length > limit;

  // The body is the only pager: reaching its end mounts the next batch, so long
  // tables stay cheap to sort without a footer that only reproduces scrolling.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!hasMore || !active || !sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries.some(entry => entry.isIntersecting)) setLimit(current => current + pageSize); },
      { root: bodyScrolls ? scrollRef.current : null, rootMargin: "240px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, active, bodyScrolls, pageSize, limit]);

  useLayoutEffect(() => {
    if (cards || maxHeight !== "viewport" || !active) return;
    const viewport = scrollRef.current;
    if (!viewport) return;
    const main = viewport.closest("main");
    const visualViewport = window.visualViewport;
    let frame: number | null = null;
    const measure = () => {
      const mainRect = main?.getBoundingClientRect();
      const mainStyle = main ? getComputedStyle(main) : undefined;
      const mainHasBox = !!mainRect && mainRect.height > 0;
      const windowBottom = window.innerHeight || document.documentElement.clientHeight;
      const visualTop = visualViewport?.offsetTop ?? 0;
      const visualBottom = visualViewport && visualViewport.height > 0 ? visualTop + visualViewport.height : windowBottom;
      const bottom = Math.min(windowBottom, visualBottom, mainHasBox ? mainRect.bottom : windowBottom)
        - (parseFloat(mainStyle?.paddingBottom ?? "0") || 0);
      const paneTop = Math.max(visualTop, mainHasBox ? mainRect.top : 0);
      // A table above the visible pane must not keep growing as main scrolls.
      const top = Math.max(viewport.getBoundingClientRect().top, paneTop);
      const paneHeight = Math.max(1, Math.floor(bottom - paneTop));
      // Offscreen tables keep a header and two rows available without imposing
      // a min-height: short tables still use only their natural content height.
      const minimum = Math.min(density === "compact" ? 132 : 164, paneHeight);
      const next = Math.max(minimum, Math.floor(bottom - top));
      setViewportMaxHeight(previous => previous === next ? previous : next);
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(() => { frame = null; measure(); });
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    // Ancestor boxes cover wrapped controls and other tables changing layout
    // above this one, without observing every DOM mutation in the application.
    for (let ancestor = viewport.parentElement; ancestor; ancestor = ancestor.parentElement) {
      observer.observe(ancestor);
      if (ancestor === main || ancestor === document.body) break;
    }
    const onOuterScroll = (event: Event) => {
      const target = event.target;
      if (target === window || target === document || target instanceof Element && target !== viewport && target.contains(viewport)) schedule();
    };
    measure();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", onOuterScroll, { capture: true, passive: true });
    visualViewport?.addEventListener("resize", schedule);
    visualViewport?.addEventListener("scroll", schedule);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", onOuterScroll, true);
      visualViewport?.removeEventListener("resize", schedule);
      visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [active, cards, maxHeight, density, toolbarHeight, processed.length, visible.length]);

  const cols = cards ? columns.filter((c) => !c.hideOnMobile) : columns;
  const primary = columns.find((c) => c.primary) ?? columns[0];
  const sortable = columns.filter((c) => c.sortable !== false);

  const tracks = [selectable ? "44px" : null, ...cols.map((c) => (c.width?.endsWith("%") ? `minmax(0,${parseFloat(c.width)}fr)` : c.width) ?? (c === primary ? "minmax(0,1.8fr)" : "minmax(0,1fr)"))]
    .filter(Boolean)
    .join(" ");

  /* ------------------------------- selection ------------------------------- */
  const selectableRows = isRowSelectable ? processed.filter(isRowSelectable) : processed;
  const allSelected = selectableRows.length > 0 && selectableRows.every((r) => selected.has(getRowId(r)));
  const someSelected = selectableRows.some((r) => selected.has(getRowId(r)));

  const toggleAll = () => {
    const ids = new Set(selected);
    if (allSelected) selectableRows.forEach((r) => ids.delete(getRowId(r)));
    else selectableRows.forEach((r) => ids.add(getRowId(r)));
    setSelected([...ids]);
    lastClicked.current = null;
  };
  const toggleRow = (id: Id, index: number, e: React.MouseEvent) => {
    const ids = new Set(selected);
    const anchor = visible.findIndex(row => getRowId(row) === lastClicked.current);
    if (e.shiftKey && anchor >= 0) {
      const [a, b] = [Math.min(anchor, index), Math.max(anchor, index)];
      const turnOn = !selected.has(id);
      for (let i = a; i <= b; i++) {
        const rangeId = getRowId(visible[i]!);
        if (!rowIds.has(rangeId)) continue;
        if (turnOn) ids.add(rangeId);
        else ids.delete(rangeId);
      }
    } else if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    lastClicked.current = id;
    setSelected([...ids]);
  };

  const clickHeader = (col: DataTableColumn<T>) => {
    if (sort?.key !== col.key) setSort({ key: col.key, dir: "asc" });
    else if (sort.dir === "asc") setSort({ key: col.key, dir: "desc" });
    else setSort(null);
  };

  const spring = reduce ? { duration: 0 } : ({ type: "spring", duration: 0.55, bounce: 0.04 } as const);
  const rowPad = density === "compact" ? "py-2" : "py-3.5";
  const rowMin = density === "compact" ? "min-h-[44px]" : "min-h-[60px]";

  /* -------------------------------- toolbar -------------------------------- */
  const selectionBar = (
    <motion.div
      key="sel"
      initial={{ opacity: 0, y: reduce ? 0 : 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: reduce ? 0 : -6, transition: { duration: 0.12 } }}
      transition={{ duration: 0.2, ease: EASE_OUT }}
      className="dt-toolbar-selection flex h-11 w-full items-center justify-between gap-3"
    >
      <p className="dt-selection-count text-[13px] font-medium text-fg" aria-live="polite">
        已选 {selectedIds.length} 项
      </p>
      {!toolbarNavigation && <div className="dt-selection-clear flex items-center gap-1.5">
        <Button unstyled
          type="button"
          onClick={() => { restoreSearchFocus.current = true; setSelected([]); }}
          className={`h-9 rounded-xl px-3 text-[12.5px] font-medium text-fg-muted transition-colors duration-150 [@media(hover:hover)]:hover:bg-surface-raised [@media(hover:hover)]:hover:text-fg   ${focus}`}
        >
          清除
        </Button>
      </div>}
    </motion.div>
  );

  const searchField = (
    <label className={cx("dt-toolbar-search relative flex min-w-0 max-w-[320px] flex-1 items-center", !!toolbar && !searchAction && "basis-[220px]")}>
      <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-3 h-4 w-4 text-fg-subtle" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4 4" />
      </svg>
      <input
        {...guardProps}
        ref={node => { inputRef.current = node; if (node && restoreSearchFocus.current) { restoreSearchFocus.current = false; node.focus({ preventScroll: true }); } }}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={searchPlaceholder}
        aria-label={searchLabel ?? searchPlaceholder}
        className="h-10 w-full rounded-xl bg-surface-raised pl-9 pr-3 text-[16px] text-fg outline-none transition-shadow placeholder:text-fg-subtle focus:ring-2 focus:ring-focus/50   sm:h-9 sm:text-[13.5px]  [&::-webkit-search-cancel-button]:hidden"
      />
    </label>
  );

  const normalBar = (
    <motion.div
      key="tools"
      ref={toolbar ? measureToolbar : undefined}
      initial={{ opacity: 0, y: reduce ? 0 : 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: reduce ? 0 : -6, transition: { duration: 0.12 } }}
      transition={{ duration: 0.2, ease: EASE_OUT }}
      className={cx("dt-toolbar-normal flex w-full items-center justify-between gap-3", toolbar ? "min-h-11 flex-wrap" : "h-full")}
    >
      {searchable ? (searchAction ? (
        <div className="dt-toolbar-search-group flex min-w-0 flex-1 items-center gap-2">
          {searchField}
          <div className="shrink-0">{searchAction}</div>
        </div>
      ) : searchField) : showRowCount && <span className={`text-[13px] ${muted}`}>{processed.length} 行</span>}
      {toolbar || (searchable && showRowCount) ? (
        <div className="dt-toolbar-actions ml-auto flex max-w-full shrink-0 flex-wrap items-center gap-2">
          {searchable && !toolbar && <span className={`hidden text-[12.5px] tabular-nums sm:block ${muted}`}>{processed.length} 行</span>}
          {toolbar}
        </div>
      ) : null}
    </motion.div>
  );

  /* ---------------------------------- cells --------------------------------- */
  const renderCell = (row: T, col: DataTableColumn<T>): ReactNode => {
    if (col.cell) return col.cell(row);
    const v = read(row, col);
    return v == null ? <span className="text-fg-subtle">—</span> : String(v instanceof Date ? v.toLocaleDateString() : v);
  };

  /* ------------------------------ render: header ---------------------------- */
  const header = cards ? (
    <div className={cx("flex items-center gap-3 px-1 pb-3")}>
      {selectable && (!isRowSelectable || selectableRows.length > 0) && <Checkbox checked={allSelected} indeterminate={!allSelected && someSelected} onToggle={toggleAll} label="全选已加载的匹配行" />}
      <div className="ml-1 min-w-0 flex-1">
        <SelectDropdown ariaLabel="排序依据" value={sort?.key ?? ""}
          items={[{ value: "", label: "排序：默认顺序" }, ...sortable.map(c => ({ value: c.key, label: `排序：${c.header}` }))]}
          onSelect={key => setSort(key ? { key, dir: sort?.dir ?? "desc" } : null)}
          triggerClassName={`flex h-10 w-full items-center justify-between rounded-xl bg-surface-raised px-3 text-[16px] text-fg ${focus}`} />
      </div>
      <Button unstyled
        type="button"
        disabled={!sort}
        aria-label={sort?.dir === "asc" ? "当前升序，切换降序" : "当前降序，切换升序"}
        onClick={() => sort && setSort({ key: sort.key, dir: sort.dir === "asc" ? "desc" : "asc" })}
        className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-surface-raised text-fg-muted transition-opacity active:scale-[0.96] disabled:opacity-40   ${focus}`}
      >
        <SortIcon state={sort?.dir ?? null} />
      </Button>
    </div>
  ) : (
    <div
      role="row"
      className={cx(
        "sticky top-0 z-10 grid items-center border-b bg-surface text-[12px] font-medium backdrop-blur ",
        hairline,
        scrolled && "shadow-[0_8px_16px_-12px_rgba(0,0,0,0.25)]",
      )}
      style={{ gridTemplateColumns: tracks }}
    >
      {selectable && (
        <div role="columnheader" className="grid h-11 place-items-center">
          {(!isRowSelectable || selectableRows.length > 0) && <Checkbox checked={allSelected} indeterminate={!allSelected && someSelected} onToggle={toggleAll} label="全选已加载的匹配行" />}
        </div>
      )}
      {cols.map((c) => {
        const state = sort?.key === c.key ? sort.dir : null;
        const can = c.sortable !== false;
        return (
          <div
            key={c.key}
            role="columnheader"
            aria-sort={state === "asc" ? "ascending" : state === "desc" ? "descending" : can ? "none" : undefined}
            className={cx("flex h-11 min-w-0 items-center px-3", alignClass[c.align ?? "left"])}
          >
            {can ? (
              <Button unstyled
                type="button"
                onClick={() => clickHeader(c)}
                className={cx(
                  "-mx-2 inline-flex h-8 items-center gap-1.5 rounded-lg px-2 transition-colors duration-150 [-webkit-tap-highlight-color:transparent]",
                  c.align === "right" && "flex-row-reverse",
                  state ? "text-fg " : "text-fg-muted [@media(hover:hover)]:hover:text-fg ",
                  focus,
                )}
              >
                <span className="truncate">{c.header}</span>
                <SortIcon state={state} />
              </Button>
            ) : (
              <span className="truncate text-fg-muted">{c.header}</span>
            )}
          </div>
        );
      })}
    </div>
  );

  /* ------------------------------- render: rows ------------------------------ */
  const rowEls = visible.map((row, index) => {
    const isSel = selected.has(getRowId(row));
    const canSelect = selectable && rowIds.has(getRowId(row));
    const label = getRowLabel(row);
    const common = {
      role: "row" as const,
      "aria-selected": canSelect ? isSel : undefined,
      "aria-rowindex": index + 2,
    };
    const interactive = onRowClick || onRowActivate || onRowDoubleClick || rowKeyboardNav
      ? {
          tabIndex: 0,
          title: rowTitle?.(row),
          onFocus: () => onRowFocus?.(row),
          onDoubleClick: (e: React.MouseEvent) => {
            if (!(e.target as HTMLElement).closest("button,a,input,select,label,[role=checkbox],[role=menuitem]")) onRowDoubleClick?.(row);
          },
          onClick: (e: React.MouseEvent) => {
            if (!(e.target as HTMLElement).closest("button,a,input,select,label,[role=checkbox],[role=menuitem]")) onRowClick?.(row);
          },
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.target !== e.currentTarget || isImeKey(e)) return;
            if (rowKeyboardNav && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
              e.preventDefault();
              const target = e.key === "Home" ? 0 : e.key === "End" ? visible.length - 1 : Math.max(0, Math.min(visible.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)));
              const targetId = JSON.stringify(getRowId(visible[target]!));
              const element = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-table-row]') ?? []).find(node => node.dataset.tableRow === targetId);
              element?.focus();
              element?.scrollIntoView({ block: "nearest" });
            } else if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              (onRowActivate ?? onRowClick)?.(row);
            }
          },
        }
      : {};
    const wrap = (element: ReactElement) => rowWrapper ? <WrappedTableRow key={getRowId(row)} element={element} wrap={element => rowWrapper(row, element)} /> : element;

    if (cards) {
      const rest = cols.filter((c) => c !== primary);
      return wrap(
        <motion.div
          key={getRowId(row)}
          layout={reduce ? false : "position"}
          initial={false}
          exit={{ opacity: 0, transition: { duration: 0.15 } }}
          transition={spring}
          {...common}
          {...interactive}
          data-table-row={JSON.stringify(getRowId(row))}
          data-highlighted={highlighted?.(row) || undefined}
          className={cx(
            "rounded-2xl bg-surface p-4 ",
            ring,
            isSel && "bg-surface-raised ring-fg/25  ",
            onRowClick && cx("cursor-pointer", focus),
          )}
        >
          <div className="flex items-start gap-3">
            {canSelect && (
              <div className="pt-0.5">
                <Checkbox checked={isSel} onToggle={(e) => toggleRow(getRowId(row), index, e)} label={`选择 ${label}`} />
              </div>
            )}
            <div role="cell" className="min-w-0 flex-1 text-[14px] font-medium text-fg [overflow-wrap:anywhere]">
              {primary ? renderCell(row, primary) : null}
            </div>
          </div>
          {rest.length > 0 && (
            <div className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-3.5 pl-0 sm:pl-0">
              {rest.map((c) => (
                <div key={c.key} role="cell" className={cx("min-w-0", c.fullWidthOnMobile && "col-span-2")}>
                  <p className={`mb-1 text-[11.5px] ${muted}`}>{c.mobileLabel ?? c.header}</p>
                  <div className="text-[13.5px] text-fg [overflow-wrap:anywhere]">{renderCell(row, c)}</div>
                </div>
              ))}
            </div>
          )}
        </motion.div>
      );
    }

    return wrap(
      <motion.div
        key={getRowId(row)}
        layout={reduce ? false : "position"}
        initial={false}
        exit={{ opacity: 0, transition: { duration: 0.15 } }}
        transition={spring}
        {...common}
        {...interactive}
        data-table-row={JSON.stringify(getRowId(row))}
        data-highlighted={highlighted?.(row) || undefined}
        className={cx(
          "grid items-center border-b bg-surface transition-colors duration-150 last:border-b-0 ",
          hairline,
          rowMin,
          isSel ? "bg-surface-raised " : "[@media(hover:hover)]:hover:bg-surface-raised/70 ",
          onRowClick && cx("cursor-pointer", focus),
        )}
        style={{ gridTemplateColumns: tracks }}
      >
        {selectable && (
          <div role="cell" className="grid place-items-center">
            {canSelect && <Checkbox checked={isSel} onToggle={(e) => toggleRow(getRowId(row), index, e)} label={`选择 ${label}`} />}
          </div>
        )}
        {cols.map((c) => (
          <div
            key={c.key}
            role="cell"
            className={cx(
              "flex min-w-0 items-center px-3 text-[13.5px]",
              rowPad,
              alignClass[c.align ?? "left"],
              c === primary ? "font-medium text-fg " : "text-fg-muted ",
            )}
          >
            <div className="min-w-0 max-w-full [overflow-wrap:anywhere]">{renderCell(row, c)}</div>
          </div>
        ))}
      </motion.div>
    );
  });

  const empty = (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      {emptyState ?? (
        <>
          <p className="text-[14px] font-medium text-fg ">没有结果</p>
          <p className={`text-[13px] ${muted}`}>{query ? `没有与“${query}”匹配的条目。` : "暂无可显示的内容。"}</p>
          {query && (
            <Button unstyled
              type="button"
              onClick={() => setQuery("")}
              className={`h-9 rounded-xl bg-surface-raised px-3.5 text-[12.5px] font-medium text-fg-muted transition-transform active:scale-[0.97]   ${focus}`}
            >
              清除搜索
            </Button>
          )}
        </>
      )}
    </div>
  );

  const bulkActionSlot = <div className="dt-bulk-slot" hidden={!selectable || selectedIds.length === 0}>{bulkActions?.(selectedIds)}</div>;
  const selectionActive = selectable && selectedIds.length > 0;

  return (
    <div ref={rootRef} role="region" aria-label={ariaLabel} aria-busy={busy || undefined} className={cx("easyui-data-table w-full min-w-0 text-fg antialiased", className)}>
      {/* Navigation stays outside the animated search/selection replacement. */}
      <div className={cx("dt-toolbar relative mb-3", toolbar || toolbarNavigation ? "min-h-11" : "h-11", !!toolbarNavigation && "dt-toolbar-navigation-layout", selectionActive && "dt-toolbar-selection-active")} style={toolbar && !toolbarNavigation ? { minHeight: toolbarHeight } : undefined}>
        {toolbarNavigation && <div className="dt-toolbar-navigation">
          {toolbarNavigation}
          <div role="group" aria-label="多选操作" className="dt-toolbar-navigation-actions" hidden={!selectionActive}>
            {bulkActionSlot}
            <IconButton label="清除" variant="ghost" className="dt-action dt-action-icon"
              onPress={() => { restoreSearchFocus.current = true; setSelected([]); }}><X aria-hidden size={16} /></IconButton>
          </div>
        </div>}
        <AnimatePresence mode="wait" initial={false}>
          {selectedIds.length > 0 && selectable ? selectionBar : normalBar}
        </AnimatePresence>
        {!toolbarNavigation && bulkActionSlot}
      </div>

      <div
        className={cx(!cards && "overflow-hidden rounded-2xl bg-surface ", !cards && ring)}
        style={!cards ? { boxShadow: "0 1px 2px rgba(0,0,0,0.04), 0 24px 48px -32px rgba(0,0,0,0.2)" } : undefined}
      >
        {cards && header}
        <motion.div
          ref={scrollRef}
          layoutScroll
          onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 2)}
          className={cx(bodyScrolls && "table-scrollbar overflow-auto", !cards && "overscroll-contain")}
          style={bodyScrolls ? { maxHeight: bodyMaxHeight ?? viewportMaxHeight } : undefined}
          tabIndex={bodyScrolls ? 0 : undefined}
          role={bodyScrolls ? "region" : undefined}
          aria-label={bodyScrolls ? `${ariaLabel}（可滚动）` : undefined}
        >
          <div
            role="table"
            aria-label={ariaLabel}
            aria-rowcount={processed.length + 1}
            aria-colcount={cols.length + (selectable ? 1 : 0)}
            style={!cards ? { minWidth } : undefined}
          >
            {!cards && header}
            <div key={JSON.stringify([cards ? "cards" : "table", selectionKey])} role="rowgroup" className={cx("relative", cards && "flex flex-col gap-2.5")}>
              <AnimatePresence initial={false} mode="popLayout">
                {rowEls}
              </AnimatePresence>
              {processed.length === 0 && empty}
            </div>
          </div>
          {hasMore && <div ref={sentinelRef} aria-hidden className="h-px" />}
        </motion.div>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}

export default DataTable;

