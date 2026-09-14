#!/usr/bin/env node
/**
 * transcript-cleanup — làm sạch phụ đề tiếng Việt chêm tiếng Anh, xử lý cả file
 * một lượt (hậu kỳ, không realtime).
 *
 * obs-localvocal khi bật "Save to File" (`file_output_enable`) sẽ ghi `.txt`
 * (mỗi dòng một câu) hoặc
 * `.srt` qua `send_sentence_to_file` (`src/transcription-filter-callbacks.cpp`).
 * Whisper phiên âm hoá thuật ngữ tiếng Anh trong lời nói tiếng Việt — "meeting"
 * thành "mít ting", "deadline" thành "đét lai" — vì mỗi lần inference chỉ nhận
 * một ngôn ngữ (`src/transcription-filter.cpp`). Tool này gửi text qua một LLM
 * để phục hồi đúng chính tả.
 *
 * Vì sao hậu kỳ file tốt hơn realtime: LLM thấy **toàn bộ** buổi họp nên suy
 * được "mít ting" = "meeting" từ ngữ cảnh xung quanh, thay vì chỉ một segment
 * ~7 giây; rẻ hơn nhiều; và không có ràng buộc latency.
 *
 * Dùng:
 *   node cleanup.mjs <input.srt|input.txt> -o <output>
 *   node cleanup.mjs in.srt -o out.srt --batch-size 8 --overlap 2
 *   node cleanup.mjs in.srt -o out.srt --dry-run     # không gọi LLM, in kế hoạch
 *
 * Env:
 *   LLM_PROVIDER  anthropic (mặc định) | azure-openai | openai
 *   LLM_BASE_URL  mặc định http://127.0.0.1:5099 (mock ở tools/mock-llm)
 *   LLM_API_KEY   header tuỳ provider (`x-api-key` / `api-key` / Bearer);
 *                 không log ra bất cứ đâu
 *   LLM_MODEL     mặc định claude-sonnet-5. Azure bỏ qua — model do deployment quyết
 *   GLOSSARY_PATH mặc định tools/vib-glossary.json
 *
 *   Riêng Azure OpenAI (tên biến trùng với chuẩn Azure SDK nên dán thẳng được):
 *   AZURE_OPENAI_ENDPOINT        vd https://<resource>.openai.azure.com/
 *   AZURE_OPENAI_API_KEY         key
 *   AZURE_OPENAI_DEPLOYMENT_NAME vd gpt-4o
 *   AZURE_OPENAI_API_VERSION     vd 2024-05-01-preview
 *
 * CẢNH BÁO DỮ LIỆU: tool này gửi **nội dung phụ đề** tới `LLM_BASE_URL`. Nếu URL
 * đó là API công cộng thì nội dung họp rời khỏi hạ tầng của bạn. Với họp nội bộ
 * hoặc dữ liệu khách hàng, trỏ vào gateway nội bộ hoặc LLM chạy local.
 *
 * Node thuần (>= 18, cần `fetch`), không dependency.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as srt from "../lib/srt.mjs";
import {
  loadGlossary,
  formatForPrompt,
  DEFAULT_GLOSSARY_PATH,
} from "../lib/glossary.mjs";
import { getProvider, PROVIDER_IDS } from "../lib/providers.mjs";

// Azure dùng tên biến riêng (trùng chuẩn Azure SDK) nên cấu hình dán thẳng từ
// portal được. Nếu có AZURE_OPENAI_ENDPOINT mà không đặt LLM_PROVIDER thì suy ra
// luôn là azure-openai — đỡ một bước dễ quên.
const AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT ?? "";
const inferredProvider = AZURE_ENDPOINT ? "azure-openai" : "anthropic";

const DEFAULTS = {
  provider: process.env.LLM_PROVIDER ?? inferredProvider,
  baseUrl:
    process.env.LLM_BASE_URL ?? AZURE_ENDPOINT ?? "http://127.0.0.1:5099",
  model: process.env.LLM_MODEL ?? "claude-sonnet-5",
  apiKey:
    process.env.LLM_API_KEY ?? process.env.AZURE_OPENAI_API_KEY ?? "",
  deployment: process.env.AZURE_OPENAI_DEPLOYMENT_NAME ?? "",
  apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? "2024-05-01-preview",
  glossaryPath: process.env.GLOSSARY_PATH ?? DEFAULT_GLOSSARY_PATH,
  batchSize: 8,
  overlap: 2,
  retries: 2,
  timeoutMs: 60_000,
};

// `??` không bắt được chuỗi rỗng, mà env rỗng là trường hợp hay gặp.
if (!DEFAULTS.baseUrl) DEFAULTS.baseUrl = "http://127.0.0.1:5099";

const USAGE = `transcript-cleanup — làm sạch phụ đề tiếng Việt chêm tiếng Anh

  node cleanup.mjs <input> -o <output> [tuỳ chọn]

Tuỳ chọn
  -o, --output <path>    File ra (bắt buộc). Không được trùng file vào.
      --batch-size <n>   Số câu mỗi lần gọi LLM (mặc định ${DEFAULTS.batchSize})
      --overlap <n>      Số câu trước đó gửi kèm làm ngữ cảnh (mặc định ${DEFAULTS.overlap})
      --glossary <path>  File glossary JSON (mặc định tools/vib-glossary.json)
      --model <name>     Model (mặc định ${DEFAULTS.model})
      --provider <id>    ${PROVIDER_IDS.join(" | ")} (mặc định ${DEFAULTS.provider})
      --base-url <url>   Endpoint LLM (mặc định ${DEFAULTS.baseUrl})
      --deployment <n>   Azure: tên deployment (bắt buộc với azure-openai)
      --api-version <v>  Azure: api-version (mặc định ${DEFAULTS.apiVersion})
      --timeout <ms>     Timeout mỗi request (mặc định ${DEFAULTS.timeoutMs})
      --retries <n>      Số lần thử lại mỗi batch (mặc định ${DEFAULTS.retries})
      --format srt|txt   Ép định dạng thay vì suy từ đuôi file
      --dry-run          Không gọi LLM; in kế hoạch batch rồi thoát
      --force            Cho phép ghi đè file ra đã tồn tại
  -h, --help             In trợ giúp này

Mã thoát: 0 thành công · 1 lỗi khi chạy · 2 sai tham số`;

/** Lỗi do người dùng dùng sai — in gọn, không stack trace. */
class UsageError extends Error {}

