# Discord Call Transcriber

## What this is
A self-hosted tool that records Discord voice calls and turns them into text transcripts for Claude to summarize or reference. Everything runs locally. No audio or transcript is uploaded to any third-party service.

## Input sources
1. Discord bot (primary): a Python bot joins a voice channel and records each speaker to a separate local audio file. Separate tracks make speaker labels possible.
2. Streamlabs OBS recordings (secondary): Carl records calls with Streamlabs OBS. These are video containers like .mkv/.mp4, usually with mixed desktop audio. The pipeline must accept these files too.

## Pipeline
1. Capture: the bot writes per-speaker audio to recordings/<session>/, or the user supplies an OBS file.
2. Extract/convert: ffmpeg pulls the audio out of video containers and converts it to 16 kHz mono WAV.
3. Transcribe: local Whisper (faster-whisper preferred) produces text with timestamps.
4. Merge: per-speaker transcripts are combined into one chronological transcript with speaker labels, e.g. [00:12:34] Julian: ...
5. Output: plain .txt/.md files in transcripts/, formatted to paste straight into Claude.

## Hard constraints
- Local-only. No cloud transcription APIs and no uploading audio or transcripts. The only network traffic is the bot's normal Discord connection.
- The bot token and config live in .env. Never hardcode or commit secrets.
- Never commit recordings, transcripts, or model files.
- The bot makes its presence obvious: it stays visible in the channel and announces when recording starts and stops.

## Tech
- Python 3.10+
- discord.py + discord-ext-voice-recv (core discord.py can't receive voice)
- ffmpeg (system dependency)
- faster-whisper (fallback: openai-whisper)
- Optional later: whisperx/pyannote to label speakers in mixed OBS audio

## Conventions
- Small modules (bot/, pipeline/), plus a CLI entry point that transcribes an existing file without the bot.
- Dependencies pinned in requirements.txt.
- Commit messages: never add "Co-Authored-By: Claude" or any other Claude attribution lines.

## Status
Repo just created. Nothing built yet.
