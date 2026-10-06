import s from "./googleNote.module.css";

/** LUME's privacy policy: the same address Google's consent screen links to (Google verification). */
export const LUME_PRIVACY_URL = "https://lumecrm.in/privacy";
const USER_DATA_POLICY = "https://developers.google.com/terms/api-services-user-data-policy";

/**
 * What LUME does with Google data, said where a person grants it (Google's verification: in-product privacy
 * notices, prominently displayed), with LUME's privacy policy and Google's Limited Use policy one click away.
 */
export function GoogleDataNote({ what }: { what: string }) {
  return (
    <p className={s.note}>
      {what} LUME&apos;s use of information received from Google follows the{" "}
      <a href={USER_DATA_POLICY} target="_blank" rel="noopener noreferrer">
        Google API Services User Data Policy
      </a>
      , including its Limited Use requirements: it is never sold or used for ads. See LUME&apos;s{" "}
      <a href={LUME_PRIVACY_URL} target="_blank" rel="noopener noreferrer">
        privacy policy
      </a>
      .
    </p>
  );
}
