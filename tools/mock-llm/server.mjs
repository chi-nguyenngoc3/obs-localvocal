#!/usr/bin/env node
/**
 * Mock LLM backend — giả lập Anthropic Messages API (`POST /v1/messages`).
 *
 * Vì sao cần: môi trường phát triển có thể không có đường ra Internet, và ngay
 * khi có thì test bằng LLM thật vẫn tốn token và **không deterministic**. Mock
 * này cho `transcript-cleanup` (và sau này là proxy realtime) một backend chạy
 * được, lặp lại y hệt, và có thể ép lỗi theo ý muốn.
 *
 * Chạy:
 *   node tools/mock-llm/server.mjs
 *   MOCK_MODE=slow  MOCK_DELAY_MS=5000 node tools/mock-llm/server.mjs
 *   MOCK_MODE=error MOCK_STATUS=500    node tools/mock-llm/server.mjs
 *
 * Env:
 *   MOCK_MODE      glossary (mặc định) | slow | error | echo
 *   PORT           mặc định 5099
 *   HOST           mặc định 127.0.0.1 — chỉ localhost, đây là mock, không phải service
 *   MOCK_DELAY_MS  độ trễ cho mode `slow`, mặc định 5000
 *   MOCK_STATUS    HTTP status cho mode `error`, mặc định 500
 *   GLOSSARY_PATH  đường dẫn glossary, mặc định tools/vib-glossary.json
 *   MOCK_EXIT_ON_STDIN_CLOSE=1
 *                  Tự thoát khi stdin đóng. Dùng cho test tự động: tiến trình
 *                  cha chỉ cần đóng stdin là mock tắt, không cần gửi signal
 *                  (một số môi trường sandbox chặn `kill`).
 *
 * Node thuần, không dependency.
 */

import { createServer } from "node:http";
import {
  loadGlossary,
  buildRules,
  applyGlossary,
  DEFAULT_GLOSSARY_PATH,
} from "../lib/glossary.mjs";

const MODES = new Set(["glossary", "slow", "error", "echo"]);

const MODE = process.env.MOCK_MODE ?? "glossary";
const PORT = Number(process.env.PORT ?? 5099);
const HOST = process.env.HOST ?? "127.0.0.1";
const DELAY_MS = Number(process.env.MOCK_DELAY_MS ?? 5000);
const ERROR_STATUS = Number(process.env.MOCK_STATUS ?? 500);
const GLOSSARY_PATH = process.env.GLOSSARY_PATH ?? DEFAULT_GLOSSARY_PATH;

/** Chặn body khổng lồ: phụ đề một buổi họp dài vẫn thừa sức nằm dưới 1 MB. */
const MAX_BODY_BYTES = 1024 * 1024;

