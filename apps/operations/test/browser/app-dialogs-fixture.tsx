import { createRoot } from "react-dom/client";
import { AppDialogHost, requestChoice, requestText } from "@ltds/ui";

type Results = { values: Array<string | null> };
const results: Results = { values: [] };
const target = window as Window & { appDialogResults?: Results; appDialogs?: Record<string, () => void> };
target.appDialogResults = results;
const record = (promise: Promise<string | null>) => void promise.then(value => { results.values.push(value); });

target.appDialogs = {
  typedPurge: () => record(requestText({ title: "Permanently purge", label: "Type dataset ID ds-42 to continue", exact: true,
    confirmLabel: "Permanently purge", validate: value => value === "ds-42" ? null : "The ID does not match. Nothing will be purged until it does." })),
  twoInARow: () => {
    record(requestText({ title: "First name", label: "First", defaultValue: "one" }));
    record(requestText({ title: "Second name", label: "Second" }));
  },
  conflict: () => record(requestChoice({ title: "An item with this name already exists",
    choices: [{ value: "rename", label: "Keep both" }, { value: "replace", label: "Replace", tone: "danger" }] })),
};

const withHost = new URLSearchParams(location.search).get("host") !== "0";
createRoot(document.getElementById("root")!).render(<>
  <button type="button" id="opener">Opener</button>
  {withHost && <AppDialogHost />}
</>);
