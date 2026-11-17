using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Qoder.SubscriptionProxy
{
    public static class ProxyJob
    {
        private const uint JobObjectLimitKillOnJobClose = 0x2000;
        private const int JobObjectExtendedLimitInformation = 9;
        private const uint CreateSuspended = 0x00000004;
        private const uint CreateNoWindow = 0x08000000;
        private const uint ExtendedStartupInfoPresent = 0x00080000;
        private const uint StartfUseStdHandles = 0x00000100;
        private const uint Synchronize = 0x00100000;
        private const uint Infinite = 0xffffffff;
        private const uint WaitObject0 = 0;
        private const uint WaitTimeout = 258;
        private const uint WaitFailed = 0xffffffff;
        private const int ProcThreadAttributeHandleList = 0x00020002;
        private const int ProcThreadAttributeJobList = 0x0002000d;
        private static readonly IntPtr InvalidHandle = new IntPtr(-1);

        /// <summary>启动固定管理端口的 Magpie；配置路径只用于校验，不传入核心命令行。</summary>
        public static int Run(string ownerPidText, string binPath, string configPath,
            string workingDirectory, string logPath, int managementPort)
        {
            return RunSafely(ownerPidText, binPath, configPath, workingDirectory, logPath, false, managementPort);
        }

        // A host handle also closes the job when inherited stdio remains open elsewhere.
        public static int RunMcp(string ownerPidText, string runtimePath, string scriptPath)
        {
            return RunSafely(ownerPidText, runtimePath, scriptPath, null, null, true, 0);
        }

        /// <summary>Execute the selected child mode and expose only safe native failure codes.</summary>
        private static int RunSafely(string ownerPidText, string binPath, string configPath,
            string workingDirectory, string logPath, bool mcp, int managementPort)
        {
            try
            {
                return RunCore(ownerPidText, binPath, configPath, workingDirectory, logPath, mcp, managementPort);
            }
            catch (NativeFailure error)
            {
                WriteError((mcp ? "MCP runtime failed. Win32=" : "Proxy supervisor failed. Win32=") +
                    error.Code.ToString(CultureInfo.InvariantCulture));
                return 1;
            }
            catch
            {
                WriteError(mcp ? "MCP runtime failed." : "Proxy supervisor failed.");
                return 1;
            }
        }

        /// <summary>Validate inputs, create the private Job and retain owner/child handles until cleanup.</summary>
        private static int RunCore(string ownerPidText, string binPath, string configPath,
            string workingDirectory, string logPath, bool mcp, int managementPort)
        {
            // MCP 包装器不使用管理端口；核心模式拒绝缺失或越界端口。
            if (!mcp && (managementPort < 1 || managementPort > 65535))
                throw new InvalidOperationException();
            uint ownerPid = 0;
            bool hasOwner = !mcp || !String.IsNullOrEmpty(ownerPidText);
            if (IntPtr.Size != 8 || (hasOwner && (!UInt32.TryParse(ownerPidText, NumberStyles.None,
                CultureInfo.InvariantCulture, out ownerPid) || ownerPid == 0)))
                throw new InvalidOperationException();

            binPath = AbsolutePath(binPath);
            configPath = AbsolutePath(configPath);
            workingDirectory = AbsolutePath(mcp ? Environment.CurrentDirectory : workingDirectory);
            if (!File.Exists(binPath) || !File.Exists(configPath) ||
                !Directory.Exists(workingDirectory))
                throw new InvalidOperationException();
            if (!String.IsNullOrEmpty(logPath))
            {
                logPath = AbsolutePath(logPath);
                if (String.Equals(logPath, binPath, StringComparison.OrdinalIgnoreCase) ||
                    String.Equals(logPath, configPath, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException();
            }

            IntPtr owner = IntPtr.Zero;
            IntPtr job = IntPtr.Zero;
            IntPtr input = IntPtr.Zero;
            IntPtr output = IntPtr.Zero;
            IntPtr errorOutput = IntPtr.Zero;
            IntPtr attributes = IntPtr.Zero;
            IntPtr inheritedHandles = IntPtr.Zero;
            IntPtr jobHandles = IntPtr.Zero;
            bool attributesInitialized = false;
            CoreLog log = null;
            ProcessInformation child = new ProcessInformation();
            try
            {
                // Retain the process object so PID reuse cannot change the owner being watched.
                if (hasOwner)
                {
                    owner = OpenProcess(Synchronize, false, ownerPid);
                    CheckHandle(owner);
                    RequireRunning(owner);
                }

                // The unnamed job handle is private to the supervisor. Its last close
                // kills the entire child tree even when PowerShell cannot run finally.
                job = CreateJobObjectW(IntPtr.Zero, null);
                CheckHandle(job);
                JobExtendedLimitInformation limits = new JobExtendedLimitInformation();
                limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
                Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                    ref limits, (uint)Marshal.SizeOf(typeof(JobExtendedLimitInformation))));

                if (mcp)
                {
                    // Duplicate only the three native streams. The wrapper must never
                    // change inherit flags or close the host's original handles.
                    input = DuplicateStandardHandle(-10);
                    output = DuplicateStandardHandle(-11);
                    errorOutput = DuplicateStandardHandle(-12);
                }
                else
                {
                    SecurityAttributes security = new SecurityAttributes();
                    security.Length = Marshal.SizeOf(typeof(SecurityAttributes));
                    security.InheritHandle = true;
                    input = CreateFileW("NUL", 0x80000000, 7, ref security, 3, 0x80, IntPtr.Zero);
                    CheckHandle(input);
                    // 原始输出只能进入管道，日志文件仅由脱敏 worker 持有。
                    if (!String.IsNullOrEmpty(logPath))
                    {
                        IntPtr readPipe;
                        Check(CreatePipe(out readPipe, out output, ref security, 0));
                        try
                        {
                            Check(SetHandleInformation(readPipe, 1, 0));
                            log = new CoreLog(readPipe, logPath);
                            readPipe = IntPtr.Zero;
                            log.Start();
                        }
                        finally { Close(ref readPipe); }
                    }
                    else
                    {
                        output = CreateFileW("NUL", 0x40000000, 7, ref security, 3, 0x80, IntPtr.Zero);
                        CheckHandle(output);
                    }
                }

                IntPtr attributeBytes = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeBytes);
                if (attributeBytes == IntPtr.Zero)
                    throw new NativeFailure(Marshal.GetLastWin32Error());
                attributes = Marshal.AllocHGlobal(attributeBytes);
                Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref attributeBytes));
                attributesInitialized = true;
                int handleBytes = IntPtr.Size * (mcp ? 3 : 2);
                inheritedHandles = Marshal.AllocHGlobal(handleBytes);
                Marshal.WriteIntPtr(inheritedHandles, 0, input);
                Marshal.WriteIntPtr(inheritedHandles, IntPtr.Size, output);
                if (mcp) Marshal.WriteIntPtr(inheritedHandles, IntPtr.Size * 2, errorOutput);
                Check(UpdateProcThreadAttribute(attributes, 0,
                    new IntPtr(ProcThreadAttributeHandleList), inheritedHandles,
                    new IntPtr(handleBytes), IntPtr.Zero, IntPtr.Zero));

                // Windows 10+ assigns this job inside CreateProcess itself. Without
                // JOB_LIST, killing the supervisor between create and assign can leave
                // an orphaned suspended child. There is deliberately no unsafe fallback.
                jobHandles = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(jobHandles, job);
                Check(UpdateProcThreadAttribute(attributes, 0,
                    new IntPtr(ProcThreadAttributeJobList), jobHandles,
                    new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));

                StartupInfoEx startup = new StartupInfoEx();
                startup.StartupInfo.Size = Marshal.SizeOf(typeof(StartupInfoEx));
                startup.StartupInfo.Flags = StartfUseStdHandles;
                startup.StartupInfo.StdInput = input;
                startup.StartupInfo.StdOutput = output;
                startup.StartupInfo.StdError = mcp ? errorOutput : output;
                startup.AttributeList = attributes;
                // Magpie 原生 serve 参数与 MCP script 参数分开组装，不能回退到旧核心 -config。
                StringBuilder command = new StringBuilder(QuoteArgument(binPath) +
                    (mcp ? " " + QuoteArgument(configPath) : " serve " +
                    QuoteArgument("--web=127.0.0.1:" + managementPort.ToString(CultureInfo.InvariantCulture))));

                if (hasOwner) RequireRunning(owner);
                // Explicit application name avoids executable-path ambiguity; only
                // selected stream handles, never owner or job, may be inherited.
                Check(CreateProcessW(binPath, command, IntPtr.Zero, IntPtr.Zero, true,
                    CreateSuspended | CreateNoWindow | ExtendedStartupInfoPresent,
                    IntPtr.Zero, workingDirectory, ref startup, out child));
                Check(AssignProcessToJobObject(job, child.Process));
                if (hasOwner) RequireRunning(owner);
                if (ResumeThread(child.Thread) == UInt32.MaxValue)
                    throw new NativeFailure(Marshal.GetLastWin32Error());
                Close(ref child.Thread);

                // These setup resources need not remain live during the owner's lifetime.
                DeleteProcThreadAttributeList(attributes);
                attributesInitialized = false;
                Marshal.FreeHGlobal(attributes);
                attributes = IntPtr.Zero;
                Marshal.FreeHGlobal(inheritedHandles);
                inheritedHandles = IntPtr.Zero;
                Marshal.FreeHGlobal(jobHandles);
                jobHandles = IntPtr.Zero;
                Close(ref input);
                Close(ref output);
                Close(ref errorOutput);

                if (mcp)
                {
                    uint runtimeWait = hasOwner
                        ? WaitForMultipleObjects(2, new IntPtr[] { child.Process, owner }, false, Infinite)
                        : WaitForSingleObject(child.Process, Infinite);
                    if (runtimeWait == WaitFailed)
                        throw new NativeFailure(Marshal.GetLastWin32Error());
                    if (hasOwner && runtimeWait == WaitObject0 + 1) return 0;
                    if (runtimeWait != WaitObject0) throw new InvalidOperationException();
                    uint exitCode;
                    Check(GetExitCodeProcess(child.Process, out exitCode));
                    return unchecked((int)exitCode);
                }

                RequireRunning(child.Process);
                RequireRunning(owner);
                Console.Out.WriteLine("{\"pid\":" +
                    child.ProcessId.ToString(CultureInfo.InvariantCulture) + "}");
                Console.Out.Flush();

                uint wait = WaitForMultipleObjects(2, new IntPtr[] { owner, child.Process },
                    false, Infinite);
                if (wait == WaitFailed)
                    throw new NativeFailure(Marshal.GetLastWin32Error());
                if (wait != WaitObject0 && wait != WaitObject0 + 1)
                    throw new InvalidOperationException();
                return 0;
            }
            finally
            {
                // Closing the job kills descendants as well as the direct child. The
                // original process handle also covers any failure during assignment.
                Close(ref job);
                if (child.Process != IntPtr.Zero)
                {
                    if (WaitForSingleObject(child.Process, 0) != WaitObject0)
                    {
                        bool terminated = TerminateProcess(child.Process, 1);
                        int error = terminated ? 0 : Marshal.GetLastWin32Error();
                        // Job termination is asynchronous; ERROR_ACCESS_DENIED can mean
                        // the process is already terminating, not a cleanup failure.
                        if (WaitForSingleObject(child.Process, 5000) != WaitObject0)
                            WriteError("Proxy cleanup wait failed. Win32=" +
                                error.ToString(CultureInfo.InvariantCulture));
                    }
                }
                Close(ref child.Thread);
                Close(ref child.Process);
                Close(ref input);
                Close(ref output);
                Close(ref errorOutput);
                if (log != null) log.Finish();
                if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (inheritedHandles != IntPtr.Zero) Marshal.FreeHGlobal(inheritedHandles);
                if (jobHandles != IntPtr.Zero) Marshal.FreeHGlobal(jobHandles);
                Close(ref owner);
            }
        }

        // 单一读取者通过非阻塞探测收尾，避免后代尚未关闭管道时永久等待。
        private sealed class CoreLog
        {
            private IntPtr pipe;
            private readonly StreamWriter writer;
            private readonly string secret;
            private readonly Thread worker;
            private volatile bool finishing;
            private bool started;

            internal CoreLog(IntPtr readPipe, string path)
            {
                secret = Environment.GetEnvironmentVariable("MAGPIE_WEB_KEY");
                worker = new Thread(Drain);
                worker.IsBackground = true;
                writer = new StreamWriter(new FileStream(path, FileMode.Append, FileAccess.Write,
                    FileShare.ReadWrite | FileShare.Delete), new UTF8Encoding(false));
                pipe = readPipe;
            }

            internal void Start()
            {
                worker.Start();
                started = true;
            }

            internal void Finish()
            {
                finishing = true;
                if (started)
                {
                    if (!worker.Join(5000)) WriteError("Proxy log cleanup timed out.");
                }
                else
                {
                    Close(ref pipe);
                    try { writer.Dispose(); } catch { WriteError("Proxy log close failed."); }
                }
            }

            private void Drain()
            {
                try
                {
                    byte[] bytes = new byte[4096];
                    char[] chars = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length)];
                    Decoder decoder = Encoding.UTF8.GetDecoder();
                    string pending = String.Empty;
                    System.Diagnostics.Stopwatch ending = null;
                    while (true)
                    {
                        if (finishing && ending == null) ending = System.Diagnostics.Stopwatch.StartNew();
                        if (ending != null && ending.ElapsedMilliseconds >= 3000) break;
                        uint available;
                        if (!PeekNamedPipe(pipe, IntPtr.Zero, 0, IntPtr.Zero, out available, IntPtr.Zero))
                        {
                            if (Marshal.GetLastWin32Error() == 109) break;
                            throw new InvalidOperationException();
                        }
                        if (available == 0)
                        {
                            Thread.Sleep(10);
                            continue;
                        }
                        uint count;
                        Check(ReadFile(pipe, bytes, Math.Min((uint)bytes.Length, available), out count, IntPtr.Zero));
                        if (count == 0) break;
                        // Decoder 保留跨字节块的 UTF-8 状态，pending 保留跨字符块的密钥状态。
                        pending += new string(chars, 0, decoder.GetChars(bytes, 0, (int)count, chars, 0, false));
                        pending = WriteSafe(pending, false);
                        writer.Flush();
                    }
                    pending += new string(chars, 0, decoder.GetChars(bytes, 0, 0, chars, 0, true));
                    WriteSafe(pending, true);
                }
                catch { WriteError("Proxy log capture failed."); }
                finally
                {
                    Close(ref pipe);
                    try { writer.Dispose(); } catch { WriteError("Proxy log close failed."); }
                }
            }

            private string WriteSafe(string pending, bool final)
            {
                if (String.IsNullOrEmpty(secret))
                {
                    writer.Write(pending);
                    return String.Empty;
                }
                int boundary = final ? pending.Length : Math.Max(0, pending.Length - secret.Length + 1);
                // Flush 前不能把 UTF-16 代理对拆到下一轮。
                if (boundary > 0 && boundary < pending.Length &&
                    Char.IsHighSurrogate(pending[boundary - 1]) && Char.IsLowSurrogate(pending[boundary]))
                    boundary--;
                int offset = 0;
                int match;
                // 匹配整个 pending；跨安全边界的完整密钥必须整体消费，不能先切块再替换。
                while ((match = pending.IndexOf(secret, offset, StringComparison.Ordinal)) >= 0 && match < boundary)
                {
                    writer.Write(pending.Substring(offset, match - offset));
                    writer.Write("[REDACTED]");
                    offset = match + secret.Length;
                }
                int consumed = Math.Max(boundary, offset);
                writer.Write(pending.Substring(offset, consumed - offset));
                return pending.Substring(consumed);
            }
        }

        private static IntPtr DuplicateStandardHandle(int stream)
        {
            IntPtr original = GetStdHandle(stream);
            CheckHandle(original);
            IntPtr currentProcess = GetCurrentProcess();
            IntPtr duplicate;
            // DUPLICATE_SAME_ACCESS preserves pipe permissions; only the new handle
            // becomes inheritable and is later closed by this supervisor.
            Check(DuplicateHandle(currentProcess, original, currentProcess,
                out duplicate, 0, true, 2));
            return duplicate;
        }

        private static string AbsolutePath(string value)
        {
            if (String.IsNullOrWhiteSpace(value) || value.IndexOf('\0') >= 0 ||
                !Path.IsPathRooted(value))
                throw new InvalidOperationException();
            return Path.GetFullPath(value);
        }

        private static string QuoteArgument(string value)
        {
            // Win32 passes one command-line string; double backslashes before a quote
            // and at the closing quote to preserve literal path characters in argv.
            StringBuilder result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char character in value)
            {
                if (character == '\\') { slashes++; continue; }
                if (character == '"')
                    result.Append('\\', slashes * 2 + 1);
                else
                    result.Append('\\', slashes);
                result.Append(character);
                slashes = 0;
            }
            result.Append('\\', slashes * 2);
            return result.Append('"').ToString();
        }

        private static void RequireRunning(IntPtr process)
        {
            uint wait = WaitForSingleObject(process, 0);
            if (wait == WaitFailed) throw new NativeFailure(Marshal.GetLastWin32Error());
            if (wait != WaitTimeout) throw new InvalidOperationException();
        }

        private static void Check(bool success)
        {
            if (!success) throw new NativeFailure(Marshal.GetLastWin32Error());
        }

        private static void CheckHandle(IntPtr handle)
        {
            if (handle == IntPtr.Zero || handle == InvalidHandle)
                throw new NativeFailure(Marshal.GetLastWin32Error());
        }

        private static void Close(ref IntPtr handle)
        {
            if (handle != IntPtr.Zero && handle != InvalidHandle)
                CloseHandle(handle);
            handle = IntPtr.Zero;
        }

        private static void WriteError(string message)
        {
            // A closed stderr must not interrupt native-handle cleanup.
            try { Console.Error.WriteLine(message); } catch { }
        }

        private sealed class NativeFailure : Exception
        {
            internal readonly int Code;
            internal NativeFailure(int code) { Code = code; }
        }

        // Native field order and pointer-sized types must match the Windows x64 ABI.
        [StructLayout(LayoutKind.Sequential)]
        private struct SecurityAttributes
        {
            internal int Length;
            internal IntPtr SecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)] internal bool InheritHandle;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobBasicLimitInformation
        {
            internal long PerProcessUserTimeLimit;
            internal long PerJobUserTimeLimit;
            internal uint LimitFlags;
            internal UIntPtr MinimumWorkingSetSize;
            internal UIntPtr MaximumWorkingSetSize;
            internal uint ActiveProcessLimit;
            internal UIntPtr Affinity;
            internal uint PriorityClass;
            internal uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            internal ulong ReadOperationCount;
            internal ulong WriteOperationCount;
            internal ulong OtherOperationCount;
            internal ulong ReadTransferCount;
            internal ulong WriteTransferCount;
            internal ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobExtendedLimitInformation
        {
            internal JobBasicLimitInformation BasicLimitInformation;
            internal IoCounters IoInfo;
            internal UIntPtr ProcessMemoryLimit;
            internal UIntPtr JobMemoryLimit;
            internal UIntPtr PeakProcessMemoryUsed;
            internal UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct StartupInfo
        {
            internal int Size;
            internal IntPtr Reserved;
            internal IntPtr Desktop;
            internal IntPtr Title;
            internal uint X;
            internal uint Y;
            internal uint XSize;
            internal uint YSize;
            internal uint XCountChars;
            internal uint YCountChars;
            internal uint FillAttribute;
            internal uint Flags;
            internal ushort ShowWindow;
            internal ushort Reserved2Length;
            internal IntPtr Reserved2;
            internal IntPtr StdInput;
            internal IntPtr StdOutput;
            internal IntPtr StdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct StartupInfoEx
        {
            internal StartupInfo StartupInfo;
            internal IntPtr AttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInformation
        {
            internal IntPtr Process;
            internal IntPtr Thread;
            internal uint ProcessId;
            internal uint ThreadId;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe,
            ref SecurityAttributes security, uint size);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool PeekNamedPipe(IntPtr pipe, IntPtr buffer, uint size,
            IntPtr bytesRead, out uint available, IntPtr bytesLeft);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ReadFile(IntPtr handle, byte[] buffer, uint count,
            out uint bytesRead, IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int stream);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle,
            IntPtr targetProcess, out IntPtr targetHandle, uint desiredAccess,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, uint options);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint desiredAccess,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, uint processId);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObjectW(IntPtr security, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(IntPtr job, int informationClass,
            ref JobExtendedLimitInformation information, uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFileW(string name, uint desiredAccess, uint shareMode,
            ref SecurityAttributes security, uint creationDisposition, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool InitializeProcThreadAttributeList(IntPtr list,
            int attributeCount, int flags, ref IntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags,
            IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);

        [DllImport("kernel32.dll")]
        private static extern void DeleteProcThreadAttributeList(IntPtr list);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcessW(string applicationName, StringBuilder commandLine,
            IntPtr processAttributes, IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint flags,
            IntPtr environment, string currentDirectory, ref StartupInfoEx startup,
            out ProcessInformation processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForMultipleObjects(uint count, [In] IntPtr[] handles,
            [MarshalAs(UnmanagedType.Bool)] bool waitAll, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);
    }
}
