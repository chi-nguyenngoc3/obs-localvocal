/**
 * Parse / serialize SubRip (.srt) — đủ dùng cho file do obs-localvocal sinh ra
 * qua `send_sentence_to_file` (`src/transcription-filter-callbacks.cpp`).
 *
 * Nguyên tắc: **round-trip trung thực**. Mỗi block giữ lại nguyên văn dòng
 * index và dòng timestamp; chỉ phần `text` được phép thay đổi. Nhờ vậy
 * `serialize(parse(s))` bằng `s` với mọi file hợp lệ, và tool hậu kỳ không thể
 * vô tình làm lệch thời gian phụ đề.
 *
 * Node thuần, không dependency.
 */

/** Dòng timestamp SubRip: `HH:MM:SS,mmm --> HH:MM:SS,mmm` (cho phép `.` thay `,`). */
const TIMESTAMP_RE =
  /^\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/;

/**
 * @typedef {object} SrtBlock
 * @property {string} index     Dòng index, nguyên văn.
 * @property {string} timestamp Dòng timestamp, nguyên văn.
 * @property {string} text      Phần text, có thể rỗng hoặc nhiều dòng.
 * @property {boolean} noTextLine `true` khi block gốc **không có dòng text nào**
 *   (index + timestamp rồi tới ngay dòng trống). Khác với block có đúng một dòng
 *   text rỗng; giữ phân biệt này để `serialize(parse(s)) === s`.
 */

/**
 * @typedef {object} ParsedSrt
 * @property {SrtBlock[]} blocks
 * @property {string} eol   Ký tự ngắt dòng phát hiện được (`"\r\n"` hoặc `"\n"`).
 * @property {string} bom   `"﻿"` nếu file có BOM, ngược lại `""`.
 * @property {string} trailer Đuôi nguyên văn sau block cuối (thường `"\n"` hoặc
 *   `"\n\n"`, hoặc `""` nếu file không kết thúc bằng ngắt dòng).
 */

/**
 * Parse nội dung .srt.
 *
 * @param {string} content
 * @returns {ParsedSrt}
 * @throws {Error} Nếu không tìm thấy block nào — nghĩa là file không phải .srt,
 *   và việc "xử lý" nó sẽ phá dữ liệu. Thà báo lỗi.
 */
export function parse(content) {
  if (typeof content !== "string") {
    throw new Error("parse() cần một string.");
  }

  const bom = content.startsWith("﻿") ? "﻿" : "";
  const body = bom ? content.slice(1) : content;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  // Giữ nguyên văn đuôi file: một số writer ghi một `\n`, một số ghi `\n\n`.
  const trailer = (body.match(/(?:\r?\n)*$/) ?? [""])[0];

  const lines = body.split(/\r?\n/);
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    // Bỏ qua dòng trống giữa các block.
    if (lines[i].trim() === "") {
      i++;
      continue;
    }

    // Một block hợp lệ: dòng index (số), rồi dòng timestamp.
    const maybeIndex = lines[i];
    const maybeTimestamp = lines[i + 1];

    if (/^\s*\d+\s*$/.test(maybeIndex) && TIMESTAMP_RE.test(maybeTimestamp ?? "")) {
      i += 2;
      const textLines = [];
      // Text chạy tới dòng trống, hoặc tới đầu block kế tiếp (một số file
      // thiếu dòng trống phân cách).
      while (i < lines.length) {
        if (lines[i].trim() === "") break;
        if (
          /^\s*\d+\s*$/.test(lines[i]) &&
          TIMESTAMP_RE.test(lines[i + 1] ?? "")
        ) {
          break;
        }
        textLines.push(lines[i]);
        i++;
      }
      blocks.push({
        index: maybeIndex,
        timestamp: maybeTimestamp,
        text: textLines.join(eol),
        noTextLine: textLines.length === 0,
      });
    } else {
      // Rác không thuộc block nào — bỏ qua một dòng rồi thử lại.
      i++;
    }
  }

  if (blocks.length === 0) {
    throw new Error(
      "Không tìm thấy block SubRip nào. File có đúng là .srt không?",
    );
  }

  return { blocks, eol, bom, trailer };
}

/**
 * Serialize trở lại .srt. Index và timestamp được ghi **nguyên văn** như lúc
 * parse; ngắt dòng, BOM và đuôi file cũng được giữ.
 *
 * @param {ParsedSrt} parsed
 * @returns {string}
 */
export function serialize(parsed) {
  const { blocks, eol, bom = "", trailer = eol } = parsed;
  const chunks = blocks.map((b) => {
    const head = `${b.index}${eol}${b.timestamp}`;
    // Block gốc không có dòng text nào thì không sinh dòng text nào — nếu thêm
    // một dòng rỗng, file ra sẽ khác file vào.
    if (b.noTextLine && b.text === "") return head;
    return `${head}${eol}${b.text}`;
  });
  return bom + chunks.join(eol + eol) + trailer;
}
