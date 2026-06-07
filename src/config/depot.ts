/**
 * Central depot / hub location.
 *
 * All orders flow through this single location:
 *   Farmer → delivers to depot on a chosen date
 *   Market → picks up from depot
 *
 * This eliminates per-order address coordination and simplifies logistics
 * to a two-step process with one shared address.
 */
export const DEPOT = {
  name: 'FarmLink Depot',
  street: '10301 North Rodney Parham Road',
  suite: 'STE C1',
  city: 'Little Rock',
  state: 'Arkansas',
  zip: '72227',
  country: 'United States',

  /** One-line address for SMS / compact display */
  get short() {
    return `${this.street}, ${this.suite}, ${this.city}, AR ${this.zip}`;
  },

  /** Full formatted address */
  get full() {
    return `${this.street}, ${this.suite}, ${this.city}, ${this.state} ${this.zip}, ${this.country}`;
  },
} as const;
