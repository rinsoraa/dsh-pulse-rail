import math, wave, struct, sys
out = sys.argv[1]; freq = float(sys.argv[2]) if len(sys.argv) > 2 else 440.0
sr = 48000; dur = 6
w = wave.open(out, "wb"); w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr)
fr = []
for i in range(sr * dur):
    s = int(12000 * math.sin(2 * math.pi * freq * i / sr))
    fr.append(struct.pack("<hh", s, s))
w.writeframes(b"".join(fr)); w.close(); print("wav ok", out, freq)
