param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][uint32]$Volume,[Parameter(Mandatory=$true)][uint64]$FileId,[Parameter(Mandatory=$true)][string]$Fixture,[Parameter(Mandatory=$true)][string]$Label)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class OwnedBrandNative {
 [StructLayout(LayoutKind.Sequential)] public struct FileInfo { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr sec,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetFileInformationByHandle(SafeFileHandle h,out FileInfo info);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd,IntPtr dc,uint flags);
}
'@
function Get-RootIdentity {
 $h=[OwnedBrandNative]::CreateFileW($Root,0x80,3,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
 try {
  $v=[OwnedBrandNative+FileInfo]::new()
  if($h.IsInvalid -or -not [OwnedBrandNative]::GetFileInformationByHandle($h,[ref]$v) -or ($v.Attributes -band 0x10) -eq 0) { throw 'Root identity unavailable.' }
  $n=([uint64]$v.IndexHigh -shl 32) -bor [uint64]$v.IndexLow
  if($v.Volume -ne $Volume -or $n -ne $FileId -or $n -eq 0) { throw 'Root identity changed.' }
 } finally { $h.Dispose() }
}
function Get-WindowIdentity($window) {
 $h=[IntPtr]$window.HWND; $pidValue=[uint32]0
 if($h -eq [IntPtr]::Zero -or -not [OwnedBrandNative]::IsWindow($h) -or [OwnedBrandNative]::GetWindowThreadProcessId($h,[ref]$pidValue) -eq 0) { throw 'Window identity unavailable.' }
 $proc=Get-Process -Id $pidValue -ErrorAction Stop
 if(-not [string]::Equals($proc.ProcessName,'explorer',[StringComparison]::OrdinalIgnoreCase)) { throw 'Window is not Explorer.' }
 if(-not [string]::Equals([string]$window.Document.Folder.Self.Path,$Root,[StringComparison]::OrdinalIgnoreCase)) { throw 'Explorer path changed.' }
 Get-RootIdentity
 return [pscustomobject]@{Hwnd=$h.ToInt64();Pid=$pidValue;StartTicks=$proc.StartTime.ToUniversalTime().Ticks}
}
function Same-Window($a,$b) { return $a.Hwnd -eq $b.Hwnd -and $a.Pid -eq $b.Pid -and $a.StartTicks -eq $b.StartTicks }

$shell=New-Object -ComObject Shell.Application
$before=[Collections.Generic.HashSet[long]]::new()
foreach($w in @($shell.Windows())) { try { [void]$before.Add([long]$w.HWND) } catch {} }
$owned=$null; $identity=$null; $closed=$false; $failure=$null; $screenshot=Join-Path $Fixture 'observer-window.png'
try {
 Get-RootIdentity
 $shell.Open($Root)
 $until=[DateTime]::UtcNow.AddSeconds(30)
 while([DateTime]::UtcNow -lt $until) {
  $matches=@()
  foreach($w in @($shell.Windows())) { try { if(-not $before.Contains([long]$w.HWND) -and [string]::Equals([string]$w.Document.Folder.Self.Path,$Root,[StringComparison]::OrdinalIgnoreCase)) { $matches+=,$w } } catch {} }
  if($matches.Count -gt 1) { throw 'Multiple candidate Explorer windows.' }
  if($matches.Count -eq 1) { $owned=$matches[0]; $identity=Get-WindowIdentity $owned; break }
  Start-Sleep -Milliseconds 250
 }
 if($null -eq $owned) { throw 'No unique new Explorer window.' }
 # The test-only label includes this run's GUID and is checked against the broker
 # list before registration. Require exactly one matching tree item in this window;
 # visual branding and namespace PIDL identity remain independent checks.
 $windowElement=[Windows.Automation.AutomationElement]::FromHandle([IntPtr]$identity.Hwnd)
 if($null -eq $windowElement) { throw 'Explorer automation is unavailable.' }
 $condition=[Windows.Automation.AndCondition]::new(
  [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::TreeItem),
  [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,$Label))
 $matches=$windowElement.FindAll([Windows.Automation.TreeScope]::Descendants,$condition)
 if($matches.Count -ne 1) { throw 'The unique test label is absent or ambiguous.' }
 # Capture the owned root window; branding and namespace PIDL are not inferred from UIA.
 if(-not (Same-Window $identity (Get-WindowIdentity $owned))) { throw 'Window identity changed before capture.' }
 $rect=[OwnedBrandNative+Rect]::new()
 if(-not [OwnedBrandNative]::GetWindowRect([IntPtr]$identity.Hwnd,[ref]$rect)) { throw 'Window bounds unavailable.' }
 $width=$rect.Right-$rect.Left; $height=$rect.Bottom-$rect.Top
 if($width -lt 100 -or $height -lt 100 -or $width -gt 10000 -or $height -gt 10000) { throw 'Window bounds invalid.' }
 $bitmap=[Drawing.Bitmap]::new($width,$height); $graphics=[Drawing.Graphics]::FromImage($bitmap); $dc=$graphics.GetHdc()
 try { if(-not [OwnedBrandNative]::PrintWindow([IntPtr]$identity.Hwnd,$dc,2)) { throw 'Screenshot capture failed.' } } finally { $graphics.ReleaseHdc($dc); $graphics.Dispose() }
 try { $output=[IO.File]::Open($screenshot,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None); try { $bitmap.Save($output,[Drawing.Imaging.ImageFormat]::Png); $output.Flush($true) } finally { $output.Dispose() } } finally { $bitmap.Dispose() }
} catch { $failure=$_.Exception.Message }
finally {
 if($null -ne $owned -and $null -ne $identity) {
  try {
   if(-not (Same-Window $identity (Get-WindowIdentity $owned))) { throw 'Window identity changed before close.' }
   $owned.Quit()
   $until=[DateTime]::UtcNow.AddSeconds(10)
   while([OwnedBrandNative]::IsWindow([IntPtr]$identity.Hwnd) -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 200 }
   $closed=-not [OwnedBrandNative]::IsWindow([IntPtr]$identity.Hwnd)
  } catch { $failure='Window closure or identity was not confirmed.' }
 }
}
if($null -ne $failure -or -not $closed) { [Console]::Error.WriteLine('Observer could not confirm its window and closure: '+$failure); exit 1 }
[pscustomobject]@{Hwnd=$identity.Hwnd;Pid=$identity.Pid;StartTicks=$identity.StartTicks;Volume=$Volume;FileId=$FileId;Closed=$closed;Screenshot=$screenshot;LabelObserved=$true;LabelCount=1} | ConvertTo-Json -Compress
