# Cấu hình LocalVocal cho tiếng Việt có chêm tiếng Anh

Tài liệu này dành cho người nói tiếng Việt hay chêm thuật ngữ tiếng Anh — kiểu nói phổ
biến trong họp chuyên môn ("cái **meeting** này bị **deadline** gấp", "đội **core banking**
đang **review**"). Đọc xong là điền được UI, không cần tra thêm.

Plugin hỗ trợ tiếng Việt đầy đủ: `vi` có trong danh sách ngôn ngữ Whisper
(`src/whisper-utils/whisper-language.h`) và có trong bảng mã dịch
(`src/translation/language_codes.cpp`). Dấu tiếng Việt được giữ đúng vì đường xử lý
caption dùng ICU để đi theo grapheme, và bước dọn ký tự theo byte chỉ áp dụng cho tiếng
Anh (`src/transcription-filter-callbacks.cpp`).

Vấn đề không nằm ở tiếng Việt, mà ở **code-switching**: mỗi lần inference Whisper chỉ nhận
**một** ngôn ngữ (`src/transcription-filter.cpp`), nên khi đang ở chế độ `vi`, thuật ngữ
tiếng Anh bị phiên âm hoá thành chữ Việt — "meeting" ra "mít ting", "deadline" ra "đét
lai". Plugin không có cơ chế nào dành riêng cho code-switching.

---

## 1. Chọn cứng `Vietnamese`, đừng để `auto`

Đây là thay đổi quan trọng nhất, và nó **miễn phí**.

Khi ô ngôn ngữ để trống hoặc `auto`, plugin đặt `detect_language = true` và
`whisper_lang_auto_detect()` được gọi lại cho **từng segment**
(`src/whisper-utils/whisper-processing.cpp`). Một segment chêm nhiều tiếng Anh rất dễ bị
nhận là `en`, và kết quả là cả đoạn đó lệch ngôn ngữ.

Hậu quả nặng hơn nếu bạn bật **WebVTT caption**: caption được gán vào track theo
`result.language`, và ngôn ngữ nào không khớp track nào thì bị `continue` — tức **mất phụ
đề hoàn toàn**, không có cảnh báo (`src/transcription-filter-callbacks.cpp`).

> Chọn cứng `Vietnamese` trong ô **Input Language**. Không để `Auto`, và không bật
> **Detect language** trong *Advanced Settings*.

Thuật ngữ tiếng Anh vẫn ra được chữ Latin đúng trong không ít trường hợp, vì tokenizer BPE
của Whisper dùng chung cho mọi ngôn ngữ — chỉ là không đáng tin cậy. Phần 3 và 4 xử lý phần
còn lại.

## 2. Dùng model đa ngữ, KHÔNG dùng model fine-tune riêng tiếng Việt

| Model | Dùng cho code-switching |
|---|---|
| `ggml-large-v3` / `large-v3-turbo` | **Nên dùng.** Đa ngữ, giữ được chữ Latin tốt nhất |
| `ggml-medium` (đa ngữ) | Được, nếu máy yếu |
| `ggml-large-v2.vi`, `ggml-large.vi`, `ggml-medium.vi` (Marksdo) | **Không nên.** Xem dưới |
| `ggml-model-whisper-tiny.en` (model đi kèm plugin) | Không dùng. English-only, không nhận tiếng Việt |

Các model `.vi` được fine-tune trên tiếng Việt thuần. Điều đó làm WER tiếng Việt tốt hơn
nhưng lại **phiên âm hoá mạnh hơn**: model càng "tin" rằng mọi thứ nghe được đều là tiếng
Việt thì càng dễ biến "meeting" thành "mít ting". Trực giác "model tiếng Việt thì tốt cho
tiếng Việt" bị đảo ngược ở đây.

Lưu ý là model English-only sẽ khiến UI khoá danh sách ngôn ngữ lại chỉ còn tiếng Anh
(`src/transcription-filter-properties.cpp`), nên nếu không thấy `Vietnamese` trong danh
sách thì nguyên nhân là model đang chọn.

## 3. Bốn tham số cần sửa

Tên ô dưới đây lấy đúng từ `data/locale/en-US.ini`. Ba ô đầu nằm trong
**Advanced Settings**.

| Ô trong UI | Giá trị đề nghị | Mặc định | Vì sao |
|---|---|---|---|
| **Initial prompt** | Danh sách thuật ngữ (xem dưới) | rỗng | Đòn bẩy rẻ nhất. Whisper coi prompt như ngữ cảnh đi trước, nên thấy "meeting" viết đúng trong prompt thì có xu hướng viết đúng trong output |
| **# Context sentences** | `2`–`3` | `0` | Tự nối các câu vừa nhận vào `initial_prompt` (`src/whisper-utils/whisper-processing.cpp`), giúp model giữ nhất quán cách viết giữa các câu |
| **Sentence prob. threshold** | `0.25`–`0.30` | `0.4` | Câu trộn hai ngôn ngữ có xác suất token trung bình thấp hơn câu thuần, nên bị coi là `DETECTION_RESULT_SILENCE` và **bị bỏ** (`src/whisper-utils/whisper-processing.cpp`). Hạ ngưỡng để giữ lại. Đổi lại là nhiều câu rác hơn |
| **Setup Filter and Replace** | Các cặp sai→đúng hay gặp | rỗng | Thay thế xác định, không phụ thuộc model |

Thứ tự thử: sửa (1) và (2) trước, đo lại, rồi mới hạ ngưỡng ở (3). Hạ ngưỡng có tác dụng
phụ, đừng làm đầu tiên.

### Initial prompt mẫu

Dán vào ô **Initial prompt**. Whisper đọc đây như văn bản đi trước, nên viết thành câu tự
nhiên hiệu quả hơn là liệt kê khô khan:

```
Đây là bản ghi buổi họp bằng tiếng Việt có dùng thuật ngữ tiếng Anh như meeting, review,
deadline, sprint, backlog, standup, checklist, template, roadmap, workshop, feedback,
dashboard, update, deploy, server, release, approve, escalate, follow up, report, align,
audit, budget, scope, confirm, onboarding, compliance, core banking, digital banking,
mobile banking, internet banking, customer journey, credit scoring, data, token, KPI, OKR,
SLA, OTP, e-KYC.
```

Whisper chỉ nhận prompt dài tối đa bằng nửa context của model, phần vượt bị cắt **từ đầu** —
giới hạn này nằm trong whisper.cpp, không thấy tham số nào trong repo này. Nên đừng nhồi quá
nhiều: giữ 30–50 thuật ngữ hay gặp nhất trong lĩnh vực của bạn, thuật ngữ ít gặp để cho
**Setup Filter and Replace** hoặc bước hậu kỳ lo. Nếu thấy prompt dài mà không có tác dụng,
đó thường là dấu hiệu đã bị cắt.

### Glossary dùng chung

[`tools/vib-glossary.json`](../tools/vib-glossary.json) chứa danh sách thuật ngữ kèm các
biến thể phiên âm hoá hay gặp. Một file này dùng cho cả ba nơi:

- ô **Initial prompt** (lấy phần `term`),
- hộp thoại **Setup Filter and Replace** (mỗi cặp `variant` → `term`),
- bước hậu kỳ [`tools/transcript-cleanup`](../tools/transcript-cleanup/) (tool tự đọc file).

> **Danh sách hiện tại là tạm.** Các biến thể trong đó do người viết dự đoán, không lấy từ
> bản ghi thật. Thay bằng thuật ngữ thật của đơn vị bạn — đó là thứ quyết định chất lượng.
> Định dạng file được mô tả trong [`tools/README.md`](../tools/README.md).

## 4. Nếu vẫn còn lỗi: làm sạch ở bước hậu kỳ

Ba phần trên giảm lỗi chứ không hết lỗi. Nguyên nhân cốt lõi — một ngôn ngữ cho mỗi lần
inference — nằm trong kiến trúc, không sửa được bằng cấu hình.

Nếu bạn cần **biên bản họp** (không cần phụ đề hiện ngay trên màn hình), cách cho kết quả
tốt nhất là bật **Save to File** rồi chạy file qua
[`tools/transcript-cleanup`](../tools/transcript-cleanup/). Bước này gửi text qua một LLM để
phục hồi chính tả tiếng Anh.

Vì sao hậu kỳ tốt hơn làm realtime:

- LLM thấy **toàn bộ** buổi họp, nên suy được "mít ting" = "meeting" từ các câu xung quanh.
  Đường realtime chỉ có một segment ~7 giây.
- Rẻ hơn nhiều lần, và không có ràng buộc latency.
- Với `.srt`, index và timestamp **không đi qua LLM** nên không thể bị làm lệch.

Cấu hình OBS tương ứng: bật **Save to File**, bật **Save in SRT format** nếu muốn giữ mốc
thời gian, và **Write output only while recording** nếu chỉ cần khi đang ghi.

> **Lưu ý dữ liệu:** bước này gửi nội dung phụ đề tới backend LLM đã cấu hình. Nếu backend
> là API công cộng thì nội dung họp rời khỏi hạ tầng của bạn. Với họp nội bộ hoặc dữ liệu
> khách hàng, trỏ `LLM_BASE_URL` vào gateway nội bộ hoặc LLM chạy local. Xem
> [`tools/transcript-cleanup/README.md`](../tools/transcript-cleanup/README.md).

## 5. Đo thay vì đoán

Các đề nghị trên là điểm khởi đầu hợp lý, không phải kết luận cho giọng nói và bộ thuật ngữ
cụ thể của bạn. Cách duy nhất để biết chắc là đo:

```bash
# Build có bật test
cmake --preset <preset> -DENABLE_TESTS=ON && cmake --build --preset <preset>

# Chạy trên một file ghi âm thật, rồi so với bản gõ tay
pip install Levenshtein diff_match_patch
python3 src/tests/evaluate_output.py reference.txt hypothesis.txt --print_alignment
```

Chạy hai lần — một với `large-v3`, một với `large-v2.vi` — rồi so WER/CER. Chi tiết trong
`src/tests/README.md`.

Lưu ý: công cụ test offline hiện có điểm vào là `wmain` (`src/tests/localvocal-offline-test.cpp`)
nên chỉ build được trên Windows. Trên macOS/Linux, dùng bước hậu kỳ ở phần 4 và so sánh bằng
`evaluate_output.py` trên file `.srt`/`.txt` do plugin ghi ra.

## 6. Bảng tra nhanh

| Tình huống | Xử lý |
|---|---|
| Phụ đề mất hẳn từng đoạn | **Input Language** đang là `Auto` + bật WebVTT. Chọn cứng `Vietnamese` |
| Câu ngắn hay bị bỏ | Hạ **Sentence prob. threshold** xuống `0.25`; cân nhắc giảm **Duration filter** (mặc định `2.25`) |
| Thuật ngữ sai khác nhau mỗi lần | Tăng **# Context sentences** lên `2`–`3` |
| Một thuật ngữ luôn sai y hệt | Thêm cặp vào **Setup Filter and Replace** — xác định, không phụ thuộc model |
| Không thấy `Vietnamese` trong danh sách | Đang dùng model English-only (`.en`). Đổi sang model đa ngữ |
| Dấu tiếng Việt bị lỗi | Kiểm **Input Language** không phải `English`; đường xử lý `en` dùng bước dọn theo byte |
| Cần bản sạch, không cần realtime | Bật **Save to File** → [`tools/transcript-cleanup`](../tools/transcript-cleanup/) |
