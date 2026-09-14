# mock-llm

Backend LLM giả, nói giao thức Anthropic Messages API (`POST /v1/messages`).

Vì sao cần: môi trường phát triển có thể không có đường ra Internet, và ngay khi có thì test
bằng LLM thật vẫn tốn token và **không deterministic**. Mock cho
[`../transcript-cleanup`](../transcript-cleanup/) một backend chạy được, lặp lại y hệt, và
có thể ép lỗi theo ý muốn.

## Chạy

```bash
node tools/mock-llm/server.mjs                                  # mode glossary, cổng 5099
MOCK_MODE=slow MOCK_DELAY_MS=5000 node tools/mock-llm/server.mjs
MOCK_MODE=error MOCK_STATUS=503   node tools/mock-llm/server.mjs
```

## Chế độ

| `MOCK_MODE` | Hành vi | Dùng để kiểm |
|---|---|---|
| `glossary` (mặc định) | Áp glossary tra cứu, trả text đã sửa | Đường thành công. Kết quả xác định → so được với bản vàng |
| `slow` | Trả kết quả **đúng** nhưng chậm `MOCK_DELAY_MS` | Đường timeout. Chậm ≠ sai: nới timeout thì phải thành công |
| `error` | Trả `MOCK_STATUS` với hình dạng lỗi Anthropic | Fail-open. Client phải giữ nguyên bản gốc, không trả rỗng |
| `echo` | Trả lại nguyên văn input | Phân biệt "client không sửa" với "backend không sửa" |

## Biến môi trường

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `MOCK_MODE` | `glossary` | Sai giá trị → thoát mã `2`, không chạy nhầm |
| `PORT` | `5099` | Cổng bị chiếm → thoát mã `1` với thông báo rõ |
| `HOST` | `127.0.0.1` | Chỉ localhost. Đây là mock, không phải service |
| `MOCK_DELAY_MS` | `5000` | Cho mode `slow` |
| `MOCK_STATUS` | `500` | Cho mode `error` |
| `GLOSSARY_PATH` | `tools/vib-glossary.json` | Thiếu file → thoát mã `2` |
| `MOCK_EXIT_ON_STDIN_CLOSE` | — | Đặt `1` để tự thoát khi stdin đóng. Dùng cho test tự động ở môi trường chặn `kill` |

## Endpoint

**`POST /v1/messages`** — nhận body Anthropic Messages. `messages[].content` hỗ trợ cả dạng
string và dạng mảng block `{type:"text", text}`. Trả:

```json
{
  "id": "msg_mock_...",
  "type": "message",
  "role": "assistant",
  "content": [{ "type": "text", "text": "..." }],
  "stop_reason": "end_turn",
  "usage": { "input_tokens": 12, "output_tokens": 12 }
}
```

**`GET /health`** — `{ok, mode, glossaryVersion, rules}`. Dùng để đợi server lên.

Đường lỗi: body không phải JSON → `400`; thiếu message `role: "user"` → `400`; route lạ →
`404`; method khác POST → `405`; body > 1 MB → `413`. Tất cả theo hình dạng lỗi Anthropic
(`{type:"error", error:{type, message}}`) để client xử lý thống nhất.

## Log

Chỉ ghi method, path, status, thời gian và **độ dài** input/output. **Không ghi nội dung
câu** — phụ đề họp có thể là dữ liệu nội bộ.

## Mock `glossary` làm gì

Đúng một việc: tra [`../vib-glossary.json`](../vib-glossary.json) rồi thay các biến thể
phiên âm hoá bằng từ tiếng Anh đúng chính tả. Không đổi gì khác.

Điều này có chủ ý: bộ dữ liệu vàng ở [`../testdata/`](../testdata/) được viết sao cho phép
tra từ điển thuần là **đủ** để ra đúng `codeswitch-vi.expected.srt`. Nhờ vậy
`cleanup.mjs` + mock phải khớp bản vàng 100%, và bất kỳ sai lệch nào là lỗi của pipeline chứ
không phải của model.

## Test

```bash
node --test tools/test.mjs
```
