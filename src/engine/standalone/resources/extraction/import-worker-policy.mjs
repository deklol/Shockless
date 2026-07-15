import { cpus, freemem } from "node:os";
import { parse } from "node:path";
import { spawnSync } from "node:child_process";

const MIB = 1024 * 1024;

export function importWorkerPolicy(outputRoot, jobCount) {
  const override = Number.parseInt(process.env.SHOCKLESS_IMPORT_WORKERS ?? "", 10);
  if (Number.isSafeInteger(override) && override > 0) {
    const workers = Math.max(1, Math.min(jobCount, override, 8));
    return { workers, cpuCap: workers, memoryCap: workers, storageCap: workers, storage: "override" };
  }

  const logicalProcessors = Math.max(1, cpus().length);
  const cpuCap = Math.max(1, Math.min(8, Math.floor((logicalProcessors - 1) * 0.75)));
  const memoryCap = Math.max(1, Math.min(8, Math.floor(Math.max(768 * MIB, freemem() - 1536 * MIB) / (768 * MIB))));
  const storage = detectWindowsStorage(outputRoot);
  const storageCap = storage === "hdd" ? 2 : storage === "nvme" ? 8 : storage === "ssd" ? 4 : 2;
  return {
    workers: Math.max(1, Math.min(jobCount, cpuCap, memoryCap, storageCap)),
    cpuCap,
    memoryCap,
    storageCap,
    storage,
  };
}

function detectWindowsStorage(outputRoot) {
  if (process.platform !== "win32") return "unknown";
  const drive = parse(outputRoot).root.slice(0, 1);
  if (!drive) return "unknown";
  const script = [
    `$partition = Get-Partition -DriveLetter '${drive}' -ErrorAction Stop`,
    "$disk = $partition | Get-Disk",
    "$physical = Get-PhysicalDisk -DeviceNumber $disk.Number -ErrorAction SilentlyContinue",
    "[Console]::WriteLine(($physical.MediaType.ToString() + '|' + $disk.BusType.ToString()))",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 2000,
    windowsHide: true,
  });
  const text = `${result.stdout ?? ""}|${result.stderr ?? ""}`.toLowerCase();
  if (text.includes("nvme")) return "nvme";
  if (text.includes("ssd")) return "ssd";
  if (text.includes("hdd")) return "hdd";
  return "unknown";
}
