import { describe, it, expect } from "vitest";
import {
  calculateEntropy,
  isLikelyBase64,
  getBase64Ratio,
  hasBinaryContent,
  removeBase64Blocks,
  redactSecrets,
  filterContent,
  shouldIndexContent,
} from "./content-filter.js";

describe("content-filter", () => {
  describe("calculateEntropy", () => {
    it("returns 0 for empty string", () => {
      expect(calculateEntropy("")).toBe(0);
    });

    it("returns low entropy for repetitive text", () => {
      const entropy = calculateEntropy("aaaaaaaaaa");
      expect(entropy).toBe(0);
    });

    it("returns moderate entropy for normal text", () => {
      const entropy = calculateEntropy("Hello, this is normal text.");
      expect(entropy).toBeGreaterThan(2);
      expect(entropy).toBeLessThan(5);
    });

    it("returns high entropy for Base64 content", () => {
      const base64 = "ZXlKMGVYQWlPaUpLVjFRaUxDSmhiR2NpT2lKU1V6STFOaUo5";
      const entropy = calculateEntropy(base64);
      expect(entropy).toBeGreaterThan(4.5);
    });
  });

  describe("isLikelyBase64", () => {
    it("returns false for short strings", () => {
      expect(isLikelyBase64("abc123")).toBe(false);
    });

    it("returns false for normal text", () => {
      expect(isLikelyBase64("This is normal text with spaces and punctuation!")).toBe(false);
    });

    it("returns true for Base64 encoded content", () => {
      const base64 = "ZXlKMGVYQWlPaUpLVjFRaUxDSmhiR2NpT2lKU1V6STFOaUo5eyJpc3MiOiJodHRwczovL2V4YW1wbGUu";
      expect(isLikelyBase64(base64)).toBe(true);
    });

    it("returns true for URL-safe Base64", () => {
      const urlSafe = "ZXlKMGVYQWlPaUpLVjFRaUxDSmhiR2NpT2lKU1V6STFOaUo5_abc-def123456";
      expect(isLikelyBase64(urlSafe)).toBe(true);
    });
  });

  describe("getBase64Ratio", () => {
    it("returns 0 for normal text", () => {
      const ratio = getBase64Ratio("This is completely normal text.");
      expect(ratio).toBe(0);
    });

    it("returns high ratio for mostly Base64 content", () => {
      // Use actual high-entropy Base64, not repeated chars
      const base64 = "ZXlKMGVYQWlPaUpLVjFRaUxDSmhiR2NpT2lKU1V6STFOaUo5eyJpc3M".repeat(3);
      const content = "Token: " + base64;
      const ratio = getBase64Ratio(content);
      expect(ratio).toBeGreaterThan(0.5);
    });

    it("returns partial ratio for mixed content", () => {
      const base64 = "ZXlKMGVYQWlPaUpLVjFRaUxDSmhiR2NpT2lKU1V6STFOaUo5";
      const content = `Normal text here. ${base64} More normal text.`;
      const ratio = getBase64Ratio(content);
      expect(ratio).toBeGreaterThan(0);
      expect(ratio).toBeLessThan(0.7);
    });
  });

  describe("hasBinaryContent", () => {
    it("returns false for normal text", () => {
      expect(hasBinaryContent("Normal text")).toBe(false);
    });

    it("returns false for text with newlines and tabs", () => {
      expect(hasBinaryContent("Line 1\nLine 2\tTabbed")).toBe(false);
    });

    it("returns true for null bytes", () => {
      expect(hasBinaryContent("Text\x00with null")).toBe(true);
    });

    it("returns true for control characters", () => {
      expect(hasBinaryContent("Text\x03with control")).toBe(true);
    });
  });

  describe("removeBase64Blocks", () => {
    it("removes Base64 blocks from content", () => {
      const base64 = "ZXlKMGVYQWlPaUpLVjFRaUxDSmhiR2NpT2lKU1V6STFOaUo5eyJpc3M";
      const content = `API Token: ${base64}\n\nNext section...`;
      const result = removeBase64Blocks(content);

      expect(result).not.toContain(base64);
      expect(result).toContain("[ENCODED]");
      expect(result).toContain("API Token:");
      expect(result).toContain("Next section...");
    });

    it("preserves normal text", () => {
      const content = "This is completely normal text without any encoding.";
      expect(removeBase64Blocks(content)).toBe(content);
    });
  });

  describe("redactSecrets", () => {
    it("redacts JWT tokens", () => {
      const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
      const content = `Bearer ${jwt}`;
      const { content: redacted, secretsFound } = redactSecrets(content);

      expect(redacted).toContain("[JWT_REDACTED]");
      expect(secretsFound).toContain("jwt");
    });

    it("redacts AWS access keys", () => {
      const content = "AWS Key: AKIAIOSFODNN7EXAMPLE";
      const { content: redacted, secretsFound } = redactSecrets(content);

      expect(redacted).toContain("[AWSACCESSKEY_REDACTED]");
      expect(secretsFound).toContain("awsAccessKey");
    });

    it("redacts GitHub tokens", () => {
      const content = "Token: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
      const { content: redacted, secretsFound } = redactSecrets(content);

      expect(redacted).toContain("[GITHUBTOKEN_REDACTED]");
      expect(secretsFound).toContain("githubToken");
    });

    it("preserves normal text", () => {
      const content = "This is normal text without secrets.";
      const { content: redacted, secretsFound } = redactSecrets(content);

      expect(redacted).toBe(content);
      expect(secretsFound).toHaveLength(0);
    });
  });

  describe("filterContent", () => {
    it("returns 'index' for clean content", () => {
      // Content must be at least 50 chars (minContentLength default)
      const content = "This is clean, normal content for indexing. It contains enough text to pass the minimum length requirement.";
      const result = filterContent(content);

      expect(result.action).toBe("index");
      expect(result.cleanedContent).toBe(content);
      expect(result.reasons).toHaveLength(0);
    });

    it("returns 'skip' for binary content", () => {
      const result = filterContent("Text\x00with null bytes");

      expect(result.action).toBe("skip");
      expect(result.reasons).toContain("Contains binary content");
    });

    it("returns 'skip' for mostly Base64 content", () => {
      const base64 = "ZXlKMGVYQWlPaUpLVjFRaUxDSmhiR2NpT2lKU1V6STFOaUo5".repeat(10);
      const result = filterContent(base64);

      expect(result.action).toBe("skip");
      expect(result.reasons[0]).toContain("Base64 encoded");
    });

    it("returns 'filter' for mixed content with Base64", () => {
      const base64 = "ZXlKMGVYQWlPaUpLVjFRaUxDSmhiR2NpT2lKU1V6STFOaUo5";
      const content = `This is important text. Token: ${base64}. More important content here that we want to index.`;
      const result = filterContent(content);

      expect(result.action).toBe("filter");
      expect(result.cleanedContent).toContain("[ENCODED]");
      expect(result.cleanedContent).toContain("This is important text");
      expect(result.reasons.some(r => r.includes("Base64"))).toBe(true);
    });

    it("returns 'skip' if content too short after filtering", () => {
      // Short text + Base64 that will be removed, leaving less than 50 chars
      const base64 = "ZXlKMGVYQWlPaUpLVjFRaUxDSmhiR2NpT2lKU1V6STFOaUo5eyJpc3M";
      const content = `Hi ${base64}`;
      const result = filterContent(content);

      expect(result.action).toBe("skip");
      // After removing Base64, only "Hi [ENCODED]" remains which is too short
    });

    it("respects custom configuration", () => {
      const base64 = "ZXlKMGVYQWlPaUpLVjFRaUxDSmhiR2NpT2lKU1V6STFOaUo5eyJpc3M";
      // Need enough remaining content after potential filtering
      const content = `This is some text before the token. Token: ${base64}. And this is some text after the token that should remain.`;

      // With removeBase64 disabled, the Base64 should stay
      const result = filterContent(content, { removeBase64: false });

      expect(result.action).not.toBe("skip");
      expect(result.cleanedContent).toContain(base64);
    });
  });

  describe("shouldIndexContent", () => {
    it("returns true for normal content", () => {
      expect(shouldIndexContent("Normal text content")).toBe(true);
    });

    it("returns false for binary content", () => {
      expect(shouldIndexContent("Binary\x00content")).toBe(false);
    });

    it("returns false for mostly Base64", () => {
      const base64 = "ZXlKMGVYQWlPaUpLVjFRaUxDSmhiR2NpT2lKU1V6STFOaUo5".repeat(10);
      expect(shouldIndexContent(base64)).toBe(false);
    });
  });
});
