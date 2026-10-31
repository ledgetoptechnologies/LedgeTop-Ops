using LedgeTop.Files.Explorer;

internal static class FailedAvailabilityIntentTests
{
    internal static int Run()
    {
        var policy=new FailedAvailabilityIntents(["photo.jpg","other.jpg"]);var attempts=0;
        void Attempt(AvailabilityIntent intent,bool fail){if(!policy.ShouldAttempt("photo.jpg",intent))return;attempts++;if(fail)policy.MarkFailed("photo.jpg",intent);}
        Attempt(AvailabilityIntent.Keep,true);
        Attempt(AvailabilityIntent.Unknown,false);
        for(var n=0;n<100;n++)Attempt(AvailabilityIntent.Keep,false);
        Require(attempts==1&&policy.ShouldAttempt("other.jpg",AvailabilityIntent.Keep));
        Attempt(AvailabilityIntent.Free,false);Require(attempts==2); // A real unpin is never blocked by a failed keep.
        Attempt(AvailabilityIntent.Keep,true);Require(attempts==3);
        Attempt(AvailabilityIntent.None,false);Attempt(AvailabilityIntent.Keep,false);Require(attempts==4);
        policy.MarkFailed("photo.jpg",AvailabilityIntent.Free);Require(!policy.ShouldAttempt("photo.jpg",AvailabilityIntent.Free));
        Require(policy.ShouldAttempt("photo.jpg",AvailabilityIntent.Keep));
        var freshConnection=new FailedAvailabilityIntents(["photo.jpg"]);Require(freshConnection.ShouldAttempt("photo.jpg",AvailabilityIntent.Free));
        var rejected=false;try{policy.MarkFailed("foreign.jpg",AvailabilityIntent.Keep);}catch(ArgumentException){rejected=true;}Require(rejected);
        Require(FailedAvailabilityIntents.ObserveAttributes(0x80000)==AvailabilityIntent.Keep&&FailedAvailabilityIntents.ObserveAttributes(0x100000)==AvailabilityIntent.Free);
        Require(FailedAvailabilityIntents.ObserveAttributes(0)==AvailabilityIntent.None&&FailedAvailabilityIntents.ObserveAttributes(0x180000)==AvailabilityIntent.Unknown);
        // The policy has no callback/transport capability. Explicit FETCH_DATA is never routed through it.
        Console.WriteLine("PASS failed same intent suppressed, observed changes/unpin/new connection proceed, foreign entries refused; no provider/native/source calls.");return 0;
    }
    private static void Require(bool value){if(!value)throw new IOException("Availability intent suppression failed.");}
}
