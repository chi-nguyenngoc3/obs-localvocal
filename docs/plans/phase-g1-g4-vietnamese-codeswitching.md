# Phase G1–G4 · Tiếng Việt chêm tiếng Anh

Trạng thái: **hoàn thành** (G5 hoãn có chủ ý, G6 chờ xác nhận). Ngày: 2026-09-14.
Repo `obs-localvocal` v0.6.2, base commit `191c7ef`, branch `master`.

## Mục tiêu

Whisper chỉ nhận **một** ngôn ngữ mỗi lần inference (`src/transcription-filter.cpp`), nên
lời nói tiếng Việt chêm thuật ngữ tiếng Anh bị phiên âm hoá: "meeting" → "mít ting",
"deadline" → "đét lai". Plugin không có cơ chế code-switching nào. Phase này phục hồi đúng
chính tả thuật ngữ tiếng Anh **mà không sửa một dòng C++ nào**.

## Scope

**Trong scope**

- G1 — tài liệu cấu hình + glossary dùng chung
- G2 — bộ dữ liệu vàng (input lỗi + bản đúng + ca biên)
- G3 — mock LLM backend (mạng ra ngoài bị chặn trong sandbox)
- G4 — CLI hậu kỳ file `.srt`/`.txt`

**Ngoài scope**

- G5 proxy realtime — hoãn. Đường file cho chất lượng cao hơn (LLM thấy toàn bộ buổi họp
  thay vì một segment ~7 giây) và không vướng 4 ràng buộc của `custom-api.cpp`. Lý do chi
  tiết trong [`../../tools/README.md`](../../tools/README.md), mục "Chưa làm: phụ đề realtime".
- Sửa C++. Hai bug đã ghi lại nhưng không chạm: `CloudTranslatorConfig::model` không bao giờ
  được gán, và `last_text_cloud_translation` chưa từng được ghi nên câu trùng trả về rỗng.
  Sửa cần build lại toàn bộ chuỗi dependency (obs-deps, whisper.cpp, ctranslate2, onnxruntime,
  ICU) — chi phí không tương xứng.

## Kiến trúc

Ba lớp, độc lập nhau, dùng chung **một** file glossary:

```
tools/vib-glossary.json  ──┬─→ ô "Initial prompt" của plugin          (G1, không code)
                           ├─→ hộp thoại "Setup Filter and Replace"   (G1, không code)
                           └─→ system prompt của cleanup.mjs          (G4)
```

Đổi glossary là đổi cả ba nơi, không cần sửa code.

## File tạo mới

| File | Giai đoạn | Vai trò |
|---|---|---|
| `docs/vietnamese-setup.md` | G1 | Hướng dẫn cấu hình. Đọc xong là điền được UI |
| `tools/vib-glossary.json` | G1 | 40 thuật ngữ + biến thể phiên âm hoá |
| `tools/testdata/codeswitch-vi.srt` | G2 | 26 block input có lỗi |
| `tools/testdata/codeswitch-vi.expected.srt` | G2 | Bản đúng, viết tay |
| `tools/testdata/edge-cases.srt` | G2 | 12 ca biên |
| `tools/testdata/codeswitch-vi.txt` | G2 | Bản `.txt` 10 dòng |
| `tools/testdata/README.md` | G2 | Lý do thiết kế bộ vàng + bảng kỳ vọng |
| `tools/mock-llm/server.mjs` | G3 | Backend giả, 4 mode |
| `tools/mock-llm/README.md` | G3 | — |
| `tools/lib/srt.mjs` | G4 | Parser `.srt` round-trip trung thực |
| `tools/lib/glossary.mjs` | G4 | Nạp + khớp glossary |
| `tools/transcript-cleanup/cleanup.mjs` | G4 | CLI chính |
| `tools/transcript-cleanup/README.md` | G4 | — |
| `tools/README.md` | G4 | Điểm vào cho `tools/` |
| `tools/test.mjs` | G4 | 57 test, 6 suite |

**Sửa:** `README.md` — thêm mục "Language-specific guides" trỏ sang `docs/vietnamese-setup.md`.
Đây là file duy nhất của plugin bị chạm, và chỉ là docs.

## Quyết định đáng ghi lại

**Không dùng provider `claude`/`openai` sẵn có.** `CloudTranslatorConfig::model` khai báo
trong `translation-cloud.h` nhưng không bao giờ được gán → luôn rỗng → fallback
`claude-3-sonnet-20240229` (đã retire) → API lỗi. Thêm nữa prompt hardcode trong
`claude.cpp:createSystemPrompt`, không có ô UI để ra lệnh "sửa lỗi nhận dạng, giữ nguyên từ
tiếng Anh".

**Mock LLM là bắt buộc, không phải tiện.** Mạng ra ngoài bị chặn trong sandbox
(`curl api.anthropic.com` → exit 56). Mock còn có giá trị lâu dài: test không tốn token và
**deterministic**.

