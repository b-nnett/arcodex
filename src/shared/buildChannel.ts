export type BuildChannel = "dev" | "internal" | "prod";

const DEFAULT_BUILD_CHANNEL: BuildChannel = "prod";

export function parseBuildChannel(value: unknown): BuildChannel {
  if (typeof value !== "string") {
    return DEFAULT_BUILD_CHANNEL;
  }

  switch (value) {
    case "dev":
    case "internal":
    case "prod":
      return value;
    default:
      throw new Error(
        `Unsupported extension build channel "${value}". Use "dev", "internal", or "prod".`,
      );
  }
}

export function enabledFromString(value = "false"): boolean {
  return value !== "false";
}