/**
 * Parse argv.
 * @param {string[]} argv
 * @returns {object} Cấu hình đã trộn với mặc định.
 * @throws {UsageError}
 */
export function parseArgs(argv) {
  const opts = { ...DEFAULTS, input: null, output: null, dryRun: false, force: false, format: null };

  const needValue = (i, flag) => {
      if (i + 1 >= argv.length) throw new UsageError(`${flag} cần một giá trị.`);
      return argv[i + 1];
  };
  const positiveInt = (raw, flag, { allowZero = false } = {}) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || (!allowZero && n === 0)) {
      throw new UsageError(`${flag} phải là số nguyên ${allowZero ? "≥ 0" : "> 0"}, nhận "${raw}".`);
    }
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        return { help: true };
      case "-o":
      case "--output":
        opts.output = needValue(i, a); i++; break;
      case "--batch-size":
        opts.batchSize = positiveInt(needValue(i, a), a); i++; break;
      case "--overlap":
        opts.overlap = positiveInt(needValue(i, a), a, { allowZero: true }); i++; break;
      case "--glossary":
        opts.glossaryPath = needValue(i, a); i++; break;
      case "--model":
        opts.model = needValue(i, a); i++; break;
      case "--base-url":
        opts.baseUrl = needValue(i, a); i++; break;
      case "--provider": {
        const v = needValue(i, a); i++;
        if (!PROVIDER_IDS.includes(v)) {
          throw new UsageError(`--provider chỉ nhận ${PROVIDER_IDS.join(" | ")}, nhận "${v}".`);
        }
        opts.provider = v; break;
      }
      case "--deployment":
        opts.deployment = needValue(i, a); i++; break;
      case "--api-version":
        opts.apiVersion = needValue(i, a); i++; break;
      case "--timeout":
        opts.timeoutMs = positiveInt(needValue(i, a), a); i++; break;
      case "--retries":
        opts.retries = positiveInt(needValue(i, a), a, { allowZero: true }); i++; break;
      case "--format": {
        const v = needValue(i, a); i++;
        if (v !== "srt" && v !== "txt") throw new UsageError(`--format chỉ nhận srt hoặc txt, nhận "${v}".`);
        opts.format = v; break;
      }
      case "--dry-run": opts.dryRun = true; break;
      case "--force": opts.force = true; break;
      default:
        if (a.startsWith("-")) throw new UsageError(`Tuỳ chọn không nhận ra: ${a}`);
        if (opts.input !== null) throw new UsageError(`Chỉ nhận một file vào (đã có "${opts.input}", lại thấy "${a}").`);
        opts.input = a;
    }
  }

  if (!opts.input) throw new UsageError("Thiếu file vào.");
  if (!opts.output) throw new UsageError("Thiếu --output.");
  if (opts.overlap >= opts.batchSize) {
    throw new UsageError(
      `--overlap (${opts.overlap}) phải nhỏ hơn --batch-size (${opts.batchSize}), ` +
        "nếu không mỗi batch sẽ toàn là ngữ cảnh.",
    );
  }

  // Azure ghép deployment vào URL, thiếu là 404 với thông báo rất khó hiểu —
  // chặn ngay ở đây thay vì để người dùng đi debug HTTP.
  if (opts.provider === "azure-openai") {
    if (!opts.deployment) {
      throw new UsageError(
        "azure-openai cần tên deployment. Đặt AZURE_OPENAI_DEPLOYMENT_NAME hoặc --deployment.",
      );
    }
    if (!opts.apiVersion) {
      throw new UsageError(
        "azure-openai cần api-version. Đặt AZURE_OPENAI_API_VERSION hoặc --api-version.",
      );
    }
    if (!/^https?:\/\//.test(opts.baseUrl)) {
      throw new UsageError(
        `azure-openai cần endpoint đầy đủ (https://<resource>.openai.azure.com), nhận "${opts.baseUrl}". ` +
          "Đặt AZURE_OPENAI_ENDPOINT hoặc --base-url.",
      );
    }
  }

  opts.format ??= opts.input.toLowerCase().endsWith(".srt") ? "srt" : "txt";
  return opts;
}

