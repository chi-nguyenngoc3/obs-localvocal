#!/usr/bin/env node
/**
 * Test suite cho tools/ — dùng `node:test` sẵn trong Node >= 18, không dependency.
 *
 * Chạy:  node --test tools/
 *   hoặc: node tools/test.mjs
 *
 * Các bài test tự khởi động mock LLM ở cổng tự do rồi tắt, nên không cần
 * chuẩn bị gì trước và không đụng tới cổng 5099 đang dùng để phát triển.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as srt from "./lib/srt.mjs";
import { loadGlossary, buildRules, applyGlossary, formatForPrompt } from "./lib/glossary.mjs";
import {
  parseArgs,
  planBatches,
  parseBatchResponse,
  buildSystemPrompt,
  buildUserMessage,
} from "./transcript-cleanup/cleanup.mjs";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const TESTDATA = join(TOOLS, "testdata");
const CLEANUP = join(TOOLS, "transcript-cleanup", "cleanup.mjs");
const MOCK = join(TOOLS, "mock-llm", "server.mjs");

const read = (p) => readFileSync(p, "utf8");

let workdir;
before(() => {
  workdir = mkdtempSync(join(tmpdir(), "localvocal-tools-"));
});
after(() => {
  if (workdir && existsSync(workdir)) rmSync(workdir, { recursive: true, force: true });
});

/**
 * Khởi động mock LLM, đợi tới khi /health trả lời. Trả về hàm tắt.
 *
 * Tắt bằng cách **đóng stdin** (`MOCK_EXIT_ON_STDIN_CLOSE=1`) thay vì gửi
 * signal: một số môi trường sandbox trả `EPERM` cho `kill`, và khi đó teardown
 * sẽ làm test đỏ dù mọi assertion đều đúng. `kill` chỉ dùng làm phương án cuối.
 */
async function startMock(env = {}, port) {
  const child = spawn(process.execPath, [MOCK], {
    env: { ...process.env, PORT: String(port), MOCK_EXIT_ON_STDIN_CLOSE: "1", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (d) => stderr.push(d.toString()));

  const deadline = Date.now() + 8000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`mock thoát sớm (code ${child.exitCode}): ${stderr.join("")}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) break;
    } catch {
      /* chưa listen, thử lại */
    }
    if (Date.now() > deadline) {
      child.stdin.end();
      throw new Error(`mock không lên sau 8s: ${stderr.join("")}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return () =>
    new Promise((done) => {
      if (child.exitCode !== null) return done();
      child.once("exit", () => done());
      child.stdin.end();
      // Phương án cuối nếu đóng stdin không đủ. `kill` có thể bị sandbox chặn,
      // nên bọc try/catch và vẫn giải phóng test.
      const hard = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* sandbox chặn kill — bỏ qua, tiến trình sẽ chết cùng test runner */
        }
        done();
      }, 2000);
      hard.unref();
    });
}

/** Chạy cleanup.mjs như một tiến trình con. */
function runCleanup(args, env = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [CLEANUP, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => res({ code, stdout, stderr }));
  });
}

// ---------------------------------------------------------------- srt parser

