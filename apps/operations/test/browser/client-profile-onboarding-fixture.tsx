import { createRoot } from "react-dom/client";
import { ClientProfileOnboardingForm } from "@ltds/ui/client-profile-onboarding";

createRoot(document.getElementById("root")!).render(<ClientProfileOnboardingForm onSubmit={values => {
  (window as Window & { onboardingSubmission?: unknown }).onboardingSubmission = values;
}} />);