/**
 * Chia danh sách câu thành các batch, mỗi batch kèm `overlap` câu **trước đó**
 * làm ngữ cảnh. Câu ngữ cảnh được gửi cho LLM đọc nhưng kết quả của chúng bị
 * bỏ — tránh một câu bị sửa hai lần theo hai cách khác nhau.
 *
 * @param {string[]} items
 * @param {number} batchSize
 * @param {number} overlap
 * @param {string} [eol="\n"] Ngắt dòng của file gốc, dùng khi ghép lại các câu
 *   nhiều dòng để output không lẫn `\n` vào file CRLF.
 * @returns {Array<{start: number, items: string[], context: string[], eol: string}>}
 */
export function planBatches(items, batchSize, overlap, eol = "\n") {
  const batches = [];
  for (let start = 0; start < items.length; start += batchSize) {
    batches.push({
      start,
      items: items.slice(start, start + batchSize),
      context: items.slice(Math.max(0, start - overlap), start),
      eol,
    });
  }
  return batches;
}

const SYSTEM_PROMPT_HEAD = `Bạn là công cụ hiệu đính bản ghi lời nói (transcript) tiếng Việt.

Bản ghi do Whisper tạo ra từ lời nói tiếng Việt có chêm thuật ngữ tiếng Anh.
Whisper thường phiên âm hoá thuật ngữ tiếng Anh thành chữ Việt (ví dụ "meeting"
bị ghi thành "mít ting"). Việc của bạn là phục hồi đúng chính tả tiếng Anh.

QUY TẮC BẮT BUỘC
1. CHỈ sửa từ tiếng Anh bị phiên âm hoá. Không sửa gì khác.
2. KHÔNG dịch. Câu tiếng Việt giữ nguyên tiếng Việt; câu tiếng Anh giữ nguyên tiếng Anh.
3. KHÔNG viết lại, KHÔNG tóm tắt, KHÔNG sửa ngữ pháp, KHÔNG bỏ từ đệm ("ờ", "ừm").
4. Giữ nguyên: dấu câu, chữ hoa/thường, số, ký hiệu tiền tệ ($ ₫ € %), URL, email, ngắt dòng.
5. Nếu một câu không cần sửa, trả lại y hệt từng ký tự.
6. Số dòng trả về phải ĐÚNG BẰNG số dòng được yêu cầu sửa. Không thêm, không bớt, không gộp.

ĐỊNH DẠNG
Đầu vào là các dòng có tiền tố số thứ tự, ví dụ "3| nội dung câu".
Trả về đúng các dòng đó, giữ nguyên tiền tố số, chỉ thay phần nội dung.
Không thêm lời giải thích, không thêm markdown, không thêm dòng nào khác.`;