describe("lib/srt", () => {
  test("round-trip từng byte trên cả ba fixture", () => {
    for (const name of ["codeswitch-vi.srt", "codeswitch-vi.expected.srt", "edge-cases.srt"]) {
      const content = read(join(TESTDATA, name));
      assert.equal(srt.serialize(srt.parse(content)), content, `round-trip lỗi ở ${name}`);
    }
  });

  test("round-trip với CRLF, BOM và không có ngắt dòng cuối", () => {
    const cases = [
      "﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nxin chào\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nhai dòng\r\nở đây",
      "1\n00:00:01,000 --> 00:00:02,000\nmột dòng\n",
      "1\n00:00:01,000 --> 00:00:02,000\nkhông ngắt dòng cuối",
    ];
    for (const c of cases) {
      assert.equal(srt.serialize(srt.parse(c)), c);
    }
  });

  test("phát hiện đúng eol và bom", () => {
    const crlf = srt.parse("﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nx\r\n");
    assert.equal(crlf.eol, "\r\n");
    assert.equal(crlf.bom, "﻿");
    const lf = srt.parse("1\n00:00:01,000 --> 00:00:02,000\nx\n");
    assert.equal(lf.eol, "\n");
    assert.equal(lf.bom, "");
  });

  test("block không có dòng text vẫn được giữ, phân biệt với dòng text rỗng", () => {
    const noText = "1\n00:00:01,000 --> 00:00:02,000\n\n2\n00:00:03,000 --> 00:00:04,000\nx\n";
    const p = srt.parse(noText);
    assert.equal(p.blocks.length, 2);
    assert.equal(p.blocks[0].text, "");
    assert.equal(p.blocks[0].noTextLine, true);
    assert.equal(srt.serialize(p), noText);
  });

  test("chấp nhận timestamp dùng dấu chấm thay dấu phẩy", () => {
    const p = srt.parse("1\n00:00:01.000 --> 00:00:02.500\nx\n");
    assert.equal(p.blocks.length, 1);
    assert.equal(p.blocks[0].timestamp, "00:00:01.000 --> 00:00:02.500");
  });

  test("báo lỗi khi file không phải .srt thay vì trả về rỗng", () => {
    assert.throws(() => srt.parse("chỉ là văn bản thường\nkhông có timestamp\n"), /SubRip/);
    assert.throws(() => srt.parse(""), /SubRip/);
    assert.throws(() => srt.parse(null), /string/);
  });

  test("index và timestamp giữ nguyên văn, kể cả khoảng trắng lạ", () => {
    const p = srt.parse("1\n00:00:01,000  -->  00:00:02,000\nx\n");
    assert.equal(p.blocks[0].timestamp, "00:00:01,000  -->  00:00:02,000");
  });
});

// ------------------------------------------------------------------ glossary

