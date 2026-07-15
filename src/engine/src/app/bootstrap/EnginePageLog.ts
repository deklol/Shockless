export type EngineLogLevel = "info" | "error" | "put";
export type EngineLogger = (level: EngineLogLevel, text: string) => void;

export function createEngineLogger(logElement: HTMLElement, mirrorToConsole: boolean): EngineLogger {
  return (level, text): void => {
    const line = document.createElement("div");
    line.className = level;
    line.textContent = `[${level}] ${text}`;
    logElement.appendChild(line);
    logElement.scrollTop = logElement.scrollHeight;
    if (!mirrorToConsole) return;
    const message = `[engine:${level}] ${text}`;
    if (level === "error") console.error(message);
    else console.log(message);
  };
}
