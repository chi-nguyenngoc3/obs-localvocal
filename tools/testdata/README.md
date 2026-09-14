# testdata — bộ dữ liệu vàng cho code-switching tiếng Việt

Dữ liệu **tự viết tay**, không lấy từ bản ghi họp thật. Mục đích: biết được một tool hậu kỳ
có thực sự cải thiện hay không, thay vì đoán.

| File | Vai trò |
|---|---|
| `codeswitch-vi.srt` | Input: 26 câu tiếng Việt chêm thuật ngữ tiếng Anh đã bị Whisper phiên âm hoá ("mít ting", "đét lai", "cor banking") |
| `codeswitch-vi.expected.srt` | Bản đúng tương ứng — cùng số block, cùng index, cùng timestamp, chỉ khác text |
| `codeswitch-vi.txt` | 10 câu đầu ở định dạng `.txt` (mỗi dòng một câu) — kiểm đường xử lý plain-text |
| `edge-cases.srt` | 12 ca biên: `$5000`, chỉ tiếng Anh, chỉ tiếng Việt, block rỗng, URL, email, phụ đề hai dòng, ký hiệu tiền tệ, ngoặc kép, từ đệm, ALL CAPS |

## Cách các từ sai được chọn

Mỗi biến thể trong `codeswitch-vi.srt` khớp với một entry của
[`../vib-glossary.json`](../vib-glossary.json). Nghĩa là:

- `codeswitch-vi.expected.srt` có thể đạt được **chỉ bằng tra từ điển** — dùng làm baseline.
- Chênh lệch giữa output của LLM thật và `expected` cho biết LLM còn **mất** gì (regression)
  hoặc **thêm** gì (sửa được cả lỗi không có trong glossary).

Mock LLM ở `../mock-llm/` với `MOCK_MODE=glossary` chạy đúng phép tra từ điển đó, nên
`cleanup.mjs` + mock phải ra khớp `expected` 100%. Đó là bài kiểm deterministic của pipeline.

## Ca biên trong `edge-cases.srt` — kỳ vọng

| # | Ca | Kỳ vọng |
|---|---|---|
| 1 | `$5000` | Giữ nguyên. Liên quan tới lỗi `std::regex_replace` ở `src/translation/cloud-translation/custom-api.cpp` — `$` trong câu bị hiểu là backreference. Lỗi đó thuộc đường realtime, không phải đường file, nhưng tool vẫn không được làm hỏng `$`. |
| 2 | Chỉ tiếng Anh | Giữ nguyên, không dịch sang tiếng Việt |
| 3 | Chỉ tiếng Việt, không có thuật ngữ | Giữ nguyên từng chữ |
| 4 | Block rỗng | Không crash; block vẫn còn trong output, index + timestamp nguyên vẹn |
| 5 | Số thập phân, `%`, ngoặc tròn | Giữ nguyên |
| 6 | URL có `?` và `&` | Giữ nguyên, không tách chữ |
| 7 | Email, dấu `—`, "17h" | Giữ nguyên |
| 8 | Phụ đề hai dòng | Số dòng trong block không đổi; "mít ting" vẫn được sửa |
| 9 | `$` `₫` `€` `%` | Không đổi ký hiệu tiền tệ |
| 10 | Ngoặc kép và ngoặc đơn | Giữ nguyên loại ngoặc |
| 11 | Từ đệm "Ờ... ừm..." | Giữ nguyên (đây là bản ghi, không phải bản biên tập) |
| 12 | ALL CAPS | Không đổi chữ hoa/thường |

Kiểm ca biên là kiểm **không phá vỡ**, nên không có file `edge-cases.expected.srt`: với
`MOCK_MODE=glossary`, output phải giống input trừ đúng từ "phít bách" → "feedback" (câu 11)
và "mít ting" → "meeting" (câu 8). Bài test ở `../transcript-cleanup/test.mjs` khẳng định
chính xác điều này.

## Đánh giá định lượng (WER/CER)

`src/tests/evaluate_output.py` nhận `ref_file` + `hyp_file`:

```bash
pip install Levenshtein diff_match_patch
python3 src/tests/evaluate_output.py \
  tools/testdata/codeswitch-vi.expected.srt out.srt --print_alignment
```

Script này cần Python chạy được; trong một số môi trường sandbox `python3` bị chặn, khi đó
chạy ở máy khác.
