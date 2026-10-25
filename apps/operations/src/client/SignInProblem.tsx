import { Brand, SignInRecovery } from "@ltds/ui";

/** Why Operations couldn't open: the session request's status and the server's plain message. */
export type StartupFailure = { status: number | null; message: string };

/**
 * Shown when Operations can't start, for any reason. Every case keeps the same way out: sign in with another
 * email (the normal Cloudflare Access sign-out, which never links accounts or widens access), try again, or
 * email Ledge Top. With JavaScript the sign-out runs in place and returns to Operations' sign-in in one click;
 * the plain logout link stays as the fallback.
 */
export function SignInProblem({ failure }: { failure: StartupFailure }) {
  const denied = failure.status === 403, expired = failure.status === 401;
  const title = denied ? "This email can't open Ledge Top Operations"
    : expired ? "Your sign-in has ended" : "Operations is unavailable right now";
  // Fixed wording, never the server's: older servers name internal systems in their denial text.
  const detail = denied ? "This email isn't set up for Ledge Top Operations. Sign in with your Ledge Top staff email, or ask your administrator to add this one."
    : expired ? "Sign in again to continue." : "Check your connection and try again, or sign in with a different email.";
  return <main className="fatal sign-in-problem" aria-labelledby="sign-in-problem-title">
    <header><Brand product="Operations" /></header>
    <div className="sign-in-problem-body">
      <h1 id="sign-in-problem-title">{title}</h1>
      <p role="alert">{detail}</p>
      <SignInRecovery lead={denied ? "different" : expired ? "again" : "retry"} />
    </div>
  </main>;
}
