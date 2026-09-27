"""Transcribe a bot recording folder or an OBS video file.

Usage: python -m pipeline <recording folder | file.mkv/.mp4> [--language en] [--out transcripts]
"""
import argparse
import json
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

from .merge import merge, render
from .model import REPO_ROOT, load_model
from .stitch import stitch
from .transcribe import transcribe_track


def main():
    parser = argparse.ArgumentParser(prog="python -m pipeline", description=__doc__.splitlines()[0])
    parser.add_argument("input", type=Path, help="bot recording folder, or an OBS .mkv/.mp4 file")
    parser.add_argument("--language", default="en", help="spoken language code (default: en)")
    parser.add_argument("--out", type=Path, default=REPO_ROOT / "transcripts", help="output folder")
    parser.add_argument("--audio-track", type=int, default=0, help="OBS files: which audio track to use (default: 0)")
    args = parser.parse_args()

    if args.input.is_dir():
        title, details, lines = transcribe_session(args.input, args.language)
        out_name = args.input.resolve().name
    elif args.input.is_file():
        title, details, lines = transcribe_file(args.input, args.language, args.audio_track)
        out_name = args.input.stem
    else:
        sys.exit(f"Not found: {args.input}")

    args.out.mkdir(parents=True, exist_ok=True)
    out_path = args.out / f"{out_name}.md"
    out_path.write_text(render(title, details, merge(lines)), encoding="utf-8")
    print(f"Wrote {out_path}")


def transcribe_session(folder, language):
    print(f"Stitching speaker tracks in {folder}", file=sys.stderr)
    tracks = stitch(folder)
    if not tracks:
        sys.exit(f"No audio clips in {folder}")

    session = json.loads((folder / "session.json").read_text(encoding="utf-8"))
    started = parse_time(session["startedAt"])
    ended = parse_time(session["endedAt"]) if session.get("endedAt") else None
    guild = session.get("guild", {}).get("name", "?")
    channel = session.get("channel", {}).get("name", "?")

    print("Loading Whisper large-v3", file=sys.stderr)
    model = load_model()
    lines = []
    for _, name, wav in tracks:
        lines += transcribe_track(model, wav, name, language)

    details = [
        f"Date: {started:%Y-%m-%d %H:%M}" + (f" to {ended:%H:%M}" if ended else " (recording did not stop cleanly)"),
        f"Where: #{channel} in {guild}",
        f"Speakers: {', '.join(name for _, name, _ in tracks)}",
        "Timestamps are from the start of the recording.",
    ]
    return f"Discord call transcript, {started:%Y-%m-%d}", details, lines


def transcribe_file(path, language, audio_track):
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "audio.wav"
        print(f"Extracting audio from {path.name}", file=sys.stderr)
        extract_audio(path, wav, audio_track)
        print("Loading Whisper large-v3", file=sys.stderr)
        model = load_model()
        lines = transcribe_track(model, wav, "Speaker", language)

    details = [
        f"Source: {path.name}",
        "Mixed audio, so speakers are not separated.",
        "Timestamps are from the start of the file.",
    ]
    return f"Call transcript, {path.stem}", details, lines


def extract_audio(src, dst, audio_track=0):
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
           "-i", str(src), "-map", f"0:a:{audio_track}", "-vn", "-ac", "1", "-ar", "16000",
           "-c:a", "pcm_s16le", str(dst)]
    try:
        subprocess.run(cmd, check=True)
    except FileNotFoundError:
        sys.exit("ffmpeg not found on PATH")
    except subprocess.CalledProcessError:
        sys.exit(f"ffmpeg could not extract audio track {audio_track} from {src}")


def parse_time(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone()


if __name__ == "__main__":
    main()
