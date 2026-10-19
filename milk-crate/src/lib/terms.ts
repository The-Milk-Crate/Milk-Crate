/**
 * The terms people agree to (the text is in src/screens/Policies.tsx).
 *
 * TERMS_VERSION: change it when the terms change in a way people must agree to again; everyone
 * signed in is asked once more (src/components/TermsGate.tsx).
 *
 * Fill these in once Milk Crate is a registered organization and has a legal contact. Until then
 * they show in the terms as written, in brackets.
 */
export const TERMS_VERSION = "2026-10-19.2";
export const TERMS_UPDATED = "October 19, 2026";

/** Who people agree with: the organization's legal name. */
export const ORG_NAME = "[ORGANIZATION NAME]";
/** The US state whose laws govern the terms, and whose courts hear disputes. */
export const GOVERNING_STATE = "[STATE]";
/** Where legal notices and copyright notices go. */
export const LEGAL_EMAIL = "[LEGAL EMAIL]";
/** Postal address for formal notices (copyright notices need one). */
export const LEGAL_ADDRESS = "[MAILING ADDRESS]";

/** The share of what listeners pay that goes to artists (the fair-pay promise). Set before payments launch. */
export const ARTIST_SHARE = "[X]%";
/** Where Milk Crate's remaining money goes if it ever closes: another nonprofit that supports musicians. */
export const DISSOLUTION_RECIPIENT = "[A NONPROFIT THAT SUPPORTS MUSICIANS]";
