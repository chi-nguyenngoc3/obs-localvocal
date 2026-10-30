# OBS UI Automation and LocalVocal Verification Runbook

## Purpose

This runbook explains how to automate and verify LocalVocal in OBS Studio on macOS. It is intended for a beginner who wants to:

1. Add a microphone and subtitle source.
2. Add the `LocalVocal Transcription` audio filter.
3. Configure Vietnamese transcription with English code-switching.
4. save and verify a raw transcript.
5. Run the separate LLM cleanup tool and verify the cleaned output.

The two execution paths must not be confused:

```text
Live path inside OBS
Microphone -> LocalVocal filter -> local Whisper -> OBS subtitle source + raw file

Post-processing path outside OBS
Raw .txt/.srt -> Node transcript-cleanup CLI -> configured LLM -> cleaned .txt/.srt
```

The current feature branch does not call the LLM from the OBS C/C++ plugin. LLM correction is not currently available as an OBS button or filter setting.

## Automation strategy

Use two complementary mechanisms:

| Mechanism | Purpose | Reliability |
|---|---|---|
| AppleScript with macOS System Events | Activate OBS, open dialogs, bootstrap configuration and handle model-download windows | Dependent on UI labels and Accessibility permission |
| OBS WebSocket | Create/query sources and filters, apply settings, start/stop recording and inspect state | Preferred once enabled because it uses semantic RPC calls |

Avoid fixed screen coordinates. Target accessible control names and verify the resulting OBS state after each action.

## Preconditions

- OBS Studio is installed at `/Applications/OBS.app`.
- LocalVocal is installed under `~/Library/Application Support/obs-studio/plugins/`.
- OBS has permission under **System Settings -> Privacy & Security -> Accessibility**.
- OBS has permission under **System Settings -> Privacy & Security -> Microphone**.
- The expected computer is Apple Silicon and has enough memory for the selected model.
- Do not place LLM API keys in this repository or directly in shell commands that may be retained in history.

## Phase A: AppleScript bootstrap

Activate OBS and confirm that its accessibility tree is available:

```applescript
tell application "OBS" to activate
delay 1

tell application "System Events"
    if not (exists process "OBS") then error "OBS is not running"
    tell process "OBS"
        set frontmost to true
        return name of every window
    end tell
end tell
```

Expected result: the main OBS window is returned. A filter dialog may also be present.

OBS does not expose a native AppleScript dictionary. Automation therefore uses Accessibility UI scripting through `System Events`.

## Phase B: create the OBS sources

In the active scene, create:

1. An **Audio Input Capture** source named `Microphone` and select the intended microphone device.
2. A **Text (FreeType 2)** source named exactly `LocalVocal Subtitles`.

The LocalVocal plugin can create `LocalVocal Subtitles` automatically when its filter is created, but creating it explicitly makes the workflow deterministic and lets the operator position it before testing.

Verification gates:

- The microphone appears in **Sources**.
- Its green level meter moves in **Audio Mixer** when the operator speaks.
- `LocalVocal Subtitles` appears in **Sources** and is visible on the canvas.

## Phase C: create and configure the LocalVocal filter

Open:

```text
Microphone -> Filters -> Audio/Video Filters -> Add -> LocalVocal Transcription
```

The native OBS filter kind in the source is:

```text
transcription_filter_audio_filter
```

Apply the following settings:

```json
{
  "subtitle_sources": "LocalVocal Subtitles",
  "whisper_language_select": "vi",
  "whisper_model_path": "Whisper Large v3 Turbo (1.62Gb)",
  "partial_group": true,
  "file_output_enable": true,
  "subtitle_output_filename": "~/Downloads/localvocal-test.txt",
  "subtitle_save_srt": false,
  "only_while_recording": false,
  "advanced_settings_mode": 1,
  "n_context_sentences": 2,
  "sentence_psum_accept_thresh": 0.25,
  "detect_language": false,
  "initial_prompt": "Đây là bản ghi tiếng Việt có dùng meeting, review, deadline, sprint, deployment, production, API, workflow, model, prompt và AI agent."
}
```

The first model selection may open a LocalVocal download dialog. Wait for completion before speaking or starting the verification recording.

## Phase D: recording and deterministic test input

For a quick manual microphone test, say:

