"""Transcribe a Telegram voice note with faster-whisper (local CPU, private).

Usage: python3 transcribe.py <audio_path> [model] [language]
Prints the transcribed text to stdout, nothing else.
"""
import sys


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: transcribe.py <audio_path> [model] [language]", file=sys.stderr)
        sys.exit(2)
    audio = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "base"
    language = sys.argv[3] if len(sys.argv) > 3 else None

    from faster_whisper import WhisperModel

    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    # VAD skips silence: much faster on 5-10 min notes, cleaner transcripts.
    segments, _info = model.transcribe(audio, beam_size=5, language=language, vad_filter=True)
    text = "".join(s.text for s in segments).strip()
    print(text)


if __name__ == "__main__":
    main()
