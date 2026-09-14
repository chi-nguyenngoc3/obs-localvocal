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
      --provider <id>    anthropic | azure-openai | openai
      --model <name>     Model (mặc định claude-sonnet-5; Azure bỏ qua)
      --base-url <url>   Endpoint LLM (mặc định http://127.0.0.1:5099)
      --deployment <n>   Azure: tên deployment (bắt buộc với azure-openai)
      --api-version <v>  Azure: api-version (mặc định 2024-05-01-preview)
      --timeout <ms>     Timeout mỗi request (mặc định 60000)
      --retries <n>      Số lần thử lại mỗi batch (mặc định 2)
      --format srt|txt   Ép định dạng thay vì suy từ đuôi file
      --dry-run          Không gọi LLM; in kế hoạch batch rồi thoát
      --force            Cho phép ghi đè file ra đã tồn tại
  -h, --help             In trợ giúp
```

Mã thoát: `0` thành công · `1` lỗi khi chạy hoặc **có batch không làm sạch được** · `2` sai
tham số.

## Backend LLM

Ba hình dạng wire được hỗ trợ, khai báo ở [`../lib/providers.mjs`](../lib/providers.mjs):

| `--provider` | Endpoint gọi | Header mang key | Dùng cho |
|---|---|---|---|
| `anthropic` (mặc định) | `<base>/v1/messages` | `x-api-key` | Anthropic API, và `tools/mock-llm` |
| `azure-openai` | `<base>/openai/deployments/<deployment>/chat/completions?api-version=…` | `api-key` | Azure OpenAI Service |
| `openai` | `<base>/v1/chat/completions` | `Authorization: Bearer` | OpenAI, và hầu hết gateway nội bộ / LLM local (vLLM, Ollama, LiteLLM) vì chúng bắt chước hình dạng này |

### Biến môi trường

| Biến | Cờ tương đương | Ghi chú |
|---|---|---|
| `LLM_PROVIDER` | `--provider` | Bỏ trống thì suy: có `AZURE_OPENAI_ENDPOINT` → `azure-openai`, không thì `anthropic` |
| `LLM_BASE_URL` | `--base-url` | Bỏ trống thì lấy `AZURE_OPENAI_ENDPOINT`, cuối cùng là `http://127.0.0.1:5099` |
| `LLM_API_KEY` | — | Bỏ trống thì lấy `AZURE_OPENAI_API_KEY` |
| `LLM_MODEL` | `--model` | Azure bỏ qua — model do deployment quyết định |
| `AZURE_OPENAI_ENDPOINT` | `--base-url` | `https://<resource>.openai.azure.com` |
| `AZURE_OPENAI_DEPLOYMENT_NAME` | `--deployment` | Bắt buộc với `azure-openai` |
| `AZURE_OPENAI_API_VERSION` | `--api-version` | Mặc định `2024-05-01-preview` |
| `GLOSSARY_PATH` | `--glossary` | |

Cờ luôn thắng biến môi trường.

### Azure OpenAI

Đặt bốn biến chuẩn của Azure là đủ — provider được suy ra, không cần `--provider`:

```bash
export AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com
export AZURE_OPENAI_API_KEY=<key>
export AZURE_OPENAI_DEPLOYMENT_NAME=gpt-4o
export AZURE_OPENAI_API_VERSION=2024-05-01-preview
node tools/transcript-cleanup/cleanup.mjs bien-ban.srt -o bien-ban.sach.srt
```

Azure khác Anthropic ở cả bốn điểm, nên đây là một provider riêng chứ không phải một cờ:
deployment nằm trong URL, `?api-version=` là **bắt buộc** (thiếu là 404), key đi qua header
`api-key`, và system prompt là message đầu `role:"system"` chứ không phải trường riêng.

Thiếu `deployment`, thiếu `api-version`, hoặc `base-url` không phải `http(s)://` đều bị chặn
ngay khi parse tham số (thoát `2`, **chưa gửi gì đi**) — nếu để Azure tự trả lời, lỗi sẽ là
một `404` rất khó truy.

### Gateway nội bộ hoặc LLM local

```bash
node tools/transcript-cleanup/cleanup.mjs bien-ban.srt -o sach.srt \
  --provider openai --base-url http://gateway.noi-bo:8000 --model <ten-model>
```

Thêm provider mới = thêm một entry trong `../lib/providers.mjs`, không sửa `cleanup.mjs`.

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
5. Gọi backend theo hình dạng của `--provider` (xem [Backend LLM](#backend-llm)). Có retry
   với backoff tuyến tính; lỗi `4xx` (trừ `408`/`429`) không retry vì thử lại cũng vậy.
6. Ghép text đã sửa về đúng vị trí, dựng lại file.

System prompt gồm phần quy tắc cố định (không dịch, không viết lại, không đổi dấu câu/số/ký
hiệu tiền tệ/URL) và glossary lấy từ [`../vib-glossary.json`](../vib-glossary.json).

### Batch size

Batch lớn cho LLM nhiều ngữ cảnh hơn nhưng tăng nguy cơ nó trả về sai số dòng. Mặc định `8`
là điểm cân bằng. `--batch-size 1 --overlap 0` cho kết quả xác định nhất nhưng tốn nhiều
request nhất.

## Bảo mật và tuân thủ

**Tool này gửi nội dung phụ đề tới backend đã cấu hình.** Nếu đó là API công cộng — kể cả
Azure OpenAI — thì nội dung buổi họp rời khỏi hạ tầng của bạn. Với họp nội bộ hoặc dữ liệu
khách hàng, trỏ vào gateway nội bộ hoặc LLM chạy local.

Hai cảnh báo trên stderr khi backend không phải localhost:

- `CẢNH BÁO DỮ LIỆU: nội dung phụ đề đang được gửi ra khỏi máy này.` — luôn in, để không ai
  gửi biên bản họp đi mà không biết.
- `CẢNH BÁO: không có API key nhưng backend không phải localhost.` — thường là cấu hình sai.

API key chỉ đi vào header (`x-api-key` / `api-key` / `Authorization` tuỳ provider), **không
bao giờ vào URL, body, hay log**. Log chỉ có số câu, số batch và độ dài; **không có nội dung
câu**. Đừng đặt key trong file commit vào repo — dùng biến môi trường.

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
