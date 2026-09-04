"""
Generate the five feedback sounds for Crop Season.

Week 2 argues that one event should be carried on several channels at once, so every action in
the plot planner gets a sound as well as a visual change and a buzz.

Synthesised rather than downloaded. They are original work so there is no licence question, they
are a few kilobytes each, and the pitch relationships can be chosen deliberately: rising intervals
read as progress, falling intervals read as a problem.

Standard library only. No numpy, no install.

Run from the app folder:  python tools/make_sounds.py
"""

import math
import os
import struct
import wave

RATE = 44100
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "audio")


def envelope(pos, attack=0.01, release=0.35):
    """Attack and release shaping, both as a fraction of the sound's length."""
    if pos < attack:
        return pos / attack
    if pos > 1.0 - release:
        return (1.0 - pos) / release
    return 1.0


def render(duration, tone, amplitude=0.55, attack=0.01, release=0.35):
    """Build a mono sample list. `tone` receives (time_seconds, position 0..1)."""
    total = int(RATE * duration)
    samples = []

    for i in range(total):
        t = i / RATE
        pos = i / total
        value = tone(t, pos) * envelope(pos, attack, release) * amplitude
        samples.append(max(-1.0, min(1.0, value)))

    return samples


def write_wav(name, samples):
    path = os.path.join(OUT_DIR, name)
    with wave.open(path, "w") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(RATE)
        frames = b"".join(struct.pack("<h", int(s * 32767)) for s in samples)
        f.writeframes(frames)

    print("wrote {} ({:,} bytes)".format(path, os.path.getsize(path)))


def sine(freq, t):
    return math.sin(2.0 * math.pi * freq * t)


def sweep(start_hz, end_hz, t, duration):
    """Linear frequency sweep, phase integrated so it does not click."""
    k = (end_hz - start_hz) / duration
    return math.sin(2.0 * math.pi * (start_hz * t + 0.5 * k * t * t))


# 1. Surface found. Short, high, unobtrusive. This fires often, so it must not become annoying.
def tick():
    return render(
        0.06,
        lambda t, pos: sine(1180, t) * 0.6 + sine(2360, t) * 0.2,
        amplitude=0.34,
        attack=0.02,
        release=0.7,
    )


# 2. Plant placed. Low and soft, like something small being set down on soil.
def place():
    def tone(t, pos):
        body = sine(190, t) * 0.8 + sine(96, t) * 0.4
        knock = sine(430, t) * max(0.0, 1.0 - pos * 6.0) * 0.35
        return body + knock

    return render(0.16, tone, amplitude=0.6, attack=0.005, release=0.75)


# 3. Something wrong. Falling interval, which reads as a problem.
def warn():
    def tone(t, pos):
        return sweep(415, 300, t, 0.28) * 0.75 + sine(150, t) * 0.25

    return render(0.28, tone, amplitude=0.5, attack=0.02, release=0.4)


# 4. Something right. Rising interval, the mirror of the warning.
def ok():
    def tone(t, pos):
        return sweep(600, 880, t, 0.2) * 0.7 + sine(1320, t) * 0.15

    return render(0.2, tone, amplitude=0.42, attack=0.02, release=0.55)


# 5. Growth. A longer swell, so the animation has something to sit inside rather than a blip at
#    the start of it.
def grow():
    def tone(t, pos):
        base = sweep(160, 520, t, 0.9)
        shimmer = sine(780 + 120 * math.sin(2.0 * math.pi * 1.6 * t), t) * 0.22
        return base * 0.7 + shimmer

    return render(0.9, tone, amplitude=0.45, attack=0.18, release=0.45)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    write_wav("tick.wav", tick())
    write_wav("place.wav", place())
    write_wav("warn.wav", warn())
    write_wav("ok.wav", ok())
    write_wav("grow.wav", grow())

    print("\nDone. Five sounds in " + OUT_DIR)


if __name__ == "__main__":
    main()