/**
 * Dựng system prompt: phần quy tắc cố định + glossary.
 * @param {ReturnType<typeof loadGlossary>} glossary
 * @returns {string}
 */
export function buildSystemPrompt(glossary) {
  return `${SYSTEM_PROMPT_HEAD}

THUẬT NGỮ ƯU TIÊN (dạng đúng ở bên trái)
${formatForPrompt(glossary)}`;
}

/**
 * Dựng user message cho một batch. Câu ngữ cảnh được đánh dấu rõ là chỉ để đọc.
 * @param {{start: number, items: string[], context: string[]}} batch
 * @returns {string}
 */
export function buildUserMessage(batch) {
  const numbered = batch.items.map((t, i) => `${batch.start + i + 1}| ${t}`).join("\n");
  if (!batch.context.length) return `CẦN SỬA:\n${numbered}`;
  const ctx = batch.context
    .map((t, i) => `${batch.start - batch.context.length + i + 1}| ${t}`)
    .join("\n");
  return `NGỮ CẢNH (chỉ để đọc, KHÔNG trả về các dòng này):\n${ctx}\n\nCẦN SỬA:\n${numbered}`;
}

/**
 * Parse phản hồi LLM về lại danh sách câu theo số thứ tự.
 *
 * Chấp nhận việc LLM bỏ sót hoặc thêm dòng: chỉ lấy đúng những số thứ tự thuộc
 * batch, và **câu nào không có trong phản hồi thì giữ nguyên bản gốc**. Đây là
 * fail-open: thà không sửa còn hơn mất phụ đề.
 *
 * @param {string} responseText
 * @param {{start: number, items: string[]}} batch
 * @returns {{texts: string[], matched: number}}
 */
export function parseBatchResponse(responseText, batch) {
  // Số dòng gốc của từng câu. Một block .srt có thể có nhiều dòng (phụ đề bị
  // cắt dòng), và dòng thứ hai trở đi KHÔNG có tiền tố số — phải gom lại,
  // nếu không sẽ mất phụ đề.
  const expectedLines = new Map(
    batch.items.map((t, i) => [batch.start + i + 1, t.split(/\r?\n/).length]),
  );

  const byIndex = new Map();
  let current = null;
  for (const line of String(responseText ?? "").split(/\r?\n/)) {
    const m = /^\s*(\d+)\s*\|\s?([\s\S]*)$/.exec(line);
    if (m) {
      const n = Number(m[1]);
      // Dòng trùng số: giữ lần xuất hiện đầu, bỏ các lần sau.
      if (byIndex.has(n)) {
        current = null;
        continue;
      }
      byIndex.set(n, [m[2]]);
      current = n;
      continue;
    }
    // Dòng không có tiền tố: chỉ coi là dòng tiếp nối khi câu đang xử lý thực
    // sự còn thiếu dòng. Nhờ vậy lời giải thích thừa của LLM không lọt vào.
    if (current === null) continue;
    const acc = byIndex.get(current);
    if (acc.length < (expectedLines.get(current) ?? 1)) {
      acc.push(line);
    } else {
      current = null;
    }
  }

  let matched = 0;
  const texts = batch.items.map((original, i) => {
    const acc = byIndex.get(batch.start + i + 1);
    if (!acc) return original;
    const got = acc.join(batch.eol ?? "\n");
    // LLM trả rỗng cho câu vốn có nội dung → coi là lỗi, giữ bản gốc.
    if (got.trim() === "" && original.trim() !== "") return original;
    // Số dòng lệch → cấu trúc block sẽ sai, không đáng đánh đổi. Giữ bản gốc.
    if (acc.length !== original.split(/\r?\n/).length) return original;
    matched++;
    return got;
  });

  return { texts, matched };
}