describe("lib/glossary", () => {
  const glossary = loadGlossary();
  const rules = buildRules(glossary);

  test("glossary có nội dung và mọi entry đều hợp lệ", () => {
    assert.ok(glossary.terms.length >= 30, `chỉ có ${glossary.terms.length} thuật ngữ`);
    for (const { term, variants } of glossary.terms) {
      assert.ok(term.length > 0);
      assert.ok(Array.isArray(variants));
    }
    assert.ok(rules.length > glossary.terms.length, "mỗi thuật ngữ nên có nhiều biến thể");
  });

  test("sửa các biến thể phiên âm hoá", () => {
    assert.equal(applyGlossary("cái mít ting hôm nay", rules), "cái meeting hôm nay");
    assert.equal(applyGlossary("bị đét lai rồi", rules), "bị deadline rồi");
    assert.equal(applyGlossary("chỉ số ca pi ai", rules), "chỉ số KPI");
  });

  test("biến thể dài được ưu tiên trước biến thể ngắn", () => {
    // "đi gi tan banking" phải thành "digital banking", không phải
    // "đi gi tan " + một kết quả khớp riêng của "banking".
    assert.equal(applyGlossary("đội đi gi tan banking", rules), "đội digital banking");
    assert.equal(applyGlossary("dự án cor banking", rules), "dự án core banking");
  });

  test("chịu được nhiều khoảng trắng giữa các tiếng", () => {
    assert.equal(applyGlossary("cái mít  ting", rules), "cái meeting");
  });

  test("không sửa ký hiệu tiền tệ, số, URL, email", () => {
    for (const s of [
      "Chi phí là $5000 chưa gồm thuế.",
      "100% 200$ 300₫ 50€",
      "https://example.internal/report?id=42&type=full",
      "ops-team@example.internal",
      "Tăng 12.5% so với quý trước.",
    ]) {
      assert.equal(applyGlossary(s, rules), s);
    }
  });

  test("không sửa câu tiếng Việt thuần và câu tiếng Anh thuần", () => {
    for (const s of [
      "Hôm nay trời mưa nên cả đội làm việc từ xa.",
      "Please review the deck before tomorrow morning.",
    ]) {
      assert.equal(applyGlossary(s, rules), s);
    }
  });

  test("không cắt vào giữa từ tiếng Việt có dấu", () => {
    // `\b` của JS dựa trên ASCII nên sẽ khớp sai ở đây nếu không dùng lớp ký
    // tự Latin mở rộng.
    const s = "Chúng ta đã bàn về chuyện đó.";
    assert.equal(applyGlossary(s, rules), s);
  });

  test("giữ chữ hoa đầu câu khi thay thế", () => {
    assert.equal(applyGlossary("Mít ting bắt đầu lúc 9h.", rules), "Meeting bắt đầu lúc 9h.");
  });

  test("giữ nguyên ngắt dòng khi thay thế trong text nhiều dòng", () => {
    assert.equal(
      applyGlossary("Câu này nói về cái mít ting\nvà bị cắt dòng.", rules),
      "Câu này nói về cái meeting\nvà bị cắt dòng.",
    );
  });

  test("chuỗi rỗng và giá trị không phải string trả về y nguyên", () => {
    assert.equal(applyGlossary("", rules), "");
    assert.equal(applyGlossary(null, rules), null);
  });

  test("formatForPrompt liệt kê thuật ngữ và giới hạn số biến thể", () => {
    const out = formatForPrompt(glossary, 2);
    assert.match(out, /- meeting \(hay bị nghe thành: /);
    for (const line of out.split("\n")) {
      const m = /hay bị nghe thành: (.*)\)$/.exec(line);
      if (m) assert.ok(m[1].split(", ").length <= 2, `quá 2 biến thể: ${line}`);
    }
  });

  test("báo lỗi rõ ràng với glossary thiếu hoặc sai định dạng", () => {
    assert.throws(() => loadGlossary("/không/tồn/tại.json"), /Không đọc được glossary/);

    const write = (name, content) => {
      const p = join(workdir, name);
      writeFileSync(p, content, "utf8");
      return p;
    };
    assert.throws(() => loadGlossary(write("bad.json", "{ không phải json }")), /không phải JSON hợp lệ/);
    assert.throws(() => loadGlossary(write("noterms.json", '{"version":"1"}')), /thiếu mảng "terms"/);
    assert.throws(
      () => loadGlossary(write("badterm.json", '{"terms":[{"variants":["x"]}]}')),
      /terms\[0\] thiếu "term"/,
    );
  });
});

// ----------------------------------------------------------- cleanup: thuần

