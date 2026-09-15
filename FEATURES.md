# FEATURES.md

Feature-oriented status board for the Vietnamese code-switching work on top of upstream
LocalVocal. Update this when a feature's status changes.

## Vietnamese speech-to-text — status: **native whisper.cpp / GGML (in use)**

The project's Vietnamese STT solution is the plugin's native `whisper.cpp` + GGML model path —
the same engine the OBS filter (`transcription_filter_audio_filter`) uses live, and which
`whisper-cli` uses for post-hoc file transcription (verified end-to-end, see
`docs/vietnamese-setup.md` §4b and `docs/obs-ui-automation-verification-runbook.md` session 3).

- Model: `ggml-large-v3-turbo.bin` (multilingual, ~1.62 GB), matching the OBS plugin's own
  `Whisper Large v3 Turbo (1.62Gb)` model label.
- Language: `vi`, fixed (not auto-detect) — see `docs/vietnamese-setup.md` §1.
- Code-switching mitigation: initial prompt (§3) + `tools/vib-glossary.json` +
  `tools/transcript-cleanup` post-processing. Verified to fix 4/6 code-switched terms on a
  synthetic test sentence, and confirmed on real recordings.
- **`--vad` (Silero VAD model) is required, not optional**, for file-based transcription of
  real (non-trivial-length) recordings — without it, Whisper can hallucinate repeated boilerplate
  text on quiet/low-energy trailing audio. Confirmed on a real 6-minute recording: hallucinated
  text appeared after 5:11 without VAD, gone entirely with `--vad` enabled, with the added benefit
  of the decoder's low-confidence fallback rate dropping from 12/36 segments to 0/0.
- Model source for the native plugin: `data/models/models_directory.json` +
  `src/model-utils/model-infos.cpp` (Hugging Face URLs, plugin's own downloader). Not modified by
  this work.

## Speaker diarization ("who said what") — status: **not implemented, removed**

A Python-based detour (`whisperx` + `pyannote.audio`, in a separate venv) was tried on
2026-09-15 to add real speaker diarization (voice-characteristic-based, not just turn detection).
It was **removed** — see `MISTAKES.md` (2026-09-15 entry) for the root cause
(`torchcodec`/FFmpeg ABI mismatch) and full rationale. Removing it does not affect the native
`whisper.cpp` Vietnamese STT path at all; the two are unrelated code paths.

`whisper-cli`'s two built-in diarization-adjacent flags were evaluated and found unsuitable for
this project's actual recordings:

- `--diarize` (stereo channel diarization): requires each speaker isolated to a separate audio
  channel. Voice Memos recordings are mono — not applicable.
- `--tinydiarize` (speaker-turn detection, not identity): only has a released model for
  English (`small.en`) — not usable with the Vietnamese multilingual model.

If real diarization is wanted again in the future, re-evaluate FFmpeg-ABI-compatible install
options first (e.g. pin an FFmpeg 7 build via `DYLD_FALLBACK_LIBRARY_PATH` alongside, rather than
downgrading the system's main `ffmpeg` 8.0.1) before reinstalling `whisperx`/`pyannote`.

## Post-processing cleanup (`tools/transcript-cleanup`) — status: **working, verified**

Node CLI, no dependencies. Cleans code-switched `.srt`/`.txt` transcripts via a configurable LLM
backend (Anthropic / Azure OpenAI / OpenAI-compatible). Verified: 75/75 tests passing
(`node --test tools/test.mjs`), byte-identical output against the golden fixture via the local
mock backend, and exercised against two real recordings (mock backend only, no real LLM calls
made against real content).

## OBS live-caption UI automation — status: **blocked, not a current priority**

See `docs/obs-ui-automation-verification-runbook.md` sessions 1-2. The Sources-dock accessibility
surface on this OBS build is unreliable for unattended `System Events` scripting (an unintended
source removal occurred during read-only inspection; a rebuild attempt hit a non-functional
duplicate button node). Not pursued further because the actual near-term use case (meeting
minutes from Mac/iPhone Voice Memos recordings) doesn't need OBS at all — see the whisper-cli
path above. Live on-screen captions would still need OBS if that use case comes up later.
