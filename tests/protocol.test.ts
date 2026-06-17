import { describe, expect, it } from "vitest";
import {
  enabledFromString,
  parseBuildChannel,
} from "../src/shared/buildChannel";
import { errorMessage } from "../src/shared/protocol";

describe("build channel helpers", () => {
  it("defaults non-string values to prod", () => {
    expect(parseBuildChannel(undefined)).toBe("prod");
    expect(parseBuildChannel(null)).toBe("prod");
  });

  it("accepts shipped build channels", () => {
    expect(parseBuildChannel("dev")).toBe("dev");
    expect(parseBuildChannel("internal")).toBe("internal");
    expect(parseBuildChannel("prod")).toBe("prod");
  });

  it("rejects unsupported build channels with the observed error text", () => {
    expect(() => parseBuildChannel("beta")).toThrow(
      'Unsupported extension build channel "beta". Use "dev", "internal", or "prod".',
    );
  });

  it("matches the shipped boolean flag parser", () => {
    expect(enabledFromString()).toBe(false);
    expect(enabledFromString("false")).toBe(false);
    expect(enabledFromString("true")).toBe(true);
    expect(enabledFromString("0")).toBe(true);
  });
});

describe("errorMessage", () => {
  it("normalizes errors and message-shaped objects", () => {
    expect(errorMessage(new Error("native host missing"))).toBe(
      "native host missing",
    );
    expect(errorMessage({ message: "port closed" })).toBe("port closed");
    expect(errorMessage("plain")).toBe("plain");
  });
});