/**
 * Gọi LLM cho một batch, có retry + timeout. Hình dạng wire do provider quyết
 * định (`../lib/providers.mjs`) — hàm này chỉ lo retry, timeout và fail-open.
 *
 * @returns {Promise<{texts: string[], matched: number, ok: boolean, error?: string}>}
 *   `ok: false` nghĩa là đã hết lượt thử; `texts` khi đó là **bản gốc** (fail-open).
 */
async function callLlm(batch, cfg, systemPrompt) {
  const { timeoutMs, retries } = cfg;
  const provider = getProvider(cfg.provider);
  const url = provider.url(cfg);
  const headers = provider.headers(cfg);

  const payload = JSON.stringify(
    provider.body({
      model: cfg.model,
      // Đủ cho một batch câu; chặn trường hợp model lan thành bài luận.
      maxTokens: Math.max(512, batch.items.join("\n").length * 2),
      system: systemPrompt,
      user: buildUserMessage(batch),
    }),
  );

  let lastError = "không rõ";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Backoff tuyến tính, đủ cho rate-limit tạm thời.
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: payload,
        signal: ac.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        lastError = `HTTP ${res.status} ${body.slice(0, 200)}`;
        // 4xx (trừ 408/429) là lỗi request, thử lại cũng vậy.
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break;
        continue;
      }
      const data = await res.json();
      const text = provider.extract(data);
      if (typeof text !== "string" || text === "") {
        lastError = `phản hồi ${provider.id} không có trường text mong đợi`;
        continue;
      }
      return { ...parseBatchResponse(text, batch), ok: true };
    } catch (err) {
      lastError = err.name === "AbortError" ? `timeout sau ${timeoutMs}ms` : err.message;
    } finally {
      clearTimeout(timer);
    }
  }

  return { texts: batch.items, matched: 0, ok: false, error: lastError };
}

