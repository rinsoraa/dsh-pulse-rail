// pulse-tap.cs — dsh-pulse-rail 的音频采集子进程。
// 用 WASAPI loopback 抓默认渲染设备的系统混音（无需管理员/驱动），1024 点 FFT 得到
// N 个对数频段，每帧向 stdout 打印一行 JSON；stdin 读到 EOF（宿主退出）即自行结束。
using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class PulseTap
{
    const int AUDCLNT_SHAREMODE_SHARED = 0;
    const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    const int eRender = 0;
    const int eConsole = 0;
    const int CLSCTX_ALL = 23;
    static int FFT_N = 1024;
    static int BANDS = 12;
    const double F_LO = 45.0;
    const double F_HI = 15000.0;
    const double DB_LO = -74.0;
    const double DB_HI = -8.0;

    static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumerator { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        int OpenPropertyStore(int stgmAccess, out IntPtr props);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        int Initialize(int shareMode, int streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr format, IntPtr audioSessionGuid);
        int GetBufferSize(out uint frames);
        int GetStreamLatency(out long lat);
        int GetCurrentPadding(out uint pad);
        int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
        int GetMixFormat(out IntPtr deviceFormat);
        int GetDevicePeriod(out long def, out long min);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr handle);
        int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr data, out uint frames, out int flags, out ulong devPos, out ulong qpcPos);
        int ReleaseBuffer(uint frames);
        int GetNextPacketSize(out uint frames);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    struct WAVEFORMATEX
    {
        public ushort wFormatTag; public ushort nChannels; public uint nSamplesPerSec;
        public uint nAvgBytesPerSec; public ushort nBlockAlign; public ushort wBitsPerSample; public ushort cbSize;
    }

    static int _rate = 48000;
    static int _channels = 2;
    static float[] _ring;
    static int _ringPos = 0;
    static double[] _hann;
    static double[] _bandLo, _bandHi;
    static double[] _env;
    static double[] _mag;
    static Fft _fft;
    static double _envRms = 0, _peakHold = 0;
    static long _silentFrames = 0;
    static long _lastInputMs = 0;
    static long _silentReinits = 0;
    static System.IO.StreamWriter _out;
    static volatile bool _stop = false;

    static void Main(string[] args)
    {
        int fps = 30;
        double attack = 0.6, release = 0.15;
        bool watchStdin = false;
        int stdinTimeoutMs = 0;
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (a == "--fps") fps = int.Parse(args[++i], CultureInfo.InvariantCulture);
            else if (a == "--attack") attack = double.Parse(args[++i], CultureInfo.InvariantCulture);
            else if (a == "--release") release = double.Parse(args[++i], CultureInfo.InvariantCulture);
            else if (a == "--bands") BANDS = int.Parse(args[++i], CultureInfo.InvariantCulture);
            else if (a == "--fft") FFT_N = int.Parse(args[++i], CultureInfo.InvariantCulture);
            else if (a == "--stdin-timeout") stdinTimeoutMs = int.Parse(args[++i], CultureInfo.InvariantCulture);
            else if (a == "--watch-stdin") watchStdin = true;
        }
        if (fps < 5) fps = 5; if (fps > 120) fps = 120;
        if (BANDS < 4) BANDS = 4; if (BANDS > 32) BANDS = 32;
        if (FFT_N < 256) FFT_N = 256; if (FFT_N > 4096) FFT_N = 4096;

        _out = new System.IO.StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false), 4096);
        _out.AutoFlush = false;
        _ring = new float[FFT_N];
        _hann = new double[FFT_N];
        _bandLo = new double[BANDS]; _bandHi = new double[BANDS];
        _env = new double[BANDS]; _mag = new double[FFT_N / 2];
        for (int i = 0; i < FFT_N; i++) _hann[i] = 0.5 - 0.5 * Math.Cos(2 * Math.PI * i / (FFT_N - 1));
        _fft = new Fft(FFT_N);

        if (watchStdin)
        {
            _lastInputMs = DateTime.UtcNow.Ticks / 10000L;
            Thread t = new Thread(delegate()
            {
                try { while (Console.In.Read() >= 0) { _lastInputMs = DateTime.UtcNow.Ticks / 10000L; } }
                catch { }
                _stop = true;
            });
            t.IsBackground = true; t.Start();
        }

        int frameMs = Math.Max(5, 1000 / fps);
        while (!_stop)
        {
            IAudioClient ac = null; IAudioCaptureClient cap = null; object acObj = null, capObj = null;
            try
            {
                IMMDeviceEnumerator en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
                IMMDevice dev;
                Hr(en.GetDefaultAudioEndpoint(eRender, eConsole, out dev), "GetDefaultAudioEndpoint");
                string devId; dev.GetId(out devId);
                Guid iid = IID_IAudioClient;
                Hr(dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out acObj), "Activate");
                ac = (IAudioClient)acObj;
                IntPtr fmtPtr;
                Hr(ac.GetMixFormat(out fmtPtr), "GetMixFormat");
                WAVEFORMATEX fmt = (WAVEFORMATEX)Marshal.PtrToStructure(fmtPtr, typeof(WAVEFORMATEX));
                _rate = (int)fmt.nSamplesPerSec;
                _channels = Math.Max(1, (int)fmt.nChannels);
                bool isFloat = fmt.wBitsPerSample == 32;
                BuildBands();
                Hr(ac.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 10000000, 0, fmtPtr, IntPtr.Zero), "Initialize(loopback)");
                Guid iidCap = IID_IAudioCaptureClient;
                Hr(ac.GetService(ref iidCap, out capObj), "GetService(CaptureClient)");
                cap = (IAudioCaptureClient)capObj;
                Hr(ac.Start(), "Start");
                EmitHello(devId, fmt.wBitsPerSample);

                while (!_stop)
                {
                    Thread.Sleep(frameMs);
                    uint packet;
                    Hr(cap.GetNextPacketSize(out packet), "GetNextPacketSize");
                    double peak = 0; long frames = 0;
                    while (packet > 0)
                    {
                        IntPtr data; uint n; int flags; ulong a, b;
                        Hr(cap.GetBuffer(out data, out n, out flags, out a, out b), "GetBuffer");
                        if ((flags & 0x2) == 0 && n > 0)
                        {
                            int total = (int)n * _channels;
                            if (isFloat)
                            {
                                float[] tmp = new float[total];
                                Marshal.Copy(data, tmp, 0, total);
                                Push(tmp, (int)n, ref peak);
                            }
                            else
                            {
                                short[] tmp = new short[total];
                                Marshal.Copy(data, tmp, 0, total);
                                float[] f = new float[total];
                                for (int k = 0; k < total; k++) f[k] = (float)(tmp[k] / 32768.0);
                                Push(f, (int)n, ref peak);
                            }
                            frames += n;
                        }
                        cap.ReleaseBuffer(n);
                        Hr(cap.GetNextPacketSize(out packet), "GetNextPacketSize");
                    }
                    Analyze(attack, release);
                    if (peak > _peakHold) _peakHold = peak; else _peakHold *= 0.88;
                    EmitFrame(_envRms, _peakHold, frames);
                    // 父进程若被强杀，stdin 写端可能被别的进程继承而迟迟不 EOF —— 心跳超时兜底自杀，防孤儿进程
                    if (stdinTimeoutMs > 0 && (DateTime.UtcNow.Ticks / 10000L - _lastInputMs) > stdinTimeoutMs) Environment.Exit(0);
                    // 端点保护：USB/蓝牙渲染端点会「假装在放、实际全 0」，持续静音到阈值就重建采集客户端。
                    if (peak > 1e-4) { _silentFrames = 0; _silentReinits = 0; }
                    else if (peak < 1e-5 && _envRms < 1e-5) _silentFrames++;
                    else _silentFrames = 0;
                    long limit = 5000L << (int)Math.Min(4, _silentReinits);   // 5s → 10s → 20s → 40s → 80s
                    if (_silentFrames * frameMs > limit) { _silentFrames = 0; _silentReinits++; throw new Exception("silent-reinit#" + _silentReinits); }
                }
            }
            catch (Exception ex)
            {
                EmitRaw("{\"type\":\"error\",\"message\":\"" + Json(ex.Message) + "\"}");
                Thread.Sleep(1000);
            }
            finally
            {
                try { if (ac != null) ac.Stop(); } catch { }
                try { if (cap != null) Marshal.ReleaseComObject(cap); } catch { }
                try { if (ac != null) Marshal.ReleaseComObject(ac); } catch { }
            }
        }
        try { _out.Flush(); } catch { }
    }

    static void Hr(int hr, string what)
    {
        if (hr != 0) throw new Exception(what + " hr=0x" + hr.ToString("X8"));
    }

    static void Push(float[] interleaved, int frames, ref double peak)
    {
        int ch = _channels;
        for (int i = 0; i < frames; i++)
        {
            float v;
            if (ch >= 2) v = (interleaved[i * ch] + interleaved[i * ch + 1]) * 0.5f;
            else v = interleaved[i * ch];
            _ring[_ringPos] = v;
            _ringPos++; if (_ringPos >= FFT_N) _ringPos = 0;
            double av = Math.Abs((double)v);
            if (av > peak) peak = av;
        }
    }

    static void Analyze(double attack, double release)
    {
        float[] buf = new float[FFT_N];
        double sum = 0;
        for (int i = 0; i < FFT_N; i++)
        {
            int idx = _ringPos + i; if (idx >= FFT_N) idx -= FFT_N;
            double s = _ring[idx];
            buf[i] = (float)(s * _hann[i]);
            sum += s * s;
        }
        _fft.Forward(buf, _mag);
        _envRms = _envRms * 0.7 + Math.Sqrt(sum / FFT_N) * 0.3;
        for (int b = 0; b < BANDS; b++)
        {
            int lo = (int)Math.Floor(_bandLo[b] * FFT_N / _rate);
            int hi = (int)Math.Ceiling(_bandHi[b] * FFT_N / _rate);
            if (lo < 1) lo = 1;
            if (hi > FFT_N / 2 - 1) hi = FFT_N / 2 - 1;
            if (hi < lo) hi = lo;
            double energy = 0; int cnt = 0;
            for (int i = lo; i <= hi; i++) { energy += _mag[i] * _mag[i]; cnt++; }
            if (cnt == 0) cnt = 1;
            double amp = Math.Sqrt(energy / cnt) / (FFT_N / 4.0);
            double db = 20 * Math.Log10(amp + 1e-9);
            double v = (db - DB_LO) / (DB_HI - DB_LO);
            if (v < 0) v = 0; else if (v > 1) v = 1;
            double prev = _env[b];
            _env[b] = v > prev ? prev + (v - prev) * attack : prev + (v - prev) * release;
        }
    }

    static void BuildBands()
    {
        double ratio = Math.Pow(F_HI / F_LO, 1.0 / BANDS);
        for (int b = 0; b < BANDS; b++)
        {
            _bandLo[b] = F_LO * Math.Pow(ratio, b);
            _bandHi[b] = F_LO * Math.Pow(ratio, b + 1);
        }
    }

    static string F(double v) { return v.ToString("0.0000", CultureInfo.InvariantCulture); }
    static string Json(string s) { return s.Replace("\\", "/").Replace("\"", "'").Replace("\r", " ").Replace("\n", " "); }

    static void EmitRaw(string line)
    {
        try { _out.Write(line); _out.Write('\n'); _out.Flush(); }
        catch { _stop = true; Environment.Exit(0); }
    }

    static void EmitHello(string devId, int bits)
    {
        EmitRaw("{\"type\":\"hello\",\"rate\":" + _rate + ",\"ch\":" + _channels + ",\"bits\":" + bits +
                ",\"bands\":" + BANDS + ",\"fft\":" + FFT_N + ",\"device\":\"" + Json(devId) + "\",\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id + "}");
    }

    static void EmitFrame(double rms, double peak, long frames)
    {
        StringBuilder sb = new StringBuilder(256);
        sb.Append("{\"t\":").Append(DateTime.UtcNow.Ticks / 10000L).Append(",\"rms\":").Append(F(rms))
          .Append(",\"peak\":").Append(F(peak)).Append(",\"n\":").Append(frames).Append(",\"b\":[");
        for (int i = 0; i < BANDS; i++) { if (i > 0) sb.Append(','); sb.Append(F(_env[i])); }
        sb.Append("]}");
        EmitRaw(sb.ToString());
    }
}

