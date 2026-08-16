import { describe, expect, it } from "vitest";
import {
  classifyPublicShareLifecycle,
  publicShareSessionExpiresAt,
  shouldRenewPublicShareSession,
  type PublicShareLifecycleRow,
} from "../src/worker/public-share-lifecycle";

const active:PublicShareLifecycleRow={
  id:"share-a",public_id:"public-a",project_id:"project-a",token_hash:"hash",label:null,
  password_hash:null,password_salt:null,password_iterations:null,password_algorithm:null,
  expires_at:null,revoked_at:null,revoked_reason:null,unavailable_since:null,share_version:3,
  client_name:"Acme",project_name:"Site",r2_prefix:"jobs/acme/",project_active:1,project_exists:1,
};

describe("public share lifecycle classification",()=>{
  const now=Date.parse("2026-08-15T12:00:00Z");
  it("keeps never-expire and future-expiry shares active",()=>{
    expect(classifyPublicShareLifecycle(active,now)).toBe("active");
    expect(classifyPublicShareLifecycle({...active,expires_at:"2026-08-16T12:00:00Z"},now)).toBe("active");
  });
  it.each([
    [{expires_at:"2026-08-15T11:59:59Z"},"expired"],
    [{expires_at:"not-a-valid-timestamp"},"expired"],
    [{revoked_at:"2026-08-15T11:00:00Z",revoked_reason:"manual"},"revoked"],
    [{project_active:0},"project_inactive"],
    [{project_exists:0},"resource_removed"],
    [{revoked_at:"2026-08-15T11:00:00Z",revoked_reason:"folder_unavailable"},"resource_removed"],
  ] as const)("classifies %j as %s",(patch,outcome)=>{
    expect(classifyPublicShareLifecycle({...active,...patch},now)).toBe(outcome);
  });
});

describe("public share sliding sessions",()=>{
  const now=Date.parse("2026-08-15T12:00:00Z");
  it("issues a twelve-hour session for a never-expire share",()=>{
    expect(publicShareSessionExpiresAt(null,now)).toBe(now+12*60*60*1000);
  });
  it("never extends a session past explicit share expiry",()=>{
    expect(publicShareSessionExpiresAt("2026-08-15T13:00:00Z",now)).toBe(Date.parse("2026-08-15T13:00:00Z"));
  });
  it("renews near expiry and after a signing-key rotation, but not a fresh current-key session",()=>{
    expect(shouldRenewPublicShareSession({sessionExpiresAt:now+60_000,cookieKeyId:"v1",currentKeyId:"v1",now})).toBe(true);
    expect(shouldRenewPublicShareSession({sessionExpiresAt:now+8*60*60*1000,cookieKeyId:"v0",currentKeyId:"v1",now})).toBe(true);
    expect(shouldRenewPublicShareSession({sessionExpiresAt:now+8*60*60*1000,cookieKeyId:"v1",currentKeyId:"v1",now})).toBe(false);
  });
});
