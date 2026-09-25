/**
 * What everyone agrees to before using LUME for the first time: the licence agreement, the terms of
 * service and the privacy policy. Changing any word here means changing LEGAL_VERSION, and everyone
 * is then asked to agree again before they carry on.
 *
 * DRAFT: written in plain language from how LUME actually works (self-hosted per business, masked
 * contacts, audit log). It has not been reviewed by a lawyer. Before real customers use LUME, have it
 * reviewed for the countries you sell in, fill in the provider's legal name and the governing law,
 * then set LEGAL_DRAFT to false and move LEGAL_VERSION on.
 */
export const LEGAL_VERSION = "2026-09-25";
export const LEGAL_DRAFT = true;

export type LegalSection = { heading: string; paragraphs: string[] };
export type LegalDocument = { id: "licence" | "terms" | "privacy"; title: string; sections: LegalSection[] };

export const needsAgreement = (agreedVersion: string | null | undefined): boolean =>
  agreedVersion !== LEGAL_VERSION;

const CHANGES =
  "If this document changes, you will be shown the new version and asked to agree again before you carry on using LUME.";

export const LEGAL_DOCUMENTS: LegalDocument[] = [
  {
    id: "licence",
    title: "Licence agreement",
    sections: [
      {
        heading: "Who this is between",
        paragraphs: [
          "LUME is software made by its provider (“we”, “us”) and licensed to the business that runs it (“the Business”). You use LUME because the Business has given you an account.",
          "By selecting “I agree” you accept this licence agreement, the terms of service and the privacy policy that follow, for your use of LUME on the Business’s behalf.",
        ],
      },
      {
        heading: "What you may do",
        paragraphs: [
          "You may use LUME to do your work for the Business: to manage its leads, its pipeline and its follow-ups, within the access your role gives you.",
          "Your licence is personal, is not transferable, and ends when your account is disabled or the Business stops using LUME.",
        ],
      },
      {
        heading: "What you may not do",
        paragraphs: [
          "You may not copy, sell, rent, sublicense or share LUME or your account; reverse engineer it except where the law allows; get around its security, masking or access controls; or use it to build a competing product.",
          "You may not use LUME to send messages people have not agreed to receive, or for anything unlawful.",
        ],
      },
      {
        heading: "Ownership",
        paragraphs: [
          "We keep all rights in LUME itself, including its design, code and the LUME name and mark. The Business owns its own data: its leads, notes, messages and settings.",
        ],
      },
      {
        heading: "Updates",
        paragraphs: [
          "LUME may be updated from time to time to fix problems, improve security or add features. Some features may change or be removed.",
        ],
      },
      {
        heading: "No warranty, and limits on liability",
        paragraphs: [
          "LUME is provided to you as a tool for your work. To the extent the law allows, we do not promise it will be free of errors or always available, and we are not liable to you personally for losses arising from your use of it. Nothing here limits liability that cannot be limited by law.",
        ],
      },
      { heading: "Changes to this agreement", paragraphs: [CHANGES] },
    ],
  },
  {
    id: "terms",
    title: "Terms of service",
    sections: [
      {
        heading: "Your account",
        paragraphs: [
          "Keep your password and two-step sign-in private, and do not let anyone else use your account. Tell an admin at the Business straight away if you think someone else has used it.",
          "Everything done while signed in to your account is recorded as done by you.",
        ],
      },
      {
        heading: "Contact details and privacy of leads",
        paragraphs: [
          "Leads’ phone numbers and email addresses may be masked for your role. Revealing a contact is recorded in the audit log, with who revealed it and when. Reveal a contact only when your work needs it.",
          "Do not copy leads’ personal details out of LUME except as the Business allows.",
        ],
      },
      {
        heading: "Messages you send",
        paragraphs: [
          "Messages you send from LUME, for example on WhatsApp, are sent by you on the Business’s behalf. Send them only to people who have asked to hear from the Business, and follow WhatsApp’s own rules.",
        ],
      },
      {
        heading: "The audit log",
        paragraphs: [
          "Important actions — signing in, revealing contacts, changing settings, moving and assigning leads — are recorded in an audit log that nobody can edit or delete. The Business’s admins can read it.",
        ],
      },
      {
        heading: "Acceptable use",
        paragraphs: [
          "Use LUME only for the Business’s legitimate work. Do not upload anything unlawful, harmful or that you have no right to use, and do not try to reach data your role does not give you.",
        ],
      },
      {
        heading: "Suspension and ending",
        paragraphs: [
          "The Business can change your access, disable your account or hand your leads to a colleague at any time. When your account is disabled you are signed out everywhere.",
        ],
      },
      { heading: "Changes to these terms", paragraphs: [CHANGES] },
    ],
  },
  {
    id: "privacy",
    title: "Privacy policy",
    sections: [
      {
        heading: "Who is responsible for your data",
        paragraphs: [
          "LUME runs on the Business’s own server. The Business decides what LUME is used for and is responsible for the personal data in it, including yours. We do not receive the Business’s leads or your activity as part of running LUME.",
        ],
      },
      {
        heading: "What LUME keeps about you",
        paragraphs: [
          "Your name, email address, role, password (stored only as a one-way hash), two-step sign-in secret (encrypted), your preferences, and the sessions you are signed in with (device and approximate time, and the network address they came from).",
          "A record of what you do in LUME: the audit log described in the terms of service, and the history of each lead you work on.",
          "When you agree to these documents, the version you agreed to, when, and from which network address and browser, so the Business can show you agreed.",
        ],
      },
      {
        heading: "What LUME keeps about leads",
        paragraphs: [
          "The details the Business collects about its leads: names, contact details, notes, the stage of each conversation, and any custom fields the Business adds. Contact details are encrypted at rest and can be masked for roles that do not need them.",
        ],
      },
      {
        heading: "Who else sees data",
        paragraphs: [
          "Only people the Business gives accounts to, within their roles. Email from LUME (invites, password resets) goes through the email service the Business chooses. If the Business connects Google Sheets or Google Calendar, LUME exchanges the data needed for that with Google. When an admin changes the business currency, LUME asks an exchange-rate service for a rate; no personal data is sent.",
        ],
      },
      {
        heading: "How long data is kept",
        paragraphs: [
          "For as long as the Business keeps it. The audit log is kept for the period the Business has set. Encrypted backups are kept for a limited time and then deleted.",
        ],
      },
      {
        heading: "Security",
        paragraphs: [
          "LUME uses encrypted connections, encrypted storage for contact details and secrets, two-step sign-in, per-role access, and automatic sign-out of disabled accounts.",
        ],
      },
      {
        heading: "Your rights",
        paragraphs: [
          "You can ask the Business to see, correct or delete personal data about you, as the law where you are allows. Ask an admin at the Business; they can act on it in LUME.",
        ],
      },
      { heading: "Changes to this policy", paragraphs: [CHANGES] },
    ],
  },
];