describe("transcript-cleanup: hàm thuần", () => {
  test("parseArgs nhận cấu hình đầy đủ", () => {
    const o = parseArgs(["in.srt", "-o", "out.srt", "--batch-size", "4", "--overlap", "1"]);
    assert.equal(o.input, "in.srt");
    assert.equal(o.output, "out.srt");
    assert.equal(o.batchSize, 4);
    assert.equal(o.overlap, 1);
    assert.equal(o.format, "srt");
  });

  test("parseArgs suy định dạng từ đuôi file, và --format ghi đè", () => {
    assert.equal(parseArgs(["a.srt", "-o", "b"]).format, "srt");
    assert.equal(parseArgs(["a.SRT", "-o", "b"]).format, "srt");
    assert.equal(parseArgs(["a.txt", "-o", "b"]).format, "txt");
    assert.equal(parseArgs(["a.log", "-o", "b"]).format, "txt");
    assert.equal(parseArgs(["a.srt", "-o", "b", "--format", "txt"]).format, "txt");
  });

  test("parseArgs từ chối tham số sai", () => {
    assert.throws(() => parseArgs([]), /Thiếu file vào/);
    assert.throws(() => parseArgs(["a.srt"]), /Thiếu --output/);
    assert.throws(() => parseArgs(["a.srt", "-o"]), /cần một giá trị/);
    assert.throws(() => parseArgs(["a.srt", "b.srt", "-o", "c"]), /Chỉ nhận một file vào/);
    assert.throws(() => parseArgs(["--bogus"]), /không nhận ra/);
    assert.throws(() => parseArgs(["a.srt", "-o", "b", "--batch-size", "0"]), /> 0/);
    assert.throws(() => parseArgs(["a.srt", "-o", "b", "--batch-size", "x"]), /số nguyên/);
    assert.throws(() => parseArgs(["a.srt", "-o", "b", "--overlap", "-1"]), /≥ 0/);
    assert.throws(() => parseArgs(["a.srt", "-o", "b", "--format", "vtt"]), /srt hoặc txt/);
    assert.throws(
      () => parseArgs(["a.srt", "-o", "b", "--overlap", "8", "--batch-size", "8"]),
      /phải nhỏ hơn/,
    );
  });

  test("parseArgs cho phép overlap = 0", () => {
    assert.equal(parseArgs(["a.srt", "-o", "b", "--overlap", "0"]).overlap, 0);
  });

  test("planBatches phủ hết câu, không trùng, ngữ cảnh lấy từ câu trước", () => {
    const items = Array.from({ length: 10 }, (_, i) => `câu ${i}`);
    const batches = planBatches(items, 4, 2);
    assert.equal(batches.length, 3);
    assert.deepEqual(
      batches.flatMap((b) => b.items),
      items,
      "ghép các batch phải ra đúng danh sách gốc",
    );
    assert.deepEqual(batches[0].context, []);
    assert.deepEqual(batches[1].context, ["câu 2", "câu 3"]);
    assert.equal(batches[2].items.length, 2);
  });

  test("planBatches với đúng một câu, và với overlap 0", () => {
    assert.equal(planBatches(["x"], 8, 2).length, 1);
    assert.deepEqual(planBatches(["a", "b"], 1, 0)[1].context, []);
  });

  test("buildUserMessage đánh số theo vị trí thật và tách rõ phần ngữ cảnh", () => {
    const b = { start: 4, items: ["một", "hai"], context: ["ba", "bốn"] };
    const msg = buildUserMessage(b);
    assert.match(msg, /NGỮ CẢNH/);
    assert.match(msg, /3\| ba/);
    assert.match(msg, /4\| bốn/);
    assert.match(msg, /CẦN SỬA:\n5\| một\n6\| hai/);
    // Batch đầu không có phần ngữ cảnh.
    assert.doesNotMatch(buildUserMessage({ start: 0, items: ["x"], context: [] }), /NGỮ CẢNH/);
  });

  test("buildSystemPrompt gồm quy tắc và glossary", () => {
    const p = buildSystemPrompt(loadGlossary());
    assert.match(p, /KHÔNG dịch/);
    assert.match(p, /THUẬT NGỮ ƯU TIÊN/);
    assert.match(p, /- meeting/);
  });

  test("parseBatchResponse ghép kết quả theo số thứ tự", () => {
    const b = { start: 0, items: ["cái mít ting", "cái đét lai"] };
    const r = parseBatchResponse("1| cái meeting\n2| cái deadline", b);
    assert.deepEqual(r.texts, ["cái meeting", "cái deadline"]);
    assert.equal(r.matched, 2);
  });

  test("parseBatchResponse dùng số thật, không dùng thứ tự dòng", () => {
    const b = { start: 10, items: ["a", "b"] };
    // Trả ngược thứ tự — vẫn phải khớp đúng.
    const r = parseBatchResponse("12| B đã sửa\n11| A đã sửa", b);
    assert.deepEqual(r.texts, ["A đã sửa", "B đã sửa"]);
  });

  test("parseBatchResponse giữ bản gốc khi LLM bỏ sót dòng", () => {
    const b = { start: 0, items: ["giữ nguyên tôi", "sửa tôi"] };
    const r = parseBatchResponse("2| đã sửa", b);
    assert.deepEqual(r.texts, ["giữ nguyên tôi", "đã sửa"]);
    assert.equal(r.matched, 1);
  });

  test("parseBatchResponse bỏ qua dòng số lạ và lời giải thích thừa", () => {
    const b = { start: 0, items: ["a"] };
    const r = parseBatchResponse(
      "Đây là kết quả:\n1| a đã sửa\n99| dòng ngoài batch\nHy vọng giúp được bạn!",
      b,
    );
    assert.deepEqual(r.texts, ["a đã sửa"]);
  });

  test("parseBatchResponse giữ bản gốc khi LLM trả rỗng cho câu có nội dung", () => {
    const b = { start: 0, items: ["nội dung thật"] };
    const r = parseBatchResponse("1| ", b);
    assert.deepEqual(r.texts, ["nội dung thật"]);
    assert.equal(r.matched, 0);
  });

  test("parseBatchResponse gom đúng câu nhiều dòng", () => {
    const b = { start: 0, items: ["dòng một\ndòng hai"], eol: "\n" };
    const r = parseBatchResponse("1| dòng một sửa\ndòng hai sửa", b);
    assert.deepEqual(r.texts, ["dòng một sửa\ndòng hai sửa"]);
    assert.equal(r.matched, 1);
  });

  test("parseBatchResponse giữ bản gốc khi số dòng trả về lệch", () => {
    const b = { start: 0, items: ["dòng một\ndòng hai"], eol: "\n" };
    // LLM gộp hai dòng thành một → cấu trúc block sẽ sai.
    const r = parseBatchResponse("1| gộp thành một dòng", b);
    assert.deepEqual(r.texts, ["dòng một\ndòng hai"]);
    assert.equal(r.matched, 0);
  });

  test("parseBatchResponse dùng eol của batch khi ghép dòng", () => {
    const b = { start: 0, items: ["a\r\nb"], eol: "\r\n" };
    const r = parseBatchResponse("1| a sửa\nb sửa", b);
    assert.equal(r.texts[0], "a sửa\r\nb sửa");
  });

  test("parseBatchResponse lấy lần xuất hiện đầu khi số bị trùng", () => {
    const b = { start: 0, items: ["x"] };
    assert.deepEqual(parseBatchResponse("1| đầu\n1| sau", b).texts, ["đầu"]);
  });

  test("parseBatchResponse chịu được phản hồi rỗng/null", () => {
    const b = { start: 0, items: ["giữ nguyên"] };
    for (const bad of ["", null, undefined]) {
      assert.deepEqual(parseBatchResponse(bad, b).texts, ["giữ nguyên"]);
    }
  });
});

