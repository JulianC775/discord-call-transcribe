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
- Pipeline: steps 1-5 done. Run: `.venv\Scripts\python -m pipeline <recording folder | OBS file> [--language en] [--out transcripts] [--audio-track 0]`. Writes transcripts/<name>.md.
  - model.py: load_model() adds the nvidia/*/bin DLL dirs (Windows CUDA), sets HF_HUB_OFFLINE=1, loads models/faster-whisper-large-v3 on cuda/float16. `python -m pipeline.smoke_test [clip]` checks the GPU on one clip.
  - stitch.py: one 16 kHz mono WAV per speaker in recordings/<session>/tracks/, clips placed at startMs. Crash-tolerant: skips a half-written last line in segments.jsonl, recovers .ogg clips missing from it (startMs from the file name), skips undecodable clips.
  - transcribe.py: beam 5, Silero VAD, no_speech 0.6, log_prob -1.0, compression_ratio 2.4, language defaults to en.
  - merge.py: sorts all speakers' lines; joins consecutive same-speaker lines into one turn unless more than 30 s apart.
  - __main__.py: OBS files go through ffmpeg (audio track 0 by default) and are labeled "Speaker".
  - Tested on the 40 s bot recording, a synthetic OBS .mkv, and a synthetic 2-speaker session with endedAt null and a missing segments line.

## Decisions
Keep the bot's per-utterance clips as raw capture and do all grouping and noise filtering in the pipeline. Don't filter or drop clips in the bot: short clips can be real words ("yeah", "no"). Whole per-speaker tracks give Whisper context; 2 s clips make it hallucinate.

## Next steps
1. Accuracy check: hand-correct a 5 minute sample, measure word accuracy, tune settings until at least 90%.
2. Live tests: a call with 2+ speakers, then a 1 to 2 hour call.
3. Optional: make the bot private (Installation > Install Link: None, then Bot > Public Bot off); speaker labels for mixed OBS audio (whisperx/pyannote).