**Mock chỉ làm tra từ điển thuần.** Bộ vàng được viết sao cho tra từ điển là **đủ** để ra
đúng `expected.srt`. Nhờ vậy mọi sai lệch là lỗi pipeline, không phải lỗi model.

**Bộ vàng viết TRƯỚC tool.** Quyết định này bắt được hai bug mất dữ liệu thật (xem dưới) mà
test viết sau sẽ không bắt được.

**Model đa ngữ, KHÔNG dùng fine-tune `.vi`.** Trực giác bị đảo: `ggml-large-v2.vi` (Marksdo)
fine-tune trên tiếng Việt thuần nên **phiên âm hoá mạnh hơn** — càng "tin" mọi thứ là tiếng
Việt thì càng dễ biến "meeting" thành "mít ting".

**Fail-open tuyệt đối.** Backend lỗi/timeout/không kết nối được → giữ nguyên bản gốc, không
bao giờ ghi phụ đề rỗng. Thoát mã `1` kèm cảnh báo rõ để không bị nhầm là đã sạch.

## Bug tìm được trong lúc làm

1. **Round-trip mất block rỗng.** `serialize` sinh một dòng text rỗng cho block không có dòng
   text nào → file ra khác file vào. Sửa bằng cờ `noTextLine`.
2. **Phụ đề hai dòng bị cắt mất dòng thứ hai** — mất dữ liệu thật.
   `parseBatchResponse` bỏ qua các dòng không có tiền tố `N|`. Sửa bằng cách theo dõi số dòng
   kỳ vọng cho từng câu, và thêm guard: số dòng không khớp → **giữ bản gốc**.
3. **`import.meta.url` percent-encode dấu cách** → guard entry-point không bao giờ khớp, tool
   thoát 0 mà không làm gì. Sửa bằng `pathToFileURL(process.argv[1]).href`.
4. **`\b` của JS theo ASCII** → cắt vào giữa từ tiếng Việt có dấu. Sửa bằng lookaround với
   lớp ký tự Latin-Extended tường minh.

## Bằng chứng

**Test:** 57/57 pass, 6 suite, `node --test tools/test.mjs`, ~5.1s. 0 skip, 0 todo.

**Bộ vàng:** `cleanup.mjs` + mock `glossary` → output **byte-identical** với
`codeswitch-vi.expected.srt` (26/26 câu thay đổi, `diff` rỗng).

**Bất biến cấu trúc:** index + timestamp + số block + số dòng mỗi block giữ nguyên từng byte.
BOM, CRLF, ngắt dòng cuối file cũng giữ nguyên.

**Fail-open:** mock mode `error` (HTTP 500) trên `edge-cases.srt` → output **byte-identical**
với input, 0/11 câu thay đổi, thoát mã `1` kèm cảnh báo. Tương tự với timeout và
không-kết-nối-được.

**Hiệu năng:** parse + serialize 5200 block mất **4 ms/lượt**; heapUsed 4.9 → 5.3 MB sau 5
lượt (không tăng đơn điệu → không leak); RSS 61.5 MB. Một buổi họp 2 giờ ≈ 1000 câu ≈ 1/5
kích thước đo. Phần chậm là các lần gọi LLM tuần tự, không phải parser.

**Nhãn UI:** mọi tên ô trong tài liệu đã đối chiếu với `data/locale/en-US.ini`.

## Rủi ro còn lại

**Glossary là tạm.** 40 thuật ngữ với biến thể **do người viết dự đoán**, không lấy từ bản
ghi thật. Đây là thứ quyết định chất lượng. Thay file JSON là xong, không cần sửa code.

**Chưa đo WER/CER trên âm thanh thật.** `evaluate_output.py` cần Python (bị chặn trong
sandbox) và một file ghi âm họp thật. Cách đo đã ghi trong `docs/vietnamese-setup.md` mục 5.

**Chưa chạy với LLM thật.** Toàn bộ verification dùng mock. Hình dạng request/response theo
đúng Anthropic Messages API nhưng hành vi model thật sẽ khác — đặc biệt là nguy cơ trả sai số
dòng (đã có guard giữ bản gốc).

**Xử lý tuần tự.** Các batch gọi lần lượt. 1000 câu ≈ 125 batch ≈ vài phút. Đủ cho hậu kỳ.

## Bước tiếp

1. Thay `tools/vib-glossary.json` bằng thuật ngữ thật của đơn vị.
2. Trỏ `LLM_BASE_URL` vào gateway nội bộ hoặc LLM local — **không** API công cộng nếu nội
   dung là họp nội bộ hoặc dữ liệu khách hàng.
3. Đo WER/CER trên một buổi họp thật, `large-v3` vs `large-v2.vi`.
4. Chỉ làm G5 nếu bắt buộc phải có phụ đề hiện ngay trên màn hình OBS.
