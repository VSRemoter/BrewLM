/**
 * Throwaway-inbox domains that can't start a new BrewLM account (auth.ts):
 * each fresh address would mean a fresh free trial. The most used services
 * only; a subdomain of one counts too. Existing accounts keep signing in.
 */
const DISPOSABLE = new Set([
  "10minutemail.com", "10minutemail.net", "20minutemail.com", "burnermail.io",
  "byom.de", "chacuo.net", "cuvox.de", "dayrep.com", "deadaddress.com", "discard.email", "discardmail.com",
  "dispostable.com", "dropmail.me", "einrot.com", "emailondeck.com", "emailtemporanea.net", "fakeinbox.com",
  "fakemail.net", "fleckens.hu", "getairmail.com", "getnada.com", "gishpuppy.com", "guerrillamail.biz",
  "guerrillamail.com", "guerrillamail.de", "guerrillamail.info", "guerrillamail.net", "guerrillamail.org",
  "guerrillamailblock.com", "gustr.com", "harakirimail.com", "hmamail.com", "inboxbear.com", "inboxkitten.com",
  "incognitomail.org", "jetable.org", "jourrapide.com", "kasmail.com", "linshiyouxiang.net", "mail-temp.com",
  "mail.tm", "mail7.io", "mailcatch.com", "maildrop.cc", "mailinator.com", "mailinator.net", "mailinator2.com",
  "mailnesia.com", "mailpoof.com", "mailsac.com", "mintemail.com", "mohmal.com", "moakt.com", "mytemp.email",
  "mytrashmail.com", "nada.email", "nwytg.net", "owlymail.com", "pokemail.net", "rhyta.com", "sharklasers.com",
  "spam4.me", "spambog.com", "spambox.us", "spamgourmet.com", "spamex.com", "superrito.com", "teleworm.us",
  "temp-mail.io", "temp-mail.org", "tempail.com", "tempinbox.com", "tempmail.com", "tempmail.dev",
  "tempmail.net", "tempmail.plus", "tempmailo.com", "tempr.email", "throwawaymail.com", "trash-mail.com",
  "trashmail.com", "trashmail.de", "trashmail.io", "trashmail.me", "trashmail.net",
  "wegwerfmail.de", "wegwerfmail.net", "yopmail.com", "yopmail.fr", "yopmail.net", "zetmail.com",
  "emltmp.com", "tmpmail.net", "tmpmail.org", "tmail.ws", "fexbox.org", "fextemp.com", "1secmail.com",
  "1secmail.net", "1secmail.org", "minuteinbox.com", "luxusmail.org", "vomoto.com", "tmpeml.com",
]);

/** Is the address at a throwaway-inbox service (or a subdomain of one)? */
export function isDisposableEmail(email: string): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i++) if (DISPOSABLE.has(parts.slice(i).join("."))) return true;
  return false;
}