// --------------------------------------------------- cleanup: end-to-end

describe("transcript-cleanup end-to-end với mock LLM", () => {
  let stopMock;
  const PORT = 5301;
  const baseUrl = `http://127.0.0.1:${PORT}`;

  before(async () => {
    stopMock = await startMock({ MOCK_MODE: "glossary" }, PORT);
  });
  after(async () => {
    if (stopMock) await stopMock();
  });

  test("SRT: output khớp từng byte với bản vàng", async () => {
    const out = join(workdir, "out.srt");
    const r = await runCleanup([join(TESTDATA, "codeswitch-vi.srt"), "-o", out], {
      LLM_BASE_URL: baseUrl,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(read(out), read(join(TESTDATA, "codeswitch-vi.expected.srt")));
  });

  test("SRT: index và timestamp giữ nguyên từng byte, số block không đổi", async () => {
    const inPath = join(TESTDATA, "codeswitch-vi.srt");
    const out = join(workdir, "ts.srt");
    const r = await runCleanup([inPath, "-o", out], { LLM_BASE_URL: baseUrl });
    assert.equal(r.code, 0, r.stderr);

    const a = srt.parse(read(inPath));
    const b = srt.parse(read(out));
    assert.equal(b.blocks.length, a.blocks.length);
    for (const [i, blockA] of a.blocks.entries()) {
      assert.equal(b.blocks[i].index, blockA.index, `index lệch ở block ${i}`);
      assert.equal(b.blocks[i].timestamp, blockA.timestamp, `timestamp lệch ở block ${i}`);
    }
  });

  test("TXT: mỗi dòng một câu, số dòng không đổi", async () => {
    const inPath = join(TESTDATA, "codeswitch-vi.txt");
    const out = join(workdir, "out.txt");
    const r = await runCleanup([inPath, "-o", out], { LLM_BASE_URL: baseUrl });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(read(out).split("\n").length, read(inPath).split("\n").length);
    assert.match(read(out), /cái meeting hôm nay/);
    assert.doesNotMatch(read(out), /mít ting/);
  });

  test("edge-cases: chỉ sửa thuật ngữ, không phá gì khác", async () => {
    const inPath = join(TESTDATA, "edge-cases.srt");
    const out = join(workdir, "edge.srt");
    const r = await runCleanup([inPath, "-o", out], { LLM_BASE_URL: baseUrl });
    assert.equal(r.code, 0, r.stderr);

    const a = srt.parse(read(inPath));
    const b = srt.parse(read(out));
    assert.equal(b.blocks.length, 12);

    // Cấu trúc từng block nguyên vẹn, kể cả block rỗng và block hai dòng.
    for (const [i, blockA] of a.blocks.entries()) {
      assert.equal(b.blocks[i].index, blockA.index);
      assert.equal(b.blocks[i].timestamp, blockA.timestamp);
      assert.equal(
        b.blocks[i].text.split(/\r?\n/).length,
        blockA.text.split(/\r?\n/).length,
        `số dòng lệch ở block ${blockA.index}`,
      );
    }

    const text = (n) => b.blocks[n - 1].text;
    assert.equal(text(1), a.blocks[0].text, "$5000 phải giữ nguyên");
    assert.equal(text(2), a.blocks[1].text, "câu tiếng Anh phải giữ nguyên");
    assert.equal(text(3), a.blocks[2].text, "câu tiếng Việt thuần phải giữ nguyên");
    assert.equal(text(4), "", "block rỗng vẫn rỗng");
    assert.equal(text(5), a.blocks[4].text);
    assert.equal(text(6), a.blocks[5].text, "URL phải giữ nguyên");
    assert.equal(text(7), a.blocks[6].text, "email phải giữ nguyên");
    assert.match(text(8), /cái meeting/, "phụ đề hai dòng vẫn được sửa");
    assert.match(text(8), /và bị cắt thành hai dòng phụ đề\./, "dòng hai không được mất");
    assert.equal(text(9), a.blocks[8].text, "ký hiệu tiền tệ phải giữ nguyên");
    assert.equal(text(10), a.blocks[9].text, "ngoặc kép phải giữ nguyên");
    assert.match(text(11), /Ờ\.\.\. ừm\.\.\./, "từ đệm phải giữ nguyên");
    assert.match(text(11), /feedback sau/);
    assert.equal(text(12), a.blocks[11].text, "ALL CAPS phải giữ nguyên");
  });

  test("--dry-run không gọi LLM và không ghi file", async () => {
    const out = join(workdir, "dry.srt");
    const r = await runCleanup([join(TESTDATA, "codeswitch-vi.srt"), "-o", out, "--dry-run"], {
      LLM_BASE_URL: "http://127.0.0.1:1", // cổng chết: nếu có gọi mạng là fail
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(existsSync(out), false, "--dry-run không được ghi file");
    assert.match(r.stderr, /batch @0/);
  });

  test("từ chối ghi đè file vào", async () => {
    const p = join(TESTDATA, "codeswitch-vi.srt");
    const r = await runCleanup([p, "-o", p], { LLM_BASE_URL: baseUrl });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /trùng file vào/);
    // Bản gốc không bị sửa.
    assert.match(read(p), /mít ting/);
  });

  test("từ chối ghi đè file ra đã tồn tại, trừ khi có --force", async () => {
    const out = join(workdir, "exists.srt");
    const first = await runCleanup([join(TESTDATA, "codeswitch-vi.srt"), "-o", out], {
      LLM_BASE_URL: baseUrl,
    });
    assert.equal(first.code, 0, first.stderr);

    const second = await runCleanup([join(TESTDATA, "codeswitch-vi.srt"), "-o", out], {
      LLM_BASE_URL: baseUrl,
    });
    assert.equal(second.code, 2);
    assert.match(second.stderr, /--force/);

    const forced = await runCleanup(
      [join(TESTDATA, "codeswitch-vi.srt"), "-o", out, "--force"],
      { LLM_BASE_URL: baseUrl },
    );
    assert.equal(forced.code, 0, forced.stderr);
  });

  test("batch-size 1 cho cùng kết quả với batch-size mặc định", async () => {
    const out = join(workdir, "b1.srt");
    const r = await runCleanup(
      [join(TESTDATA, "codeswitch-vi.srt"), "-o", out, "--batch-size", "1", "--overlap", "0"],
      { LLM_BASE_URL: baseUrl },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(read(out), read(join(TESTDATA, "codeswitch-vi.expected.srt")));
  });

  test("--help in hướng dẫn, mã thoát 0", async () => {
    const r = await runCleanup(["--help"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /transcript-cleanup/);
    assert.match(r.stdout, /--batch-size/);
  });

  test("báo lỗi khi file vào không phải .srt hợp lệ", async () => {
    const junk = join(workdir, "junk.srt");
    writeFileSync(junk, "đây không phải srt\n", "utf8");
    const r = await runCleanup([junk, "-o", join(workdir, "junk.out.srt")], {
      LLM_BASE_URL: baseUrl,
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /SubRip/);
  });
});

// ------------------------------------------------------- fail-open (lỗi/chậm)

describe("transcript-cleanup fail-open", () => {
  test("backend trả 500: output giữ nguyên bản gốc, mã thoát 1, có cảnh báo", async () => {
    const PORT = 5302;
    const stop = await startMock({ MOCK_MODE: "error" }, PORT);
    try {
      const inPath = join(TESTDATA, "codeswitch-vi.srt");
      const out = join(workdir, "err.srt");
      const r = await runCleanup([inPath, "-o", out, "--retries", "0"], {
        LLM_BASE_URL: `http://127.0.0.1:${PORT}`,
      });
      assert.equal(r.code, 1, "phải báo lỗi qua mã thoát");
      assert.match(r.stderr, /CẢNH BÁO/);
      assert.match(r.stderr, /THẤT BẠI/);
      // Quan trọng nhất: KHÔNG mất dữ liệu.
      assert.equal(read(out), read(inPath));
    } finally {
      await stop();
    }
  });

  test("backend không tồn tại: vẫn ghi ra file nguyên vẹn", async () => {
    const inPath = join(TESTDATA, "codeswitch-vi.txt");
    const out = join(workdir, "noconn.txt");
    const r = await runCleanup([inPath, "-o", out, "--retries", "0"], {
      LLM_BASE_URL: "http://127.0.0.1:1",
    });
    assert.equal(r.code, 1);
    assert.equal(read(out), read(inPath));
  });

  test("timeout: quá hạn thì giữ bản gốc; nới timeout thì thành công", async () => {
    const PORT = 5303;
    const stop = await startMock({ MOCK_MODE: "slow", MOCK_DELAY_MS: "1500" }, PORT);
    const baseUrl = `http://127.0.0.1:${PORT}`;
    try {
      const inPath = join(TESTDATA, "codeswitch-vi.txt");

      const tooShort = join(workdir, "slow-timeout.txt");
      const r1 = await runCleanup(
        [inPath, "-o", tooShort, "--retries", "0", "--timeout", "300"],
        { LLM_BASE_URL: baseUrl },
      );
      assert.equal(r1.code, 1);
      assert.match(r1.stderr, /timeout sau 300ms/);
      assert.equal(read(tooShort), read(inPath), "timeout không được làm mất phụ đề");

      // Chậm không có nghĩa là sai: nới timeout thì vẫn phải ra kết quả đúng.
      const enough = join(workdir, "slow-ok.txt");
      const r2 = await runCleanup(
        [inPath, "-o", enough, "--retries", "0", "--timeout", "10000"],
        { LLM_BASE_URL: baseUrl },
      );
      assert.equal(r2.code, 0, r2.stderr);
      assert.match(read(enough), /cái meeting hôm nay/);
    } finally {
      await stop();
    }
  });
});

// ------------------------------------------------------------------ mock LLM

describe("mock-llm", () => {
  test("mode glossary: /health và /v1/messages hoạt động, không lộ nội dung ra log", async () => {
    const PORT = 5304;
    const stop = await startMock({ MOCK_MODE: "glossary" }, PORT);
    const base = `http://127.0.0.1:${PORT}`;
    try {
      const health = await (await fetch(`${base}/health`)).json();
      assert.equal(health.ok, true);
      assert.equal(health.mode, "glossary");
      assert.ok(health.rules > 0);

      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "m",
          max_tokens: 100,
          messages: [{ role: "user", content: "1| cái mít ting" }],
        }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      // Đúng hình dạng Anthropic Messages — client chỉ đọc content[].text.
      assert.equal(data.type, "message");
      assert.equal(data.role, "assistant");
      assert.equal(data.content[0].type, "text");
      assert.equal(data.content[0].text, "1| cái meeting");
      assert.ok(data.usage.input_tokens >= 0);
    } finally {
      await stop();
    }
  });

  test("hỗ trợ content dạng mảng block, không chỉ string", async () => {
    const PORT = 5305;
    const stop = await startMock({ MOCK_MODE: "glossary" }, PORT);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: [{ type: "text", text: "cái đét lai" }] }],
        }),
      });
      const data = await res.json();
      assert.equal(data.content[0].text, "cái deadline");
    } finally {
      await stop();
    }
  });

  test("mode echo trả lại nguyên văn", async () => {
    const PORT = 5306;
    const stop = await startMock({ MOCK_MODE: "echo" }, PORT);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "cái mít ting" }] }),
      });
      const data = await res.json();
      assert.equal(data.content[0].text, "cái mít ting");
    } finally {
      await stop();
    }
  });

  test("mode error trả status cấu hình được, đúng hình dạng lỗi Anthropic", async () => {
    const PORT = 5307;
    const stop = await startMock({ MOCK_MODE: "error", MOCK_STATUS: "503" }, PORT);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
      });
      assert.equal(res.status, 503);
      const data = await res.json();
      assert.equal(data.type, "error");
      assert.equal(data.error.type, "api_error");
    } finally {
      await stop();
    }
  });

  test("đường lỗi: JSON sai, route lạ, method sai, thiếu message user", async () => {
    const PORT = 5308;
    const stop = await startMock({ MOCK_MODE: "glossary" }, PORT);
    const base = `http://127.0.0.1:${PORT}`;
    try {
      const post = (path, body) =>
        fetch(`${base}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });

      assert.equal((await post("/v1/messages", "không phải json")).status, 400);
      assert.equal((await post("/không-có-route", "{}")).status, 404);
      assert.equal((await fetch(`${base}/v1/messages`)).status, 405);
      assert.equal((await post("/v1/messages", JSON.stringify({ messages: [] }))).status, 400);
      assert.equal(
        (await post("/v1/messages", JSON.stringify({ messages: [{ role: "assistant", content: "x" }] }))).status,
        400,
        "chỉ có message của assistant thì không có gì để sửa",
      );
    } finally {
      await stop();
    }
  });

  test("từ chối MOCK_MODE không hợp lệ thay vì chạy sai", async () => {
    await assert.rejects(() => startMock({ MOCK_MODE: "bogus" }, 5309), /thoát sớm|MOCK_MODE/);
  });

  test("từ chối GLOSSARY_PATH không tồn tại thay vì chạy với 0 rule", async () => {
    await assert.rejects(
      () => startMock({ MOCK_MODE: "glossary", GLOSSARY_PATH: "/không/có.json" }, 5310),
      /thoát sớm|glossary/,
    );
  });
});
