# Pinned WindowsDesktop component notices

These are unmodified vendor notices, not Ledge Top's licensing statement. Both
come from Microsoft's `dotnet/dotnet` commit
`4099f83977f4d29604a9aeb971fb0a7bc1d5f699`, the repository commit recorded in the
signed `Microsoft.WindowsDesktop.App.Runtime.win-x64`10.0.13 nupkg's nuspec.
The package contains its MIT license but omits these component notice files.
The actual WPF publish includes Presentation assemblies and shared drawing
binaries (`System.Drawing.Common.dll` and `System.Private.Windows.GdiPlus.dll`),
and omits `System.Windows.Forms.dll`. Retain both component notice files as
conservative vendor material for the selected desktop runtime package; this
does not claim that every third-party component named in those files is linked
into the application, or that the full Windows Forms runtime is shipped.

| Local file | Original source | SHA256 |
| --- | --- | --- |
| THIRD-PARTY-NOTICES.WPF.txt | [src/wpf/THIRD-PARTY-NOTICES.TXT](https://raw.githubusercontent.com/dotnet/dotnet/4099f83977f4d29604a9aeb971fb0a7bc1d5f699/src/wpf/THIRD-PARTY-NOTICES.TXT) | `d23dba2fee20c6b59d8f7088ee9ed372459c952a319b7ca90f3eec370cc76eb9` |
| THIRD-PARTY-NOTICES.WindowsForms.txt | [src/winforms/THIRD-PARTY-NOTICES.TXT](https://raw.githubusercontent.com/dotnet/dotnet/4099f83977f4d29604a9aeb971fb0a7bc1d5f699/src/winforms/THIRD-PARTY-NOTICES.TXT) | `5a412b38efae0b162dc0893b319023f4cd14a8985a0f9f9ae01ac052b37a36eb` |

The packaging script also copies NETCore's license/third-party notices and the
WindowsDesktop license directly from their exact hash-pinned nupkg entries.
No network retrieval occurs while assembling notices. A runtime upgrade needs
new reviewed package/source hashes; an old notice set must not quietly carry
forward. Complete cloudflared/Go/native attribution remains a separate gap.
