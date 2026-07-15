import { Activity, Bot, CircleAlert, Command, Hammer, Info, List, Map, MessageSquare, Package, Plug, Sofa, Terminal, User, Wrench } from "lucide-react";
import type { PluginDefinition } from "../../../shared/plugin";

export const iconMap = {
  activity: Activity,
  bot: Bot,
  command: Command,
  list: List,
  map: Map,
  messages: MessageSquare,
  package: Package,
  plug: Plug,
  sofa: Sofa,
  terminal: Terminal,
  user: User,
  wrench: Wrench,
  hammer: Hammer,
  info: Info,
};

export function PluginIcon({ plugin }: { readonly plugin: PluginDefinition }) {
  const Icon = iconMap[plugin.icon as keyof typeof iconMap] ?? CircleAlert;
  return <Icon aria-hidden="true" size={17} strokeWidth={2.1} />;
}
