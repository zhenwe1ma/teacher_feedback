#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
PYDEPS = ROOT / ".pydeps"
if str(PYDEPS) not in sys.path:
    sys.path.insert(0, str(PYDEPS))

from faster_whisper import WhisperModel  # type: ignore


def main() -> int:
    if len(sys.argv) < 2:
        raise SystemExit("usage: transcribe_local.py <audio_path> [model_size] [language]")

    audio_path = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("LOCAL_WHISPER_MODEL", "medium")
    language = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("LOCAL_WHISPER_LANGUAGE", "zh")

    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        audio_path,
        language=language,
        vad_filter=True,
        beam_size=5,
        best_of=5,
        temperature=0.0,
    )

    items = []
    text_parts = []
    for segment in segments:
        segment_text = segment.text.strip()
        if not segment_text:
            continue
        items.append(
            {
                "start": round(float(segment.start), 2),
                "end": round(float(segment.end), 2),
                "text": segment_text,
            }
        )
        text_parts.append(segment_text)

    payload = {
        "language": getattr(info, "language", language),
        "language_probability": round(float(getattr(info, "language_probability", 0.0)), 4),
        "duration": round(float(getattr(info, "duration", 0.0)), 2),
        "text": "\n".join(text_parts).strip(),
        "segments": items,
    }
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