```text
Hôm nay chúng ta review kế hoạch sprint. Deadline là Friday và team sẽ deploy lên production.
```

Wait at least one full segment, normally 7-10 seconds.

For repeatable automated testing, use a synthetic prerecorded audio fixture containing no personal, customer or confidential information. A fixed fixture is preferable to the live microphone because every run receives the same audio.

Recording can be controlled by named OBS buttons through AppleScript or by the OBS WebSocket `StartRecord` and `StopRecord` requests.

Example AppleScript fallback:

```applescript
tell application "System Events"
    tell process "OBS"
        click button "Start Recording" of window 1
        delay 20
        click button "Stop Recording" of window 1
    end tell
end tell
```

Do not assume the operation succeeded merely because the click returned. Query OBS state or verify that a recording/output file was created.

## Phase E: verify the live LocalVocal result

All three gates must pass:

1. **Canvas:** the `LocalVocal Subtitles` source displays text.
2. **File:** `~/Downloads/localvocal-test.txt` exists, is non-empty and has a current modification time.
3. **Log:** the newest OBS log reports LocalVocal loaded and contains no model-load, Whisper or file-output error for the test.

Useful read-only checks:

```bash
test -s "~/Downloads/localvocal-test.txt"

latest_log="$(find "$HOME/Library/Application Support/obs-studio/logs" \
  -maxdepth 1 -type f -print0 | xargs -0 ls -1t | head -1)"
rg -n "obs-localvocal|Whisper|LocalVocal|error|failed" "$latest_log"
```

Do not enable `Log Output to Console` for confidential meetings because that setting can place transcript text in the OBS log.

## Phase F: run the post-processing LLM cleanup

This phase runs outside OBS. First perform a dry run:

```bash
cd "<repo-root>"

node tools/transcript-cleanup/cleanup.mjs \
  "~/Downloads/localvocal-test.txt" \
  -o "~/Downloads/localvocal-test-cleaned.txt" \
  --dry-run
```

Then validate the pipeline using the local mock backend before spending tokens:

```bash
# Terminal 1
node tools/mock-llm/server.mjs

# Terminal 2
node tools/transcript-cleanup/cleanup.mjs \
  "~/Downloads/localvocal-test.txt" \
  -o "~/Downloads/localvocal-test-cleaned.txt"
```

A real internal OpenAI-compatible gateway uses:

```bash
node tools/transcript-cleanup/cleanup.mjs \
  "~/Downloads/localvocal-test.txt" \
  -o "~/Downloads/localvocal-test-cleaned.txt" \
  --provider openai \
  --base-url "http://approved-internal-gateway" \
  --model "approved-model"
```

Supply the API key through an approved secret mechanism. Do not paste a real key into a committed file, command example, screenshot or shared transcript.

## Phase G: verify the cleaned result

Verify:

1. The command exits with status `0`.
2. The cleaned output exists and is non-empty.
3. The raw input remains unchanged.
4. The output has the same number of lines as the input for `.txt`.
5. For `.srt`, sequence numbers and timestamps are byte-identical.
6. English terms improve without translating or rewriting the Vietnamese sentences.

The mock backend validates plumbing and glossary behavior. It does not establish real-model quality. Real-model quality requires synthetic or approved test data and a reviewed expected transcript.

## Current product boundary

| Capability | Current status |
|---|---|
| Local Whisper transcription inside OBS | Available |
| Live subtitle display inside OBS | Available |
| Raw `.txt`/`.srt` output from OBS | Available |
| Existing cloud language translation inside OBS | Available, but it is translation rather than code-switch correction |
| LLM code-switch correction after recording | Available through the Node CLI |
| LLM code-switch correction button inside OBS | Not implemented |
| Real-time LLM-corrected subtitles inside OBS | Not implemented |

## Verification record

Recorded on 2026-09-14 against the live OBS installation. Do not claim a capability is verified merely because its source code exists.

