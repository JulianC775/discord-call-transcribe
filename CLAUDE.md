# Discord Call Transcriber

## What this is
A self-hosted tool that records Discord voice calls and turns them into text transcripts for Claude to summarize or reference. Everything runs locally. No audio or transcript is uploaded to any third-party service.

## Input sources
1. Discord bot (primary): a Node.js bot joins a voice channel and records each speaker to separate local audio files. Separate tracks make speaker labels possible.
2. Streamlabs OBS recordings (secondary): Carl records calls with Streamlabs OBS. These are video containers like .mkv/.mp4, usually with mixed desktop audio. The pipeline must accept these files too.

## Pipeline
1. Capture: the bot writes per-speaker audio to recordings/<session>/, or the user supplies an OBS file. Bot output layout:
   - session.json: start/end time, guild, channel, speakers ({userId: {name, username}})
   - segments.jsonl: one line per utterance: {user, file, startMs, durationMs}; startMs is ms since recording start
   - <userId>/<startMs>.ogg: Ogg Opus, 48 kHz stereo, one file per utterance (split after 1.5 s of silence)
2. Extract/convert: ffmpeg pulls the audio out of video containers and converts it to 16 kHz mono WAV.
3. Transcribe: local Whisper (faster-whisper preferred) produces text with timestamps.
4. Merge: per-speaker transcripts are combined into one chronological transcript with speaker labels, e.g. [00:12:34] Julian: ...
5. Output: plain .txt/.md files in transcripts/, formatted to paste straight into Claude.

## Targets
- Calls of 1 to 2 hours. The bot must survive network drops and save audio as it goes.
- At least 90% word accuracy. Use Whisper large-v3 on the GPU (RTX 4090, 24 GB VRAM); don't trade accuracy for speed.

## Hard constraints
- Local-only. No cloud transcription APIs and no uploading audio or transcripts. The only network traffic is the bot's normal Discord connection.
- The bot token and config live in .env. Never hardcode or commit secrets.
- Never commit recordings, transcripts, or model files.
- The bot makes its presence obvious: it stays visible in the channel and announces when recording starts and stops.

## Tech
- Bot: Node.js 22+, discord.js + @discordjs/voice (bot/). Node because Discord requires DAVE end-to-end encryption on voice since March 2026, and @discordjs/voice is the only maintained library that decrypts received DAVE audio. The Python option (discord-ext-voice-recv) has no DAVE support on PyPI as of Sept 2026.
- Pipeline: Python 3.10+ (pipeline/)
- ffmpeg (system dependency)
- faster-whisper (fallback: openai-whisper)
- Optional later: whisperx/pyannote to label speakers in mixed OBS audio

## Conventions
- Small modules (bot/ in Node, pipeline/ in Python), plus a CLI entry point that transcribes an existing file without the bot.
- Dependencies pinned: exact versions in bot/package.json (+ package-lock.json), requirements.txt for Python.
- Bot tests: cd bot && npm test
- Commit messages: never add "Co-Authored-By: Claude" or any other Claude attribution lines.

## Status
- Bot: ?record and ?stop (prefix via COMMAND_PREFIX in .env; needs Message Content intent). Tested in a live 40 s call with 1 speaker: 4 clips, DAVE decrypt clean (0 decode errors). Not yet tested with 2+ speakers or a 1 to 2 hour call.
- Pipeline: not started. .venv exists (Python 3.13, pip installed) with nothing else installed.

## Next steps (the user may say "do 1-5")
Decided: keep the bot's per-utterance clips as raw capture and do all grouping and noise filtering in the pipeline. Don't filter or drop clips in the bot: short clips can be real words ("yeah", "no").

1. Python setup: requirements.txt with pinned faster-whisper, install into .venv with CUDA support, download Whisper large-v3 into models/.
2. Stitch: pipeline/stitch.py reads session.json + segments.jsonl and places each speaker's clips on one continuous 16 kHz mono WAV track at their startMs. Whole tracks give Whisper context; 2 s clips make it hallucinate.
3. Transcribe: pipeline/transcribe.py runs faster-whisper large-v3 on the GPU per speaker track, with vad_filter (Silero) to skip non-speech and hallucination guards (no_speech_threshold, log_prob_threshold, compression_ratio_threshold).
4. Merge + output: combine all speakers by timestamp, join back-to-back lines from the same speaker into one turn, write transcripts/<session>.md as "[HH:MM:SS] Name: text".
5. CLI: `python -m pipeline <recording folder | OBS .mkv/.mp4>`. OBS files: ffmpeg extracts audio to one mixed track, labeled "Speaker" for now.

Later:
6. Accuracy check: hand-correct a 5 minute sample, measure word accuracy, tune settings until at least 90%.
7. Live tests: a call with 2+ speakers, then a 1 to 2 hour call.
8. Optional: make the bot private (Installation > Install Link: None, then Bot > Public Bot off); speaker labels for mixed OBS audio (whisperx/pyannote).