class Fft
{
    int n; float[] re, im; int[] rev;
    public Fft(int size)
    {
        n = size; re = new float[n]; im = new float[n]; rev = new int[n];
        int bits = 0; while ((1 << bits) < n) bits++;
        for (int i = 0; i < n; i++)
        {
            int r = 0;
            for (int b = 0; b < bits; b++) if ((i & (1 << b)) != 0) r |= 1 << (bits - 1 - b);
            rev[i] = r;
        }
    }
    public void Forward(float[] input, double[] magOut)
    {
        for (int i = 0; i < n; i++) { re[i] = input[rev[i]]; im[i] = 0; }
        for (int len = 2; len <= n; len <<= 1)
        {
            double ang = -2 * Math.PI / len;
            float wr = (float)Math.Cos(ang), wi = (float)Math.Sin(ang);
            for (int i = 0; i < n; i += len)
            {
                float cwr = 1, cwi = 0;
                for (int k = 0; k < len / 2; k++)
                {
                    int a = i + k, b = i + k + len / 2;
                    float tr = re[b] * cwr - im[b] * cwi;
                    float ti = re[b] * cwi + im[b] * cwr;
                    re[b] = re[a] - tr; im[b] = im[a] - ti;
                    re[a] += tr; im[a] += ti;
                    float nwr = cwr * wr - cwi * wi; cwi = cwr * wi + cwi * wr; cwr = nwr;
                }
            }
        }
        for (int i = 0; i < n / 2; i++) magOut[i] = Math.Sqrt(re[i] * (double)re[i] + im[i] * (double)im[i]);
    }
}