| Check | Result | Evidence |
|---|---|---|
| OBS installed and running | Pass | OBS Studio 32.0.4, Apple Silicon process active from `/Applications/OBS.app` |
| LocalVocal plugin loads | Pass | Current OBS log: `plugin loaded successfully (version 0.6.2)` |
| AppleScript Accessibility access | Pass | AppleScript activated OBS, enumerated windows and named main-window controls, and located **Tools -> WebSocket Server Settings** |
| Native AppleScript dictionary | Not available, expected | `sdef /Applications/OBS.app` returns error `-192`; automation must use System Events |
| OBS WebSocket listening | Disabled | No listener on default TCP port 4455; menu entry exists but no configuration was changed |
| LocalVocal filter configured | Partial | Scene contains enabled filter `transcription_filter_audio_filter`; output source is `LocalVocal Subtitles`; input language is `vi`; file output is not configured |
| Whisper model loaded | Blocked for Vietnamese test | OBS loaded `Whisper Tiny English (74Mb)` on CPU. This model is English-only and must be replaced with a multilingual model |
| Live subtitle rendered | Not verified | Subtitle source exists but currently contains empty text; no synthetic audio was injected and no operator speech was captured during verification |
| Raw file generated | Not configured | `~/Downloads/localvocal-test.txt` is absent or empty |
| Mock cleanup pipeline | Pass | Local mock returned 26/26 changes, zero failed batches, exit status 0 and byte-identical output against the golden fixture |
| Project test suite | Pass | `node --test tools/test.mjs`: 75/75 tests, 8/8 suites |
| Real LLM cleanup | Not run | Requires approved endpoint, synthetic input and explicit token use |

### Findings from live verification

1. The installed plugin and basic OBS source wiring work.
2. The current `vi` language setting conflicts with the loaded English-only Tiny model. A multilingual model is a hard prerequisite for the Vietnamese test.
3. The output file path has not been configured, so the post-processing CLI has no real OBS transcript to consume yet.
4. AppleScript reliably handles application activation, main-window controls and menu navigation. Deep Qt property dialogs intermittently return Apple event error `-10000`; OBS WebSocket should be enabled before relying on unattended configuration.
5. The mock LLM proves the post-processing pipeline and glossary integration, but it does not prove live Whisper quality or real-LLM quality.

## Verification record — session 2 (2026-09-14, ~15:00-15:10)

Continuation of the same-day verification against the same live OBS installation. Goal was to
replace the Tiny English model with the multilingual model, configure code-switching settings,
configure raw file output, and re-verify. That goal was **not reached** — read-only accessibility
inspection itself destabilized the running OBS instance before any intended configuration change
was made. This is recorded in full because it is a safety-relevant finding about automating this
specific OBS/Qt build via `System Events`, not just a status update.

### Incident: read-only AppleScript inspection triggered source removal

