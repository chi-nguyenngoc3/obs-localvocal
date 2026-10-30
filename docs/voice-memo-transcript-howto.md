# Hướng dẫn dùng: từ file ghi âm (Voice Memos) tới bản ghi sạch

Tài liệu này dành cho người **có sẵn một file ghi âm** (Voice Memos trên Mac/iPhone, file
Zoom/Teams tải xuống, ghi âm điện thoại, v.v.) và muốn có **biên bản họp bằng chữ**, không
liên quan gì tới OBS. Đây là quy trình đã dùng thật trên máy Mac (Apple Silicon), không phải
lý thuyết.

Nếu mục tiêu là **phụ đề hiện trực tiếp lúc đang họp/stream**, đọc
[`vietnamese-setup.md`](vietnamese-setup.md) thay vì tài liệu này — đó mới cần OBS.

## Quy trình tổng quan

```
File ghi âm (.m4a/.mp3/…)
   │  ffmpeg: đổi sang wav 16kHz mono
   ▼
whisper-cli (model đa ngữ + --vad + --prompt)
   │  ra file .srt (bản ghi thô, còn lỗi phiên âm hoá tiếng Anh)
   ▼
tools/transcript-cleanup (LLM sửa chính tả, không dịch/viết lại)
   │
   ▼
File .srt sạch — mở bằng TextEdit để đọc, hoặc kéo vào VLC để nghe kèm phụ đề
```

## 0. Cài một lần (bỏ qua nếu máy đã có)

```bash
brew install whisper-cpp ffmpeg

mkdir -p ~/"Library/Application Support/whisper-cpp-models"

# Model đa ngữ, ~1.62 GB — khớp đúng cỡ model OBS gọi là "Whisper Large v3 Turbo (1.62Gb)"
curl -L -C - --retry 5 -o ~/"Library/Application Support/whisper-cpp-models/ggml-large-v3-turbo.bin" \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"

# Model VAD, nhỏ ~885 KB — bắt buộc, xem lý do ở bước 2
curl -L -o ~/"Library/Application Support/whisper-cpp-models/ggml-silero-v5.1.2.bin" \
  "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin"
```

> **Kiểm cỡ file sau khi tải xong**, đừng chỉ tin câu lệnh "chạy xong không lỗi". Model đa
> ngữ đúng phải nặng **1,624,555,275 byte**. Lần đầu làm việc này trên máy thật, mạng đứt
> giữa đường ở ~231 MB mà `curl` (khi bị pipe qua `tail`) vẫn báo như chạy xong — chỉ phát
> hiện ra vì kiểm `ls -la` lại. Dùng `curl -C -` để có thể tải tiếp nếu đứt giữa đường.

## 1. Lấy file ra khỏi Voice Memos

Trên Mac, app **Voice Memos** không có nút "Save to Files" trong share sheet (chỉ có
AirDrop/Mail/Messages/Notes...). Cách chắc ăn nhất là **kéo — thả**:

1. Mở Voice Memos, tìm bản ghi cần dùng.
2. Nhấp giữ và **kéo trực tiếp từ danh sách** ra Desktop hoặc một cửa sổ Finder (ví dụ
   `~/Downloads/`).
3. File `.m4a` sẽ xuất hiện ở đó.

(Nếu bạn dùng share sheet và nó tạo file tạm dưới
`~/Library/Containers/com.apple.VoiceMemos/Data/tmp/...` — đường đó bị macOS chặn quyền đọc
qua Terminal. Chạy `open -R "<đường dẫn đó>"` để Finder tự mở ra, rồi kéo tiếp từ đó ra chỗ
bình thường.)

## 2. Chuyển đổi và chạy transcribe

```bash
MODEL=~/"Library/Application Support/whisper-cpp-models/ggml-large-v3-turbo.bin"
VAD=~/"Library/Application Support/whisper-cpp-models/ggml-silero-v5.1.2.bin"
PROMPT="Đây là bản ghi buổi họp bằng tiếng Việt có dùng thuật ngữ tiếng Anh như meeting, review, deadline, sprint, backlog, standup, checklist, template, roadmap, workshop, feedback, dashboard, update, deploy, server, release, approve, escalate, follow up, report, align, audit, budget, scope, confirm, onboarding, compliance, core banking, digital banking, mobile banking, internet banking, customer journey, credit scoring, data, token, KPI, OKR, SLA, OTP, e-KYC."

# Đổi input.m4a thành file thật của bạn
ffmpeg -y -i input.m4a -ar 16000 -ac 1 -c:a pcm_s16le input.wav

whisper-cli -m "$MODEL" -l vi -osrt -of input \
  -f input.wav \
  --prompt "$PROMPT" --carry-initial-prompt \
  --vad --vad-model "$VAD"
```

Kết quả: file `input.srt` cùng thư mục.

