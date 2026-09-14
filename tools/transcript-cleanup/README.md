# transcript-cleanup

Làm sạch bản ghi tiếng Việt chêm tiếng Anh — xử lý cả file một lượt, không realtime.

Whisper phiên âm hoá thuật ngữ tiếng Anh khi đang ở chế độ tiếng Việt: "meeting" thành
"mít ting", "deadline" thành "đét lai". Tool này gửi text qua một LLM để phục hồi chính tả,
giữ nguyên mọi thứ khác.

Đọc [`docs/vietnamese-setup.md`](../../docs/vietnamese-setup.md) trước — phần lớn lỗi giảm
được bằng cấu hình, không cần tới tool này.

## Yêu cầu

Node >= 18 (cần `fetch` sẵn có). Không có dependency.

## Dùng nhanh

Không có backend LLM thật? Dùng mock để thử ngay:

```bash
# Cửa sổ 1
node tools/mock-llm/server.mjs

# Cửa sổ 2
node tools/transcript-cleanup/cleanup.mjs tools/testdata/codeswitch-vi.srt -o sach.srt
```

Với backend thật:

```bash
export LLM_BASE_URL=https://api.anthropic.com
export LLM_API_KEY=sk-...
export LLM_MODEL=claude-sonnet-5
node tools/transcript-cleanup/cleanup.mjs bien-ban.srt -o bien-ban.sach.srt
```

## Tuỳ chọn

```
node cleanup.mjs <input> -o <output> [tuỳ chọn]

  -o, --output <path>    File ra (bắt buộc). Không được trùng file vào.
      --batch-size <n>   Số câu mỗi lần gọi LLM (mặc định 8)
      --overlap <n>      Số câu trước đó gửi kèm làm ngữ cảnh (mặc định 2)
      --glossary <path>  File glossary JSON (mặc định tools/vib-glossary.json)
      --model <name>     Model (mặc định claude-sonnet-5)
      --base-url <url>   Endpoint LLM (mặc định http://127.0.0.1:5099)
      --timeout <ms>     Timeout mỗi request (mặc định 60000)
      --retries <n>      Số lần thử lại mỗi batch (mặc định 2)
      --format srt|txt   Ép định dạng thay vì suy từ đuôi file
      --dry-run          Không gọi LLM; in kế hoạch batch rồi thoát
      --force            Cho phép ghi đè file ra đã tồn tại
  -h, --help             In trợ giúp
```