Before any UI mutation was attempted, the live scene collection (`Untitled.json`, 14433 bytes) was
backed up to a temporary scratch directory. It contained the expected configuration: `macOS Screen
Capture`, `LocalVocal Subtitles` (`text_ft2_source_v2`), and `Audio Input Capture - 0`
(`coreaudio_input_capture`) with the `LocalVocal Transcription` filter attached (`whisper_language_select:
"vi"`, no model/output settings yet — matching session 1's "Partial" finding).

Read-only AppleScript queries were then run against the OBS accessibility tree: window enumeration,
button/checkbox listing, and one `entire contents of window 1` deep traversal (which itself failed
with Apple event error `-10000`, consistent with session 1's finding #4). No `click`, `keystroke`, or
`AXPress` action was issued at any point during this phase.

The OBS log for that window shows, verbatim:

```
15:07:02.265: User Removed source 'LocalVocal Subtitles' (text_ft2_source_v2) from scene 'Scene'
...
15:07:20.494: User Removed source 'LocalVocal Subtitles' (text_ft2_source_v2) from scene 'Scene'
15:07:24.514: User Removed source 'Audio Input Capture - 0' (coreaudio_input_capture) from scene 'Scene'
15:07:27.539: [obs-websocket] [obs_module_unload] Finished shutting down.
15:07:27.567: Number of memory leaks: 0
```

followed by a clean OBS restart (`==== Startup complete ===`, `All scene data cleared`) that loaded a
scene collection file already missing both sources. The shutdown was graceful (0 memory leaks logged),
not a crash. It could not be established with certainty whether this was caused by the read-only
accessibility traversal (a known failure class: buggy `QAccessibleInterface` implementations can fire
an object's default action in response to an attribute query, and the two duplicate/`Add`-labeled
buttons found afterward — see below — corroborate an unreliable AX bridge for this app) or by a
human/other process operating OBS at the same time. The user, when asked, was not sure either and
opted to rebuild rather than investigate further. **The prior scene state is preserved** in
`/private/tmp/.../scratchpad/obs-backup/Untitled-backup-20260914-150655.json` (session-local scratch
path, not committed to the repo) in case restoration is wanted later.

### Blocker: Sources-dock controls are not reliably addressable via System Events

After the removal, an attempt was made to rebuild `Audio Input Capture` and `LocalVocal Subtitles` via
the Sources dock's `+`/"Add" button, per Phase B of this runbook. This could not be completed safely:

- Enumerating all `AXButton`s of the main window returns the Sources dock's `Add`, `Remove`,
  `Properties`, `Move Up`, `Move Down` buttons at **the exact same reported screen position** as the
  Scenes dock's identically-named buttons (e.g. both `Add` buttons report `x=1923 y=959`).
- A deep walk of `groups`/`lists`/`rows` of the main window returns lists with rows that carry no
  name, value, title, or usable child elements — the Sources/Scenes list contents are not exposed in
  a way that lets a specific source be selected or identified by name via accessibility.
- As a reversible probe, the second (`Sources`-dock-position) `Add` button was pressed once via its
  `AXUIElement` reference (not a coordinate click). It produced **no observable effect**: no new menu,
  no new window, and no new log line of any kind in the following seconds. This indicates the button
  reference obtained by list position is a stale or non-functional duplicate node, not a live control.

Per the runbook's own safety rule ("avoid blind clicks; if Qt accessibility prevents a safe change,
stop and report the exact blocker"), no further UI clicks were attempted. **OBS WebSocket** (Tools →
WebSocket Server Settings, reachable via the menu bar) is the recommended next path — it exposes
semantic `CreateInput` / `SetInputSettings` / `CreateSceneItem` RPCs that do not depend on this dock's
broken accessibility surface — but enabling it and driving it was out of scope for this pass without
further direction, since it requires setting a listener password.

### Verification record

| Check | Result | Evidence |
|---|---|---|
| OBS running, main window reachable via AppleScript | Pass | `OBS 32.0.4 - Profile: Untitled - Scenes: Untitled` returned; `Start Streaming`/`Start Recording` buttons (not `Stop`) confirmed no active recording/stream before any action |
| Scene collection backed up before UI changes | Pass | `Untitled-backup-20260914-150655.json`, 14433 bytes, saved to session scratch dir before any mutation attempt |
| Existing Audio Input Capture / LocalVocal Subtitles / LocalVocal Transcription filter confirmed | Pass, then lost | Present and confirmed via backup JSON + OBS log at inspection start; removed from the live app and from disk during read-only inspection (see incident above) |
| Rebuild sources via AppleScript System Events | Blocked | Sources-dock `Add`/`Remove`/`Properties` buttons indistinguishable by position from Scenes-dock equivalents; a reversible test press produced no log activity, indicating a non-functional accessibility node. No further blind clicks attempted |
| Whisper model replaced with multilingual `Whisper Large v3 Turbo` | Not attempted | Blocked on the above — the Filters property dialog for the audio source could not be reached |
| Vietnamese language / advanced settings (context sentences, threshold, prompt) | Not attempted | Same blocker |
| Raw text output file configured | Not attempted | Same blocker. Confirmed `~/Downloads/localvocal-test.txt` still does not exist, so no pre-existing operator file is at risk |
| Live subtitle / synthetic audio test | Blocked | No subtitle source currently exists in the live scene, and no deterministic audio-injection path is available in this environment. Not claimed as passing |
| Project test suite | Pass | `node --test tools/test.mjs`: **75/75 tests, 8/8 suites, 0 failures** |
| Mock LLM cleanup pipeline | Pass | `tools/mock-llm/server.mjs` + `cleanup.mjs tools/testdata/codeswitch-vi.srt` → exit code `0`, `26/26` sentences changed, `0` failed batches, output byte-identical to `tools/testdata/codeswitch-vi.expected.srt` (verified with both `diff` and `cmp`), written to a session scratch directory (not `~/Downloads/`) |
| Real LLM cleanup | Not run | Out of scope per safety constraints (no token spend, no real API calls) |

### Findings from session 2

1. **This specific OBS build's accessibility tree is not safe for unattended Sources-dock mutation.**
   Both an unintended removal during read-only inspection and a non-functional duplicate `Add` button
   were observed in the same session. Treat any further AppleScript-driven Sources-dock changes on
   this machine as unverified until OBS WebSocket (with an authenticated password) is enabled and used
   instead of `System Events` UI scripting for source/filter creation.
2. **Menu-bar navigation and top-level window/button enumeration remain reliable** (confirming session
   1 finding #4); it is specifically the Sources/Scenes dock's list-based controls that are unreliable.
3. **The software-only pipeline (Node test suite, mock LLM cleanup) is unaffected by the OBS incident**
   and re-verified clean in this session: 75/75 tests, byte-identical golden-fixture match.
4. **Remaining work is entirely OBS-side**: recreate `Audio Input Capture` + `LocalVocal Subtitles` +
   `LocalVocal Transcription` filter (fresh, per user direction — not restored from backup), then
   select the multilingual model, set language/advanced settings, configure file output, and capture
   one operator speech sample for the live-subtitle gate. Recommended path: enable OBS WebSocket with
   a generated local password and drive the rebuild through its RPCs rather than through `System
   Events` clicks on the Sources dock.

## Verification record — session 3 (2026-09-15): whisper-cli route, no OBS

Scope changed after session 2: the actual source is a **recorded file** (Voice Memos on Mac or
iPhone), not a live OBS capture. For that use case OBS is not required at all — see the "Three
routes" decision table below. This session verifies the file-based route (`whisper-cli` +
`transcript-cleanup`) end-to-end with synthetic TTS audio, independent of the OBS plugin.

### Environment found on this machine

| Tool | Status |
|---|---|
| `whisper.cpp` (provides `whisper-cli`) | Already installed via Homebrew, v1.9.4 |
| `ffmpeg` | Already installed, v8.0.1 |
| `ggml-large-v3-turbo.bin` | Not present — downloaded this session (see below) |
| Mac Voice Memos sync folder (`~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings/`) | Empty — no recordings currently synced from iPhone/Mac |

### Model download — first attempt failed silently, caught and fixed

The first `curl` download of `ggml-large-v3-turbo.bin` stalled at 14.3% with `curl: (56) Recv
failure: Can't assign requested address` (a local network hiccup), but because the command was
piped through `tail`, the captured exit code reflected `tail`, not `curl`, and read as `0`. The
resulting file was 231,767,470 bytes — a silently truncated model that would very likely have
loaded with a corrupt/incomplete tensor and either failed or produced garbage. This was caught by
checking the file size against the expected ~1.6 GB rather than trusting the shell's reported exit
code. Re-run with `curl -C -` (resume) and a direct (unpiped) exit-code check completed
successfully: **1,624,555,275 bytes**, matching OBS's own label for this model, `Whisper Large v3
Turbo (1.62Gb)`, almost exactly.

**Lesson:** never trust a piped exit code for a long-running download; check the resulting file
size/hash independently of the reported status.

### Synthetic test (no real meeting audio used)

Vietnamese TTS voice `Linh` (already present in macOS `say`) was used to generate the following
code-switched sentence, matching the style of this repo's existing test fixtures and the
`docs/vietnamese-setup.md` example:

```
Hôm nay chúng ta review kế hoạch sprint. Deadline là Friday và team sẽ deploy lên production.
Bên core banking chưa trả KPI.
```

`say -v Linh -o synthetic.aiff "…"` → `ffmpeg -ar 16000 -ac 1` → `synthetic.wav` (9.9s, 16kHz mono).

**Run 1 — no initial prompt** (`whisper-cli -m ggml-large-v3-turbo.bin -l vi -osrt`), Metal backend
on Apple M4 Pro, load time 2.9s, total time 5.25s:

```
Hôm nay chúng ta review kế hoạch screen, đẹp lại là Friday và Tim sẽ e-coi lên production,
bên co banking chưa trả ca tờ y.
```

`sprint→screen`, `deadline→đẹp lại`, `team→Tim`, `deploy→e-coi`, `core banking→co banking`,
`KPI→ca tờ y`. `review`, `Friday`, `production` survived correctly even without any mitigation —
consistent with `docs/vietnamese-setup.md`'s note that the BPE tokenizer sometimes gets Latin
terms right by chance, just not reliably.

**Run 2 — same audio, with `--prompt` (the runbook's code-switching initial prompt) and
`--carry-initial-prompt`**, total time 2.47s:

```
Hôm nay chúng ta review kế hoạch sprint, deadline là Friday và team sẽ e-play lên production,
bên core banking chưa trả KTI.
```

`sprint`, `deadline`, `team`, `core banking` are now **all correct** — a direct, real (not just
documented) confirmation that the initial-prompt mitigation in `docs/vietnamese-setup.md` §3 works.
Only `deploy→e-play` and `KPI→KTI` remain mangled, and in a way the current
`tools/vib-glossary.json` does not cover (`deploy`'s known variants are `đi ploi`/`đê
ploi`/`đi-ploi`; `KPI`'s are `ca pi ai`/`ka pi ai`/`cây pi ai` — `e-play` and `KTI` are new
patterns from this specific TTS voice, not in either list).

**Post-processing with `transcript-cleanup` + mock LLM** on the Run 2 output: exit `0`, but
`0/1 câu thay đổi` — the mock backend only does literal glossary-variant substitution, and since
`e-play`/`KTI` are not in the glossary, nothing changed. This is expected and correctly documented
behavior (`tools/README.md`: "mock chỉ là backend dev... không phải bản mô phỏng đầy đủ"), not a
tool defect — it demonstrates concretely why `docs/vietnamese-setup.md`'s warning that "the
glossary's variants are guesses" matters in practice, and why a **real** LLM backend (which
reasons from context, not just string-matching) would be needed to catch `e-play`/`KTI`, or why
these two specific patterns should be added to the glossary once seen in real recordings.

### Verification record

| Check | Result | Evidence |
|---|---|---|
| `whisper.cpp`/`whisper-cli` present | Pass | `brew info whisper-cpp`: v1.9.4 installed |
| `ffmpeg` present | Pass | v8.0.1 at `/opt/homebrew/bin/ffmpeg` |
| `ggml-large-v3-turbo.bin` downloaded and size-verified | Pass (after one caught failure) | 1,624,555,275 bytes; first attempt silently truncated at 231,767,470 bytes and was re-run |
| Metal backend used on Apple M4 Pro | Pass | Log: `ggml_metal_init: found device: Apple M4 Pro`, `using MTL0 backend` |
| Vietnamese transcription of code-switched synthetic speech | Pass (with expected transliteration) | See Run 1/Run 2 above |
| Initial-prompt mitigation reduces transliteration | Pass, verified directly | 4 of 6 code-switched terms fixed by the prompt alone (Run 1 → Run 2) |
| `transcript-cleanup` + mock LLM on the whisper-cli output | Pass (tool behaved correctly; content only partially cleaned) | exit `0`, fail-open preserved original text for unmatched terms, no crash |
| No real audio, no real LLM, no token spend | Pass | TTS-synthesized audio only; mock backend only |

### Findings from session 3

1. **The file-based route works end-to-end on this machine today** and does not need OBS, the
   plugin, or any UI automation — `whisper-cli` handles both capture-equivalent (from a file) and
   transcription in one command, matching the architecture note that OBS is only a live-audio
   host, not a requirement for post-hoc transcription.
2. **The initial-prompt mitigation is real, not just documented** — verified a 4/6 improvement on a
   held-out synthetic sentence in this session.
3. **Never trust a piped shell command's exit code for long downloads** — verify output file size
   independently; this session caught a silently truncated multi-hundred-MB file that would
   otherwise have been used as if valid.
4. **The current glossary is confirmed provisional in practice, not just by disclaimer** — two novel
   mangling patterns from a single TTS voice (`e-play`, `KTI`) were not covered, reinforcing
   `docs/vietnamese-setup.md`'s point that real terminology from real recordings is the actual
   quality lever, more than model/prompt tuning.
5. **For an actual Mac/iPhone Voice Memos workflow**: no recordings were found synced to this Mac
   (`~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings/` is empty). iCloud
   sync for Voice Memos needs to be enabled on both devices, or the `.m4a` shared manually (AirDrop/
   Files), before a real recording can be run through this same `ffmpeg` → `whisper-cli` →
   `transcript-cleanup` chain.
