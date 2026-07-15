import { Package } from "lucide-react";
import { useRef, useState } from "react";
import type { PluginDefinition } from "../../shared/plugin";

interface IconRailProps {
  readonly filteredPlugins: readonly PluginDefinition[];
  readonly pluginEnabledById: Readonly<Record<string, boolean>>;
  readonly selectedPluginId: string;
  readonly PluginIcon: React.ComponentType<{ readonly plugin: PluginDefinition }>;
  readonly onOpenPluginManager: () => void;
  readonly onSelectPlugin: (pluginId: string) => void;
  readonly onReorderPlugins: (orderedIds: readonly string[]) => void;
}

export function IconRail({
  filteredPlugins, pluginEnabledById, selectedPluginId,
  PluginIcon, onOpenPluginManager, onSelectPlugin, onReorderPlugins,
}: IconRailProps) {
  const dragIdRef = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const handleDrop = (targetId: string) => {
    const fromId = dragIdRef.current;
    dragIdRef.current = null;
    setDragOverId(null);
    if (!fromId || fromId === targetId) return;
    const ids = filteredPlugins.map((plugin) => plugin.id);
    const fromIndex = ids.indexOf(fromId);
    const toIndex = ids.indexOf(targetId);
    if (fromIndex < 0 || toIndex < 0) return;
    ids.splice(fromIndex, 1);
    ids.splice(toIndex, 0, fromId);
    onReorderPlugins(ids);
  };

  return (
    <nav className="icon-rail" aria-label="Plugins">
      <button
        className="rail-toggle"
        type="button"
        aria-label="Open plugin manager"
        onClick={onOpenPluginManager}
        title="Open plugin manager"
      >
        <Package size={18} />
      </button>
      <div className="rail-list">
        {filteredPlugins.map((plugin) => {
          const enabled = pluginEnabledById[plugin.id] !== false;
          const active = plugin.id === selectedPluginId;
          const dragOver = dragOverId === plugin.id;
          return (
            <button
              className={`rail-tab ${active ? "active" : ""} ${enabled ? "" : "disabled"} ${dragOver ? "drag-over" : ""}`}
              type="button"
              key={plugin.id}
              title={plugin.name}
              aria-label={plugin.name}
              aria-pressed={active}
              draggable
              onDragStart={(event) => {
                dragIdRef.current = plugin.id;
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                if (dragOverId !== plugin.id) setDragOverId(plugin.id);
              }}
              onDragLeave={() => setDragOverId((current) => (current === plugin.id ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                handleDrop(plugin.id);
              }}
              onDragEnd={() => {
                dragIdRef.current = null;
                setDragOverId(null);
              }}
              onClick={() => onSelectPlugin(plugin.id)}
            >
              <span className="plugin-icon">
                <PluginIcon plugin={plugin} />
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
