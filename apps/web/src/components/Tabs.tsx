import {
  createContext,
  useContext,
  useId,
  useRef,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
type Icon = ComponentType<{ size?: number }>;
export type TabItem<T extends string> = { id: T; label: string; icon?: Icon };
const TabsContext = createContext<{ id: string; value: string } | null>(null);
// Panel switcher with the WAI-ARIA tabs pattern: roving tabIndex and Arrow/Home/End keys.
export function Tabs<T extends string>({
  label,
  items,
  value,
  onChange,
  disabled = false,
  className = '',
  children,
}: {
  label: string;
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  function onKeyDown(e: KeyboardEvent) {
    const index = items.findIndex((item) => item.id === value);
    const next =
      e.key === 'ArrowRight'
        ? (index + 1) % items.length
        : e.key === 'ArrowLeft'
          ? (index - 1 + items.length) % items.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? items.length - 1
              : -1;
    if (next < 0 || disabled) return;
    e.preventDefault();
    onChange(items[next]!.id);
    list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }
  return (
    <TabsContext.Provider value={{ id, value }}>
      <div
        ref={list}
        role="tablist"
        aria-label={label}
        className={`tabs ${className}`}
        onKeyDown={onKeyDown}
      >
        {items.map(({ id: item, label, icon: Icon }) => (
          <button
            key={item}
            type="button"
            role="tab"
            id={`${id}-tab-${item}`}
            aria-controls={`${id}-panel`}
            aria-selected={value === item}
            tabIndex={value === item ? 0 : -1}
            disabled={disabled}
            className={value === item ? 'active' : ''}
            onClick={() => onChange(item)}
          >
            {Icon && <Icon size={15} />}
            {label}
          </button>
        ))}
      </div>
      {children}
    </TabsContext.Provider>
  );
}
// Filters that change a list, not the visible panel, use pressed buttons instead of tabs.
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: [T, string][];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segment" role="group" aria-label={label}>
      {options.map(([id, text]) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          className={value === id ? 'active' : ''}
          onClick={() => onChange(id)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
export function TabPanel({ children }: { children: ReactNode }) {
  const tabs = useContext(TabsContext);
  return (
    <div
      role="tabpanel"
      id={tabs ? `${tabs.id}-panel` : undefined}
      aria-labelledby={tabs ? `${tabs.id}-tab-${tabs.value}` : undefined}
      className="tab-panel"
    >
      {children}
    </div>
  );
}
