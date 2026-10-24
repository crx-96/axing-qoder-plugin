using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

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

        public static int Run(string ownerPidText, string binPath, string configPath,
            string workingDirectory, string logPath)
        {
            return RunSafely(ownerPidText, binPath, configPath, workingDirectory, logPath, false);
        }

        // A host handle also closes the job when inherited stdio remains open elsewhere.
        public static int RunMcp(string ownerPidText, string runtimePath, string scriptPath)
        {
            return RunSafely(ownerPidText, runtimePath, scriptPath, null, null, true);
        }

        private static int RunSafely(string ownerPidText, string binPath, string configPath,
            string workingDirectory, string logPath, bool mcp)
        {
            try
            {
                return RunCore(ownerPidText, binPath, configPath, workingDirectory, logPath, mcp);
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

        private static int RunCore(string ownerPidText, string binPath, string configPath,
            string workingDirectory, string logPath, bool mcp)
        {
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
                    // FILE_APPEND_DATA prevents truncation and makes every log write append.
                    // Missing LogPath redirects to NUL, never to the supervisor's stdout.
                    bool hasLog = !String.IsNullOrEmpty(logPath);
                    output = CreateFileW(hasLog ? logPath : "NUL", hasLog ? 4u : 0x40000000u,
                        7, ref security, hasLog ? 4u : 3u, 0x80, IntPtr.Zero);
                    CheckHandle(output);
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
                StringBuilder command = new StringBuilder(QuoteArgument(binPath) +
                    (mcp ? " " : " -config ") + QuoteArgument(configPath));

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
                if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (inheritedHandles != IntPtr.Zero) Marshal.FreeHGlobal(inheritedHandles);
                if (jobHandles != IntPtr.Zero) Marshal.FreeHGlobal(jobHandles);
                Close(ref owner);
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
