using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Test-only primitive. Caller must independently verify payload, VM, root identity and receipt.
// The native scale entry and its supervisor remain unconditionally disabled.
public static class SyntheticJobContainment
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo { public int cb; public string reserved, desktop, title; public int x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reserved2; public IntPtr reservedPtr, stdIn, stdOut, stdErr; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { public IntPtr process, thread; public uint processId, threadId; }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits { public long perProcess, perJob; public uint flags; public UIntPtr minWorkingSet,maxWorkingSet; public uint activeProcessLimit; public UIntPtr affinity; public uint priorityClass,schedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits { public BasicLimits basic; public IoCounters io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
    [StructLayout(LayoutKind.Sequential)] private struct Accounting { public long totalUser,totalKernel,thisUser,thisKernel; public uint totalFaults,totalProcesses,activeProcesses,terminatedProcesses; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits value, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting value, uint size, out uint returned);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo info);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);
    private static Exception Error(string action) => new Win32Exception(Marshal.GetLastWin32Error(), action);
    public sealed class Result { public bool TimedOut; public uint ExitCode; public uint ProcessId; public uint ActiveAfterDrain; }
    public static Result Run(string executable, string arguments, int deadlineMs, int drainMs)
    {
        if (String.IsNullOrWhiteSpace(executable) || !System.IO.Path.IsPathFullyQualified(executable) || arguments == null || deadlineMs < 1 || deadlineMs > 600000 || drainMs < 1 || drainMs > 30000) throw new ArgumentException("Invalid bounded process request.");
        IntPtr job=IntPtr.Zero; ProcessInfo pi=default(ProcessInfo); bool assigned=false, zero=false;
        try {
            job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw Error("CreateJobObject");
            var limits=new ExtendedLimits(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE
            if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits)))) throw Error("SetInformationJobObject");
            var si=new StartupInfo(); si.cb=Marshal.SizeOf(typeof(StartupInfo));
            var cmd=new StringBuilder("\""+executable+"\" "+arguments);
            if(!CreateProcess(executable,cmd,IntPtr.Zero,IntPtr.Zero,false,0x00000004 | 0x08000000,IntPtr.Zero,System.IO.Path.GetDirectoryName(executable),ref si,out pi)) throw Error("CreateProcess suspended");
            if(!AssignProcessToJobObject(job,pi.process)) throw Error("AssignProcessToJobObject"); assigned=true;
            if(ResumeThread(pi.thread)==UInt32.MaxValue) throw Error("ResumeThread");
            var wait=WaitForSingleObject(pi.process,(uint)deadlineMs);
            if(wait!=0 && wait!=0x102) throw Error("WaitForSingleObject");
            bool timedOut=wait==0x102;
            if(timedOut && !TerminateJobObject(job, 89)) throw Error("TerminateJobObject");
            if(WaitForSingleObject(pi.process,(uint)drainMs)!=0) throw new TimeoutException("Owned parent did not exit; reconcile fixture.");
            uint exitCode; if(!GetExitCodeProcess(pi.process,out exitCode)) throw Error("GetExitCodeProcess");
            var sw=Stopwatch.StartNew(); Accounting accounting;
            do {
                uint returned; if(!QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(Accounting)),out returned)) throw Error("QueryInformationJobObject");
                if(accounting.activeProcesses==0) { zero=true; break; }
                if(sw.ElapsedMilliseconds>=drainMs) break;
                Thread.Sleep(20);
            } while(true);
            if(!zero) throw new TimeoutException("Owned job did not drain; reconcile fixture.");
            return new Result { TimedOut=timedOut, ExitCode=exitCode, ProcessId=pi.processId, ActiveAfterDrain=accounting.activeProcesses };
        } finally {
            if(job!=IntPtr.Zero && assigned && !zero) TerminateJobObject(job,90);
            if(pi.process!=IntPtr.Zero && !assigned) TerminateProcess(pi.process,90);
            if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread);
            if(pi.process!=IntPtr.Zero) CloseHandle(pi.process);
            if(job!=IntPtr.Zero) CloseHandle(job);
        }
    }
}
