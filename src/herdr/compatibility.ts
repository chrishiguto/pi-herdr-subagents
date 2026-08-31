export const SUPPORTED_HERDR_VERSION = ">=0.8.2 <0.9";
export const SUPPORTED_HERDR_PROTOCOL = 20;

export interface HerdrStatus {
  ok: boolean;
  version?: string | null;
  protocol?: number | null;
}

export type HerdrReadiness =
  | {
      ready: true;
      version: string;
      protocol: typeof SUPPORTED_HERDR_PROTOCOL;
    }
  | {
      ready: false;
      reason: "missing" | "not-running" | "incompatible";
      error: string;
    };

function setupRequirement(): string {
  return `Herdr ${SUPPORTED_HERDR_VERSION} with protocol ${SUPPORTED_HERDR_PROTOCOL}`;
}

function isSupportedVersion(version: string): boolean {
  const match = /^v?0\.8\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(version);
  return match !== null && Number(match[1]) >= 2;
}

function displayValue(value: string | number | null | undefined): string {
  return value == null ? "unknown" : String(value);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error);
}

function isMissingExecutable(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  if (code === "ENOENT") return true;

  return /(?:^|\b)ENOENT(?:\b|$)|command not found|executable.*not found/i.test(errorText(error));
}

export function classifyHerdrStatus(status: HerdrStatus): HerdrReadiness {
  if (!status.ok) {
    return {
      ready: false,
      reason: "not-running",
      error:
        `${setupRequirement()} is required, but the Herdr server is not running or reachable. ` +
        "Start Herdr and run Pi inside a Herdr pane.",
    };
  }

  if (
    typeof status.version !== "string" ||
    !isSupportedVersion(status.version) ||
    status.protocol !== SUPPORTED_HERDR_PROTOCOL
  ) {
    return {
      ready: false,
      reason: "incompatible",
      error:
        `${setupRequirement()} is required; detected version ` +
        `${displayValue(status.version)} with protocol ${displayValue(status.protocol)}. ` +
        "Install a supported Herdr release and restart Pi inside its pane.",
    };
  }

  return {
    ready: true,
    version: status.version,
    protocol: SUPPORTED_HERDR_PROTOCOL,
  };
}

export async function probeHerdrReadiness(
  probe: () => Promise<HerdrStatus>,
): Promise<HerdrReadiness> {
  if (process.platform === "win32") {
    return {
      ready: false,
      reason: "incompatible",
      error:
        `${setupRequirement()} is required, but pi-herdr-subagents currently supports ` +
        "Herdr event watching only on Unix-like platforms.",
    };
  }

  try {
    return classifyHerdrStatus(await probe());
  } catch (error) {
    if (isMissingExecutable(error)) {
      return {
        ready: false,
        reason: "missing",
        error:
          `${setupRequirement()} is required, but the Herdr executable was not found. ` +
          "Install Herdr and ensure the `herdr` command is available on PATH.",
      };
    }

    return {
      ready: false,
      reason: "not-running",
      error:
        `${setupRequirement()} is required, but the Herdr server could not be reached: ` +
        `${errorText(error)}. Start Herdr and run Pi inside a Herdr pane.`,
    };
  }
}
