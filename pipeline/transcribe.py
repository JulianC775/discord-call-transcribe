"""Run Whisper on one audio track, skipping silence and guarding against hallucinations."""
import sys
from dataclasses import dataclass


@dataclass
class Line:
    start: float  # seconds from the start of the recording
    end: float
    speaker: str
    text: str


TRANSCRIBE_OPTIONS = dict(
    beam_size=5,
    # Silero VAD: drop non-speech so Whisper never sees long silent stretches.
    vad_filter=True,
    vad_parameters=dict(min_silence_duration_ms=500, speech_pad_ms=400),
    # Hallucination guards: treat a window as silence when Whisper is unsure
    # there's speech, and retry at higher temperature on low-confidence or
    # repetitive (highly compressible) output.
    no_speech_threshold=0.6,
    log_prob_threshold=-1.0,
    compression_ratio_threshold=2.4,
)


def transcribe_track(model, audio_path, speaker, language="en"):
    segments, info = model.transcribe(str(audio_path), language=language, **TRANSCRIBE_OPTIONS)
    lines = []
    for seg in segments:
        text = seg.text.strip()
        if text:
            lines.append(Line(seg.start, seg.end, speaker, text))
        print(f"\r  {speaker}: {fmt(min(seg.end, info.duration))} / {fmt(info.duration)}", end="", file=sys.stderr)
    print(f"\r  {speaker}: done, {len(lines)} segments" + " " * 20, file=sys.stderr)
    return lines


def fmt(seconds):
    s = int(seconds)
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"
