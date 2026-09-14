# tools/

Công cụ hỗ trợ cho tiếng Việt có chêm tiếng Anh. Node thuần (>= 18), không dependency,
**không sửa gì trong plugin C++**.

Bắt đầu từ [`docs/vietnamese-setup.md`](../docs/vietnamese-setup.md) — phần lớn lỗi phiên âm
hoá giảm được bằng cấu hình, chưa cần tới tool nào ở đây.

## Có gì

| Thư mục | Là gì |
|---|---|
| [`transcript-cleanup/`](transcript-cleanup/) | CLI làm sạch file `.srt`/`.txt` qua LLM. **Đây là thứ bạn cần.** |
| [`mock-llm/`](mock-llm/) | Backend LLM giả để dev/test không cần mạng và không tốn token |
| [`testdata/`](testdata/) | Bộ dữ liệu vàng: input có lỗi + bản đúng + các ca biên |
| [`lib/`](lib/) | Module dùng chung: parser `.srt` và glossary |
| [`vib-glossary.json`](vib-glossary.json) | Thuật ngữ + biến thể phiên âm hoá hay gặp |
| [`test.mjs`](test.mjs) | Test suite (`node --test tools/test.mjs`) |

## Thử trong 30 giây

```bash
# Cửa sổ 1 — backend giả
node tools/mock-llm/server.mjs

# Cửa sổ 2 — làm sạch bộ dữ liệu mẫu
node tools/transcript-cleanup/cleanup.mjs tools/testdata/codeswitch-vi.srt -o /tmp/sach.srt
diff /tmp/sach.srt tools/testdata/codeswitch-vi.expected.srt && echo "khớp bản vàng"
```

## Test

```bash
node --test tools/test.mjs
```

Test tự khởi động mock ở cổng riêng rồi tắt. Không cần chuẩn bị, không cần mạng.

## Định dạng glossary

```json
{
  "version": "0.1.0-provisional",
  "terms": [
    { "term": "meeting",  "variants": ["mít ting", "mít tinh"] },
    { "term": "deadline", "variants": ["đét lai", "đe lai"] }
  ]
}
```

- `term` — dạng viết đúng, là thứ sẽ xuất hiện trong output.
- `variants` — các cách Whisper hay nghe sai. So khớp không phân biệt hoa/thường, chịu được
  nhiều khoảng trắng, và chỉ khớp trọn từ (biên từ tính theo cả ký tự Latin có dấu, nên
  không cắt vào giữa từ tiếng Việt).

Biến thể **dài được thử trước** biến thể ngắn, nên `"đi gi tan banking"` ra
`"digital banking"` chứ không bị `"banking"` khớp trước và làm hỏng phần đầu.

Một file này dùng cho ba nơi: ô **Initial prompt** của plugin, hộp thoại
**Setup Filter and Replace**, và prompt của `transcript-cleanup`. Đổi glossary là đổi cả ba.

> **Glossary hiện tại là tạm.** Các biến thể do người viết dự đoán, không lấy từ bản ghi
> thật. Thay bằng thuật ngữ thật của đơn vị bạn — đó là thứ quyết định chất lượng. Không cần
> sửa code, chỉ sửa file JSON.

## Bảo mật

`transcript-cleanup` gửi nội dung phụ đề tới `LLM_BASE_URL`. Nếu đó là API công cộng thì
nội dung buổi họp rời khỏi hạ tầng của bạn — với họp nội bộ hoặc dữ liệu khách hàng, trỏ vào
gateway nội bộ hoặc LLM chạy local.

`mock-llm` chỉ bind `127.0.0.1` và không gọi ra ngoài. Cả hai tool chỉ log độ dài và thời
gian, **không log nội dung câu**; API key không bao giờ vào log.

Bộ dữ liệu trong `testdata/` là **dữ liệu mẫu tự viết**, không phải bản ghi họp thật.

## Chưa làm: phụ đề realtime

Các tool ở đây xử lý **file**, sau khi ghi xong. Muốn phụ đề sạch hiện ngay trên màn hình
OBS thì cần một proxy HTTP nói được giao thức của provider `api` trong plugin. Việc đó khó
hơn đáng kể, và bốn ràng buộc từ `src/translation/cloud-translation/custom-api.cpp` phải
được tuân thủ:

1. **Response phải là JSON phẳng.** `parseResponse` dùng `response[response_json_path_]` —
   tra key phẳng, không phải JSON pointer. Giá trị mặc định `translations.0.text` không đi
   vào object lồng nhau được.
2. **Không có header xác thực.** Plugin chỉ gửi `Content-Type`, và UI không có ô nhập API
   key → buộc phải là proxy nội bộ tự giữ key.
3. **`$` bị lem.** `replacePlaceholders` dùng `std::regex_replace`, nên `$` trong câu bị hiểu
   là backreference. Proxy phải chịu input đã lem.
4. **Phải nhanh và fail-open.** `CURLOPT_TIMEOUT` cố định 30 giây — quá lâu cho phụ đề. Lỗi
   hoặc timeout thì phải trả lại nguyên văn input, tuyệt đối không trả rỗng.

Thêm nữa, câu trùng câu liền trước sẽ trả về **rỗng**: `transcription-filter-callbacks.cpp`
gọi `callback(gf->last_text_cloud_translation)` nhưng biến đó chưa từng được ghi (chỗ gán
ghi vào `last_text_translation` — tên khác). Proxy phải tự cache để né.

Nếu mục tiêu là biên bản họp thì đường file ở đây cho chất lượng cao hơn và không vướng gì
trong số trên.
