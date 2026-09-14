/**
 * Glossary dùng chung cho `mock-llm` (áp glossary để mô phỏng LLM) và
 * `transcript-cleanup` (nhúng glossary vào prompt gửi LLM thật).
 *
 * Node thuần, không dependency.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Đường dẫn glossary mặc định: `tools/vib-glossary.json`. */
export const DEFAULT_GLOSSARY_PATH = resolve(HERE, "..", "vib-glossary.json");

/**
 * Lớp ký tự coi là "chữ" khi xét biên từ. `\b` của JavaScript dựa trên `\w`
 * (ASCII), nên với tiếng Việt có dấu nó cắt sai giữa từ. Lớp này gồm Latin cơ
 * bản, Latin-1 Supplement / Extended-A/B (À-ɏ) và Latin Extended Additional
 * (1E00-1EFF, nơi chứa phần lớn nguyên âm tiếng Việt có dấu).
 */
const LETTER = "0-9A-Za-z\\u00C0-\\u024F\\u1E00-\\u1EFF";

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Đọc và kiểm tra file glossary JSON.
 *
 * @param {string} [path] Đường dẫn file. Mặc định `tools/vib-glossary.json`.
 * @returns {{version: string, terms: Array<{term: string, variants: string[]}>}}
 * @throws {Error} Nếu file không đọc được, không phải JSON hợp lệ, hoặc thiếu
 *   mảng `terms`. Thất bại ồn ào ở đây tốt hơn là lặng lẽ chạy với glossary rỗng.
 */
export function loadGlossary(path = DEFAULT_GLOSSARY_PATH) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Không đọc được glossary tại ${path}: ${err.message}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Glossary ${path} không phải JSON hợp lệ: ${err.message}`);
  }

  if (!data || !Array.isArray(data.terms)) {
    throw new Error(`Glossary ${path} thiếu mảng "terms".`);
  }

  const terms = [];
  for (const [i, entry] of data.terms.entries()) {
    if (!entry || typeof entry.term !== "string" || !entry.term.trim()) {
      throw new Error(`Glossary ${path}: terms[${i}] thiếu "term".`);
    }
    const variants = Array.isArray(entry.variants)
      ? entry.variants.filter((v) => typeof v === "string" && v.trim())
      : [];
    terms.push({ term: entry.term.trim(), variants });
  }

  return { version: data.version ?? "unknown", terms };
}

/**
 * Dựng danh sách quy tắc thay thế, sắp xếp biến thể **dài trước** để biến thể
 * dài không bị biến thể ngắn hơn ăn mất một phần (ví dụ "đi gi tan banking"
 * phải được thử trước "banking").
 *
 * @param {{terms: Array<{term: string, variants: string[]}>}} glossary
 * @returns {Array<{re: RegExp, term: string}>}
 */
export function buildRules(glossary) {
  const rules = [];
  for (const { term, variants } of glossary.terms) {
    for (const variant of variants) {
      rules.push({ variant, term });
    }
  }
  rules.sort((a, b) => b.variant.length - a.variant.length);

  return rules.map(({ variant, term }) => ({
    term,
    // Khoảng trắng trong biến thể khớp một-hoặc-nhiều khoảng trắng, để chịu
    // được trường hợp bản ghi có hai dấu cách.
    re: new RegExp(
      `(?<![${LETTER}])${escapeRegExp(variant).replace(/\\?\s+/g, "\\s+")}(?![${LETTER}])`,
      "giu",
    ),
  }));
}

/**
 * Chép lại kiểu chữ hoa của từ gốc sang từ thay thế, chỉ ở ký tự đầu. Không
 * đụng tới các từ vốn viết hoa toàn bộ trong glossary (KPI, OTP, SLA...).
 */
function matchLeadingCase(matched, replacement) {
  const first = matched[0];
  if (first !== first.toUpperCase() || first === first.toLowerCase()) {
    return replacement;
  }
  return replacement[0].toUpperCase() + replacement.slice(1);
}

/**
 * Áp glossary lên một đoạn text: thay các biến thể phiên âm hoá bằng từ tiếng
 * Anh đúng chính tả. Không đổi gì khác — dấu câu, ký hiệu tiền tệ, số, URL,
 * ngắt dòng đều giữ nguyên.
 *
 * @param {string} text
 * @param {Array<{re: RegExp, term: string}>} rules Kết quả của {@link buildRules}.
 * @returns {string}
 */
export function applyGlossary(text, rules) {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  for (const { re, term } of rules) {
    out = out.replace(re, (matched) => matchLeadingCase(matched, term));
  }
  return out;
}

/**
 * Kết xuất glossary thành danh sách gọn cho prompt LLM.
 *
 * @param {{terms: Array<{term: string, variants: string[]}>}} glossary
 * @param {number} [maxVariants=4] Số biến thể tối đa mỗi từ, để prompt không phình.
 * @returns {string} Mỗi dòng: `- meeting (hay bị nghe thành: mít ting, mít tinh)`
 */
export function formatForPrompt(glossary, maxVariants = 4) {
  return glossary.terms
    .map(({ term, variants }) => {
      const shown = variants.slice(0, maxVariants);
      return shown.length
        ? `- ${term} (hay bị nghe thành: ${shown.join(", ")})`
        : `- ${term}`;
    })
    .join("\n");
}