if (!MODES.has(MODE)) {
  console.error(
    `MOCK_MODE không hợp lệ: "${MODE}". Chọn một trong: ${[...MODES].join(", ")}`,
  );
  process.exit(2);
}
for (const [name, value] of [
  ["PORT", PORT],
  ["MOCK_DELAY_MS", DELAY_MS],
  ["MOCK_STATUS", ERROR_STATUS],
]) {
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${name} không hợp lệ: ${process.env[name]}`);
    process.exit(2);
  }
}

let rules = [];
let glossaryVersion = "n/a";
if (MODE === "glossary" || MODE === "slow") {
  // `slow` cũng trả kết quả đúng — nó chỉ trả *muộn*. Nhờ vậy test timeout
  // phân biệt được "chậm" với "sai".
  try {
    const glossary = loadGlossary(GLOSSARY_PATH);
    rules = buildRules(glossary);
    glossaryVersion = glossary.version;
  } catch (err) {
    console.error(`[mock-llm] ${err.message}`);
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Đọc toàn bộ request body, có giới hạn kích thước. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body quá lớn"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Lỗi theo đúng hình dạng lỗi của Anthropic API, để client xử lý thống nhất. */
function sendApiError(res, status, type, message) {
  sendJson(res, status, { type: "error", error: { type, message } });
}

/**
 * Trích text người dùng gửi từ body Anthropic Messages.
 * Hỗ trợ cả `content` dạng string và dạng mảng block `{type:"text", text}`.
 */
function extractUserText(body) {
  if (!body || !Array.isArray(body.messages)) return null;
  const parts = [];
  for (const msg of body.messages) {
    if (!msg || msg.role !== "user") continue;
    if (typeof msg.content === "string") {
      parts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && block.type === "text" && typeof block.text === "string") {
          parts.push(block.text);
        }
      }
    }
  }
  return parts.length ? parts.join("\n") : null;
}

/** Đếm token thô — chỉ để field `usage` trông hợp lý, không dùng để tính tiền. */
const roughTokens = (s) => Math.ceil((s?.length ?? 0) / 4);

const server = createServer(async (req, res) => {
  const started = process.hrtime.bigint();
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  const elapsedMs = () => Number(process.hrtime.bigint() - started) / 1e6;
  const log = (status, extra = "") =>
    console.log(
      `[mock-llm] ${req.method} ${url.pathname} -> ${status} ` +
        `${elapsedMs().toFixed(0)}ms mode=${MODE}${extra}`,
    );

  if (url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      mode: MODE,
      glossaryVersion,
      rules: rules.length,
    });
    log(200);
    return;
  }

  if (req.method !== "POST") {
    sendApiError(res, 405, "invalid_request_error", `${req.method} không được hỗ trợ`);
    log(405);
    return;
  }

  if (url.pathname !== "/v1/messages") {
    sendApiError(res, 404, "not_found_error", `Không có route ${url.pathname}`);
    log(404);
    return;
  }

  // Mode `error` trả lỗi *trước khi* đọc body: đây chính là kịch bản backend
  // sập, và client phải fail-open chứ không được trả phụ đề rỗng.
  if (MODE === "error") {
    sendApiError(res, ERROR_STATUS, "api_error", "mock: lỗi có chủ đích");
    log(ERROR_STATUS);
    return;
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    sendApiError(res, 413, "invalid_request_error", err.message);
    log(413);
    return;
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    sendApiError(res, 400, "invalid_request_error", "body không phải JSON hợp lệ");
    log(400);
    return;
  }

  const userText = extractUserText(body);
  if (userText === null) {
    sendApiError(
      res,
      400,
      "invalid_request_error",
      'thiếu messages[].content với role "user"',
    );
    log(400);
    return;
  }

  if (MODE === "slow") await sleep(DELAY_MS);

  const outText = MODE === "echo" ? userText : applyGlossary(userText, rules);

  sendJson(res, 200, {
    id: `msg_mock_${url.pathname.length}_${raw.length}`,
    type: "message",
    role: "assistant",
    model: typeof body.model === "string" ? body.model : "mock-model",
    content: [{ type: "text", text: outText }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: roughTokens(userText),
      output_tokens: roughTokens(outText),
    },
  });
  // Chỉ log độ dài, KHÔNG log nội dung — phụ đề họp có thể là dữ liệu nội bộ.
  log(200, ` in=${userText.length}ch out=${outText.length}ch`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[mock-llm] Cổng ${PORT} đã bị chiếm. Đặt PORT=<khác> rồi chạy lại.`);
  } else {
    console.error(`[mock-llm] Lỗi server: ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(
    `[mock-llm] http://${HOST}:${PORT}  mode=${MODE}` +
      (MODE === "slow" ? ` delay=${DELAY_MS}ms` : "") +
      (MODE === "error" ? ` status=${ERROR_STATUS}` : "") +
      (rules.length ? `  glossary=${glossaryVersion} (${rules.length} rules)` : ""),
  );
});

function shutdown() {
  server.close(() => process.exit(0));
  // Không để kết nối treo giữ tiến trình sống mãi.
  setTimeout(() => process.exit(0), 1000).unref();
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, shutdown);
}

if (process.env.MOCK_EXIT_ON_STDIN_CLOSE === "1") {
  process.stdin.resume();
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
}
