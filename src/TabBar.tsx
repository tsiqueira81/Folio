import { useEffect, useRef } from "react";
import { Icon } from "./icons";
import { keys } from "./platform";

export interface TabItem {
  id: string;
  name: string;
  dirty: boolean;
}

interface Props {
  tabs: TabItem[];
  activeId: string | null;
  showLibrary: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
}

/** Browser-style horizontal tab strip shown whenever at least one PDF is open. */
export function TabBar({ tabs, activeId, showLibrary, onSelect, onClose, onNewTab }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showLibrary) {
      activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    }
  }, [activeId, showLibrary, tabs.length]);

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      el.scrollLeft += e.deltaY;
    }
  };

  return (
    <nav className="tabbar" aria-label="Open documents">
      <div className="tabbar-scroll" role="tablist" ref={scrollRef} onWheel={onWheel}>
        {tabs.map((tab) => {
          const active = !showLibrary && tab.id === activeId;
          const label = tab.name.replace(/\.pdf$/i, "");
          return (
            <div
              key={tab.id}
              ref={active ? activeRef : undefined}
              className={`tab-item ${active ? "on" : ""}`}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={tab.name}
              onClick={() => onSelect(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(tab.id);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(tab.id);
                }
              }}
            >
              <Icon name="file" size={13} />
              <span className="tab-title">{label}</span>
              {tab.dirty && <span className="dirty-dot" title="Unsaved annotations" />}
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${tab.name}`}
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className={`tab-new ${showLibrary ? "on" : ""}`}
          onClick={onNewTab}
          title={showLibrary ? "Back to document" : keys("Open another PDF (Ctrl+T)")}
          aria-label="Open another PDF in a new tab"
          aria-pressed={showLibrary}
        >
          <Icon name="plus" size={15} />
        </button>
      </div>
    </nav>
  );
}
