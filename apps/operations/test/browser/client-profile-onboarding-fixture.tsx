import { createRoot } from "react-dom/client";
import { ClientProfileOnboardingForm } from "../../src/client/ClientProfileOnboardingForm";

createRoot(document.getElementById("root")!).render(<ClientProfileOnboardingForm onSubmit={values => {
  (window as Window & { onboardingSubmission?: unknown }).onboardingSubmission = values;
}} />);