Biến môi trường `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `GLOSSARY_PATH` tương đương các
cờ cùng tên (cờ thắng).

Mã thoát: `0` thành công · `1` lỗi khi chạy hoặc **có batch không làm sạch được** · `2` sai
tham số.

## Định dạng đầu vào

Plugin ghi file qua `send_sentence_to_file` (`src/transcription-filter-callbacks.cpp`), hai
dạng:

- **`.txt`** — mỗi dòng một câu. Số dòng trong file ra luôn bằng file vào.
- **`.srt`** — block `index` / `timestamp` / `text`. **Chỉ phần `text` được thay.** Index và
  timestamp không bao giờ đi qua LLM, nên không thể bị làm lệch.

Định dạng được suy từ đuôi file; `--format` ghi đè nếu cần.

## Điều tool này bảo đảm

Những điều dưới đây đều có test tương ứng trong [`../test.mjs`](../test.mjs):

1. **Không bao giờ ghi đè file vào.** Trùng đường dẫn thì thoát mã `2`. File ra đã tồn tại
   thì cũng thoát, trừ khi có `--force`.
2. **Index và timestamp `.srt` giữ nguyên từng byte.** Số block không đổi.
3. **Số dòng trong mỗi block không đổi.** Phụ đề bị cắt hai dòng vẫn ra hai dòng. Nếu LLM
   trả về số dòng khác, tool **giữ bản gốc** cho câu đó.
4. **Fail-open.** Backend lỗi, timeout, hoặc không kết nối được → câu đó giữ nguyên bản gốc,
   file ra vẫn hợp lệ và đầy đủ. Không bao giờ ghi ra phụ đề rỗng.
5. **LLM bỏ sót câu → giữ bản gốc câu đó.** Phản hồi được ghép theo số thứ tự, không theo
   thứ tự dòng, nên LLM trả lộn xộn vẫn khớp đúng.
6. **Câu rỗng không gửi LLM.** Tiết kiệm token và tránh model tự "sáng tác" nội dung.
7. **Ngắt dòng, BOM, CRLF giữ nguyên.** File CRLF ra vẫn CRLF.

Khi có batch thất bại, tool in cảnh báo rõ và thoát mã `1` — file vẫn dùng được nhưng bạn
biết là chưa sạch hết, không bị nhầm là đã xong.

## Cách hoạt động

1. Tách file thành danh sách câu (block `.srt` hoặc dòng `.txt`).
2. Bỏ các câu rỗng ra khỏi danh sách gửi đi.
3. Chia thành batch `--batch-size` câu, mỗi batch kèm `--overlap` câu **trước đó** làm ngữ
   cảnh. Câu ngữ cảnh được LLM đọc nhưng kết quả bị bỏ — nếu không, một câu sẽ bị sửa hai
   lần theo hai cách khác nhau.
4. Mỗi câu được gửi kèm số thứ tự (`5| nội dung`), và phản hồi được ghép lại theo số đó.
5. Gọi backend theo hình dạng Anthropic Messages API (`POST /v1/messages`). Có retry với
   backoff tuyến tính; lỗi `4xx` (trừ `408`/`429`) không retry vì thử lại cũng vậy.
6. Ghép text đã sửa về đúng vị trí, dựng lại file.

System prompt gồm phần quy tắc cố định (không dịch, không viết lại, không đổi dấu câu/số/ký
hiệu tiền tệ/URL) và glossary lấy từ [`../vib-glossary.json`](../vib-glossary.json).

### Batch size

Batch lớn cho LLM nhiều ngữ cảnh hơn nhưng tăng nguy cơ nó trả về sai số dòng. Mặc định `8`
là điểm cân bằng. `--batch-size 1 --overlap 0` cho kết quả xác định nhất nhưng tốn nhiều
request nhất.

## Bảo mật và tuân thủ

**Tool này gửi nội dung phụ đề tới `LLM_BASE_URL`.** Nếu đó là API công cộng thì nội dung
buổi họp rời khỏi hạ tầng của bạn. Với họp nội bộ hoặc dữ liệu khách hàng, trỏ vào gateway
nội bộ hoặc LLM chạy local.

Tool cảnh báo trên stderr nếu `LLM_BASE_URL` không phải localhost mà lại không có
`LLM_API_KEY` — thường là dấu hiệu cấu hình sai.

`LLM_API_KEY` chỉ được đặt vào header `x-api-key`, không in ra log. Log chỉ có số câu, số
batch và độ dài; **không có nội dung câu**.

## Test

```bash
node --test tools/test.mjs
```

Test tự khởi động mock LLM ở cổng riêng rồi tắt — không cần chuẩn bị gì.

## Đo chất lượng

```bash
pip install Levenshtein diff_match_patch
python3 src/tests/evaluate_output.py tham-chieu.srt ket-qua.srt --print_alignment
```

Bộ dữ liệu vàng ở [`../testdata/`](../testdata/) có sẵn cặp input/expected để so.

## Giới hạn đã biết

- **Xử lý tuần tự.** Các batch gọi lần lượt, không song song. Một buổi họp 2 giờ (~1000 câu,
  125 batch) mất vài phút. Đủ dùng cho hậu kỳ; nếu cần nhanh hơn thì tăng `--batch-size`.
- **Không chia lại câu.** Whisper cắt câu sai thì tool không gộp/tách lại — nó chỉ sửa từ
  trong phạm vi từng câu.
- **Không sửa lỗi ngoài glossary một cách đáng tin cậy.** LLM đôi khi sửa thêm được, nhưng
  đó là phần thưởng, không phải bảo đảm. Thuật ngữ quan trọng phải có trong glossary.
- **Không dùng cho phụ đề live.** Đây là tool hậu kỳ file. Phụ đề realtime cần một proxy
  HTTP nói được giao thức của provider `api` trong plugin — chưa làm.
