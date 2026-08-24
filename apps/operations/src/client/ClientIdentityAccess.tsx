import { useState } from "react";
import { Card, StatusPill } from "@ltds/ui";
import { api } from "./api";

export interface ClientIdentityContact {
  workspace_id: string;
  public_id: string;
  display_name: string;
  email_hint: string;
  identity_id: string | null;
  has_workspace_access: number;
  blocked: number;
  invitation: null | {
    id?: string;
    status: string;
    expires_at?: string;
    email_status: string | null;
    attempts?: number | null;
    last_error_code?: string | null;
  };
}

export interface ClientEligibilityBlock {
  id: string;
  match_type: string;
  normalized_email: string | null;
  status: string;
}

export interface ClientAccessManagementState {
  blocks: ClientEligibilityBlock[];
  canManageEligibilityBlocks: boolean;
  canManagePortal: boolean;
}

export function ClientIdentityAccess({ contacts, management, onChanged }: {
  contacts: ClientIdentityContact[];
  management: ClientAccessManagementState;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState("");
  const manageableContacts = contacts.filter(contact => contact.workspace_id && contact.email_hint);
  if ((!management.canManagePortal && !management.canManageEligibilityBlocks) || !manageableContacts.length) return null;

  const block = async (client: ClientIdentityContact) => {
    if (!management.canManageEligibilityBlocks || busy) return;
    setBusy(client.public_id);
    try {
      await api("/api/team/clients/eligibility-blocks", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          matchType: "email",
          email: client.email_hint,
          reasonCode: "operator_opt_out",
          expiresAt: null,
        }),
      });
      onChanged();
    } catch (caught) {
      alert((caught as Error).message);
    } finally {
      setBusy("");
    }
  };

  const revoke = async (blockId: string) => {
    if (!management.canManageEligibilityBlocks || busy) return;
    setBusy(blockId);
    try {
      await api(`/api/team/clients/eligibility-blocks/${encodeURIComponent(blockId)}/revoke`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ reasonCode: "operator_opt_in" }),
      });
      onChanged();
    } catch (caught) {
      alert((caught as Error).message);
    } finally {
      setBusy("");
    }
  };

  const retryInvitation = async (client: ClientIdentityContact) => {
    if (!management.canManagePortal || busy) return;
    setBusy(client.public_id);
    try {
      const result = await api<{ outcome: string }>(
        `/api/team/clients/${encodeURIComponent(client.workspace_id)}/${encodeURIComponent(client.public_id)}/invitation/retry`,
        { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } },
      );
      alert(result.outcome === "queued" ? "Invitation delivery queued." : result.outcome === "already_queued"
        ? "Invitation delivery is already queued."
        : "This invitation cannot be retried. Create a new invitation from an authorized client manager.");
      onChanged();
    } catch (caught) {
      alert((caught as Error).message);
    } finally {
      setBusy("");
    }
  };

  return <Card title="Client access management">
    <p>Eligibility only opens the Client Portal shell. Projects, deliveries, Viewer models, and other data still require explicit access.</p>
    <div className="client-access-management-list">
      {manageableContacts.map(contact => {
        const activeBlock = management.blocks.find(block => block.status === "active" &&
          block.match_type === "email" && block.normalized_email === contact.email_hint.toLowerCase());
        return <section key={`${contact.workspace_id}:${contact.public_id}`}>
          <div>
            <strong>{contact.display_name}</strong>
            <small>{contact.email_hint}</small>
            {contact.invitation?.last_error_code && <small>Delivery error: {contact.invitation.last_error_code}</small>}
          </div>
          <StatusPill tone={contact.blocked ? "danger" : "neutral"}>{contact.blocked ? "blocked" : "eligible"}</StatusPill>
          <div className="actions">
            {management.canManagePortal && contact.invitation?.status === "pending" &&
              ["failed", "pending"].includes(contact.invitation.email_status || "") &&
              <button className="button-ghost button-small" disabled={busy === contact.public_id}
                onClick={() => void retryInvitation(contact)}>Retry invitation delivery</button>}
            {management.canManageEligibilityBlocks && (activeBlock
              ? <button className="button-ghost button-small" disabled={busy === activeBlock.id}
                onClick={() => void revoke(activeBlock.id)}>Remove opt-out</button>
              : <button className="button-danger button-small" disabled={busy === contact.public_id}
                onClick={() => void block(contact)}>Block portal eligibility</button>)}
          </div>
        </section>;
      })}
    </div>
  </Card>;
}