> **`--vad` là bắt buộc, không phải tuỳ chọn.** Không có nó, Whisper có thể "ảo giác"
> (hallucinate) — lặp lại một câu không có trong audio — khi gặp đoạn nói nhỏ/thưa hoặc im
> lặng, đặc biệt ở cuối file. Đã thấy thật trên một bản ghi 6 phút: đúng đến giây 5:11 rồi
> lặp một câu quảng cáo YouTube không liên quan suốt gần 1 phút. Bật `--vad` xử lý hết, và
> còn giảm luôn tỷ lệ đoạn model "không chắc" (fallback) từ 12/36 xuống 0/0 trên cùng file.

## 3. Kiểm trước khi chạy trên máy đang tải nặng

Model 1.62 GB cần khoảng 2 GB+ RAM khả dụng lúc chạy. Nếu máy đang chạy nhiều agent/app khác,
kiểm nhanh trước:

```bash
vm_stat | head -2        # "Pages free" thấp (dưới ~10,000, tức dưới ~160MB) là báo động
sysctl vm.swapusage      # swap gần đầy (free thấp) + RAM free thấp = rủi ro treo máy
```

Nếu thấy báo động, đóng vài app/agent khác trước, đừng ép chạy — quy trình vẫn chạy được khi
nhẹ tải hơn, chỉ là chờ thêm.

## 4. Làm sạch bằng transcript-cleanup

```bash
cd "<repo-root>"

# Thử với mock LLM trước (không tốn token, không rời máy) — xem tools/README.md
node tools/mock-llm/server.mjs &
node tools/transcript-cleanup/cleanup.mjs input.srt -o input.sach.srt
kill %1   # tắt mock-llm sau khi xong
```

Với nội dung thật/nhạy cảm, **không dùng backend công khai** (kể cả Azure OpenAI công khai) —
trỏ `--base-url`/`LLM_BASE_URL` vào gateway nội bộ hoặc LLM chạy local. Xem
[`tools/transcript-cleanup/README.md`](../tools/transcript-cleanup/README.md#backend-llm).

## 5. Đọc kết quả

- Mở `.srt` bằng TextEdit để đọc như văn bản thường (bỏ qua số thứ tự + mốc thời gian).
- Hoặc kéo `.srt` vào **VLC** cùng lúc mở file audio gốc để nghe kèm phụ đề đồng bộ — cách
  tốt nhất để tự kiểm tra chất lượng transcribe. QuickTime không hỗ trợ `.srt` trực tiếp.

## 6. Khi thấy lỗi transcribe: sửa glossary hay bỏ qua?

Không phải lỗi nào cũng nên đưa vào `tools/vib-glossary.json`. Quy tắc để quyết định:

| Loại lỗi | Ví dụ thật đã gặp | Đưa vào glossary? |
|---|---|---|
| Thuật ngữ tiếng Anh bị phiên âm hoá, chuỗi vô nghĩa nếu đứng riêng | `KPI→KTI`, `deploy→e-play`, `fully booked→fulling book` | **Có.** Không tự nhiên xuất hiện đúng nghĩa khác |
| Lỗi dấu/chính tả tiếng Việt, chuỗi sai không phải từ có nghĩa khác | `căn cước công dân→căn cức công dân` | **Có.** Cùng lý do |
| Từ đúng ngữ pháp/nghĩa khác cũng tồn tại, dễ đụng nhau | `lending→landing` ("landing page" cũng là từ thật) | **Cân nhắc kỹ**, biết trước rủi ro: mọi "landing" tương lai (kể cả đúng) sẽ bị đổi thành "lending" |
| Từ phổ biến, nghĩa khác hoàn toàn nhưng đọc gần giống, chỉ hiểu đúng nhờ đọc cả câu | `giảm→giả` ("làm giảm" ≠ "làm giả"), `Điều→đều` | **Không.** Đưa vào sẽ làm sai mọi câu dùng đúng từ đó. Loại này chỉ LLM đọc cả câu mới sửa được, glossary không làm được |

Cách thêm (an toàn, có test tự động): sửa `tools/vib-glossary.json`, thêm
`{ "term": "...", "variants": ["..."] }`, rồi chạy `node --test tools/test.mjs` để chắc
không hỏng gì trước khi dùng.

## Chưa làm được

- **Phân biệt người nói (diarization)**: đã thử và bỏ, xem `FEATURES.md` và `MISTAKES.md` ở
  gốc repo — lỗi phụ thuộc (torchcodec/FFmpeg) trên máy này, và bản ghi Voice Memos là mono
  nên cách "diarize theo channel" của `whisper-cli` cũng không dùng được.
- **LLM thật cho nội dung nhạy cảm**: cần gateway nội bộ hoặc model chạy local được duyệt
  trước — xem cảnh báo bảo mật ở bước 4.
