/**
 * Content quality filter for RAG indexing.
 * Detects and filters Base64-encoded, binary, and secret content.
 */

import { createDebugLogger } from "./debug.js";

const debug = createDebugLogger("CONTENT_FILTER");

/**
 * Result of content filtering.
 */
export interface FilterResult {
  /** Whether to index this content */
  action: "index" | "filter" | "skip";
  /** Cleaned content (if action is "index" or "filter") */
  cleanedContent?: string;
  /** Reasons for filtering/skipping */
  reasons: string[];
}

/**
 * Calculate Shannon entropy of a string.
 * Higher entropy = more random/encoded content.
 *
 * Typical values:
 * - Normal text: 0.8 - 4.5
 * - Base64: 5.0 - 6.0
 * - Encrypted: 6.0+
 *
 * @param str - String to analyze
 * @returns Entropy value (0-8)
 */
export function calculateEntropy(str: string): number {
  if (!str || str.length === 0) return 0;

  const freq = new Map<string, number>();
  for (const char of str) {
    freq.set(char, (freq.get(char) || 0) + 1);
  }

  let entropy = 0;
  const len = str.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/**
 * Regex pattern for Base64 content (40+ chars).
 */
const BASE64_PATTERN = /[A-Za-z0-9+/]{40,}={0,2}/g;

/**
 * Regex pattern for URL-safe Base64.
 */
const BASE64_URL_SAFE_PATTERN = /[A-Za-z0-9_-]{40,}={0,2}/g;

/**
 * Patterns for common secrets/tokens.
 */
const SECRET_PATTERNS: Record<string, RegExp> = {
  // Private Keys
  privateKey: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/,

  // JWT tokens
  jwt: /eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/g,

  // AWS
  awsAccessKey: /AKIA[0-9A-Z]{16}/g,

  // GitHub
  githubToken: /ghp_[a-zA-Z0-9]{36}/g,
  githubFineGrained: /github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/g,

  // Slack
  slackToken: /xox[baprs]-[0-9a-zA-Z]{10,48}/g,

  // Stripe
  stripeKey: /sk_live_[0-9a-zA-Z]{24}/g,

  // Database URIs with credentials
  dbUri: /(?:mongodb|postgres(?:ql)?|mysql|redis):\/\/[^\s'"]+:[^\s'"]+@[^\s'"]+/g,
};

/**
 * Check if a string segment is likely Base64 encoded.
 */
export function isLikelyBase64(str: string): boolean {
  // Minimum length check
  if (str.length < 40) return false;

  // Check if only Base64 characters
  if (!/^[A-Za-z0-9+/=_-]+$/.test(str)) return false;

  // Check entropy - Base64 typically has high entropy
  const entropy = calculateEntropy(str);
  return entropy > 4.5;
}

/**
 * Calculate the ratio of Base64-like content in a string.
 */
export function getBase64Ratio(content: string): number {
  const matches = content.match(BASE64_PATTERN) || [];
  const urlSafeMatches = content.match(BASE64_URL_SAFE_PATTERN) || [];

  // Combine and deduplicate
  const allMatches = new Set([...matches, ...urlSafeMatches]);

  let totalBase64Length = 0;
  for (const match of allMatches) {
    if (isLikelyBase64(match)) {
      totalBase64Length += match.length;
    }
  }

  return content.length > 0 ? totalBase64Length / content.length : 0;
}

/**
 * Check if content contains binary/control characters.
 */
export function hasBinaryContent(content: string): boolean {
  // Check for null bytes or control characters (except newlines/tabs)
  return /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(content);
}

/**
 * Remove Base64 blocks from content.
 */
export function removeBase64Blocks(content: string): string {
  let result = content;

  // Remove standard Base64
  result = result.replace(BASE64_PATTERN, (match) => {
    if (isLikelyBase64(match)) {
      return "[ENCODED]";
    }
    return match;
  });

  // Remove URL-safe Base64
  result = result.replace(BASE64_URL_SAFE_PATTERN, (match) => {
    if (isLikelyBase64(match)) {
      return "[ENCODED]";
    }
    return match;
  });

  return result;
}

/**
 * Redact detected secrets in content.
 */
export function redactSecrets(content: string): { content: string; secretsFound: string[] } {
  let result = content;
  const secretsFound: string[] = [];

  for (const [name, pattern] of Object.entries(SECRET_PATTERNS)) {
    if (pattern.test(result)) {
      // Reset lastIndex for global patterns
      pattern.lastIndex = 0;
      result = result.replace(pattern, `[${name.toUpperCase()}_REDACTED]`);
      secretsFound.push(name);
    }
  }

  return { content: result, secretsFound };
}

/**
 * Configuration for content filtering.
 */
export interface FilterConfig {
  /** Maximum Base64 ratio before skipping (default: 0.5) */
  maxBase64Ratio?: number;
  /** Minimum meaningful content length after filtering (default: 50) */
  minContentLength?: number;
  /** Whether to redact secrets (default: true) */
  redactSecrets?: boolean;
  /** Whether to remove Base64 blocks (default: true) */
  removeBase64?: boolean;
}

const DEFAULT_CONFIG: Required<FilterConfig> = {
  maxBase64Ratio: 0.5,
  minContentLength: 50,
  redactSecrets: true,
  removeBase64: true,
};

/**
 * Filter content for RAG indexing.
 *
 * @param content - Raw content to filter
 * @param config - Filter configuration
 * @returns Filter result with action and cleaned content
 */
export function filterContent(
  content: string,
  config: FilterConfig = {}
): FilterResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const reasons: string[] = [];

  // 1. Check for binary content - skip entirely
  if (hasBinaryContent(content)) {
    debug("Skipping content with binary characters");
    return { action: "skip", reasons: ["Contains binary content"] };
  }

  // 2. Calculate Base64 ratio
  const base64Ratio = getBase64Ratio(content);
  debug(`Base64 ratio: ${(base64Ratio * 100).toFixed(1)}%`);

  // Skip if too much encoded content
  if (base64Ratio > cfg.maxBase64Ratio) {
    debug(`Skipping content: ${(base64Ratio * 100).toFixed(1)}% Base64`);
    return {
      action: "skip",
      reasons: [`${(base64Ratio * 100).toFixed(1)}% is Base64 encoded (threshold: ${(cfg.maxBase64Ratio * 100).toFixed(0)}%)`],
    };
  }

  let cleanedContent = content;

  // 3. Remove Base64 blocks if present and configured
  if (cfg.removeBase64 && base64Ratio > 0.1) {
    cleanedContent = removeBase64Blocks(cleanedContent);
    reasons.push("Removed Base64 blocks");
  }

  // 4. Redact secrets if configured
  if (cfg.redactSecrets) {
    const { content: redacted, secretsFound } = redactSecrets(cleanedContent);
    if (secretsFound.length > 0) {
      cleanedContent = redacted;
      reasons.push(`Redacted secrets: ${secretsFound.join(", ")}`);
    }
  }

  // 5. Check if remaining content is meaningful
  const meaningfulContent = cleanedContent
    .replace(/\[.*?_REDACTED\]|\[ENCODED\]/g, "")
    .trim();

  if (meaningfulContent.length < cfg.minContentLength) {
    debug(`Skipping: insufficient content after filtering (${meaningfulContent.length} chars)`);
    return {
      action: "skip",
      reasons: ["Insufficient meaningful content after filtering"],
    };
  }

  // Determine action
  const action = reasons.length > 0 ? "filter" : "index";

  return { action, cleanedContent, reasons };
}

/**
 * Quick check if content should be indexed.
 * Use this for fast pre-filtering before chunking.
 */
export function shouldIndexContent(content: string): boolean {
  // Quick checks
  if (hasBinaryContent(content)) return false;
  if (getBase64Ratio(content) > 0.5) return false;
  return true;
}
