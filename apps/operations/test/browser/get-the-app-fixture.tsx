import { createRoot } from "react-dom/client";
import { AccountMenu } from "@ltds/ui";
import { OPERATIONS_APP_API } from "@ltds/shared";

createRoot(document.getElementById("root")!).render(<header className="topbar" style={{ display: "flex", justifyContent: "flex-end", padding: "12px", background: "#151b22" }}>
  <div style={{ position: "relative" }}>
    <AccountMenu className="profile" displayName="Beau Koltz" avatar="B" details={<small>Owner</small>} appApi={OPERATIONS_APP_API} />
  </div>
</header>);