/** Chuyển `.txt` thành danh sách câu, giữ lại vị trí dòng rỗng để ghép lại đúng. */
function splitTxt(content) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const trailer = (content.match(/(?:\r?\n)*$/) ?? [""])[0];
  const lines = content.slice(0, content.length - trailer.length).split(/\r?\n/);
  return { lines, eol, trailer };
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const inputPath = resolve(opts.input);
  const outputPath = resolve(opts.output);

  if (inputPath === outputPath) {
    throw new UsageError("File ra trùng file vào. Tool này không ghi đè bản gốc.");
  }
  if (!existsSync(inputPath)) {
    throw new UsageError(`Không thấy file vào: ${inputPath}`);
  }
  if (existsSync(outputPath) && !opts.force) {
    throw new UsageError(`File ra đã tồn tại: ${outputPath}. Thêm --force để ghi đè.`);
  }

  const content = readFileSync(inputPath, "utf8");
  const glossary = loadGlossary(opts.glossaryPath);
  const systemPrompt = buildSystemPrompt(glossary);

  // Tách nội dung thành danh sách câu + cách ghép lại. Chỉ text được thay;
  // với .srt thì index và timestamp không bao giờ đi qua LLM.
  let sentences;
  let rebuild;
  let eol;
  if (opts.format === "srt") {
    const parsed = srt.parse(content);
    sentences = parsed.blocks.map((b) => b.text);
    eol = parsed.eol;
    rebuild = (texts) =>
      srt.serialize({
        ...parsed,
        blocks: parsed.blocks.map((b, i) => ({ ...b, text: texts[i] })),
      });
  } else {
    const split = splitTxt(content);
    sentences = split.lines;
    eol = split.eol;
    rebuild = (texts) => texts.join(split.eol) + split.trailer;
  }

  // Câu rỗng không cần gửi LLM — tiết kiệm token và tránh model "sáng tác".
  const sendable = sentences
    .map((text, i) => ({ text, i }))
    .filter(({ text }) => text.trim() !== "");

  const batches = planBatches(
    sendable.map((s) => s.text),
    opts.batchSize,
    opts.overlap,
    eol,
  );

  console.error(
    `[cleanup] ${opts.format.toUpperCase()} · ${sentences.length} đơn vị ` +
      `(${sendable.length} có nội dung) · ${batches.length} batch ` +
      `· batch=${opts.batchSize} overlap=${opts.overlap}`,
  );
  // Azure chọn model qua deployment, in `model=` ở đây sẽ gây hiểu nhầm.
  const modelLabel =
    opts.provider === "azure-openai"
      ? `deployment=${opts.deployment} api-version=${opts.apiVersion}`
      : `model=${opts.model}`;
  console.error(
    `[cleanup] backend ${opts.baseUrl} provider=${opts.provider} ` +
      `${modelLabel} glossary=${glossary.version}`,
  );
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(opts.baseUrl);
  if (!opts.apiKey && !isLocal) {
    console.error("[cleanup] CẢNH BÁO: không có API key nhưng backend không phải localhost.");
  }
  if (!isLocal) {
    console.error(
      "[cleanup] CẢNH BÁO DỮ LIỆU: nội dung phụ đề đang được gửi ra khỏi máy này.",
    );
  }

  if (opts.dryRun) {
    for (const b of batches) {
      console.error(
        `[cleanup] batch @${b.start}: ${b.items.length} câu, ${b.context.length} câu ngữ cảnh`,
      );
    }
    console.error("[cleanup] --dry-run: không gọi LLM, không ghi file.");
    return 0;
  }

  const out = [...sentences];
  let failedBatches = 0;
  let changed = 0;
  const t0 = process.hrtime.bigint();

  for (const [bi, batch] of batches.entries()) {
    const r = await callLlm(batch, opts, systemPrompt);
    if (!r.ok) {
      failedBatches++;
      console.error(
        `[cleanup] batch ${bi + 1}/${batches.length} THẤT BẠI (${r.error}) — giữ nguyên bản gốc.`,
      );
    } else if (r.matched < batch.items.length) {
      console.error(
        `[cleanup] batch ${bi + 1}/${batches.length}: LLM chỉ trả ${r.matched}/${batch.items.length} dòng — ` +
          "các dòng thiếu giữ nguyên bản gốc.",
      );
    }
    // Ghép kết quả về đúng vị trí gốc trong `sentences`.
    r.texts.forEach((text, k) => {
      const target = sendable[batch.start + k].i;
      if (text !== out[target]) changed++;
      out[target] = text;
    });
  }

  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  writeFileSync(outputPath, rebuild(out), "utf8");

  console.error(
    `[cleanup] Xong: ${changed}/${sendable.length} câu thay đổi · ` +
      `${failedBatches} batch thất bại · ${(elapsedMs / 1000).toFixed(1)}s → ${outputPath}`,
  );

  // Có batch thất bại: file vẫn hợp lệ (fail-open) nhưng cảnh báo rõ để không
  // ai nhầm là đã làm sạch toàn bộ.
  if (failedBatches > 0) {
    console.error(
      `[cleanup] CẢNH BÁO: ${failedBatches}/${batches.length} batch không được làm sạch.`,
    );
    return 1;
  }
  return 0;
}

// Chỉ chạy main khi được gọi trực tiếp; khi `import` thì chỉ export hàm để test.
// Dùng `pathToFileURL` thay vì nối `file://` bằng tay — đường dẫn có khoảng
// trắng sẽ được mã hoá thành `%20` trong `import.meta.url`, nối tay thì không
// bao giờ khớp và tool im lặng không làm gì.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      if (err instanceof UsageError) {
        console.error(`[cleanup] ${err.message}\n`);
        console.error(USAGE);
        process.exit(2);
      }
      console.error(`[cleanup] Lỗi: ${err.message}`);
      process.exit(1);
    });
}
