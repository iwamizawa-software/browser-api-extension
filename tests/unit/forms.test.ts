import { describe, expect, it } from "vitest";
import { formatBlocklist, maskKey, parseBlocklist, parsePatternList } from "../../src/setup/forms";

describe("setup form helpers", () => {
  it("parses pattern lists, reporting invalid lines", () => {
    expect(parsePatternList("https://a.test/*\n\n  # comment\nbad\nhttps://a.test/*\n<all_urls>\n")).toEqual({
      patterns: ["https://a.test/*", "<all_urls>"],
      invalid: ["bad"],
    });
  });

  it("round-trips the blocklist format", () => {
    const { blocklist, invalid } = parseBlocklist("ja: ご視聴ありがとうございました\nEN：Thanks for watching!\n*: foo\nno colon here\n");
    expect(invalid).toEqual(["no colon here"]);
    expect(blocklist).toEqual({ ja: ["ご視聴ありがとうございました"], en: ["Thanks for watching!"], "*": ["foo"] });
    expect(parseBlocklist(formatBlocklist(blocklist)).blocklist).toEqual(blocklist);
  });

  it("masks keys", () => {
    expect(maskKey("gsk_abcdefghijklmnop1234")).toBe("gsk_…1234");
    expect(maskKey("short")).toBe("********");
  });
});
