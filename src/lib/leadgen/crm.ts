import type { ZohoService } from "@/lib/services/types";

import type { CrmCheck } from "./holds";

/**
 * The CRM check over the Zoho adapter as it is today (leadgen v2.1 §10), with
 * no change to its interface.
 *
 * `findLead` searches Leads only and returns the first match, so this is
 * positive only: a lead marked Customer holds, and anything else, a miss
 * included, proves nothing. The open-deal hold is deferred; there is no deal
 * read to make one from.
 */
export function zohoCrmCheck(zoho: Pick<ZohoService, "findLead">): CrmCheck {
  return {
    async isCustomerDomain(domain) {
      const match = await zoho.findLead({ domain });
      return match?.isCustomer === true;
    },
    async emailStatus(email) {
      const match = await zoho.findLead({ email });
      return { optOut: match?.optOut === true, isCustomer: match?.isCustomer === true };
    },
  };
}

/** No CRM connected: nothing is known, so nothing holds on the CRM's say. */
export const NO_CRM: CrmCheck = {
  async isCustomerDomain() {
    return false;
  },
  async emailStatus() {
    return { optOut: false, isCustomer: false };
  },
};
