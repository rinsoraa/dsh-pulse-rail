import math, wave, struct, sys, random
out = sys.argv[1]
sr = 48000; dur = 8
mix = [(60, 0.30), (150, 0.22), (400, 0.24), (900, 0.20), (1800, 0.18), (3500, 0.16), (7000, 0.14), (11000, 0.12)]
w = wave.open(out, "wb"); w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr)
buf = []
for i in range(sr * dur):
    t = i / sr
    # 4Hz 幅度调制，模拟节拍
    env = 0.55 + 0.45 * abs(math.sin(2 * math.pi * 2 * t))
    s = 0.0
    for (f, a) in mix:
        s += a * math.sin(2 * math.pi * f * t + f)
    s += 0.05 * (random.random() * 2 - 1)
    v = int(max(-1.0, min(1.0, s * env * 0.55)) * 30000)
    buf.append(struct.pack("<hh", v, v))
w.writeframes(b"".join(buf)); w.close(); print("music wav ok")
