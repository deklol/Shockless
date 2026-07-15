export interface PluginSchemaActionEvent {
  readonly pluginId: string;
  readonly surfaceId: string;
  readonly action: string;
  readonly elementId?: string;
  readonly value?: string | number | boolean | null;
  readonly command?: string;
}
