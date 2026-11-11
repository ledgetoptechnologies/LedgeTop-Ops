using LedgeTop.Files;

internal static class InstallerVersionConflictTests {
    internal static async Task Run() {
        const string root=@"C:\Users\synthetic\AppData\Local\Programs\LedgeTop Files Pilot";
        string Exe(string version)=>root+@"\versions\"+version+@"\LedgeTop.Files.exe";
        string Cmd(string version)=>"\""+Exe(version)+"\" --startup-saved-source-v1 employee";
        void Need(bool value,string why){if(!value)throw new Exception(why);}
        Need(!InstallerVersionConflict.HasConflict("0.5.34.0",Cmd("0.5.34.0"),[Exe("0.5.34.0")],root),"matching owned paths refused");
        Need(InstallerVersionConflict.HasConflict("0.5.34.0",Cmd("0.5.44.0"),[],root),"mismatched owned startup accepted");
        Need(InstallerVersionConflict.HasConflict("0.5.34.0",Cmd("0.5.34.0"),[Exe("0.5.44.0")],root),"mismatched running image accepted");
        Need(!InstallerVersionConflict.HasConflict("0.5.34.0",null,[ @"C:\Other\LedgeTop.Files.exe" ],root),"absent startup or foreign image refused");
        Need(!InstallerVersionConflict.HasConflict("0.5.34.0","foreign startup command",[],root),"foreign startup refused");
        Need(!InstallerVersionConflict.HasConflict("0.5.34.0","\""+Exe("0.5.44.0")+"\" --unrelated",[],root),"unrecognized foreign command refused");
        Need(InstallerVersionConflict.HasConflict(null,Cmd("0.5.34.0"),[],root),"owned orphan startup accepted");
        Need(!InstallerVersionConflict.HasConflict(null,null,[],root),"empty fresh install refused");
        Need(!InstallerVersionConflict.CanonicalVersion("01.2.3.4") && !InstallerVersionConflict.CanonicalVersion("65536.0.0.0"),"noncanonical version accepted");
        var calls=0;Task<int> Next(){calls++;return Task.FromResult(7);}
        var compiled=(true,(LedgeTop.Files.Backends.ReleaseChannel?)LedgeTop.Files.Backends.ReleaseChannel.Pilot);
        Need(await InstallerMaintenance.CheckVersionBeforeMaintenanceAsync(compiled,[InstallerMaintenance.CheckArgument],()=>false,Next)==21 && calls==0,"conflict must stop before other maintenance");
        Need(await InstallerMaintenance.CheckVersionBeforeMaintenanceAsync(compiled,[InstallerMaintenance.CheckArgument],()=>throw new IOException(),Next)==20 && calls==0,"unknown state must stop before other maintenance");
        Need(await InstallerMaintenance.CheckVersionBeforeMaintenanceAsync(compiled,[InstallerMaintenance.CheckArgument],()=>true,Next)==7 && calls==1,"matching state must continue");
        Console.WriteLine("PASS synthetic installer startup and running image conflict classification; no registry or process operations.");
    }
}
