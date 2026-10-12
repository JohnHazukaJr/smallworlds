/**
 * Public operator on the license and the in-app legal pages.
 * Replace this with your legal name or company before you charge anyone.
 * Do not put a personal name here until you have decided it should be public.
 */
export const COPYRIGHT_HOLDER = 'Small Worlds';
export const COPYRIGHT_YEAR = 2026;

/**
 * Public address for privacy, refunds, and abuse or copyright reports.
 * Leave this empty until you are ready to publish one. The legal pages
 * name the operator without an address until it is set.
 */
export const LEGAL_CONTACT = '';

export function legalContactSentence(): string {
  const address = LEGAL_CONTACT.trim();
  if (address) {
    return `Privacy requests, refund questions, and abuse or copyright reports go to ${address}.`;
  }
  return `Privacy requests, refund questions, and abuse or copyright reports go to the operator, ${COPYRIGHT_HOLDER}.`;
}
