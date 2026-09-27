"""Combine every speaker's lines into one chronological transcript."""
from .transcribe import Line, fmt

# Consecutive lines from the same speaker are joined into one turn unless they
# are further apart than this, so long monologues still get fresh timestamps.
MAX_TURN_GAP_S = 30.0


def merge(lines):
    turns = []
    for line in sorted(lines, key=lambda l: l.start):
        prev = turns[-1] if turns else None
        if prev and prev.speaker == line.speaker and line.start - prev.end <= MAX_TURN_GAP_S:
            prev.text += " " + line.text
            prev.end = max(prev.end, line.end)
        else:
            turns.append(Line(line.start, line.end, line.speaker, line.text))
    return turns


def render(title, details, turns):
    out = [f"# {title}", ""]
    out += [f"- {d}" for d in details]
    out += ["", "---", ""]
    out += [f"[{fmt(t.start)}] {t.speaker}: {t.text}" for t in turns]
    return "\n".join(out) + "\n"
