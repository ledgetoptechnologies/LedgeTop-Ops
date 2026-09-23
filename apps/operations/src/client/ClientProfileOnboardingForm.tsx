import { useId, useState, type FormEvent, type InvalidEvent } from "react";
import "./ClientProfileOnboardingForm.css";

export type ClientProfileType = "individual" | "organization";

/** These limits intentionally match the current native client-profile writer. */
export const CLIENT_PROFILE_ONBOARDING_LIMITS = {
  contactName: 150,
  email: 255,
  phone: 50,
  organizationName: 150,
  generalEmail: 255,
  generalPhone: 50,
  addressLine1: 255,
  addressLine2: 255,
  city: 100,
  region: 2,
  postalCode: 20,
  country: 100,
} as const;

export interface ClientProfileOnboardingValues {
  profileType: ClientProfileType;
  contactName: string;
  email: string;
  phone: string;
  organizationName: string;
  generalEmail: string;
  generalPhone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

export const EMPTY_CLIENT_PROFILE_ONBOARDING_VALUES: ClientProfileOnboardingValues = {
  profileType: "individual", contactName: "", email: "", phone: "", organizationName: "", generalEmail: "", generalPhone: "",
  addressLine1: "", addressLine2: "", city: "", region: "", postalCode: "", country: "",
};

/**
 * Returns a presentation-safe form state. It deliberately clears fields that
 * are not relevant to an individual rather than retaining them in UI state.
 */
export function valuesForClientProfileType(values: ClientProfileOnboardingValues, profileType: ClientProfileType): ClientProfileOnboardingValues {
  return profileType === "organization" ? { ...values, profileType } : {
    ...values, profileType, organizationName: "", generalEmail: "", generalPhone: "",
  };
}

/** No values are shortened: callers receive exactly what the browser validated. */
export function clientProfileOnboardingSubmission(values: ClientProfileOnboardingValues): ClientProfileOnboardingValues {
  return values.profileType === "organization" ? { ...values } : valuesForClientProfileType(values, "individual");
}

export interface ClientProfileOnboardingFormProps {
  initialValues?: Partial<ClientProfileOnboardingValues>;
  /** Future transport boundary. This component never sends, stores, or logs profile data. */
  onSubmit?: (values: ClientProfileOnboardingValues) => void;
  submitLabel?: string;
}

function initialFormValues(initialValues: Partial<ClientProfileOnboardingValues> | undefined): ClientProfileOnboardingValues {
  const values = { ...EMPTY_CLIENT_PROFILE_ONBOARDING_VALUES, ...initialValues };
  return valuesForClientProfileType(values, values.profileType === "organization" ? "organization" : "individual");
}

export function ClientProfileOnboardingForm({ initialValues, onSubmit, submitLabel = "Continue" }: ClientProfileOnboardingFormProps) {
  const formId = useId();
  const [values, setValues] = useState(() => initialFormValues(initialValues));
  const [validationMessage, setValidationMessage] = useState("");
  const change = <K extends keyof ClientProfileOnboardingValues>(field: K, value: ClientProfileOnboardingValues[K]) => {
    setValues(previous => ({ ...previous, [field]: value }));
    setValidationMessage("");
  };
  const selectProfileType = (profileType: ClientProfileType) => setValues(previous => valuesForClientProfileType(previous, profileType));
  const invalid = (event: InvalidEvent<HTMLFormElement>) => {
    event.preventDefault();
    const control = event.target as HTMLInputElement;
    setValidationMessage(control.validity.valueMissing ? `${control.labels?.[0]?.textContent || "This field"} is required.` : control.validationMessage);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    setValidationMessage("");
    onSubmit?.(clientProfileOnboardingSubmission(values));
  };
  const input = <K extends Exclude<keyof ClientProfileOnboardingValues, "profileType">>(field: K, label: string, options: {
    autoComplete?: string; required?: boolean; type?: "email" | "tel" | "text";
  } = {}) => <label className="client-profile-onboarding-field" htmlFor={`${formId}-${field}`}>
    <span>{label}{options.required && <em aria-hidden="true"> *</em>}</span>
    <input id={`${formId}-${field}`} name={field} type={options.type || "text"} autoComplete={options.autoComplete}
      maxLength={CLIENT_PROFILE_ONBOARDING_LIMITS[field]} required={options.required} value={values[field]}
      onChange={event => change(field, event.target.value)} />
  </label>;

  return <section className="client-profile-onboarding" aria-labelledby={`${formId}-title`}>
    <div className="client-profile-onboarding-card">
      <header><p className="client-profile-onboarding-eyebrow">LedgeTop Ops Client Portal</p>
        <h1 id={`${formId}-title`}>Client profile onboarding</h1>
        <p>Tell us how to reach you and where your services take place. You can review these details before they are submitted.</p>
      </header>
      <form className="client-profile-onboarding-form" noValidate onInvalid={invalid} onSubmit={submit}>
        <fieldset className="client-profile-onboarding-type">
          <legend>Profile type</legend>
          <div>
            <label><input type="radio" name={`${formId}-profile-type`} checked={values.profileType === "individual"}
              onChange={() => selectProfileType("individual")} /> Individual</label>
            <label><input type="radio" name={`${formId}-profile-type`} checked={values.profileType === "organization"}
              onChange={() => selectProfileType("organization")} /> Organization</label>
          </div>
        </fieldset>

        <div className="client-profile-onboarding-grid">
          {input("contactName", "Contact name", { autoComplete: "name", required: true })}
          {input("email", "Email address", { autoComplete: "email", required: true, type: "email" })}
          {input("phone", "Phone", { autoComplete: "tel", type: "tel" })}
          {values.profileType === "organization" && <>
            {input("organizationName", "Organization name", { autoComplete: "organization" })}
            {input("generalEmail", "General company email", { autoComplete: "email", type: "email" })}
            {input("generalPhone", "General company phone", { autoComplete: "tel", type: "tel" })}
          </>}
          <div className="client-profile-onboarding-span-two">{input("addressLine1", "Address line 1", { autoComplete: "address-line1" })}</div>
          <div className="client-profile-onboarding-span-two">{input("addressLine2", "Address line 2", { autoComplete: "address-line2" })}</div>
          {input("city", "City", { autoComplete: "address-level2" })}
          {input("region", "Region / state", { autoComplete: "address-level1" })}
          {input("postalCode", "Postal code", { autoComplete: "postal-code" })}
          {input("country", "Country", { autoComplete: "country-name" })}
        </div>
        <p className="client-profile-onboarding-required"><span aria-hidden="true">*</span> Required fields</p>
        {validationMessage && <p className="client-profile-onboarding-error" role="alert">{validationMessage}</p>}
        <button type="submit" className="button-orange">{submitLabel}</button>
      </form>
    </div>
  </section>;
}
